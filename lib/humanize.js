// Humaniser for cover letters: a five-check panel that scores how machine-written a letter reads,
// and a scrub that removes the mechanical tells (invisible characters, em dashes, curly quotes,
// stock words with a safe plain replacement).
//
// The checks are local heuristics modelled on the signals public AI-text detectors key on:
// sentence-length variation, concreteness, stock vocabulary, typography and voice. They are not
// GPTZero, Originality or Turnitin, don't call them, and can't promise their verdict.

const clamp = (n) => Math.max(0, Math.min(100, n));
/** Map value onto 0-100 where `human` -> 100 and `machine` -> 0. */
const scale = (value, human, machine) => (human === machine ? 50 : clamp(((value - machine) / (human - machine)) * 100));
const round1 = (n) => Math.round(n * 10) / 10;

// ---------- lexicon ----------
// [find, plain replacement, safe to swap automatically]. Entries without a safe swap are only flagged;
// the AI editing pass rewrites those sentences.
const WORDS = [
  ['delve into', 'look at', true], ['delve', 'look', true], ['deep dive', 'close look', false],
  ['leverage', 'use', true], ['leveraging', 'using', true], ['leveraged', 'used', true],
  ['utilize', 'use', true], ['utilizing', 'using', true], ['utilized', 'used', true],
  ['utilise', 'use', true], ['utilising', 'using', true], ['utilised', 'used', true],
  ['harness', 'use', false], ['embark on', 'start', true], ['foster', 'build', true], ['fostering', 'building', true],
  ['showcase', 'show', true], ['showcasing', 'showing', true], ['elevate', 'improve', true],
  ['spearhead', 'lead', true], ['spearheaded', 'led', true], ['spearheading', 'leading', true],
  ['underscore', 'show', true], ['underscores', 'shows', true], ['cultivate', 'build', true],
  ['amplify', 'boost', false], ['empower', 'help', false], ['revolutionize', 'change', false], ['revolutionise', 'change', false],
  ['transformative', 'big', false], ['robust', 'solid', true], ['seamless', 'smooth', true], ['seamlessly', 'smoothly', true],
  ['pivotal', 'key', true], ['crucial', 'important', true], ['vital', 'important', true],
  ['cutting-edge', 'modern', false], ['game-changer', 'big change', false], ['game-changing', 'major', false],
  ['groundbreaking', 'new', false], ['unparalleled', 'unmatched', false], ['invaluable', 'very useful', false],
  ['meticulous', 'careful', true], ['meticulously', 'carefully', true], ['myriad of', 'many', true], ['myriad', 'many', true],
  ['multifaceted', 'varied', false], ['holistic', 'whole', false], ['bespoke', 'custom', true], ['innovative', 'new', false],
  ['profound', 'deep', false], ['remarkable', 'notable', false], ['compelling', 'convincing', false],
  ['tapestry', 'mix', false], ['realm', 'area', false], ['landscape', 'field', false], ['journey', 'path', false],
  ['testament to', 'proof of', true], ['cornerstone', 'base', false], ['beacon', 'example', false], ['paradigm', 'model', false],
  ['synergy', 'overlap', false], ['plethora of', 'lots of', true], ['plethora', 'lots', true], ['arsenal', 'set', false],
  ['north star', 'goal', false], ['moreover', 'also', true], ['furthermore', 'also', true], ['additionally', 'also', true],
  ['nevertheless', 'still', true], ['consequently', 'so', true], ['thus', 'so', true], ['hence', 'so', true],
  ['notably', '', false], ['importantly', '', false], ['ultimately', 'in the end', false], ['in essence', 'basically', false],
  ['in conclusion', '', false], ['in order to', 'to', true], ['a wide range of', 'many', true],
  ['it is worth noting that', '', false], ['supercharge', 'speed up', false], ['unleash', 'release', false],
  ['effortlessly', 'easily', true], ['captivating', 'interesting', false],
  // cover-letter clichés
  ['honed', 'built up', false], ['adept at', 'good at', true], ['eager to', 'keen to', false], ['keen interest', 'interest', false],
  ['resonates with me', 'matters to me', false], ['resonate with', 'connect with', false], ['resonates', 'matters', false],
  ['ever-evolving', 'changing', false], ['ever-changing', 'changing', false], ['rapidly evolving', 'changing fast', false],
  ['fast-paced environment', '', false], ['fast-paced', 'busy', false], ['dynamic team', 'team', false], ['dynamic environment', '', false],
  ['passionate about', 'into', false], ['passion for', 'interest in', false], ['thrilled', 'glad', false],
  ['unique blend', 'mix', false], ['unique combination', 'mix', false], ['commitment to excellence', '', false],
  ['proven track record', 'record', false], ['track record of success', 'record', false], ['results-driven', '', false],
  ['detail-oriented', 'careful', false], ['self-starter', '', false], ['go-getter', '', false], ['team player', '', false],
  ['hit the ground running', 'start quickly', false], ['think outside the box', '', false], ['wear many hats', '', false],
  ['valuable asset', '', false], ['an asset to your team', '', false], ['bring to the table', 'bring', false],
  ['at the intersection of', 'where', false], ['in today\'s fast-paced world', '', false], ['deeply', '', false], ['truly', '', false],
];

