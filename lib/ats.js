// Deterministic ATS checks, keyword matching and scoring. Pure functions only.

export const IMPORTANCE_WEIGHT = { must: 3, important: 2, nice: 1 };

const ACTION_VERBS = new Set(
  `accelerated accomplished achieved acquired adapted addressed administered advanced advised advocated analyzed analysed
  applied appointed architected arranged assembled assessed assisted attained audited authored automated balanced cleaned
  boosted briefed budgeted built calculated campaigned captured catalogued centralized centralised chaired championed
  clarified coached collaborated collected combined communicated compiled completed composed computed conceived
  conceptualized condensed conducted configured consolidated constructed consulted contracted contributed controlled
  converted coordinated corrected created cultivated curated customized cut debugged decreased defined delegated
  delivered demonstrated deployed designed detected determined developed devised diagnosed directed discovered
  dispatched documented doubled drafted drove earned edited educated eliminated enabled encouraged engaged engineered
  enhanced established estimated evaluated examined exceeded executed expanded expedited experimented facilitated
  finalized forecasted formalized formulated fostered founded generated grew guided halved handled headed helped
  hired identified implemented improved increased influenced initiated innovated inspected installed instituted
  instructed integrated interpreted interviewed introduced invented investigated launched led leveraged liaised
  maintained managed mapped marketed maximized measured mentored merged migrated minimized modeled modelled modernized
  monitored motivated navigated negotiated onboarded operated optimized optimised orchestrated organized organised
  originated outperformed overhauled oversaw partnered performed persuaded pioneered planned prepared presented
  prioritized processed produced programmed projected promoted proposed prototyped provided published purchased
  qualified quantified raised ran rebuilt recommended reconciled recruited redesigned reduced refactored refined
  regulated rehabilitated reorganized repaired replaced reported represented researched resolved restored restructured
  retained revamped reviewed revised scaled scheduled scoped secured selected served shaped shipped simplified sold
  solved spearheaded specified sped standardized steered streamlined strengthened structured supervised supported
  surpassed surveyed sustained synthesized systematized targeted taught tested tracked trained transformed translated
  tripled troubleshot tuned uncovered unified upgraded validated verified visualized won wrote`
    .split(/\s+/)
    .filter(Boolean),
);

const SECTION_PATTERNS = {
  summary: /^(professional\s+)?(summary|profile|objective|about( me)?|career (summary|objective)|overview)\b/i,
  experience: /^((professional|work|relevant|employment)\s+)?(experience|history|employment)\b|^work history\b|^career history\b/i,
  education: /^(education|academic (background|qualifications)|qualifications)\b/i,
  skills: /^((technical|core|key|professional)\s+)?(skills|competencies|expertise|technologies|tech stack)\b/i,
  projects: /^(key\s+|selected\s+|personal\s+|academic\s+)?projects\b/i,
  certifications: /^(certifications?|licen[cs]es?( (and|&) certifications?)?|courses?)\b/i,
  other: /^(awards?|honou?rs|languages|interests|hobbies|publications|volunteer(ing)?|references|activities|extra-?curricular|additional( information)?|personal (details|information)|training|achievements)\b/i,
};

const STATEMENT_SECTIONS = new Set(['experience', 'projects', null]);

const BULLET_RE = /^\s*[•●▪◦‣∙·\-–—*►▶➢✓✔]\s+/;

// ---------- Text helpers ----------

export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regex for one keyword: case-insensitive, flexible spaces/hyphens, safe around C++, C#, .NET, Node.js. */
export function termRegex(term) {
  const t = String(term).trim();
  if (!t) return null;
  const parts = t.split(/[\s\-_/]+/).filter(Boolean).map(escapeRegex);
  let body = parts.join('[\\s\\-_/]*');
  // allow a simple plural on alphabetic endings (API -> APIs)
  if (/[A-Za-z]$/.test(t)) body += '(?:e?s)?';
  return new RegExp(`(?<![A-Za-z0-9+#])${body}(?![A-Za-z0-9+#])`, 'i');
}

export function matchKeywords(text, keywords = []) {
  const src = String(text || '');
  return keywords.map((k) => {
    const candidates = [k.term, ...(k.variants || [])].filter(Boolean);
    let matchedAs = null;
    for (const c of candidates) {
      const re = termRegex(c);
      if (re && re.test(src)) {
        matchedAs = c;
        break;
      }
    }
    return { ...k, matched: Boolean(matchedAs), matchedAs };
  });
}

