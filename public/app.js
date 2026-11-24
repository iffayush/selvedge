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
  for (const id of ['#analyzeBtn', '#tailorBtn', '#recheckBtn', '#testBtn']) {
    const el = $(id);
    if (el) el.disabled = b || (id === '#analyzeBtn' && !canAnalyze());
  }
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
  for (const v of ['tailor', 'history', 'settings']) $(`#view-${v}`).hidden = v !== name;
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === name)));
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
    persist();
    $('#openSavedBtn').hidden = false;
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
          h('p', { class: 'muted small' }, 'Tailor a résumé and choose “Save application”; it will be filed here by company.')));
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
              ),
              h(
                'div',
                { class: 'btn-row' },
                h('button', { class: 'btn ghost small', onclick: () => openFolder(a.dir) }, 'Open folder'),
                h('button', { class: 'btn small', onclick: () => loadApp(a.id) }, 'Load'),
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

// ---------- boot ----------
function renderAll() {
  renderInputs();
  renderResults();
  renderTailored();
}

renderAll();
loadSettings().then(maybeShowWelcome);