const PHRASES = [
  'i am writing to express', 'i am writing to apply', 'i am excited to apply', "i'm excited to apply", 'i am thrilled to',
  'perfect fit', 'ideal candidate', 'perfect match', 'great fit for', 'align perfectly', 'aligns perfectly', 'aligns seamlessly',
  'aligns with my values', 'make a meaningful impact', 'meaningful impact', 'drive impact', "contribute to your team's success",
  'contribute to the success of', 'eager to contribute', 'excited about the opportunity', 'excited by the opportunity',
  'thank you for considering my application', 'thank you for your time and consideration', 'look forward to the opportunity to discuss',
  'i am confident that i', 'i am confident in my ability', 'strong work ethic', 'skills and experience make me',
  'would be a great addition', 'would make me a strong', 'i would welcome the opportunity',
].map((p) => [p, '', false]);

export const LEXICON = [...WORDS, ...PHRASES].map(([find, replace, auto]) => ({
  find,
  replace,
  auto,
  re: new RegExp(`(?<![\\w'-])${find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')}(?![\\w-])`, 'gi'),
}));

// ---------- structural tells ----------
export const STRUCTURES = [
  { id: 'not-just', re: /\bit'?s not (?:just|only) [^.!?\n]{2,60}[,.] it'?s\b/gi, name: '"It\'s not just X, it\'s Y"', fix: 'Say the one thing you mean and delete the setup half.' },
  { id: 'not-only', re: /\bnot only\b[^.!?\n]{2,80}\bbut also\b/gi, name: '"Not only X but also Y"', fix: 'Split it into two plain sentences, or drop the weaker half.' },
  { id: 'isnt-about', re: /\b(?:this|it) is(?:n'?t| not) about [^.!?\n]{2,60}[.!] it'?s about\b/gi, name: '"It isn\'t about X. It\'s about Y."', fix: 'Lead with Y. The reversal is the tell.' },
  // lower-case only, so a list of tools ("SQL, Python, and Tableau.") isn't flagged
  { id: 'triad', re: /\b[a-z]+, [a-z]+,? and [a-z]+\./g, name: 'Rule-of-three list', fix: 'Use two items or one strong one. Three is the default AI rhythm.' },
  { id: 'generic-opener', re: /^\s*(?:I am|I'm) writing to\b|^\s*My name is\b/gim, name: 'Template opening line', fix: 'Open with something specific: a moment, a result, or your real reason for this company.' },
  { id: 'template-greeting', re: /\bto whom it may concern\b|\bdear sir(?:\s*or\s*|\s*\/\s*)madam\b/gi, name: 'Template greeting', fix: 'Address the hiring manager or the team by name.' },
  { id: 'hedged-confidence', re: /\bI (?:am|'m) confident (?:that|in)\b|\bI believe (?:that )?I (?:would|will|am|could)\b/gi, name: '"I am confident that I..."', fix: 'Show it with an example instead of asserting it.' },
  { id: 'in-summary', re: /^\s*(?:in summary|to summari[sz]e|in conclusion|overall,)/gim, name: 'Essay-style conclusion', fix: "A letter doesn't need a summary paragraph. End on something specific." },
  { id: 'rhetorical', re: /(?:^|[.!]\s+)(?:What|Why|How|Who|Isn't|Doesn't|Wouldn't|Have you|Did you)\b[^.!?\n]{3,90}\?/g, name: 'Rhetorical question', fix: 'Make the point directly.' },
  { id: 'exclaim', re: /!/g, name: 'Exclamation mark', fix: 'Use a full stop. Enthusiasm reads better through specifics.', min: 1 },
  { id: 'as-an-ai', re: /\bas an ai\b|\bas a language model\b/gi, name: 'Model self-reference', fix: 'Delete the sentence.' },
];

// ---------- text helpers ----------
const SENT_RE = /[^.!?\n]+[.!?]*/g;
const WORD_RE = /[A-Za-z']+/g;
const CONTRACTIONS = /\b\w+'(?:s|t|re|ve|ll|d|m)\b/gi;
const PRONOUNS = /\b(i|me|my|mine|we|us|our|you|your)\b/gi;
const NUMBERS = /\b\d[\d,.]*%?|\$\d/g;
const count = (text, re) => (String(text).match(re) || []).length;

export function sentences(text) {
  return (String(text).match(SENT_RE) || []).map((s) => s.trim()).filter((s) => s.split(/\s+/).length > 2);
}
const words = (text) => String(text).match(WORD_RE) || [];

/** Capitalised words that don't start a sentence or a line: names, products, places. */
function properNouns(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/\b[A-Z][a-z]{2,}\b/g)) {
    const before = text.slice(0, m.index).replace(/[ \t"'(]+$/, '');
    if (!before || /[.!?:\n]$/.test(before)) continue;
    out.add(m[0]);
  }
  return out;
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const pstdev = (a) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};

/**
 * The letter without its greeting line and sign-off block, so "Dear ..." and "Best regards, Name"
 * don't count as sentences.
 */
export function letterBody(text) {
  const blocks = String(text || '').replace(/\r\n/g, '\n').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length > 1 && /^(dear|hi|hello)\b/i.test(blocks[0]) && blocks[0].split('\n').length === 1 && blocks[0].length < 120) blocks.shift();
  const last = blocks[blocks.length - 1] || '';
  if (blocks.length > 1 && last.split('\n').length <= 4 && last.length < 160 && /,\s*(\n|$)/.test(last.split('\n')[0])) blocks.pop();
  return blocks.join('\n\n');
}

function exemptFilter(exempt) {
  const ex = String(exempt || '');
  return (entry) => {
    entry.re.lastIndex = 0;
    const hit = ex && entry.re.test(ex);
    entry.re.lastIndex = 0;
    return !hit;
  };
}

// ---------- the five checks ----------
function checkBurstiness(body) {
  const lens = sentences(body).map((s) => s.split(/\s+/).length);
  if (lens.length < 4) return { score: 50, value: null, detail: 'Too short to judge.' };
  const m = mean(lens);
  const cv = m ? pstdev(lens) / m : 0;
  // letters run more even than captions or chat, so the human end is 0.6 rather than 0.7
  return { score: scale(cv, 0.6, 0.2), value: round1(cv), detail: `Sentence-length variation ${cv.toFixed(2)} across ${lens.length} sentences (0.5 or more reads human).` };
}

function checkSpecificity(body) {
  const w = words(body);
  if (w.length < 25) return { score: 50, value: null, detail: 'Too short to judge.' };
  const hits = count(body, NUMBERS) + properNouns(body).size;
  const density = (hits * 100) / w.length;
  return { score: scale(density, 6, 0.5), value: round1(density), detail: `${hits} concrete names and numbers, ${density.toFixed(1)} per 100 words (4 or more reads human).` };
}

function checkSlop(body, exempt) {
  const w = words(body);
  if (!w.length) return { score: 50, found: [], detail: 'Empty.' };
  const found = [];
  let hits = 0;
  // longest first, and each match blanked out, so "delve into" isn't also counted as "delve"
  let rest = body;
  for (const e of [...LEXICON].filter(exemptFilter(exempt)).sort((a, b) => b.find.length - a.find.length)) {
    e.re.lastIndex = 0;
    const n = count(rest, e.re);
    if (!n) continue;
    hits += n;
    found.push({ term: e.find, count: n, replace: e.replace, auto: e.auto });
    rest = rest.replace(e.re, (m) => ' '.repeat(m.length));
  }
  const density = (hits * 100) / w.length;
  return {
    score: scale(density, 0, 4),
    found,
    detail: hits ? `${hits} stock word${hits > 1 ? 's' : ''} or phrase${hits > 1 ? 's' : ''}, ${density.toFixed(1)} per 100 words.` : 'No stock words or phrases.',
  };
}

export function fingerprintCounts(text) {
  const t = String(text);
  return {
    invisible: count(t, /\p{Cf}/gu),
    emDash: count(t, /\u2014/g),
    enDash: count(t, /\s\u2013\s/g),
    curly: count(t, /[\u2018\u2019\u201C\u201D]/g),
    ellipsis: count(t, /\u2026/g),
    hardSpace: count(t, /[\u00A0\u202F\u2009\u2007\u2003\u2002]/g),
  };
}

function checkFingerprint(text) {
  const f = fingerprintCounts(text);
  const total = f.invisible * 4 + (f.emDash + f.enDash) * 2 + f.curly + f.ellipsis + f.hardSpace;
  const per1k = (total * 1000) / Math.max(String(text).length, 1);
  const parts = [];
  if (f.invisible) parts.push(`${f.invisible} invisible character${f.invisible > 1 ? 's' : ''}`);
  if (f.emDash + f.enDash) parts.push(`${f.emDash + f.enDash} dash${f.emDash + f.enDash > 1 ? 'es' : ''}`);
  if (f.curly) parts.push(`${f.curly} curly quote${f.curly > 1 ? 's' : ''}`);
  if (f.ellipsis) parts.push(`${f.ellipsis} ellipsis character${f.ellipsis > 1 ? 's' : ''}`);
  if (f.hardSpace) parts.push(`${f.hardSpace} hard space${f.hardSpace > 1 ? 's' : ''}`);
  return { score: scale(per1k, 0, 12), counts: f, detail: parts.length ? `${parts.join(', ')}.` : 'Plain keyboard typography.' };
}

function findTells(body) {
  const tells = [];
  for (const s of STRUCTURES) {
    s.re.lastIndex = 0;
    const matches = String(body).match(s.re) || [];
    if (matches.length > (s.min || 0)) {
      tells.push({ id: s.id, name: s.name, fix: s.fix, count: matches.length, example: matches[0].trim().replace(/^[.!]\s+/, '').slice(0, 90) });
    }
  }
  // too many sentences opening with "I"
  const sents = sentences(body);
  const iStarts = sents.filter((s) => /^I(?:\s|'m|'ve|'d|'ll)/.test(s)).length;
  if (sents.length >= 5 && iStarts / sents.length > 0.5) {
    tells.push({ id: 'i-openers', name: 'Most sentences start with "I"', fix: 'Start some sentences with the work, the result or the company instead.', count: iStarts, example: '' });
  }
  // every bullet the same length
  const bullets = [...String(body).matchAll(/^\s*[-*•]\s+(.+)$/gm)].map((m) => m[1].split(/\s+/).length);
  if (bullets.length >= 3 && pstdev(bullets) < 1.6) {
    tells.push({ id: 'uniform-bullets', name: 'Bullets all the same length', fix: 'Vary them: one short, one longer.', count: bullets.length, example: '' });
  }
  return tells;
}

function checkVoice(body, tells) {
  const w = words(body);
  if (w.length < 25) return { score: 50, detail: 'Too short to judge.' };
  const per100 = 100 / w.length;
  const contractions = count(body, CONTRACTIONS) * per100;
  const person = count(body, PRONOUNS) * per100;
  const n = tells.reduce((s, t) => s + (t.id === 'uniform-bullets' ? 0 : Math.min(t.count, 2)), 0);
  let score = scale(contractions, 3, 0) * 0.35 + scale(person, 8, 1) * 0.35 + clamp(100 - n * 22) * 0.3;
  if (tells.some((t) => t.id === 'uniform-bullets')) score -= 12;
  return {
    score: clamp(score),
    contractions: round1(contractions),
    detail: `${contractions.toFixed(1)} contractions and ${person.toFixed(1)} personal pronouns per 100 words; ${n} structural tell${n === 1 ? '' : 's'}.`,
  };
}

export const CHECK_NAMES = {
  burstiness: 'Sentence rhythm',
  specificity: 'Specific detail',
  slop: 'Stock phrases',
  fingerprint: 'Typography',
  voice: 'Voice',
};

export const VERDICT_LABEL = { pass: 'Reads human', review: 'Needs a pass', flagged: 'Reads like AI' };

/**
 * Score a letter. `exempt` is text whose words are the candidate's own (their answers, the company
 * and role names): stock words that appear there aren't counted.
 */
export function detect(text, { exempt = '' } = {}) {
  const full = String(text || '');
  const body = letterBody(full);
  const burstiness = checkBurstiness(body);
  const specificity = checkSpecificity(body);
  const slop = checkSlop(body, exempt);
  const fingerprint = checkFingerprint(full);
  const tells = findTells(body);
  const voice = checkVoice(body, tells);
  const parts = { burstiness, specificity, slop, fingerprint, voice };
  const scores = Object.values(parts).map((p) => p.score);
  const overall = mean(scores) * 0.6 + Math.min(...scores) * 0.4;
  const verdict = overall >= 70 && Math.min(...scores) >= 55 ? 'pass' : overall >= 50 ? 'review' : 'flagged';
  const checks = Object.entries(parts).map(([id, p]) => ({ id, name: CHECK_NAMES[id], score: Math.round(p.score), detail: p.detail }));
  const weakest = checks.reduce((a, b) => (b.score < a.score ? b : a));
  return {
    score: Math.round(overall),
    verdict,
    label: VERDICT_LABEL[verdict],
    checks,
    weakest: weakest.id,
    slop: slop.found,
    tells,
    fingerprint: fingerprint.counts,
    burstiness: burstiness.value,
    contractions: voice.contractions ?? null,
    words: words(body).length,
  };
}

/** Plain-English problems for the AI editing pass. */
export function problemsFor(report) {
  const out = [];
  for (const s of report.slop) {
    out.push(`Stock phrase "${s.term}"${s.count > 1 ? ` (${s.count} times)` : ''}: ${s.replace ? `use something plain like "${s.replace}", or rephrase` : 'rephrase it in plain words, or cut it'}.`);
  }
  for (const t of report.tells) out.push(`${t.name}${t.example ? ` (for example "${t.example}")` : ''}: ${t.fix}`);
  const score = Object.fromEntries(report.checks.map((c) => [c.id, c.score]));
  if (score.burstiness < 65) out.push(`Sentence lengths are too even (variation ${report.burstiness ?? '?'}). Mix in a couple of short sentences (4 to 8 words) next to longer ones.`);
  if (score.specificity < 60) out.push("It's too abstract. Lean on the concrete names, numbers and details already in the letter, the résumé or the candidate's answers. Don't add new facts.");
  if (score.voice < 65) out.push(`It sounds impersonal. Write in first person with a few natural contractions (I've, I'm, didn't); it has ${report.contractions ?? 0} per 100 words.`);
  if (score.fingerprint < 95) out.push('Remove every em dash and en dash, curly quote and special character. Use commas, full stops and straight quotes.');
  if (!out.length) out.push('No specific problems found. Do a light edit: vary the rhythm and cut any filler, keeping it natural.');
  return out;
}

// ---------- scrub ----------
function matchCase(src, repl) {
  if (!repl) return repl;
  if (src === src.toUpperCase() && /[A-Z]/.test(src) && src.length > 1) return repl.toUpperCase();
  if (/^[A-Z]/.test(src)) return repl[0].toUpperCase() + repl.slice(1);
  return repl;
}

/**
 * Remove the mechanical tells. Returns {text, changes}: invisible and hard-space characters, em and
 * en dashes used as punctuation, curly quotes, the ellipsis character, and stock words that have a
 * safe plain swap (unless the candidate used that word themselves).
 */
export function scrub(text, { exempt = '' } = {}) {
  let t = String(text || '').replace(/\r\n/g, '\n');
  const changes = [];
  const note = (n, what) => n && changes.push(`${what}${n > 1 ? ` (${n})` : ''}`);

  const inv = count(t, /\p{Cf}/gu);
  t = t.replace(/\p{Cf}/gu, '');
  note(inv, 'Removed invisible characters');
  const hard = count(t, /[\u00A0\u202F\u2009\u2007\u2003\u2002]/g);
  t = t.replace(/[\u00A0\u202F\u2009\u2007\u2003\u2002]/g, ' ');
  note(hard, 'Replaced hard spaces');

  const dashes = count(t, /\u2014|\s\u2013\s/g);
  t = t
    .replace(/(\d)\s*[\u2013\u2014]\s*(\d)/g, '$1-$2') // ranges: 2019–2021
    .replace(/[ \t]*\u2014[ \t]*/g, ', ')
    .replace(/[ \t]+\u2013[ \t]+/g, ', ')
    .replace(/\u2013/g, '-')
    .replace(/,\s*,/g, ',')
    .replace(/,[ \t]*([.!?;:])/g, '$1');
  note(dashes, 'Replaced dashes with commas');

  const curly = count(t, /[\u2018\u2019\u201C\u201D]/g);
  t = t.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  note(curly, 'Straightened curly quotes');
  const ell = count(t, /\u2026/g);
  t = t.replace(/\u2026/g, '...');
  note(ell, 'Replaced ellipsis characters');
  t = t.replace(/^[ \t]*[•*][ \t]+/gm, '- ');

  // stock words with a safe swap; the greeting and sign-off are left alone
  for (const e of LEXICON.filter((x) => x.auto && x.replace).filter(exemptFilter(exempt))) {
    e.re.lastIndex = 0;
    let n = 0;
    t = t.replace(e.re, (m) => {
      n++;
      return matchCase(m, e.replace);
    });
    if (n) changes.push(`"${e.find}" → "${e.replace}"${n > 1 ? ` (${n})` : ''}`);
  }

  t = t
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: t, changes };
}