export function keywordCoverage(matches) {
  let total = 0;
  let got = 0;
  const byImportance = { must: [0, 0], important: [0, 0], nice: [0, 0] };
  for (const m of matches) {
    const w = IMPORTANCE_WEIGHT[m.importance] ?? 1;
    total += w;
    if (m.matched) got += w;
    const bucket = byImportance[m.importance] ?? byImportance.nice;
    bucket[1] += 1;
    if (m.matched) bucket[0] += 1;
  }
  return {
    score: total ? Math.round((got / total) * 100) : 0,
    matched: matches.filter((m) => m.matched).length,
    total: matches.length,
    byImportance: Object.fromEntries(
      Object.entries(byImportance).map(([k, [hit, all]]) => [k, { matched: hit, total: all }]),
    ),
  };
}

function lines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Which section a heading line names, or null if the line is not a heading. */
function headingSection(line) {
  const clean = line.replace(/[:\s]+$/, '');
  if (clean.length > 40) return null;
  for (const [name, re] of Object.entries(SECTION_PATTERNS)) {
    if (re.test(clean)) return name;
  }
  return null;
}

export function detectSections(text) {
  const found = {};
  for (const line of lines(text)) {
    const s = headingSection(line);
    if (s && s !== 'other') found[s] = true;
  }
  return found;
}

/**
 * Achievement statements from the Experience and Projects sections (or the whole resume when no
 * headings are recognised): real bullets if there are enough, otherwise long sentence lines.
 */
export function statementLines(text) {
  const scoped = [];
  let section = null;
  for (const line of lines(text)) {
    const s = headingSection(line);
    if (s) {
      section = s;
      continue;
    }
    if (STATEMENT_SECTIONS.has(section)) scoped.push(line);
  }
  const bullets = scoped.filter((l) => BULLET_RE.test(l)).map((l) => l.replace(BULLET_RE, '').trim());
  if (bullets.length >= 3) return bullets;
  return scoped.filter((l) => l.split(/\s+/).length >= 6 && !/@/.test(l)).map((l) => l.replace(BULLET_RE, '').trim());
}

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december';

function stripDates(s) {
  return s
    .replace(new RegExp(`\\b(${MONTHS})\\.?\\s*'?\\d{2,4}\\b`, 'gi'), ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}[/-](19|20)?\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}\.(19|20)\d{2}\b/g, ' ');
}

export function hasMetric(line) {
  const s = stripDates(line);
  return /\d/.test(s) || /\b(doubled|tripled|halved)\b/i.test(s);
}

function startsWithActionVerb(line) {
  const first = line.replace(/^[^A-Za-z]+/, '').split(/[\s,;:]+/)[0]?.toLowerCase() || '';
  if (ACTION_VERBS.has(first)) return true;
  // present-tense forms: "build" -> built? keep simple: try adding "ed"/"d"
  return ACTION_VERBS.has(`${first}ed`) || ACTION_VERBS.has(`${first}d`);
}

function dateStyles(text) {
  const styles = new Set();
  const src = String(text || '');
  if (new RegExp(`\\b(jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\\.?\\s+(19|20)\\d{2}\\b`, 'i').test(src)) styles.add('Mon YYYY');
  if (/\b(january|february|march|april|june|july|august|september|october|november|december)\s+(19|20)\d{2}\b/i.test(src)) styles.add('Month YYYY');
  if (/\b(0?[1-9]|1[0-2])\/(19|20)\d{2}\b/.test(src)) styles.add('MM/YYYY');
  if (/\b(19|20)\d{2}-(0[1-9]|1[0-2])\b/.test(src)) styles.add('YYYY-MM');
  if (/\b(0?[1-9]|1[0-2])\/\d{2}\b/.test(src)) styles.add('MM/YY');
  return [...styles];
}

// ---------- Checks ----------

function check(id, label, status, detail, weight) {
  return { id, label, status, detail, weight };
}

