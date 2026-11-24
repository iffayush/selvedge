// Selvedge front end. Plain JS; talks to the local server at /api.

// ---------- DOM helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** replaceChildren that skips null/false children (the native one prints "null"). */
function setKids(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
}

const PLACEHOLDER_RE = /\[[^\]\n]{1,60}\]/;

// ---------- state ----------
const STORE_KEY = 'selvedge-session-v1';

function freshState() {
  return {
    upload: null, // {uploadId, fileName, meta}
    resumeText: '',
    jd: '',
    company: '',
    jobTitle: '',
    analysis: null,
    scoresBefore: null,
    model: null,
    confirmed: [],
    tailored: null, // {resume, changes, placeholders}
    scoresAfter: null,
    placeholdersFound: [],
    unconfirmed: [],
    changedNumbers: [],
    pdfInfo: null,
    recheck: null,
    savedDir: null,
    savedId: null,
    saveCompany: '',
    saveRole: '',
    stale: false,
  };
}

function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    return s && typeof s === 'object' ? { ...freshState(), ...s } : null;
  } catch {
    return null;
  }
}

let state = loadSession() ?? freshState();
let settings = null;

let persistTimer;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch {}
  }, 300);
}

// ---------- API ----------
async function api(path, { method = 'GET', body, signal, raw = false } = {}) {
  const opts = { method, signal, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw Object.assign(new Error('Selvedge is not running. Start it again from the desktop shortcut.'), { code: 'offline' });
  }
  if (raw && res.ok) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data?.error?.message || `Request failed (${res.status})`), {
      code: data?.error?.code,
      detail: data?.error?.detail,
    });
  }
  return data;
}

// ---------- feedback ----------
function toast(message, { error = false, action } = {}) {
  const t = h(
    'div',
    { class: `toast${error ? ' error' : ''}`, role: error ? 'alert' : 'status' },
    h('span', {}, message),
    action
      ? h('button', { onclick: () => { action.fn(); t.remove(); } }, action.label)
      : null,
  );
  $('#toasts').append(t);
  setTimeout(() => t.remove(), error ? 10000 : 4500);
}

function showError(err) {
  if (err?.name === 'AbortError' || err?.code === 'cancelled') return;
  const toSettings = ['auth', 'no_key', 'model', 'no_root'].includes(err?.code);
  toast(err?.message || 'Something went wrong.', {
    error: true,
    action: toSettings ? { label: 'Open Settings', fn: () => showView('settings') } : undefined,
  });
}

function setStatus(sel, text, tone = '') {
  const el = typeof sel === 'string' ? $(sel) : sel;
  el.className = `status${tone ? ` ${tone}` : ''}${el.classList.contains('small') ? ' small' : ''}`;
  setKids(el, text);
}

let busy = false;
function setBusy(b) {
  busy = b;
  for (const id of ['#analyzeBtn', '#tailorBtn', '#recheckBtn', '#testBtn', '#coverWriteBtn', '#coverHumanizeBtn']) {
    const el = $(id);
    if (el) el.disabled = b || (id === '#analyzeBtn' && !canAnalyze());
  }
  updateCoverButtons();
}

/** Put a button into (or out of) its loading state: spinner inside, clicks ignored. */
function setLoading(btn, on) {
  if (!btn) return;
  btn.classList.toggle('is-loading', on);
  btn.setAttribute('aria-busy', String(on));
}

/** Set a button's visible text without removing its label wrapper. */
function setButtonLabel(btn, text) {
  const label = $('.btn-label', btn);
  if (label) label.textContent = text;
  else btn.textContent = text;
}

/** Run an AI request with a spinner, a timer and a Cancel button. `button` shows a loading state. */
async function runWithStatus(statusEl, label, fn, button) {
  const ctl = new AbortController();
  const started = Date.now();
  const timeEl = h('span', { class: 'muted' }, '0s');
  const small = statusEl.classList.contains('small');
  statusEl.className = `status${small ? ' small' : ''}`;
  setKids(statusEl,
    h('span', { class: 'spinner' }),
    h('span', {}, label, ' ', timeEl),
    h('button', { class: 'btn ghost small', onclick: () => ctl.abort() }, 'Cancel'),
  );
  const tick = setInterval(() => {
    timeEl.textContent = `${Math.round((Date.now() - started) / 1000)}s`;
  }, 1000);
  setBusy(true);
  setLoading(button, true);
  try {
    const result = await fn(ctl.signal);
    return { result, seconds: Math.round((Date.now() - started) / 1000) };
  } catch (err) {
    if (err.name === 'AbortError') {
      setStatus(statusEl, 'Cancelled.');
    } else {
      setStatus(statusEl, err.message, 'error');
      showError(err);
    }
    return null;
  } finally {
    clearInterval(tick);
    setBusy(false);
    setLoading(button, false);
  }
}

// ---------- views ----------
function showView(name) {
  for (const v of ['tailor', 'cover', 'history', 'settings']) $(`#view-${v}`).hidden = v !== name;
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === name)));
  if (name === 'cover') loadCoverView();
  if (name === 'history') loadHistory();
  if (name === 'settings') loadSettings();
  window.scrollTo({ top: 0 });
}

$$('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));

$$('.subtab').forEach((t) =>
  t.addEventListener('click', () => {
    $$('.subtab').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    $$('.subview').forEach((v) => (v.hidden = v.id !== `sub-${t.dataset.sub}`));
  }),
);

// ---------- inputs ----------
function canAnalyze() {
  return Boolean(state.resumeText.trim() && state.jd.trim());
}

function renderFileInfo(loadingName) {
  const box = $('#fileInfo');
  const dz = $('#dropzone');
  if (loadingName) {
    box.hidden = false;
    setKids(box, h('div', { class: 'status' }, h('span', { class: 'spinner' }), `Reading ${loadingName}…`));
    return;
  }
  if (!state.upload && !state.resumeText) {
    box.hidden = true;
    dz.classList.remove('compact');
    setKids($('.dz-title', dz), 'Drop your résumé here, or ', h('u', {}, 'browse'));
    return;
  }
  dz.classList.add('compact');
  setKids($('.dz-title', dz), 'Replace file');
  box.hidden = false;
  const m = state.upload?.meta || {};
  const chips = [];
  if (m.multiColumn) chips.push(h('span', { class: 'chip warn' }, 'Multi-column layout'));
  if (m.hasTables) chips.push(h('span', { class: 'chip warn' }, 'Uses tables'));
  if (m.oddChars) chips.push(h('span', { class: 'chip warn' }, `${m.oddChars} icon/odd characters`));
  if (m.pages > 2) chips.push(h('span', { class: 'chip warn' }, `${m.pages} pages`));
  if (state.upload && !chips.length) chips.push(h('span', { class: 'chip good' }, 'ATS-friendly layout'));
  setKids(box,
    state.upload
      ? h(
          'div',
          { class: 'file-chip' },
          h('span', { class: 'kind' }, m.kind || 'file'),
          h('span', {}, state.upload.fileName),
          m.pages ? h('span', { class: 'muted small' }, `${m.pages} page${m.pages > 1 ? 's' : ''}`) : null,
        )
      : h('div', { class: 'muted small' }, 'Résumé text restored from a saved application.'),
    chips.length ? h('div', { class: 'chips' }, chips) : null,
  );
}

function renderInputs() {
  const pairs = [
    ['#resumeText', 'resumeText'],
    ['#jd', 'jd'],
    ['#company', 'company'],
    ['#jobTitle', 'jobTitle'],
  ];
  for (const [sel, key] of pairs) if ($(sel).value !== state[key]) $(sel).value = state[key];
  $('#textDetails').hidden = !state.resumeText;
  if (state.resumeText && !state.analysis) $('#textDetails').open = true;
  renderFileInfo();
  $('#analyzeBtn').disabled = busy || !canAnalyze();
  if (state.stale && state.analysis) {
    setStatus('#analyzeStatus', 'Your résumé or the job description changed. Analyze again to refresh the results.');
  }
}

function bindInput(sel, key) {
  $(sel).addEventListener('input', (e) => {
    state[key] = e.target.value;
    if (state.analysis && (key === 'resumeText' || key === 'jd')) state.stale = true;
    persist();
    $('#analyzeBtn').disabled = busy || !canAnalyze();
    if (state.stale) setStatus('#analyzeStatus', 'Your résumé or the job description changed. Analyze again to refresh the results.');
  });
}
bindInput('#resumeText', 'resumeText');
bindInput('#jd', 'jd');
bindInput('#company', 'company');
bindInput('#jobTitle', 'jobTitle');

async function handleFile(file) {
  if (!file) return;
  if (!/\.(pdf|docx)$/i.test(file.name)) {
    toast('Please choose a PDF or Word (.docx) file.', { error: true });
    return;
  }
  renderFileInfo(file.name);
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await api('/api/parse', { method: 'POST', body: fd });
    state.upload = { uploadId: r.uploadId, fileName: r.fileName, meta: r.meta };
    state.resumeText = r.text;
    if (state.analysis) state.stale = true;
    persist();
    renderInputs();
    $('#textDetails').open = true;
  } catch (err) {
    renderFileInfo();
    showError(err);
  }
}

const dz = $('#dropzone');
$('#fileInput').addEventListener('change', (e) => {
  handleFile(e.target.files[0]);
  e.target.value = '';
});
dz.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    $('#fileInput').click();
  }
});
dz.addEventListener('dragover', (e) => {
  e.preventDefault();
  dz.classList.add('over');
});
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  dz.classList.remove('over');
  handleFile(e.dataTransfer.files[0]);
});
// Dropping a file anywhere else should not navigate away.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ---------- analyze ----------
/** Skeleton metric tiles while Gemini works; the rest of the results section waits. */
function showResultsLoading(on) {
  const results = $('#results');
  results.classList.toggle('loading', on);
  if (on) {
    results.hidden = false;
    const tile = () =>
      h('div', { class: 'metric skeleton', 'aria-hidden': 'true' },
        h('div', { class: 'sk l1' }), h('div', { class: 'sk l2' }), h('div', { class: 'sk l3' }), h('div', { class: 'sk l4' }));
    setKids($('#scoreCards'), tile(), tile(), tile());
  }
}

async function analyze() {
  showResultsLoading(true);
  const out = await runWithStatus($('#analyzeStatus'), 'Gemini is reading the role and your résumé…', (signal) =>
    api('/api/analyze', {
      method: 'POST',
      signal,
      body: {
        resumeText: state.resumeText,
        jd: state.jd,
        company: state.company,
        jobTitle: state.jobTitle,
        meta: state.upload?.meta || {},
      },
    }),
  $('#analyzeBtn'));
  showResultsLoading(false);
  if (!out) {
    renderResults();
    return;
  }
  setAiBadge('ok');
  const r = out.result;
  Object.assign(state, {
    analysis: r.analysis,
    scoresBefore: r.scores,
    model: r.model,
    confirmed: [],
    tailored: null,
    scoresAfter: null,
    placeholdersFound: [],
    unconfirmed: [],
    recheck: null,
    savedDir: null,
    stale: false,
    saveCompany: r.analysis.company || state.company || '',
    saveRole: r.analysis.jobTitle || state.jobTitle || '',
  });
  renderBanner();
  persist();
  renderResults();
  renderTailored();
  setStatus('#analyzeStatus', `Analysis done in ${out.seconds}s.`, 'ok');
  $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('#analyzeBtn').addEventListener('click', analyze);

// ---------- results ----------
/** Status family for a 0–100 score: drives the meter colour and the labelled state chip. */
function tone(score) {
  if (score >= 75) return 'good';
  if (score >= 50) return 'warn';
  return 'bad';
}
const toneState = { good: 'good', warn: 'caution', bad: 'problem' };
const toneWord = { good: 'Strong', warn: 'Fair', bad: 'Weak' };

/** A headline stat tile: label, value, a labelled state, a meter, the change and a breakdown. */
function scoreCard(title, before, after, sub, label) {
  const hasAfter = after !== undefined && after !== null;
  const value = hasAfter ? after : before;
  const t = tone(value);
  let delta = h('div', { class: 'metric-delta' }, 'Your current résumé');
  if (hasAfter && before !== undefined) {
    const d = after - before;
    delta = h('div', { class: `metric-delta ${d > 0 ? 'up' : d < 0 ? 'down' : ''}` },
      d === 0 ? `Unchanged from ${before}` : `${d > 0 ? '▲' : '▼'} ${Math.abs(d)} from ${before} · tailored`);
  }
  return h('div', { class: 'metric', role: 'group', 'aria-label': `${title}: ${value} out of 100, ${label || toneWord[t]}` },
    h('div', { class: 'metric-label' }, title, h('span', { class: `state ${toneState[t]}` }, label || toneWord[t])),
    h('div', { class: 'metric-value' }, h('span', { class: 'num' }, value), h('span', { class: 'of' }, '/ 100')),
    h('div', { class: `meter ${toneState[t] === 'good' ? '' : toneState[t]}`, 'aria-hidden': 'true' },
      h('span', { style: `width:${Math.max(2, Math.min(100, value))}%` })),
    delta,
    h('div', { class: 'metric-sub' }, sub),
  );
}

function renderScoreCards() {
  const b = state.scoresBefore;
  if (!b) return;
  const a = state.scoresAfter;
  const cur = a ?? b;
  const must = cur.keywords.byImportance.must;
  setKids($('#scoreCards'),
    scoreCard('ATS score', b.ats.score, a?.ats.score, `Keywords ${cur.ats.keywordPart}% · Format ${cur.ats.formatPart}%`),
    scoreCard(
      'Keyword match',
      b.keywords.score,
      a?.keywords.score,
      `${cur.keywords.matched} of ${cur.keywords.total} keywords · ${must.matched}/${must.total} required`,
    ),
    scoreCard(
      'Shortlist confidence',
      b.confidence.score,
      a?.confidence.score,
      `Keywords ${cur.confidence.parts.keywords} · Requirements ${cur.confidence.parts.requirements} · Fit ${cur.confidence.parts.fit}`,
      cur.confidence.label,
    ),
  );
  const cap = $('#capNote');
  cap.hidden = !cur.confidence.capped;
  if (cur.confidence.capped) {
    cap.textContent = `Confidence is capped at 60 because a required qualification is missing: ${cur.confidence.blockers.join('; ')}.`;
  }
  $('#fitRationale').textContent = state.recheck?.fitRationale || state.analysis?.fitRationale || '';
}

const markChar = { pass: '✓', warn: '!', fail: '✕', met: '✓', partial: '~', missing: '✕' };

function renderChecks() {
  const checks = state.scoresBefore.checks;
  const problems = checks.filter((c) => c.status !== 'pass').length;
  setKids($('[data-sub="checks"]'), 'ATS checks', problems ? h('span', { class: 'count' }, problems) : null);
  setKids($('#sub-checks'),
    h('p', { class: 'muted small' }, 'How your original résumé reads to an applicant tracking system.'),
    h(
      'ul',
      { class: 'check-list' },
      checks.map((c) =>
        h(
          'li',
          {},
          h('span', { class: `mark ${c.status}` }, markChar[c.status]),
          h('div', { class: 'item-body' }, h('div', { class: 'item-title' }, c.label), h('div', { class: 'item-detail' }, c.detail)),
        ),
      ),
    ),
  );
}

const importanceLabel = { must: 'Required', important: 'Important', nice: 'Nice to have' };
const importanceTone = { must: 'bad', important: 'warn', nice: 'neutral' };
const categoryLabel = {
  hard_skill: 'Skill', tool: 'Tool', soft_skill: 'Soft skill', certification: 'Certification', domain: 'Domain', qualification: 'Qualification',
};

function renderKeywords() {
  const matches = state.scoresBefore.keywords.matches;
  const matched = matches.filter((m) => m.matched);
  const missing = matches.filter((m) => !m.matched);
  const order = { must: 0, important: 1, nice: 2 };
  missing.sort((a, b) => order[a.importance] - order[b.importance]);
  setKids($('[data-sub="keywords"]'), 'Keywords', missing.length ? h('span', { class: 'count' }, missing.length) : null);

  const option = (m) => {
    const on = state.confirmed.includes(m.term);
    const box = h('input', {
      type: 'checkbox',
      checked: on,
      onchange: (e) => {
        state.confirmed = e.target.checked
          ? [...new Set([...state.confirmed, m.term])]
          : state.confirmed.filter((t) => t !== m.term);
        e.target.closest('.kw-option').classList.toggle('on', e.target.checked);
        persist();
        renderTailorNote();
      },
    });
    return h(
      'label',
      { class: `kw-option${on ? ' on' : ''}` },
      box,
      h(
        'span',
        { class: 'item-body' },
        h('span', { class: 'kw-term' }, m.term),
        h('span', { class: 'kw-meta' }, `${importanceLabel[m.importance]} · ${categoryLabel[m.category] || m.category}`),
      ),
    );
  };

  // one meter per importance level: matched against that level's own total
  const byImp = state.scoresBefore.keywords.byImportance;
  const meterRows = ['must', 'important', 'nice']
    .filter((k) => byImp[k]?.total)
    .flatMap((k) => {
      const { matched: m, total: t } = byImp[k];
      return [
        h('span', { class: 'name' }, importanceLabel[k]),
        h('div', { class: 'meter', role: 'img', 'aria-label': `${importanceLabel[k]}: ${m} of ${t} found` },
          h('span', { style: `width:${t ? Math.max(m ? 4 : 0, (m / t) * 100) : 0}%` })),
        h('span', { class: 'fig' }, `${m} of ${t}`),
      ];
    });

  setKids($('#sub-keywords'),
    meterRows.length ? h('div', { class: 'meter-list' }, meterRows) : null,
    h(
      'div',
      { class: 'kw-group' },
      h('div', { class: 'kw-head' }, h('h3', {}, `Missing from your résumé (${missing.length})`),
        h('span', { class: 'muted small' }, 'Tick the ones you really have. Only ticked skills get added.')),
      missing.length ? h('div', { class: 'kw-missing' }, missing.map(option)) : h('p', { class: 'muted' }, 'Nothing missing. Nice.'),
    ),
    h(
      'div',
      { class: 'kw-group' },
      h('h3', {}, `Already in your résumé (${matched.length})`),
      h(
        'div',
        { class: 'chips' },
        matched.map((m) =>
          h('span', { class: 'chip good', title: m.matchedAs !== m.term ? `Found as "${m.matchedAs}"` : '' }, m.term),
        ),
      ),
    ),
  );
}

function renderRequirements() {
  const reqs = state.recheck?.requirements || state.analysis.requirements;
  const missing = reqs.filter((r) => r.status === 'missing').length;
  setKids($('[data-sub="reqs"]'), 'Requirements', missing ? h('span', { class: 'count' }, missing) : null);
  // thin segmented bar of met / partial / missing, with the figures in the legend beside it
  const counts = { met: 0, partial: 0, missing: 0 };
  for (const r of reqs) counts[r.status] = (counts[r.status] || 0) + 1;
  const parts = [
    ['met', 'Met', 's-good', 'var(--good)'],
    ['partial', 'Partly met', 's-caution', 'var(--caution)'],
    ['missing', 'Missing', 's-problem', 'var(--problem)'],
  ];
  const summary = reqs.length
    ? h('div', { class: 'summary-bar' },
        h('div', { class: 'seg', role: 'img', 'aria-label': parts.map(([k, n]) => `${n}: ${counts[k]}`).join(', ') },
          parts.filter(([k]) => counts[k]).map(([k, n, cls]) => h('span', { class: cls, style: `flex:${counts[k]}`, title: `${n}: ${counts[k]}` }))),
        h('div', { class: 'legend' },
          parts.map(([k, n, , color]) => h('span', {}, h('i', { style: `background:${color}` }), n, ' ', h('strong', {}, counts[k])))))
    : null;
  setKids($('#sub-reqs'),
    state.recheck ? h('p', { class: 'subview-intro' }, 'Showing the re-check of your tailored résumé.') : null,
    summary,
    h(
      'ul',
      { class: 'req-list' },
      reqs.map((r) =>
        h(
          'li',
          {},
          h('span', { class: `mark ${r.status}` }, markChar[r.status]),
          h(
            'div',
            { class: 'item-body' },
            h(
              'div',
              { class: 'item-title' },
              r.text,
              r.mustHave ? h('span', { class: 'badge neutral' }, 'Required') : null,
              r.hard ? h('span', { class: 'badge neutral' }, 'Screening filter') : null,
            ),
            r.evidence ? h('div', { class: 'evidence' }, `"${r.evidence}"`) : null,
            r.note ? h('div', { class: 'item-detail' }, r.note) : null,
          ),
        ),
      ),
    ),
  );
}

function renderTips() {
  const a = state.analysis;
  const list = (title, items) =>
    h('div', {}, h('h4', {}, title), items?.length ? h('ul', {}, items.map((i) => h('li', {}, i))) : h('p', { class: 'muted small' }, 'None.'));
  setKids($('#sub-tips'),
    h(
      'ul',
      { class: 'tip-list' },
      a.shortlistTips.map((t) =>
        h(
          'li',
          {},
          h('span', { class: `badge ${t.priority === 'high' ? 'ink' : 'neutral'}` }, `${t.priority} priority`),
          h('div', { class: 'item-body' }, h('div', { class: 'item-title' }, t.tip), t.why ? h('div', { class: 'item-detail' }, t.why) : null),
        ),
      ),
    ),
    h('div', { class: 'three-col' }, list('Strengths', a.strengths), list('Gaps', a.gaps), list('Red flags', a.redFlags)),
  );
}

function renderTailorNote() {
  const n = state.confirmed.length;
  $('#tailorNote').textContent =
    "Gemini rewrites your résumé for this role using only what's true: no invented jobs, dates or numbers." +
    (n ? ` It will also add the ${n} skill${n > 1 ? 's' : ''} you ticked.` : ' Tick missing keywords you really have to include them.');
  setButtonLabel($('#tailorBtn'), state.tailored ? 'Tailor again' : 'Tailor my résumé');
}

const effortLabel = { weekend: 'About a weekend', one_to_two_weeks: '1–2 weeks', month: 'About a month' };
const wayLabel = {
  certification: 'Certification', course: 'Course', open_source: 'Open source', portfolio: 'Portfolio', networking: 'Networking', other: 'Other',
};

function renderProjects() {
  const a = state.analysis;
  const ideas = a.projectIdeas || [];
  const ways = a.otherWaysToQualify || [];
  setKids($('[data-sub="projects"]'), 'Projects to build', ideas.length ? h('span', { class: 'count' }, ideas.length) : null);
  if (!ideas.length && !ways.length) {
    setKids($('#sub-projects'), h('p', { class: 'muted' }, 'No project ideas for this analysis. Click Analyze again to get them.'));
    return;
  }
  setKids($('#sub-projects'),
    h('p', { class: 'muted small' }, 'Projects you could build to close the gaps for this job. Add them to your résumé only once they are done.'),
    h('div', { class: 'project-list' },
      ideas.map((p, i) =>
        h('div', { class: 'project' },
          h('div', { class: 'item-title' }, h('span', { class: 'project-num' }, i + 1), p.title,
            h('span', { class: 'badge neutral' }, effortLabel[p.effort] || p.effort)),
          h('p', {}, p.whatToBuild),
          p.skills?.length ? h('div', { class: 'chips' }, p.skills.map((s) => h('span', { class: 'chip' }, s))) : null,
          p.gapsClosed?.length ? h('div', { class: 'item-detail' }, h('strong', {}, 'Closes: '), p.gapsClosed.join('; ')) : null,
          p.resumeLine ? h('div', { class: 'evidence' }, `Résumé line once it's done: ${p.resumeLine}`) : null,
        )),
    ),
    ways.length
      ? h('div', { class: 'kw-group' },
          h('h3', {}, 'Other ways to qualify'),
          h('ul', { class: 'tip-list' },
            ways.map((w) =>
              h('li', {},
                h('span', { class: 'badge neutral' }, wayLabel[w.type] || w.type),
                h('div', { class: 'item-body' }, h('div', { class: 'item-title' }, w.suggestion), w.why ? h('div', { class: 'item-detail' }, w.why) : null)))))
      : null,
  );
}

function renderResults() {
  $('#results').hidden = !state.analysis;
  if (!state.analysis) return;
  renderScoreCards();
  renderChecks();
  renderKeywords();
  renderRequirements();
  renderTips();
  renderProjects();
  renderTailorNote();
}

// ---------- tailor ----------
async function tailor() {
  const out = await runWithStatus($('#tailorStatus'), 'Gemini is tailoring your résumé…', (signal) =>
    api('/api/tailor', {
      method: 'POST',
      signal,
      body: { resumeText: state.resumeText, jd: state.jd, analysis: state.analysis, confirmedKeywords: state.confirmed },
    }),
  $('#tailorBtn'));
  if (!out) return;
  const r = out.result;
  state.tailored = { resume: r.resume, changes: r.changes, placeholders: r.placeholders };
  state.scoresAfter = r.scores;
  state.placeholdersFound = r.placeholdersFound;
  state.unconfirmed = r.unconfirmed || [];
  state.changedNumbers = r.changedNumbers || [];
  state.pdfInfo = r.pdf || null;
  state.recheck = null;
  state.savedDir = null;
  persist();
  renderResults();
  renderTailored();
  setStatus('#tailorStatus', `Done in ${out.seconds}s. Review it below.`, 'ok');
  $('#tailored').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('#tailorBtn').addEventListener('click', tailor);

// ----- editor -----
let scoreTimer;
function onEdit(el) {
  if (el) el.classList.toggle('has-placeholder', PLACEHOLDER_RE.test(el.value));
  persist();
  clearTimeout(scoreTimer);
  scoreTimer = setTimeout(rescore, 500);
}

async function rescore() {
  if (!state.tailored) return;
  try {
    const r = await api('/api/score', {
      method: 'POST',
      body: {
        resume: state.tailored.resume,
        analysis: state.analysis,
        requirements: state.recheck?.requirements,
        fitScore: state.recheck?.fitScore,
        originalText: state.resumeText,
        confirmedKeywords: state.confirmed,
      },
    });
    state.scoresAfter = r.scores;
    state.placeholdersFound = r.placeholdersFound;
    state.unconfirmed = r.unconfirmed || [];
    state.changedNumbers = r.changedNumbers || [];
    state.pdfInfo = r.pdf || null;
    persist();
    renderPageFit();
    renderScoreCards();
    renderPlaceholderAlert();
    renderAdditionsAlert();
    renderMissingAfter();
  } catch {
    // scoring is best-effort while typing
  }
}

function textField(label, obj, key, attrs = {}) {
  const input = h('input', { type: 'text', value: obj[key] ?? '', ...attrs, oninput: (e) => { obj[key] = e.target.value; onEdit(e.target); } });
  return label ? h('label', { class: 'field' }, h('span', {}, label), input) : input;
}

function areaField(label, obj, key, rows = 3) {
  const ta = h('textarea', { rows, oninput: (e) => { obj[key] = e.target.value; onEdit(e.target); } });
  ta.value = obj[key] ?? '';
  return label ? h('label', { class: 'field' }, h('span', {}, label), ta) : ta;
}

function linesField(label, obj, key, hint, rows = 4) {
  const ta = h('textarea', {
    rows,
    oninput: (e) => {
      obj[key] = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean);
      onEdit(e.target);
    },
  });
  ta.value = (obj[key] || []).join('\n');
  return h('label', { class: 'field' }, h('span', {}, label || '', hint ? h('span', { class: 'ed-hint' }, ` ${hint}`) : null), ta);
}

function csvField(label, obj, key) {
  const input = h('input', {
    type: 'text',
    value: (obj[key] || []).join(', '),
    oninput: (e) => {
      obj[key] = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
      onEdit(e.target);
    },
  });
  return h('label', { class: 'field' }, h('span', {}, label), input);
}

function edSection(title, onAdd, ...content) {
  return h(
    'div',
    { class: 'ed-section' },
    h('div', { class: 'ed-head' }, h('h3', {}, title), onAdd ? h('button', { class: 'icon-btn', onclick: onAdd }, '+ Add') : null),
    content,
  );
}

function edItem(list, i, ...content) {
  const move = (d) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    rebuildEditor();
    onEdit();
  };
  return h(
    'div',
    { class: 'ed-item' },
    h(
      'div',
      { class: 'ed-item-head' },
      list.length > 1 ? h('button', { class: 'icon-btn', title: 'Move up', onclick: () => move(-1), disabled: i === 0 }, '↑') : null,
      list.length > 1 ? h('button', { class: 'icon-btn', title: 'Move down', onclick: () => move(1), disabled: i === list.length - 1 }, '↓') : null,
      h('button', {
        class: 'icon-btn danger',
        onclick: () => {
          list.splice(i, 1);
          rebuildEditor();
          onEdit();
        },
      }, 'Remove'),
    ),
    content,
  );
}