export function formatChecks(text, meta = {}) {
  const src = String(text || '');
  const out = [];
  const words = src.split(/\s+/).filter(Boolean).length;

  const email = /[\w.+-]+@[\w-]+(\.[\w-]+)+/.test(src);
  out.push(check('email', 'Email address', email ? 'pass' : 'fail',
    email ? 'Found an email address.' : 'No email address found. Recruiters and ATS need it to contact you.', 2));

  const phone = /(\+?\d[\d\s().-]{7,}\d)/.test(src.replace(/\b(19|20)\d{2}\s*[-–]\s*((19|20)\d{2}|present)\b/gi, ''));
  out.push(check('phone', 'Phone number', phone ? 'pass' : 'warn',
    phone ? 'Found a phone number.' : 'No phone number found.', 1));

  const linkedin = /linkedin\.com\/(in|pub)\//i.test(src);
  out.push(check('linkedin', 'LinkedIn profile', linkedin ? 'pass' : 'warn',
    linkedin ? 'Found a LinkedIn URL.' : 'Add your LinkedIn URL; most recruiters check it.', 0.5));

  const sections = detectSections(src);
  const missing = ['experience', 'education', 'skills'].filter((s) => !sections[s]);
  out.push(check('sections', 'Standard section headings',
    missing.length === 0 ? 'pass' : missing.includes('experience') ? 'fail' : 'warn',
    missing.length === 0
      ? `Found: ${Object.keys(sections).join(', ')}.`
      : `Missing or non-standard: ${missing.join(', ')}. ATS look for headings like "Experience", "Education" and "Skills".`,
    2));

  let lengthStatus = 'pass';
  let lengthDetail = `${words} words.`;
  if (words < 250) {
    lengthStatus = 'warn';
    lengthDetail = `${words} words: quite thin. Add detail on your impact.`;
  } else if (words > 1100) {
    lengthStatus = 'warn';
    lengthDetail = `${words} words: long. Aim for 1 page (under 5 years' experience) or 2 pages at most.`;
  }
  if (meta.pages > 2) {
    lengthStatus = 'warn';
    lengthDetail += ` ${meta.pages} pages; keep it to 2 at most.`;
  }
  out.push(check('length', 'Length', lengthStatus, lengthDetail, 1));

  const statements = statementLines(src);
  if (statements.length) {
    const withMetric = statements.filter(hasMetric).length;
    const ratio = withMetric / statements.length;
    out.push(check('metrics', 'Quantified achievements', ratio >= 0.4 ? 'pass' : ratio >= 0.2 ? 'warn' : 'fail',
      `${withMetric} of ${statements.length} bullets include a number (${Math.round(ratio * 100)}%). Aim for 40% or more.`, 1.5));

    const verbs = statements.filter(startsWithActionVerb).length;
    const vr = verbs / statements.length;
    out.push(check('verbs', 'Bullets start with action verbs', vr >= 0.6 ? 'pass' : vr >= 0.3 ? 'warn' : 'fail',
      `${verbs} of ${statements.length} bullets start with an action verb (${Math.round(vr * 100)}%).`, 1));

    const pronouns = statements.filter((l) => /\b(I|me|my|myself)\b/.test(l)).length;
    out.push(check('pronouns', 'No first-person pronouns', pronouns === 0 ? 'pass' : 'warn',
      pronouns === 0 ? 'Bullets avoid "I", "me" and "my".' : `${pronouns} bullets use "I", "me" or "my". Drop them.`, 0.5));
  } else {
    out.push(check('metrics', 'Quantified achievements', 'fail', 'No bullet points found to check.', 1.5));
  }

  const styles = dateStyles(src);
  out.push(check('dates', 'Consistent date format', styles.length <= 1 ? 'pass' : 'warn',
    styles.length <= 1 ? 'Dates use one format.' : `Mixed date formats (${styles.join(', ')}). Pick one, e.g. "Jan 2022".`, 0.5));

  if (meta.multiColumn !== undefined) {
    out.push(check('columns', 'Single-column layout', meta.multiColumn ? 'warn' : 'pass',
      meta.multiColumn
        ? 'Looks like a multi-column layout. Some ATS read straight across columns and scramble your text.'
        : 'No side-by-side columns detected.', 1));
  }
  if (meta.hasTables !== undefined) {
    out.push(check('tables', 'No tables', meta.hasTables ? 'warn' : 'pass',
      meta.hasTables ? 'The document uses tables. Many ATS skip or garble table content.' : 'No tables found.', 1));
  }
  if (meta.oddChars !== undefined) {
    out.push(check('chars', 'Readable characters', meta.oddChars > 0 ? 'warn' : 'pass',
      meta.oddChars > 0
        ? `${meta.oddChars} icon, emoji or unreadable characters found. ATS may show them as garbage; use plain text.`
        : 'No icons or unreadable characters.', 1));
  }
  return out;
}

export function formatScore(checks) {
  const value = { pass: 1, warn: 0.5, fail: 0 };
  let total = 0;
  let got = 0;
  for (const c of checks) {
    total += c.weight;
    got += c.weight * (value[c.status] ?? 0);
  }
  return total ? Math.round((got / total) * 100) : 0;
}