const row2 = (...c) => h('div', { class: 'row-2' }, c);
const row3 = (...c) => h('div', { class: 'row-3' }, c);

function rebuildEditor() {
  const r = state.tailored.resume;
  const addTo = (list, item) => () => {
    list.push(item());
    rebuildEditor();
    onEdit();
  };
  setKids($('#editor'),
    edSection('Header', null,
      row2(textField('Name', r, 'name'), textField('Headline', r, 'headline')),
      linesField('Contact details', r, 'contact', 'one per line: email, phone, city, LinkedIn', 4)),
    edSection('Summary', null, areaField(null, r, 'summary', 4)),
    edSection('Skills', addTo(r.skills, () => ({ category: '', items: [] })),
      r.skills.map((g, i) => edItem(r.skills, i, row2(textField('Category', g, 'category'), csvField('Skills (comma-separated)', g, 'items'))))),
    edSection('Experience', addTo(r.experience, () => ({ title: '', company: '', location: '', start: '', end: '', bullets: [] })),
      r.experience.map((e, i) =>
        edItem(r.experience, i,
          row3(textField('Job title', e, 'title'), textField('Start', e, 'start'), textField('End', e, 'end')),
          row2(textField('Company', e, 'company'), textField('Location', e, 'location')),
          linesField('Bullets', e, 'bullets', 'one per line', 5)))),
    edSection('Projects', addTo(r.projects, () => ({ name: '', context: '', link: '', bullets: [] })),
      r.projects.map((p, i) =>
        edItem(r.projects, i,
          row2(textField('Project', p, 'name'), textField('Tech / context', p, 'context', { placeholder: 'e.g. Python, AWS' })),
          textField('Link', p, 'link', { placeholder: 'e.g. github.com/you/project or a live demo URL' }),
          linesField('Bullets', p, 'bullets', 'one per line', 3)))),
    edSection('Education', addTo(r.education, () => ({ degree: '', institution: '', location: '', start: '', end: '', details: [] })),
      r.education.map((e, i) =>
        edItem(r.education, i,
          row3(textField('Degree', e, 'degree'), textField('Start', e, 'start'), textField('End', e, 'end')),
          row2(textField('Institution', e, 'institution'), textField('Location', e, 'location')),
          linesField('Details', e, 'details', 'optional, one per line', 2)))),
    edSection('Certifications', null, linesField(null, r, 'certifications', 'one per line', 3)),
    edSection('Other sections', addTo(r.extras, () => ({ heading: '', items: [] })),
      r.extras.map((x, i) =>
        edItem(r.extras, i, textField('Heading', x, 'heading', { placeholder: 'e.g. Awards, Languages' }), linesField('Items', x, 'items', 'one per line', 3)))),
  );
  for (const el of $$('#editor input, #editor textarea')) el.classList.toggle('has-placeholder', PLACEHOLDER_RE.test(el.value));
}

function renderPlaceholderAlert() {
  const list = state.placeholdersFound || [];
  const box = $('#placeholderAlert');
  box.hidden = !list.length;
  if (list.length) {
    setKids(box,
      h('strong', {}, `${list.length} placeholder${list.length > 1 ? 's' : ''} to fill before saving:`),
      h('span', {}, list.join(', ')),
      h('span', {}, 'They are highlighted below. Replace them with your real numbers, or delete them.'),
    );
  }
  $('#saveBtn').disabled = list.length > 0;
  $('#saveBtn').title = list.length ? 'Fill in the highlighted placeholders first' : '';
}

function renderPageFit() {
  const el = $('#pageFit');
  const info = state.pdfInfo;
  if (!info) {
    el.textContent = '';
    return;
  }
  el.className = `small ${info.fits ? 'status ok' : 'status error'}`;
  el.textContent = info.fits
    ? `PDF fits on 1 page (${info.fontSize}pt text).`
    : `PDF needs ${info.pages} pages even at the smallest text size. Remove a few bullets or a project to get it onto one page.`;
}

function renderAdditionsAlert() {
  const skills = state.unconfirmed || [];
  const numbers = state.changedNumbers || [];
  const box = $('#additionsAlert');
  box.hidden = !skills.length && !numbers.length;
  if (box.hidden) return;
  setKids(box,
    h('strong', {}, 'Check these before you save:'),
    skills.length
      ? h('div', { class: 'alert-item' },
          `Skills your original résumé doesn't mention and you didn't tick: ${skills.join(', ')}. `,
          "Keep them only if they're true for you.")
      : null,
    numbers.length
      ? h('div', { class: 'alert-item' },
          'Numbers that aren’t in your original résumé. Fix any that Gemini changed; ignore ones you typed in yourself:',
          h('ul', {}, numbers.map((n) => h('li', {}, h('strong', {}, n.value), ` in “${n.context}”`))))
      : null,
  );
}

function renderMissingAfter() {
  const missing = (state.scoresAfter?.keywords.matches || []).filter((m) => !m.matched && m.importance !== 'nice');
  const box = $('#changesList');
  const old = $('#missingAfter');
  if (old) old.remove();
  if (!missing.length) return;
  box.closest('.card').append(
    h('div', { id: 'missingAfter' },
      h('h3', {}, 'Still missing'),
      h('p', { class: 'muted small' }, 'Important keywords the tailored résumé still lacks. Add them only if they are true for you.'),
      h('div', { class: 'chips' }, missing.map((m) => h('span', { class: `chip ${m.importance === 'must' ? 'bad' : 'warn'}` }, m.term)))),
  );
}