export function requirementsScore(requirements = []) {
  const value = { met: 1, partial: 0.5, missing: 0 };
  let total = 0;
  let got = 0;
  for (const r of requirements) {
    const w = r.mustHave ? 2 : 1;
    total += w;
    got += w * (value[r.status] ?? 0);
  }
  return total ? Math.round((got / total) * 100) : null;
}

export function confidenceLabel(score) {
  if (score >= 75) return 'High';
  if (score >= 50) return 'Medium';
  return 'Low';
}

const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

/**
 * All scores for one version of a resume.
 * @param {object} p
 * @param {string} p.text resume text
 * @param {object} p.meta parse metadata
 * @param {Array} p.keywords from analysis
 * @param {Array} p.requirements from analysis (or recheck)
 * @param {number} p.fitScore from analysis (or recheck)
 */
export function computeScores({ text, meta = {}, keywords = [], requirements = [], fitScore = 0 }) {
  const matches = matchKeywords(text, keywords);
  const kw = keywordCoverage(matches);
  const checks = formatChecks(text, meta);
  const fmt = formatScore(checks);
  const ats = Math.round(0.5 * kw.score + 0.5 * fmt);

  const req = requirementsScore(requirements);
  const reqScore = req ?? kw.score;
  const fit = clamp(fitScore);
  let confidence = Math.round(0.35 * kw.score + 0.35 * reqScore + 0.3 * fit);
  const blockers = requirements.filter((r) => r.hard && r.mustHave && r.status === 'missing');
  const capped = blockers.length > 0 && confidence > 60;
  if (capped) confidence = 60;

  return {
    ats: { score: ats, keywordPart: kw.score, formatPart: fmt },
    keywords: { ...kw, matches },
    checks,
    confidence: {
      score: confidence,
      label: confidenceLabel(confidence),
      parts: { keywords: kw.score, requirements: reqScore, fit },
      capped,
      blockers: blockers.map((b) => b.text),
    },
  };
}

// ---------- Structured resume helpers ----------