function renderSavePreview() {
  const root = settings?.rootFolder || '';
  const company = $('#saveCompany').value.trim() || 'Unknown Company';
  const role = $('#saveRole').value.trim() || 'Role';
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // An application saved before (this session or loaded from History) is updated in place,
  // unless the company or role changed.
  const prev = state.savedDir || '';
  const prevRole = prev.split('\\').pop() || '';
  const prevCompany = prev.split('\\').slice(-2, -1)[0] || '';
  const sameFolder = prev && prevCompany === company.replace(/[<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim() && prevRole.startsWith(`${role} (`);
  $('#savePreview').textContent = !root
    ? 'Set a save folder in Settings.'
    : sameFolder
      ? `Updates ${prev}`
      : `Saves to ${root}\\${company}\\${role} (${date})`;
}

function renderTailored() {
  $('#tailored').hidden = !state.tailored;
  if (!state.tailored) return;
  rebuildEditor();
  setKids($('#changesList'),
    ...(state.tailored.changes || []).map((c) =>
      h('li', {}, h('strong', {}, `${c.section}: `), c.what, c.why ? h('span', { class: 'why' }, c.why) : null),
    ),
  );
  if (!state.tailored.changes?.length) $('#changesList').append(h('li', { class: 'muted' }, 'No changes listed.'));
  $('#saveCompany').value = state.saveCompany || '';
  $('#saveRole').value = state.saveRole || '';
  $('#openSavedBtn').hidden = !state.savedDir;
  $('#coverFromTailorBtn').hidden = !state.savedId;
  setStatus('#saveStatus', state.savedDir ? `Saved to ${state.savedDir}` : '', state.savedDir ? 'ok' : '');
  renderSavePreview();
  renderPlaceholderAlert();
  renderAdditionsAlert();
  renderPageFit();
  renderMissingAfter();
}

$('#saveCompany').addEventListener('input', (e) => {
  state.saveCompany = e.target.value;
  persist();
  renderSavePreview();
});
$('#saveRole').addEventListener('input', (e) => {
  state.saveRole = e.target.value;
  persist();
  renderSavePreview();
});

async function save() {
  setStatus('#saveStatus', 'Saving…');
  setLoading($('#saveBtn'), true);
  try {
    const r = await api('/api/save', {
      method: 'POST',
      body: {
        uploadId: state.upload?.uploadId,
        originalFileName: state.upload?.fileName,
        originalMeta: state.upload?.meta,
        originalResumeText: state.resumeText,
        company: $('#saveCompany').value.trim(),
        jobTitle: $('#saveRole').value.trim(),
        jd: state.jd,
        analysis: state.analysis,
        resume: state.tailored.resume,
        changes: state.tailored.changes,
        confirmedKeywords: state.confirmed,
        scoresBefore: state.scoresBefore,
        scoresAfter: state.scoresAfter,
        recheck: state.recheck,
        model: state.model,
        previousDir: state.savedDir,
      },
    });
    state.savedDir = r.dir;
    state.savedId = r.id;
    persist();
    $('#openSavedBtn').hidden = false;
    $('#coverFromTailorBtn').hidden = false;
    setStatus('#saveStatus', `Saved to ${r.dir}`, 'ok');
    toast('Application saved.', { action: { label: 'Open folder', fn: () => openFolder(r.dir) } });
  } catch (err) {
    setStatus('#saveStatus', err.message, 'error');
    showError(err);
  } finally {
    setLoading($('#saveBtn'), false);
  }
}
$('#saveBtn').addEventListener('click', save);

async function downloadPdf() {
  try {
    const res = await api('/api/pdf', {
      method: 'POST',
      raw: true,
      body: { resume: state.tailored.resume, jobTitle: $('#saveRole').value.trim() },
    });
    const blob = await res.blob();
    const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'Resume.pdf';
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    if (state.placeholdersFound?.length) toast('Heads up: this PDF still contains placeholders like [X%].', { error: true });
  } catch (err) {
    showError(err);
  }
}
$('#pdfBtn').addEventListener('click', downloadPdf);

async function recheck() {
  const out = await runWithStatus($('#saveStatus'), 'Gemini is re-checking…', (signal) =>
    api('/api/recheck', { method: 'POST', signal, body: { resume: state.tailored.resume, jd: state.jd, analysis: state.analysis } }),
  $('#recheckBtn'));
  if (!out) return;
  const r = out.result;
  state.recheck = { requirements: r.requirements, fitScore: r.fitScore, fitRationale: r.fitRationale };
  state.scoresAfter = r.scores;
  persist();
  renderResults();
  renderPlaceholderAlert();
  renderMissingAfter();
  setStatus('#saveStatus', `Re-check done in ${out.seconds}s. Scores updated.`, 'ok');
}
$('#recheckBtn').addEventListener('click', recheck);

async function openFolder(dir) {
  try {
    await api('/api/open-folder', { method: 'POST', body: { dir } });
  } catch (err) {
    showError(err);
  }
}
$('#openSavedBtn').addEventListener('click', () => state.savedDir && openFolder(state.savedDir));
$('#coverFromTailorBtn').addEventListener('click', () => state.savedId && openCoverFor(state.savedId));

$('#newBtn').addEventListener('click', () => {
  if (state.tailored && !state.savedDir && !confirm('Your tailored résumé isn’t saved. Start a new application anyway?')) return;
  const keep = { upload: state.upload, resumeText: state.resumeText };
  state = { ...freshState(), ...keep };
  persist();
  renderAll();
  setStatus('#analyzeStatus', 'Kept your résumé. Paste the next job description.');
  setStatus('#tailorStatus', '');
  $('#jd').focus();
});

// ---------- history ----------
const SVG_NS = 'http://www.w3.org/2000/svg';
/** The small decorative sheet-and-sprig drawing defined once in index.html. */
function illustration(cls = 'illus') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#illus-sheet');
  svg.append(use);
  return svg;
}

async function loadHistory() {
  const list = $('#historyList');
  setKids(list, h('div', { class: 'status' }, h('span', { class: 'spinner' }), 'Loading…'));
  try {
    const r = await api('/api/applications');
    $('#historyRoot').textContent = r.root ? `Saved in ${r.root}` : '';
    if (!r.applications.length) {
      setKids(list,
        h('div', { class: 'card empty' },
          illustration(),
          h('p', { class: 'empty-line' }, 'Nothing saved yet.'),
          h('p', { class: 'muted small' }, 'Tailor a résumé or write a cover letter and save it; it will be filed here by company.')));
      return;
    }
    const byCompany = new Map();
    for (const a of r.applications) {
      if (!byCompany.has(a.company)) byCompany.set(a.company, []);
      byCompany.get(a.company).push(a);
    }
    setKids(list,
      ...[...byCompany.entries()].map(([company, apps]) =>
        h(
          'div',
          { class: 'hist-company' },
          h('h2', {}, company),
          apps.map((a) => {
            const s = a.scores || {};
            return h(
              'div',
              { class: 'card hist-row' },
              h(
                'div',
                { class: 'hist-main' },
                h('span', { class: 'hist-title' }, a.jobTitle),
                h('span', { class: 'muted small' }, [a.date, a.candidateName].filter(Boolean).join(' · ')),
              ),
              h(
                'div',
                { class: 'hist-scores' },
                s.atsAfter != null ? h('span', { class: 'chip' }, `ATS ${s.atsBefore ?? '–'} → ${s.atsAfter}`) : null,
                s.confidenceAfter != null
                  ? h('span', { class: `state ${toneState[tone(s.confidenceAfter)]}` }, `${s.confidenceLabel} · ${s.confidenceAfter}`)
                  : null,
                a.hasCoverLetter ? h('span', { class: 'chip good' }, 'Cover letter') : null,
              ),
              h(
                'div',
                { class: 'btn-row' },
                h('button', { class: 'btn ghost small', onclick: () => openFolder(a.dir) }, 'Open folder'),
                h('button', { class: 'btn ghost small', onclick: () => openCoverFor(a.id) }, a.hasCoverLetter ? 'Cover letter' : 'Write cover letter'),
                a.hasResume !== false ? h('button', { class: 'btn small', onclick: () => loadApp(a.id) }, 'Load') : null,
              ),
            );
          }),
        ),
      ),
    );
  } catch (err) {
    setKids(list, h('div', { class: 'card empty' }, err.message));
  }
}

async function loadApp(id) {
  try {
    const r = await api(`/api/applications/${encodeURIComponent(id)}`);
    const a = r.app;
    state = {
      ...freshState(),
      upload: a.originalFileName ? { uploadId: null, fileName: a.originalFileName, meta: a.originalMeta || {} } : null,
      resumeText: a.originalResumeText || '',
      jd: r.jd || '',
      company: a.company || '',
      jobTitle: a.jobTitle || '',
      analysis: a.analysis,
      scoresBefore: a.scoresBefore,
      model: a.model,
      confirmed: a.confirmedKeywords || [],
      tailored: { resume: r.resume, changes: a.changes || [], placeholders: [] },
      scoresAfter: a.scoresAfter,
      recheck: a.recheck || null,
      savedDir: r.dir,
      savedId: id,
      saveCompany: a.company || '',
      saveRole: a.jobTitle || '',
    };
    persist();
    showView('tailor');
    renderAll();
    await rescore();
    $('#tailored').scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast(`Loaded ${a.jobTitle} at ${a.company}.`);
  } catch (err) {
    showError(err);
  }
}

$('#refreshHistoryBtn').addEventListener('click', loadHistory);
$('#openRootBtn').addEventListener('click', () => settings?.rootFolder && openFolder(settings.rootFolder));

// ---------- settings ----------
let models = null;

function renderModelSelect() {
  const s = settings;
  const sel = $('#modelSelect');
  if (!models) {
    setKids(sel, h('option', { value: s.model, selected: true }, `${s.model} (loading the model list…)`));
    return;
  }
  const opt = (m) => h('option', { value: m.id, selected: m.id === s.model }, m.recommended && m.id === models[0]?.id ? `${m.label} (recommended)` : m.label);
  const rec = models.filter((m) => m.recommended);
  const other = models.filter((m) => !m.recommended);
  const known = models.some((m) => m.id === s.model);
  setKids(sel,
    known ? null : h('option', { value: s.model, selected: true }, s.model),
    rec.length ? h('optgroup', { label: 'Recommended' }, rec.map(opt)) : null,
    other.length ? h('optgroup', { label: 'Other models (may not work on the free tier)' }, other.map(opt)) : null,
  );
}

function renderSettings() {
  const s = settings;
  if (!s) return;
  const sourceText = {
    settings: `Saved in Settings (ending ${s.keyHint}). `,
    GEMINI_API_KEY: `Using GEMINI_API_KEY from Windows (ending ${s.keyHint}).`,
    GOOGLE_API_KEY: `Using GOOGLE_API_KEY from Windows (ending ${s.keyHint}).`,
  };
  setKids($('#keyState'),
    s.keySource
      ? h('span', {}, sourceText[s.keySource],
          s.keySource === 'settings'
            ? h('button', { class: 'link-btn', onclick: () => saveSettings({ clearKey: true }, 'Saved key removed.') }, 'Remove it')
            : null)
      : h('span', { class: 'status error' }, 'No key found. Add one below.'),
  );
  renderModelSelect();
  $('#rootInput').value = s.rootFolder || '';
}

async function loadModels() {
  try {
    models = (await api('/api/models')).models;
  } catch {
    models = [];
  }
  if (settings) renderModelSelect();
}

async function loadSettings() {
  try {
    settings = await api('/api/settings');
    renderSettings();
    renderBanner();
    renderSavePreview();
    setAiBadge(settings.keySource ? aiBadgeState : 'off');
    if (!models && settings.keySource && !$('#view-settings').hidden) loadModels();
  } catch (err) {
    showError(err);
  }
}

// ---------- sidebar AI status ----------
let aiBadgeState = 'idle';
/** 'ok' after a successful call, 'off' with no key or a failed call, 'idle' otherwise. */
function setAiBadge(stateName) {
  aiBadgeState = stateName;
  const badge = $('#aiBadge');
  badge.classList.toggle('ok', stateName === 'ok');
  badge.classList.toggle('off', stateName === 'off');
  const model = settings?.model || '';
  $('#aiModel').textContent = stateName === 'off' && !settings?.keySource ? 'No API key' : model;
  badge.title = stateName === 'ok' ? `Connected to ${model}` : stateName === 'off' ? 'Not connected' : `Gemini · ${model}`;
}

// ---------- welcome (first run) ----------
const WELCOME_SKIP_KEY = 'selvedge-welcome-skipped';
function maybeShowWelcome() {
  let skipped = false;
  try {
    skipped = sessionStorage.getItem(WELCOME_SKIP_KEY) === '1';
  } catch {}
  $('#welcome').hidden = Boolean(settings?.keySource) || skipped;
  if (!$('#welcome').hidden) setTimeout(() => $('#welcomeKey').focus(), 50);
}

$('#welcomeSave').addEventListener('click', async () => {
  const key = $('#welcomeKey').value.trim();
  const status = $('#welcomeStatus');
  if (!key) {
    setStatus(status, 'Paste your key first.', 'error');
    $('#welcomeKey').focus();
    return;
  }
  const btn = $('#welcomeSave');
  setLoading(btn, true);
  setKids(status, h('span', { class: 'spinner' }), 'Saving and checking your key…');
  status.className = 'status small';
  try {
    settings = await api('/api/settings', { method: 'POST', body: { geminiKey: key } });
    renderSettings();
    const r = await api('/api/test-ai', { method: 'POST' });
    if (!r.ok) throw new Error('Gemini answered, but not as expected. Try again.');
    $('#welcomeKey').value = '';
    $('#welcome').hidden = true;
    setAiBadge('ok');
    renderBanner();
    models = null;
    toast(`Connected to ${r.model}. You're ready to go.`);
  } catch (err) {
    if (err.code === 'auth') {
      // Don't keep a key Google rejected.
      try {
        settings = await api('/api/settings', { method: 'POST', body: { clearKey: true } });
        renderSettings();
      } catch {}
      setStatus(status, "Google didn't accept that key. Check you copied all of it, then try again.", 'error');
    } else {
      setStatus(status, err.message, 'error');
    }
    setAiBadge('off');
  } finally {
    setLoading(btn, false);
  }
});
$('#welcomeKey').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#welcomeSave').click();
});
$('#welcomeSkip').addEventListener('click', () => {
  try {
    sessionStorage.setItem(WELCOME_SKIP_KEY, '1');
  } catch {}
  $('#welcome').hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#welcome').hidden) $('#welcomeSkip').click();
});

async function saveSettings(patch, message) {
  try {
    settings = await api('/api/settings', { method: 'POST', body: patch });
    renderSettings();
    renderBanner();
    renderSavePreview();
    if (message) toast(message);
    return true;
  } catch (err) {
    showError(err);
    return false;
  }
}

async function testConnection() {
  const el = $('#aiStatus');
  el.className = '';
  setKids(el, h('span', { class: 'status' }, h('span', { class: 'spinner' }), 'Testing…'));
  setBusy(true);
  setLoading($('#testBtn'), true);
  try {
    const r = await api('/api/test-ai', { method: 'POST' });
    el.className = r.ok ? 'status ok' : 'status error';
    el.textContent = r.ok ? `Connected to ${r.model} (answered in ${r.seconds}s). You're ready to go.` : 'Gemini answered, but not as expected. Try again.';
    setAiBadge(r.ok ? 'ok' : 'off');
  } catch (err) {
    el.className = 'status error';
    el.textContent = err.message;
    setAiBadge('off');
  } finally {
    setBusy(false);
    setLoading($('#testBtn'), false);
    renderBanner();
  }
}
$('#testBtn').addEventListener('click', testConnection);

$('#saveKeyBtn').addEventListener('click', async () => {
  const key = $('#keyInput').value.trim();
  if (!key) {
    toast('Paste the key first.', { error: true });
    return;
  }
  if (await saveSettings({ geminiKey: key }, 'Key saved. Testing the connection…')) {
    $('#keyInput').value = '';
    models = null;
    loadModels();
    testConnection();
  }
});

$('#modelSelect').addEventListener('change', (e) => saveSettings({ model: e.target.value }, `Model set to ${e.target.value}.`));
$('#saveRootBtn').addEventListener('click', () => saveSettings({ rootFolder: $('#rootInput').value.trim() }, 'Save folder updated.'));
$('#browseBtn').addEventListener('click', async () => {
  try {
    const r = await api('/api/choose-folder', { method: 'POST' });
    if (r.path) {
      $('#rootInput').value = r.path;
      await saveSettings({ rootFolder: r.path }, 'Save folder updated.');
    }
  } catch (err) {
    showError(err);
  }
});

function renderBanner() {
  const b = $('#connBanner');
  if (settings && !settings.keySource) {
    b.hidden = false;
    setKids(b, h('span', {}, h('strong', {}, 'Gemini isn’t connected yet. '), 'Add your free API key to analyse and tailor résumés.'),
      h('button', { class: 'btn small', onclick: () => { $('#welcome').hidden = false; $('#welcomeKey').focus(); } }, 'Connect Gemini'));
  } else {
    b.hidden = true;
  }
}

// ---------- quit & heartbeat ----------
$('#quitBtn').addEventListener('click', async () => {
  if (!confirm('Quit Selvedge?')) return;
  try {
    await api('/api/quit', { method: 'POST' });
  } catch {}
  // In the desktop app the window closes; in a browser tab, say so.
  setKids(document.body,
    h('div', { class: 'overlay' },
      h('div', { class: 'overlay-card empty' }, illustration(), h('p', { class: 'empty-line' }, 'Selvedge has stopped.'), h('p', { class: 'muted small' }, 'You can close this tab.'))),
  );
});

function beat() {
  fetch('/api/heartbeat', { method: 'POST' }).catch(() => {});
}
beat();
setInterval(beat, 30000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) beat();
});

// ---------- cover letter ----------
const COVER_KEY = 'selvedge-cover-v1';
const MAX_FACTS = 2;

function freshCover() {
  return {
    source: 'saved', // 'saved' | 'new'
    appId: null,
    appInfo: null, // {dir, company, jobTitle, date, hasResume, coverLetter}
    newJob: { company: '', jobTitle: '', jd: '' },
    newResume: { from: '', text: '', label: '' }, // from: 'tailor' | 'latest' | 'upload'
    company: '',
    jobTitle: '',
    jd: '',
    resumeText: '',
    header: null, // {name, contact[]}
    prep: null, // {questions, jdSkills, formatAdvice}
    answers: [], // [{question, answer}]
    companyNote: '',
    website: '',
    hiringManager: '',
    tone: 'warm',
    format: null,
    formatChosen: false,
    research: null,
    researchState: 'idle', // idle | loading | done | error | skipped
    researchError: '',
    selected: [],
    letter: '',
    draft: '',
    human: null,
    humanStart: null,
    passes: [],
    scrubChanges: [],
    flags: null,
    pdfInfo: null,
    model: null,
    savedDir: null,
    savedText: '',
    saveCompany: '',
    saveRole: '',
  };
}

function loadCover() {
  try {
    const s = JSON.parse(localStorage.getItem(COVER_KEY));
    if (!s || typeof s !== 'object') return null;
    const c = { ...freshCover(), ...s };
    if (c.researchState === 'loading') c.researchState = c.research ? 'done' : 'idle';
    return c;
  } catch {
    return null;
  }
}

let cover = loadCover() ?? freshCover();
let coverApps = null;
let researchCtl = null;
let researchPromise = null;

let coverTimer;
function persistCover() {
  clearTimeout(coverTimer);
  coverTimer = setTimeout(() => {
    try {
      localStorage.setItem(COVER_KEY, JSON.stringify(cover));
    } catch {}
  }, 300);
}

const coverUnsaved = () => Boolean(cover.letter.trim()) && cover.letter !== cover.savedText;

/** Forget everything after step 01 (a different job was chosen). */
function resetCoverWork() {
  researchCtl?.abort();
  researchCtl = null;
  Object.assign(cover, {
    prep: null, answers: [], research: null, researchState: 'idle', researchError: '', selected: [], website: '', companyNote: '',
    hiringManager: '', letter: '', draft: '', human: null, humanStart: null, passes: [], scrubChanges: [], flags: null, pdfInfo: null,
    savedDir: null, savedText: '', saveCompany: '', saveRole: '', formatChosen: false, format: null,
  });
}

function canPrepare() {
  return Boolean(cover.jd.trim() && cover.resumeText.trim());
}

function updateCoverButtons() {
  const prep = $('#coverPrepBtn');
  if (!prep) return;
  prep.disabled = busy || !canPrepare();
  setButtonLabel(prep, cover.prep ? 'Refresh the questions' : 'Next: a few questions');
  const write = $('#coverWriteBtn');
  write.disabled = busy || !cover.prep;
  setButtonLabel(write, cover.letter ? 'Write it again' : 'Write my cover letter');
  $('#coverHumanizeBtn').disabled = busy || !cover.letter.trim();
}

// ----- step 01: the role -----

function setChoice(group, attr, value) {
  for (const b of $$(`#${group} .choice-opt`)) b.setAttribute('aria-checked', String(b.dataset[attr] === value));
}