export function resumeToText(r = {}) {
  const out = [];
  const push = (s) => {
    if (s && String(s).trim()) out.push(String(s).trim());
  };
  const range = (a, b) => [a, b].filter((x) => x && String(x).trim()).join(' – ');
  push(r.name);
  push(r.headline);
  if (r.contact?.length) push(r.contact.filter(Boolean).join(' | '));
  if (r.summary?.trim()) {
    out.push('', 'Summary');
    push(r.summary);
  }
  if (r.skills?.length) {
    out.push('', 'Skills');
    for (const g of r.skills) push(`${g.category ? `${g.category}: ` : ''}${(g.items || []).join(', ')}`);
  }
  if (r.experience?.length) {
    out.push('', 'Experience');
    for (const e of r.experience) {
      push([e.title, e.company, e.location].filter(Boolean).join(' | ') + (range(e.start, e.end) ? ` | ${range(e.start, e.end)}` : ''));
      for (const b of e.bullets || []) push(`• ${b}`);
    }
  }
  if (r.projects?.length) {
    out.push('', 'Projects');
    for (const p of r.projects) {
      push([p.name, p.context, p.link].filter(Boolean).join(' | '));
      for (const b of p.bullets || []) push(`• ${b}`);
    }
  }
  if (r.education?.length) {
    out.push('', 'Education');
    for (const e of r.education) {
      push([e.degree, e.institution, e.location].filter(Boolean).join(' | ') + (range(e.start, e.end) ? ` | ${range(e.start, e.end)}` : ''));
      for (const d of e.details || []) push(`• ${d}`);
    }
  }
  if (r.certifications?.length) {
    out.push('', 'Certifications');
    for (const c of r.certifications) push(`• ${c}`);
  }
  for (const x of r.extras || []) {
    if (!x.items?.length) continue;
    out.push('', x.heading || 'Additional');
    for (const i of x.items) push(`• ${i}`);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function findPlaceholders(text) {
  return [...new Set(String(text || '').match(/\[[^\]\n]{1,60}\]/g) || [])];
}

/** Numbers in a text as plain values ("~70%" -> "70", "1,200+" -> "1200"), leaving out years, URLs and phone numbers. */
function numberValues(text) {
  const src = String(text || '')
    .replace(/\b(?:https?:\/\/|www\.)\S+|\b[\w.-]+\.(?:com|dev|io|org|net|in|ai|app)\/\S*/gi, ' ')
    .replace(/\+?\d[\d\s().-]{8,}\d/g, ' ');
  const out = [];
  for (const m of src.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const value = m[0].replace(/,/g, '').replace(/\.0+$/, '');
    if (/^(19|20)\d{2}$/.test(value)) continue;
    out.push({ value, index: m.index });
  }
  return { src, out };
}

/**
 * Numbers that appear in the tailored resume but nowhere in the original, with the phrase around
 * each one. A changed metric ("~70%" became "~54%") shows up here. Placeholders like [X%] have no
 * digits, so they are not reported.
 */
export function changedNumbers(originalText, tailoredText) {
  const known = new Set(numberValues(originalText).out.map((n) => n.value));
  const { src, out } = numberValues(tailoredText);
  const seen = new Set();
  const result = [];
  for (const n of out) {
    if (known.has(n.value) || seen.has(n.value)) continue;
    seen.add(n.value);
    // the phrase around the number, kept within its own line
    const lineStart = src.lastIndexOf('\n', n.index) + 1;
    const lineEnd = src.indexOf('\n', n.index) === -1 ? src.length : src.indexOf('\n', n.index);
    const line = src.slice(lineStart, lineEnd);
    const at = n.index - lineStart;
    const from = at > 45 ? line.lastIndexOf(' ', at - 40) + 1 : 0;
    const toSpace = line.indexOf(' ', at + n.value.length + 30);
    const to = toSpace === -1 ? line.length : toSpace;
    const context = `${from > 0 ? '…' : ''}${line.slice(from, to).replace(/^[•\s]+/, '').trim()}${to < line.length ? '…' : ''}`;
    result.push({ value: n.value, context });
  }
  return result;
}

/**
 * Job keywords that the tailored resume claims but the original resume never mentioned and the
 * candidate did not confirm. These are skills the AI may have invented.
 */
export function unconfirmedAdditions(originalText, tailoredText, keywords = [], confirmed = []) {
  const ok = new Set(confirmed.map((c) => String(c).toLowerCase()));
  const before = matchKeywords(originalText, keywords);
  const after = matchKeywords(tailoredText, keywords);
  return after
    .filter((k, i) => k.matched && !before[i].matched && !ok.has(String(k.term).toLowerCase()))
    .filter((k) => !mentionsStem(originalText, k))
    .map((k) => k.term);
}

// Words that describe a skill rather than name it ("retail domain knowledge" is about "retail").
const FILLER_WORDS = new Set(
  `a an and or of in on with the for to knowledge experience skills skill domain understanding ability
  proficiency proficient familiarity strong working expertise concepts principles tools basics fundamentals
  background hands-on practical solid good excellent`.split(/\s+/),
);

/** Strip a common English ending so "testing" ~ "tests", "analysis" ~ "analyst", "forecasting" ~ "forecast". */
function stemWord(word) {
  const w = word.toLowerCase();
  const m = w.match(/^(.{4,}?)(ysis|yses|ytics|ysts|yst|ings|ing|ions|ion|ed|es|s)$/);
  return m ? m[1] : w;
}

/**
 * Looser check for the original resume: true when every meaningful word of the keyword (or of one
 * of its variants) appears there in some form. "Ran A/B tests" counts as "A/B testing".
 */
function mentionsStem(text, k) {
  return [k.term, ...(k.variants || [])].some((c) => {
    const words = String(c)
      .split(/[\s-]+/)
      .map((w) => w.replace(/^[^\w+#./]+|[^\w+#]+$/g, ''))
      .filter((w) => w && !FILLER_WORDS.has(w.toLowerCase()));
    if (!words.length) return false;
    return words.every((w) => {
      const stem = stemWord(w);
      const re = stem.length >= 4
        ? `(?<![A-Za-z0-9])${escapeRegex(stem)}[a-z]{0,5}(?![A-Za-z0-9])`
        : `(?<![A-Za-z0-9])${escapeRegex(stem)}(?:e?s)?(?![A-Za-z0-9+#])`;
      return new RegExp(re, 'i').test(text);
    });
  });
}

/** Meta for a resume rendered by our own PDF template (single column, no tables). */
export function generatedMeta(text) {
  const words = String(text || '').split(/\s+/).filter(Boolean).length;
  return { pages: Math.max(1, Math.ceil(words / 550)), multiColumn: false, hasTables: false, oddChars: 0 };
}