function fmtDay(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function renderCoverSource() {
  setChoice('coverSourceChoice', 'source', cover.source);
  const savedOpt = $('#coverSourceChoice [data-source="saved"]');
  const none = coverApps && !coverApps.length;
  savedOpt.disabled = Boolean(none);
  $('span', savedOpt).textContent = none ? 'Nothing saved yet' : 'Uses its job description and tailored résumé';
  $('#coverSavedPane').hidden = cover.source !== 'saved';
  $('#coverNewPane').hidden = cover.source !== 'new';

  // saved applications
  const sel = $('#coverApp');
  if (coverApps) {
    setKids(sel, coverApps.map((a) =>
      h('option', { value: a.id, selected: a.id === cover.appId }, `${a.company} · ${a.jobTitle}${a.date ? ` · ${fmtDay(a.date)}` : ''}`)));
  }
  const info = cover.appInfo;
  const box = $('#coverAppInfo');
  if (cover.source === 'saved' && info) {
    const words = cover.jd.split(/\s+/).filter(Boolean).length;
    setKids(box,
      h('div', { class: 'chips' },
        h('span', { class: 'chip' }, `Job description · ${words} words`),
        h('span', { class: `chip ${cover.resumeText ? 'good' : 'bad'}` }, cover.resumeText ? (info.hasResume ? 'Tailored résumé' : 'Résumé from the letter') : 'No résumé text'),
        cover.header?.name ? h('span', { class: 'chip' }, cover.header.name) : null),
      info.coverLetter
        ? h('div', { class: 'existing' },
            h('span', {}, `This application already has a cover letter${info.coverLetter.savedAt ? `, saved ${fmtDay(info.coverLetter.savedAt.slice(0, 10))}` : ''}.`),
            h('button', { class: 'btn small', onclick: openSavedLetter }, 'Open it'))
        : null);
  } else {
    setKids(box);
  }

  // new job description
  const nj = cover.newJob;
  for (const [sel2, key] of [['#coverCompany', 'company'], ['#coverRole', 'jobTitle'], ['#coverJd', 'jd']]) {
    if ($(sel2).value !== nj[key]) $(sel2).value = nj[key];
  }
  renderResumeSelect();
  updateCoverButtons();
}

function latestResumeApp() {
  return (coverApps || []).find((a) => a.hasResume);
}

function renderResumeSelect() {
  const opts = [];
  if (state.resumeText.trim()) opts.push(['tailor', `Résumé in New application${state.upload?.fileName ? ` (${state.upload.fileName})` : ''}`]);
  const latest = latestResumeApp();
  if (latest) opts.push(['latest', `Tailored résumé: ${latest.jobTitle} at ${latest.company}`]);
  if (cover.newResume.from === 'upload') opts.push(['upload', `Uploaded: ${cover.newResume.label}`]);
  opts.push(['pick', 'Upload a résumé (PDF or Word)…']);
  const current = cover.newResume.from || (opts.length > 1 ? '' : 'pick');
  setKids($('#coverResumeSel'),
    current ? null : h('option', { value: '', selected: true, disabled: true }, 'Choose a résumé'),
    opts.map(([v, label]) => h('option', { value: v, selected: v === current }, label)));
  const words = cover.newResume.text.split(/\s+/).filter(Boolean).length;
  $('#coverResumeNote').textContent = cover.newResume.text ? `${words} words of résumé text.` : '';
}

async function useResume(from) {
  const r = cover.newResume;
  if (from === 'tailor') {
    Object.assign(r, { from, text: state.resumeText, label: state.upload?.fileName || 'New application' });
  } else if (from === 'latest') {
    const a = latestResumeApp();
    if (!a) return;
    try {
      const d = await api(`/api/applications/${encodeURIComponent(a.id)}`);
      Object.assign(r, { from, text: d.resumeText, label: `${a.jobTitle} at ${a.company}` });
      if (d.resume) cover.header = { name: d.resume.name, contact: d.resume.contact || [] };
    } catch (err) {
      showError(err);
    }
  } else if (from === 'pick') {
    $('#coverFile').click();
    renderResumeSelect();
    return;
  }
  if (cover.source === 'new') {
    cover.resumeText = r.text;
    if (from !== 'latest') cover.header = null;
  }
  persistCover();
  renderCoverSource();
}

$('#coverResumeSel').addEventListener('change', (e) => useResume(e.target.value));
$('#coverFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!/\.(pdf|docx)$/i.test(file.name)) {
    toast('Please choose a PDF or Word (.docx) file.', { error: true });
    return;
  }
  $('#coverResumeNote').textContent = `Reading ${file.name}…`;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await api('/api/parse', { method: 'POST', body: fd });
    Object.assign(cover.newResume, { from: 'upload', text: r.text, label: r.fileName });
    cover.resumeText = r.text;
    cover.header = null;
    persistCover();
  } catch (err) {
    showError(err);
  }
  renderCoverSource();
});

function defaultNewResume() {
  if (cover.newResume.from) return;
  if (state.resumeText.trim()) return useResume('tailor');
  if (latestResumeApp()) return useResume('latest');
}

async function selectCoverApp(id) {
  if (!id) return;
  try {
    const r = await api(`/api/applications/${encodeURIComponent(id)}`);
    if (id !== cover.appId || cover.source !== 'saved') resetCoverWork();
    cover.source = 'saved';
    cover.appId = id;
    cover.appInfo = {
      dir: r.dir,
      company: r.app.company || '',
      jobTitle: r.app.jobTitle || '',
      date: r.app.date || '',
      hasResume: Boolean(r.resume),
      coverLetter: r.coverLetter ? { text: r.coverLetter.text, savedAt: r.coverLetter.savedAt, record: r.coverLetter.record } : null,
    };
    cover.company = r.app.company || '';
    cover.jobTitle = r.app.jobTitle || '';
    cover.jd = r.jd || '';
    cover.resumeText = r.resumeText || '';
    cover.header = r.resume ? { name: r.resume.name, contact: r.resume.contact || [] } : r.coverLetter?.record?.header || null;
    cover.savedDir = r.dir;
    persistCover();
  } catch (err) {
    showError(err);
  }
  renderCover();
}

function switchSource(source) {
  if (source === cover.source) return;
  if (coverUnsaved() && !confirm('Your cover letter isn’t saved. Switch anyway?')) {
    renderCoverSource();
    return;
  }
  resetCoverWork();
  cover.source = source;
  if (source === 'new') {
    cover.appId = null;
    cover.appInfo = null;
    Object.assign(cover, { company: cover.newJob.company, jobTitle: cover.newJob.jobTitle, jd: cover.newJob.jd, resumeText: cover.newResume.text, header: null });
    defaultNewResume();
  } else {
    const first = coverApps?.[0]?.id;
    if (first) selectCoverApp(first);
  }
  persistCover();
  renderCover();
}

$$('#coverSourceChoice .choice-opt').forEach((b) => b.addEventListener('click', () => switchSource(b.dataset.source)));
$('#coverApp').addEventListener('change', (e) => {
  if (coverUnsaved() && !confirm('Your cover letter isn’t saved. Switch application anyway?')) {
    e.target.value = cover.appId;
    return;
  }
  selectCoverApp(e.target.value);
});

for (const [sel, key] of [['#coverCompany', 'company'], ['#coverRole', 'jobTitle'], ['#coverJd', 'jd']]) {
  $(sel).addEventListener('input', (e) => {
    cover.newJob[key] = e.target.value;
    cover[key] = e.target.value;
    persistCover();
    updateCoverButtons();
    if (cover.prep && key === 'jd') setStatus('#coverPrepStatus', 'The job description changed. Refresh the questions to match it.');
  });
}

async function openCoverFor(appId) {
  if (cover.appId !== appId && coverUnsaved() && !confirm('Your cover letter isn’t saved. Open a different application anyway?')) return;
  cover.source = 'saved';
  showView('cover');
  await selectCoverApp(appId);
  window.scrollTo({ top: 0 });
}

async function loadCoverView() {
  renderCover();
  try {
    coverApps = (await api('/api/applications')).applications;
  } catch {
    coverApps = [];
  }
  if (cover.source === 'saved') {
    if (!coverApps.length) {
      cover.source = 'new';
      Object.assign(cover, { company: cover.newJob.company, jobTitle: cover.newJob.jobTitle, jd: cover.newJob.jd, resumeText: cover.newResume.text });
    } else if (!cover.appId || !coverApps.some((a) => a.id === cover.appId)) {
      await selectCoverApp(coverApps[0].id);
    }
  }
  if (cover.source === 'new') await defaultNewResume();
  renderCover();
}

// ----- step 02: questions, research and options -----

const kindLabel = { story: 'Your story', motivation: 'Why them', analogy: 'Analogy or interest', context: 'Context' };

function renderQuestions() {
  const qs = cover.prep?.questions || cover.answers.map((a) => ({ question: a.question }));
  setKids($('#coverQuestions'),
    h('div', { class: 'card-head' },
      h('h3', {}, 'A few questions'),
      h('p', { class: 'muted small' }, 'Specific beats impressive. Skip any that don’t fit you.')),
    qs.map((q, i) =>
      h('div', { class: 'question' },
        h('div', { class: 'q-head' }, h('span', { class: 'q-num', 'aria-hidden': 'true' }, String(i + 1).padStart(2, '0')), h('span', { class: 'badge neutral' }, kindLabel[q.kind] || 'Question')),
        h('label', { class: 'q-text', for: `coverQ${i}` }, q.question),
        q.why ? h('p', { class: 'q-why' }, q.why) : null,
        h('textarea', {
          id: `coverQ${i}`,
          rows: 3,
          placeholder: q.placeholder || '',
          value: cover.answers[i]?.answer || '',
          oninput: (e) => {
            cover.answers[i] = { question: q.question, answer: e.target.value };
            persistCover();
          },
        }))),
  );
}

function selectedFacts() {
  const facts = cover.research?.facts || [];
  return cover.selected.map((i) => facts[i]).filter(Boolean);
}

function researchSkeleton() {
  return h('div', { class: 'r-skeleton', 'aria-hidden': 'true' }, [1, 2, 3].map(() => h('div', { class: 'sk-fact' }, h('div', { class: 'sk w90' }), h('div', { class: 'sk w70' }), h('div', { class: 'sk w40' }))));
}

function sourceLinks(sources = []) {
  const seen = new Set();
  return sources
    .filter((s) => s.url && !seen.has(s.domain || s.url) && seen.add(s.domain || s.url))
    .slice(0, 3)
    .map((s) => h('a', { class: 'src', href: s.url, target: '_blank', rel: 'noopener', title: s.title || s.url }, s.kind === 'news' && s.title ? s.title : s.domain || s.title || 'source'));
}

function renderResearch() {
  const box = $('#coverResearch');
  const name = cover.company || 'the company';
  const head = h('div', { class: 'card-head' }, h('h3', {}, 'What we found about ', h('span', { class: 'accent' }, name)));
  const st = cover.researchState;
  if (!cover.company.trim()) {
    setKids(box, head, h('p', { class: 'muted small' }, 'Add the company name in step 01 and Selvedge will look them up.'));
  } else if (st === 'loading') {
    setKids(box, head,
      h('div', { class: 'status small' }, h('span', { class: 'spinner' }), `Reading about ${name}…`,
        h('button', { class: 'link-btn', onclick: skipResearch }, 'Skip')),
      researchSkeleton());
  } else if (st === 'error') {
    setKids(box, head, h('p', { class: 'status error small' }, cover.researchError || 'The research failed.'),
      h('button', { class: 'btn small', onclick: startResearch }, 'Try again'));
  } else if (st === 'skipped' || st === 'idle') {
    setKids(box, head, h('p', { class: 'muted small' }, st === 'skipped' ? 'Research skipped. The letter will focus on the role and your work.' : 'Not researched yet.'),
      h('button', { class: 'btn small', onclick: startResearch }, `Research ${name}`));
  } else {
    const r = cover.research;
    const facts = r.facts || [];
    const how = r.method === 'google'
      ? 'Searched with Google through Gemini.'
      : r.method === 'web'
        ? `Read ${(r.read || []).map((x) => (x.kind === 'news' ? `${x.count} news headline${x.count > 1 ? 's' : ''}` : x.kind === 'website' ? `${x.count} page${x.count > 1 ? 's' : ''} of their website` : 'Wikipedia')).join(', ')}.`
        : '';
    setKids(box, head,
      r.summary ? h('p', { class: 'r-summary' }, r.summary) : null,
      facts.length
        ? [
            h('p', { class: 'muted small' }, `Pick up to ${MAX_FACTS} to mention. Check them first: they come from the web.`),
            h('div', { class: 'fact-list' }, facts.map((f, i) => {
              const on = cover.selected.includes(i);
              return h('label', { class: `fact-option${on ? ' on' : ''}` },
                h('input', {
                  type: 'checkbox',
                  checked: on,
                  onchange: (e) => {
                    let sel = cover.selected.filter((x) => x !== i);
                    if (e.target.checked) sel = [...sel, i].slice(-MAX_FACTS);
                    cover.selected = sel;
                    persistCover();
                    renderResearch();
                  },
                }),
                h('span', { class: 'item-body' },
                  h('span', { class: 'fact-text' }, f.fact),
                  f.relevance ? h('span', { class: 'fact-why' }, f.relevance) : null,
                  f.angle ? h('span', { class: 'fact-angle' }, h('strong', {}, 'Angle: '), f.angle) : null,
                  h('span', { class: 'fact-meta' },
                    f.date ? h('span', { class: 'badge neutral' }, f.date) : null,
                    f.verified === false ? h('span', { class: 'badge warn' }, 'No source found') : null,
                    sourceLinks(f.sources))));
            })),
          ]
        : r.method === 'none' ? null : h('p', { class: 'muted small' }, 'Nothing specific enough turned up. Add their website below and search again, or tell Selvedge what you know.'),
      r.note ? h('p', { class: 'r-note' }, r.note) : null,
      how ? h('p', { class: 'r-how' }, how) : null,
      r.method === 'google' && r.searchHtml
        ? h('iframe', { class: 'search-chips', title: 'Google Search suggestions', sandbox: 'allow-popups allow-popups-to-escape-sandbox', srcdoc: `<base target="_blank">${r.searchHtml}` })
        : null,
    );
  }
  if ($('#coverWebsite').value !== cover.website) $('#coverWebsite').value = cover.website;
  if ($('#coverNote').value !== cover.companyNote) $('#coverNote').value = cover.companyNote;
}

function skipResearch() {
  researchCtl?.abort();
  researchCtl = null;
  cover.researchState = 'skipped';
  persistCover();
  renderResearch();
}

function startResearch() {
  if (!cover.company.trim()) return renderResearch();
  researchCtl?.abort();
  const ctl = new AbortController();
  researchCtl = ctl;
  cover.researchState = 'loading';
  cover.research = null;
  cover.selected = [];
  renderResearch();
  researchPromise = (async () => {
    try {
      const r = await api('/api/cover/research', {
        method: 'POST',
        signal: ctl.signal,
        body: { company: cover.company, jobTitle: cover.jobTitle, jd: cover.jd, website: cover.website },
      });
      if (ctl !== researchCtl) return;
      cover.research = r;
      cover.researchState = 'done';
      cover.selected = r.facts?.length ? [0] : [];
      if (r.website && !cover.website) cover.website = r.website.replace(/^https?:\/\/(www\.)?/, '');
    } catch (err) {
      if (err.name === 'AbortError' || ctl !== researchCtl) return;
      cover.researchState = 'error';
      cover.researchError = err.message;
    } finally {
      if (ctl === researchCtl) {
        researchCtl = null;
        persistCover();
        renderResearch();
      }
    }
  })();
  return researchPromise;
}

$('#coverResearchBtn').addEventListener('click', startResearch);
$('#coverWebsite').addEventListener('input', (e) => {
  cover.website = e.target.value.trim();
  persistCover();
});
$('#coverWebsite').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startResearch();
});
$('#coverNote').addEventListener('input', (e) => {
  cover.companyNote = e.target.value;
  persistCover();
});

function renderOptions() {
  if ($('#coverManager').value !== cover.hiringManager) $('#coverManager').value = cover.hiringManager;
  setChoice('coverTone', 'value', cover.tone);
  const advice = cover.prep?.formatAdvice;
  const format = cover.format || advice?.recommended || 'paragraphs';
  setChoice('coverFormat', 'value', format);
  for (const b of $$('#coverFormat .choice-opt')) {
    $('.rec', b)?.remove();
    if (advice?.recommended === b.dataset.value) $('strong', b).append(h('span', { class: 'rec' }, 'Recommended'));
  }
  setKids($('#coverFormatAdvice'), advice?.reason ? [h('strong', {}, 'Our take: '), advice.reason] : null);
}

$('#coverManager').addEventListener('input', (e) => {
  cover.hiringManager = e.target.value;
  persistCover();
});
$$('#coverTone .choice-opt').forEach((b) =>
  b.addEventListener('click', () => {
    cover.tone = b.dataset.value;
    persistCover();
    renderOptions();
  }),
);
$$('#coverFormat .choice-opt').forEach((b) =>
  b.addEventListener('click', () => {
    cover.format = b.dataset.value;
    cover.formatChosen = true;
    persistCover();
    renderOptions();
  }),
);

let prepInFlight = false;
async function coverPrepare() {
  if (cover.letter && coverUnsaved() && !confirm('Refreshing the questions keeps your letter, but your answers will be replaced. Continue?')) return;
  const knewCompany = Boolean(cover.company.trim());
  if (knewCompany && (cover.researchState === 'idle' || cover.researchState === 'error')) startResearch();
  // show step 02 right away, so the research can be read while the questions are written
  const firstTime = $('#coverPersonal').hidden;
  prepInFlight = true;
  if (firstTime) {
    $('#coverPersonal').hidden = false;
    setKids($('#coverQuestions'),
      h('div', { class: 'card-head' }, h('h3', {}, 'A few questions'), h('p', { class: 'muted small' }, 'Writing questions about your résumé and this role…')),
      researchSkeleton());
    renderResearch();
    renderOptions();
  }
  const out = await runWithStatus($('#coverPrepStatus'), 'Gemini is reading the role and your résumé…', (signal) =>
    api('/api/cover/prepare', {
      method: 'POST',
      signal,
      body: { resumeText: cover.resumeText, jd: cover.jd, company: cover.company, jobTitle: cover.jobTitle },
    }),
  $('#coverPrepBtn'));
  prepInFlight = false;
  if (!out) {
    if (firstTime && !cover.prep) {
      setKids($('#coverQuestions'),
        h('div', { class: 'card-head' }, h('h3', {}, 'A few questions'), h('p', { class: 'muted small' }, 'The questions couldn’t be written. Try “Next” again in a moment.')));
    }
    return;
  }
  const r = out.result;
  cover.prep = { questions: r.questions, jdSkills: r.jdSkills, formatAdvice: r.formatAdvice };
  cover.answers = r.questions.map((q) => ({ question: q.question, answer: '' }));
  if (!cover.company && r.company) {
    cover.company = r.company;
    if (cover.source === 'new') cover.newJob.company = r.company;
  }
  if (!cover.jobTitle && r.jobTitle) {
    cover.jobTitle = r.jobTitle;
    if (cover.source === 'new') cover.newJob.jobTitle = r.jobTitle;
  }
  if (!cover.header?.name && r.candidate?.name) cover.header = r.candidate;
  if (!cover.formatChosen) cover.format = r.formatAdvice?.recommended || 'paragraphs';
  cover.model = r.model;
  persistCover();
  setStatus('#coverPrepStatus', `Ready in ${out.seconds}s.`, 'ok');
  if (!knewCompany && cover.company) startResearch();
  renderCover();
  $('#coverPersonal').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => $('#coverQ0')?.focus({ preventScroll: true }), 500);
}
$('#coverPrepBtn').addEventListener('click', coverPrepare);

function coverBody(extra = {}) {
  return {
    resumeText: cover.resumeText,
    jd: cover.jd,
    company: cover.company,
    jobTitle: cover.jobTitle,
    header: cover.header || { name: '', contact: [] },
    answers: cover.answers.filter((a) => a?.answer?.trim()).map((a) => ({ question: a.question, answer: a.answer.trim() })),
    companyNote: cover.companyNote.trim(),
    facts: selectedFacts().map((f) => ({
      fact: f.fact,
      angle: f.angle || '',
      date: f.date || '',
      sources: (f.sources || []).map((s) => ({ title: s.title || s.domain || '', url: s.url || '' })),
    })),
    hiringManager: cover.hiringManager.trim(),
    tone: cover.tone,
    format: cover.format || 'paragraphs',
    jdSkills: cover.prep?.jdSkills || cover.appInfo?.coverLetter?.record?.jdSkills || [],
    ...extra,
  };
}

function applyLetterResult(r, { fresh }) {
  cover.letter = r.letter;
  if (fresh) {
    cover.draft = r.draft || '';
    cover.humanStart = r.humanStart || null;
    cover.passes = r.passes || [];
  } else {
    cover.passes = [...cover.passes, ...(r.passes || [])];
  }
  cover.scrubChanges = r.scrubChanges || [];
  cover.human = r.human;
  cover.flags = r.flags;
  cover.pdfInfo = r.pdf;
  cover.model = r.model || cover.model;
  persistCover();
}

async function coverWrite() {
  if (cover.letter && coverUnsaved() && !confirm('Write a new letter? Your edits to the current one will be replaced.')) return;
  if (cover.researchState === 'loading' && researchPromise) {
    setKids($('#coverWriteStatus'), h('span', { class: 'spinner' }), 'Finishing the company research first…');
    await researchPromise;
  }
  const out = await runWithStatus($('#coverWriteStatus'), 'Writing your letter, then humanising it…', (signal) =>
    api('/api/cover/write', { method: 'POST', signal, body: coverBody() }),
  $('#coverWriteBtn'));
  if (!out) return;
  applyLetterResult(out.result, { fresh: true });
  const skipped = (out.result.passes || []).some((p) => p.skipped);
  setStatus('#coverWriteStatus', skipped
    ? `Written in ${out.seconds}s, but Gemini was too busy to humanise it. Click Humanise again in a minute.`
    : `Written and humanised in ${out.seconds}s.`, skipped ? '' : 'ok');
  renderCover();
  $('#coverResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('#coverWriteBtn').addEventListener('click', coverWrite);

// ----- step 03: the letter -----

function humanTile() {
  const r = cover.human;
  if (!r) return null;
  const t = tone(r.score);
  const start = cover.humanStart;
  const d = start ? r.score - start.score : 0;
  return h('div', { class: 'metric human', role: 'group', 'aria-label': `Human read: ${r.score} out of 100, ${r.label}` },
    h('div', { class: 'metric-label' }, 'Human read', h('span', { class: `state ${toneState[t]}` }, r.label)),
    h('div', { class: 'metric-value' }, h('span', { class: 'num' }, r.score), h('span', { class: 'of' }, '/ 100')),
    h('div', { class: `meter ${toneState[t] === 'good' ? '' : toneState[t]}`, 'aria-hidden': 'true' }, h('span', { style: `width:${Math.max(2, r.score)}%` })),
    start
      ? h('div', { class: `metric-delta ${d > 0 ? 'up' : d < 0 ? 'down' : ''}` }, d === 0 ? `Same as the first draft (${start.score})` : `${d > 0 ? '▲' : '▼'} ${Math.abs(d)} from the first draft (${start.score})`)
      : null,
  );
}

function renderHumanChecks() {
  const r = cover.human;
  if (!r) return setKids($('#coverChecks'));
  setKids($('#coverChecks'),
    h('div', { class: 'meter-list checks-meters' },
      r.checks.flatMap((c) => {
        const t = toneState[tone(c.score)];
        return [
          h('span', { class: 'name', title: c.detail }, c.name),
          h('div', { class: `meter ${t === 'good' ? '' : t}`, role: 'img', 'aria-label': `${c.name}: ${c.score} of 100` }, h('span', { style: `width:${Math.max(3, c.score)}%` })),
          h('span', { class: 'fig' }, c.score),
        ];
      })),
    h('p', { class: 'muted small' }, r.checks.find((c) => c.id === r.weakest)?.detail || ''),
    r.slop.length
      ? h('div', { class: 'kw-group' }, h('h4', {}, 'Stock phrases left'), h('div', { class: 'chips' }, r.slop.map((s) => h('span', { class: 'chip warn', title: s.replace ? `Try “${s.replace}”` : 'Rephrase or cut' }, s.count > 1 ? `${s.term} ×${s.count}` : s.term))))
      : null,
    r.tells.length
      ? h('ul', { class: 'tell-list' }, r.tells.map((t) => h('li', {}, h('strong', {}, t.name), t.example ? h('span', { class: 'muted' }, ` “${t.example}”`) : null, h('span', { class: 'why' }, t.fix))))
      : null,
  );
}

function renderCoverEdits() {
  const items = [];
  cover.passes.forEach((p, i) => {
    if (p.accepted) for (const e of p.edits) items.push(h('li', {}, e));
    else if (p.skipped) items.push(h('li', { class: 'muted' }, `Editing pass ${i + 1} was skipped because Gemini was busy. Click Humanise again in a minute.`));
    else if (p.rejected) items.push(h('li', { class: 'muted' }, `Editing pass ${i + 1} was discarded: ${p.rejected}.`));
  });
  for (const c of cover.scrubChanges) items.push(h('li', {}, c));
  setKids($('#coverEdits'), items.length ? items : h('li', { class: 'muted' }, 'Nothing needed changing.'));
}

function renderCoverFlags() {
  const f = cover.flags || {};
  const box = $('#coverFlags');
  const skills = f.unconfirmed || [];
  const numbers = f.changedNumbers || [];
  const ph = f.placeholders || [];
  box.hidden = !skills.length && !numbers.length && !ph.length;
  $('#coverSaveBtn').disabled = ph.length > 0;
  if (box.hidden) return;
  setKids(box,
    h('strong', {}, 'Check these before you send it:'),
    skills.length ? h('div', { class: 'alert-item' }, `Skills your résumé and answers don’t mention: ${skills.join(', ')}. Keep them only if they’re true for you.`) : null,
    numbers.length
      ? h('div', { class: 'alert-item' }, 'Numbers that aren’t in your résumé, your answers or the company facts:',
          h('ul', {}, numbers.map((n) => h('li', {}, h('strong', {}, n.value), ` in “${n.context}”`))))
      : null,
    ph.length ? h('div', { class: 'alert-item' }, `Placeholders to fill in: ${ph.join(', ')}`) : null,
  );
}

function renderCoverSaveFields() {
  const root = settings?.rootFolder || '';
  const fields = $('#coverSaveFields');
  if (cover.source === 'saved' && cover.appInfo) {
    setKids(fields, h('p', { class: 'small' }, h('strong', {}, 'Saves into '), `${cover.appInfo.company} · ${cover.appInfo.jobTitle}`));
    $('#coverSavePreview').textContent = cover.appInfo.dir;
  } else {
    if (!cover.saveCompany) cover.saveCompany = cover.company;
    if (!cover.saveRole) cover.saveRole = cover.jobTitle;
    const input = (label, key) =>
      h('label', { class: 'field' }, h('span', {}, label),
        h('input', { type: 'text', autocomplete: 'off', value: cover[key], oninput: (e) => { cover[key] = e.target.value; persistCover(); renderCoverPreviewPath(); } }));
    setKids(fields, input('Company folder', 'saveCompany'), input('Role', 'saveRole'));
    renderCoverPreviewPath(root);
  }
}

function renderCoverPreviewPath(root = settings?.rootFolder || '') {
  if (cover.source === 'saved') return;
  const company = (cover.saveCompany || 'Unknown Company').trim();
  const role = (cover.saveRole || 'Role').trim();
  $('#coverSavePreview').textContent = !root ? 'Set a save folder in Settings.' : cover.savedDir ? `Updates ${cover.savedDir}` : `Saves to ${root}\\${company}\\${role} (date)`;
}

function renderCoverPageFit() {
  const el = $('#coverPageFit');
  const info = cover.pdfInfo;
  if (!info) return setKids(el);
  el.className = `small status ${info.fits ? 'ok' : 'error'}`;
  el.textContent = info.fits ? `The PDF fits on one page (${info.fontSize}pt text).` : `The PDF runs to ${info.pages} pages. Trim a paragraph to get it onto one.`;
}

function renderCoverResult() {
  const has = Boolean(cover.letter);
  $('#coverResult').hidden = !has;
  if (!has) return;
  if ($('#coverLetter').value !== cover.letter) $('#coverLetter').value = cover.letter;
  autosizeLetter();
  $('#coverDraftBox').hidden = !cover.draft;
  $('#coverDraft').textContent = cover.draft;
  setKids($('#coverHumanTile'), humanTile());
  renderHumanChecks();
  renderCoverEdits();
  renderCoverFlags();
  renderCoverPageFit();
  renderCoverSaveFields();
  const hd = cover.header || { name: '', contact: [] };
  if (document.activeElement !== $('#coverName')) $('#coverName').value = hd.name || '';
  if (document.activeElement !== $('#coverContact')) $('#coverContact').value = (hd.contact || []).join(' | ');
  $('#coverOpenBtn').hidden = !cover.savedDir || (cover.source === 'new' && !cover.savedText);
}

function autosizeLetter() {
  const ta = $('#coverLetter');
  ta.style.height = 'auto';
  ta.style.height = `${Math.max(420, ta.scrollHeight + 4)}px`;
}

let sizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(sizeTimer);
  sizeTimer = setTimeout(() => !$('#coverResult').hidden && autosizeLetter(), 120);
});

let checkTimer;
let checkCtl;
function scheduleCoverCheck() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(async () => {
    checkCtl?.abort();
    checkCtl = new AbortController();
    try {
      const r = await api('/api/cover/check', { method: 'POST', signal: checkCtl.signal, body: coverBody({ letter: cover.letter }) });
      cover.human = r.human;
      cover.flags = r.flags;
      cover.pdfInfo = r.pdf;
      persistCover();
      setKids($('#coverHumanTile'), humanTile());
      renderHumanChecks();
      renderCoverFlags();
      renderCoverPageFit();
    } catch (err) {
      if (err.name !== 'AbortError') console.warn(err);
    }
  }, 450);
}

$('#coverLetter').addEventListener('input', (e) => {
  cover.letter = e.target.value;
  persistCover();
  autosizeLetter();
  updateCoverButtons();
  scheduleCoverCheck();
});
$('#coverName').addEventListener('input', (e) => {
  cover.header = { ...(cover.header || { contact: [] }), name: e.target.value };
  persistCover();
  scheduleCoverCheck();
});
$('#coverContact').addEventListener('input', (e) => {
  cover.header = { ...(cover.header || { name: '' }), contact: e.target.value.split('|').map((s) => s.trim()).filter(Boolean) };
  persistCover();
  scheduleCoverCheck();
});

async function coverHumanizeAgain() {
  const out = await runWithStatus($('#coverSaveStatus'), 'Humanising…', (signal) =>
    api('/api/cover/humanize', { method: 'POST', signal, body: coverBody({ letter: cover.letter }) }),
  $('#coverHumanizeBtn'));
  if (!out) return;
  const before = cover.human?.score;
  applyLetterResult(out.result, { fresh: false });
  setStatus('#coverSaveStatus', before != null ? `Done: human read ${before} → ${cover.human.score}.` : 'Done.', 'ok');
  renderCover();
}
$('#coverHumanizeBtn').addEventListener('click', coverHumanizeAgain);

async function coverSave() {
  setStatus('#coverSaveStatus', 'Saving…');
  setLoading($('#coverSaveBtn'), true);
  try {
    const saved = cover.source === 'saved' && cover.appId;
    const r = await api('/api/cover/save', {
      method: 'POST',
      body: coverBody({
        letter: cover.letter,
        appId: saved ? cover.appId : undefined,
        previousDir: saved ? undefined : cover.savedText ? cover.savedDir : undefined,
        company: saved ? cover.company : (cover.saveCompany || cover.company).trim(),
        jobTitle: saved ? cover.jobTitle : (cover.saveRole || cover.jobTitle).trim(),
        research: cover.research,
        selectedFacts: cover.selected,
        model: cover.model,
      }),
    });
    cover.savedDir = r.dir;
    cover.savedText = cover.letter;
    if (cover.appInfo) cover.appInfo.coverLetter = { text: cover.letter, savedAt: new Date().toISOString(), record: null };
    persistCover();
    coverApps = null;
    setStatus('#coverSaveStatus', `Saved to ${r.dir}`, 'ok');
    $('#coverOpenBtn').hidden = false;
    renderCoverPreviewPath();
    toast('Cover letter saved.', { action: { label: 'Open folder', fn: () => openFolder(r.dir) } });
  } catch (err) {
    setStatus('#coverSaveStatus', err.message, 'error');
    showError(err);
  } finally {
    setLoading($('#coverSaveBtn'), false);
  }
}
$('#coverSaveBtn').addEventListener('click', coverSave);

$('#coverPdfBtn').addEventListener('click', async () => {
  try {
    const res = await api('/api/cover/pdf', { method: 'POST', raw: true, body: coverBody({ letter: cover.letter }) });
    const blob = await res.blob();
    const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'Cover_Letter.pdf';
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  } catch (err) {
    showError(err);
  }
});

$('#coverCopyBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(cover.letter);
  } catch {
    const ta = $('#coverLetter');
    ta.select();
    document.execCommand('copy');
    ta.setSelectionRange(0, 0);
  }
  toast('Letter copied. Paste it into the application form.');
});

$('#coverOpenBtn').addEventListener('click', () => cover.savedDir && openFolder(cover.savedDir));

function openSavedLetter() {
  const c = cover.appInfo?.coverLetter;
  if (!c) return;
  const rec = c.record || {};
  cover.letter = c.text || '';
  cover.savedText = cover.letter;
  cover.draft = '';
  cover.passes = [];
  cover.scrubChanges = [];
  cover.humanStart = null;
  if (rec.header) cover.header = rec.header;
  cover.hiringManager = rec.hiringManager || cover.hiringManager;
  cover.tone = rec.tone || cover.tone;
  cover.format = rec.format || cover.format;
  cover.companyNote = rec.companyNote || cover.companyNote;
  if (rec.answers?.length) cover.answers = rec.answers;
  if (rec.research) {
    cover.research = rec.research;
    cover.researchState = 'done';
    cover.selected = (rec.research.facts || []).map((f, i) => (rec.factsUsed || []).some((u) => u.fact === f.fact) ? i : -1).filter((i) => i >= 0);
  }
  persistCover();
  renderCover();
  scheduleCoverCheck();
  $('#coverResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#coverResetBtn').addEventListener('click', () => {
  if (coverUnsaved() && !confirm('Your cover letter isn’t saved. Start over anyway?')) return;
  const keep = { source: cover.source, appId: cover.appId, newResume: cover.newResume };
  cover = { ...freshCover(), ...keep };
  setStatus('#coverPrepStatus', '');
  setStatus('#coverWriteStatus', '');
  setStatus('#coverSaveStatus', '');
  persistCover();
  loadCoverView();
});

function renderCover() {
  renderCoverSource();
  const prepped = prepInFlight || Boolean(cover.prep) || Boolean(cover.letter && cover.answers.length);
  $('#coverPersonal').hidden = !prepped;
  if (prepped) {
    if (cover.prep || !prepInFlight) renderQuestions();
    renderResearch();
    renderOptions();
  }
  renderCoverResult();
  updateCoverButtons();
}

// ---------- boot ----------
function renderAll() {
  renderInputs();
  renderResults();
  renderTailored();
}

renderAll();
loadSettings().then(maybeShowWelcome);
