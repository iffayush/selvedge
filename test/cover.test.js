import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { detect, scrub, letterBody, problemsFor } from '../lib/humanize.js';
import { composeLetter, letterFlags, humanizeLetter, writeLetter, CoverInputSchema, defaultQuestions, contentProblems } from '../lib/cover.js';
import { layoutCoverLetterPdf, letterBlocks, coverLetterFileName } from '../lib/pdf.js';
import { saveApplication, saveCoverLetter, listApplications, loadApplication } from '../lib/library.js';
import {
  companySiteFromJd, pageText, interestingLinks, parseNewsRss, attachGroundingSources, isPublicUrl, normaliseSite, researchMarkdown, tidyDate,
} from '../lib/research.js';

const AI_LETTER = `Dear Hiring Manager,

I am writing to express my interest in the Senior Data Analyst position at Lumen Analytics. I am passionate about data and I believe I would be a great fit for your dynamic team. Furthermore, my proven track record of leveraging robust analytics makes me the ideal candidate.

In my current role, I spearheaded a comprehensive initiative that delivered seamless dashboards. This experience underscores my commitment to excellence — and my ability to thrive in a fast-paced environment. I am confident that I would make a meaningful impact.

Thank you for considering my application. I look forward to the opportunity to discuss how I can contribute to your team's success.

Best regards,
Priya Sharma`;

const HUMAN_LETTER = `Dear Lumen Analytics hiring team,

Our checkout test at Northwind showed nothing for two weeks. Then I split it by device. Mobile users were dropping at the address form, so we cut it down, and conversions rose 6%. That's the kind of digging I'd like to do as your Senior Data Analyst.

I've spent four years in retail data, mostly in SQL and Power BI. At Northwind I rebuilt the weekly sales report so store managers could read it in five minutes instead of an hour. It's a small thing. They still use it.

My first job was in my uncle's shop, and he never had time for reports. Lumen builds for owners like him, which is why this role caught my eye.

I'd be glad to talk about how you test changes before rolling them out to every retailer.

Best regards,
Priya Sharma`;

const input = (over = {}) =>
  CoverInputSchema.parse({
    resumeText: 'Priya Sharma. Data Analyst at Northwind Retail. SQL, Power BI. Raised checkout conversion 6% with an A/B test. Four years in retail analytics.',
    jd: 'Senior Data Analyst at Lumen Analytics. SQL, Power BI, Snowflake, dbt.',
    company: 'Lumen Analytics',
    jobTitle: 'Senior Data Analyst',
    header: { name: 'Priya Sharma', contact: ['priya@example.com', '+91 98765 43210'] },
    answers: [{ question: 'Why them?', answer: "My first job was in my uncle's shop." }],
    jdSkills: ['SQL', 'Power BI', 'Snowflake', 'dbt'],
    ...over,
  });

// ---------- humaniser ----------

test('the detector separates a template letter from a specific one', () => {
  const ai = detect(AI_LETTER);
  const human = detect(HUMAN_LETTER);
  assert.ok(ai.score < 55, `template letter scored ${ai.score}`);
  assert.equal(ai.verdict === 'pass', false);
  assert.ok(human.score >= 70, `specific letter scored ${human.score}`);
  assert.ok(human.score > ai.score + 20);
  const terms = ai.slop.map((s) => s.term);
  for (const t of ['passionate about', 'furthermore', 'proven track record', 'spearheaded', 'seamless']) assert.ok(terms.includes(t), t);
  const tells = ai.tells.map((t) => t.id);
  assert.ok(tells.includes('generic-opener'));
  assert.ok(tells.includes('hedged-confidence'));
  assert.equal(ai.fingerprint.emDash, 1);
  assert.equal(ai.checks.length, 5);
});

test('the candidate’s own words are not counted as stock phrases', () => {
  const letter = 'Dear team,\n\nI am truly passionate about bread, and I bake every weekend with my family and friends in Pune.\n\nBest,\nA';
  assert.ok(detect(letter).slop.some((s) => s.term === 'passionate about'));
  assert.ok(!detect(letter, { exempt: 'I am truly passionate about bread' }).slop.some((s) => s.term === 'passionate about'));
});

test('letterBody drops the greeting and the sign-off', () => {
  assert.equal(letterBody('Dear team,\n\nOne.\n\nTwo.\n\nBest regards,\nPriya'), 'One.\n\nTwo.');
});

test('scrub removes invisible characters, dashes and curly quotes, and swaps safe stock words', () => {
  const dirty = 'Dear team,\n\nI leveraged SQL​ — and it worked. “Good”… We moved 2019–2021 data. Additionally, it’s fine.\n\nBest regards,\nPriya';
  const { text, changes } = scrub(dirty);
  assert.ok(!/[​—–“”’…]/.test(text));
  assert.match(text, /I used SQL, and it worked\./);
  assert.match(text, /2019-2021/);
  assert.match(text, /Also, it's fine\./);
  assert.match(text, /^Dear team,\n/);
  assert.match(text, /Best regards,\nPriya$/);
  assert.ok(changes.length >= 4);
  // the candidate's own wording is left alone
  assert.match(scrub('We leveraged it.', { exempt: 'leveraged' }).text, /leveraged/);
});

test('problemsFor turns a report into instructions', () => {
  const p = problemsFor(detect(AI_LETTER));
  assert.ok(p.some((x) => /passionate about/.test(x)));
  assert.ok(p.some((x) => /dash/i.test(x)));
});

// ---------- letter ----------

test('composeLetter puts bullets after the opening paragraph', () => {
  const text = composeLetter({ greeting: 'Dear team,', paragraphs: ['Open.', 'Close.'], bullets: ['One', '- Two'], signOff: 'Best regards,' }, 'Priya');
  assert.equal(text, 'Dear team,\n\nOpen.\n\n- One\n- Two\n\nClose.\n\nBest regards,\nPriya');
  assert.deepEqual(letterBlocks(text).map((b) => b.type), ['p', 'p', 'ul', 'p', 'p']);
  assert.deepEqual(letterBlocks(text)[4].lines, ['Best regards,', 'Priya']);
});

test('letterFlags catches skills and numbers that are not in the candidate’s material', () => {
  const f = letterFlags('I built Snowflake models in SQL and grew revenue 40%. My phone is +91 98765 43210. Conversions rose 6%.', input());
  assert.deepEqual(f.unconfirmed, ['Snowflake']);
  assert.deepEqual(f.changedNumbers.map((n) => n.value), ['40']);
  assert.deepEqual(letterFlags('It rose [X%].', input()).placeholders, ['[X%]']);
});

test('humanizeLetter runs an editing pass, keeps the frame, and scrubs the result', async () => {
  const calls = [];
  const ask = async (opts) => {
    calls.push(opts);
    return { data: { letter: HUMAN_LETTER.replace('Dear Lumen Analytics hiring team,', 'Hello,'), edits: ['Cut stock phrases'] }, model: 'fake' };
  };
  const r = await humanizeLetter({ ask, letter: AI_LETTER, input: input() });
  assert.ok(calls.length >= 1 && calls.length <= 2);
  assert.match(calls[0].prompt, /problems_found/);
  assert.ok(r.final.score > r.start.score);
  assert.match(r.letter, /^Dear Hiring Manager,/); // the greeting is restored
  assert.ok(r.passes[0].accepted);
});

test('humanizeLetter discards an edit that changes a number', async () => {
  const ask = async () => ({ data: { letter: HUMAN_LETTER.replace('6%', '60%'), edits: ['x'] }, model: 'fake' });
  const r = await humanizeLetter({ ask, letter: HUMAN_LETTER, input: input(), maxPasses: 1 });
  assert.equal(r.passes[0].accepted, false);
  assert.match(r.passes[0].rejected, /number/);
  assert.match(r.letter, /rose 6%/);
});

test('writeLetter drafts, then humanises', async () => {
  const ask = async ({ zodSchema }) =>
    zodSchema.shape.greeting
      ? { data: { greeting: 'Dear team,', paragraphs: ['I am writing to express my interest — truly.', 'Thanks.'], bullets: ['x'], signOff: 'Best regards,' }, model: 'm1' }
      : { data: { letter: HUMAN_LETTER, edits: ['Rewrote the opening'] }, model: 'm2' };
  const r = await writeLetter({ ask, input: input() });
  assert.match(r.draft, /I am writing to express/);
  assert.ok(!/\n- x/.test(r.draft), 'paragraph format drops bullets');
  assert.ok(r.final.score >= r.start.score);
});

test('a busy Gemini during humanising keeps the draft instead of failing', async () => {
  const { AIError } = await import('../lib/gemini.js');
  const ask = async ({ zodSchema }) => {
    if (zodSchema.shape.greeting) return { data: { greeting: 'Dear team,', paragraphs: ['Our test showed nothing for two weeks — then I split it by device.', 'Talk soon.'], bullets: [], signOff: 'Best regards,' }, model: 'm1' };
    throw new AIError('overloaded', 'Gemini is busy right now.');
  };
  const r = await writeLetter({ ask, input: input() });
  assert.equal(r.passes[0].skipped, true);
  assert.match(r.letter, /two weeks, then I split/); // still scrubbed
  // asked directly (Humanise again), the error is reported
  await assert.rejects(() => humanizeLetter({ ask, letter: r.letter, input: input(), maxPasses: 1 }), /busy/);
});

test('the editing pass is told when the opening never names the role or the company', () => {
  const vague = 'Dear team,\n\nMy first job was in a shop.\n\nI applied to Lumen Analytics as a Senior Data Analyst.\n\nBest regards,\nPriya';
  assert.equal(contentProblems(vague, input()).length, 2);
  assert.deepEqual(contentProblems(HUMAN_LETTER, input()), []);
});

test('there are always fallback questions', () => {
  const q = defaultQuestions('Acme', 'Designer');
  assert.equal(q.length, 3);
  assert.match(q[1].question, /Acme/);
});

// ---------- PDF ----------

test('the cover letter PDF fits on one page with the letterhead', async () => {
  const r = await layoutCoverLetterPdf({
    name: 'Priya Sharma',
    contact: ['priya@example.com', 'linkedin.com/in/priya'],
    date: '24 November 2026',
    recipient: ['Hiring team', 'Lumen Analytics'],
    text: HUMAN_LETTER,
  });
  assert.equal(r.pages, 1);
  assert.equal(r.fits, true);
  assert.equal(r.pdf.subarray(0, 5).toString(), '%PDF-');
  assert.match(r.pdf.toString('latin1'), /Selvedge by @iffayush/);
  assert.equal(coverLetterFileName('Priya Sharma', 'Lumen Analytics'), 'Priya_Sharma_Lumen_Analytics_Cover_Letter.pdf');
});

// ---------- saving ----------

test('a cover letter is saved into the application folder, and a later résumé save keeps it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cover-'));
  try {
    const appSave = () =>
      saveApplication({
        root, company: 'Lumen Analytics', jobTitle: 'Senior Data Analyst', date: '2026-11-24',
        pdf: Buffer.from('%PDF-1'), pdfName: 'Priya_Resume.pdf', jd: 'JD', report: '# r', resume: { name: 'Priya' }, app: { candidateName: 'Priya' },
      });
    const first = appSave();
    const [listed] = listApplications(root);
    assert.equal(listed.hasResume, true);
    assert.equal(listed.hasCoverLetter, false);

    const c = saveCoverLetter({
      root, appId: listed.id, company: 'Lumen Analytics', jobTitle: 'Senior Data Analyst',
      pdf: Buffer.from('%PDF-c'), pdfName: 'Priya_Lumen_Cover_Letter.pdf', text: 'Dear team,\n\nHello.', record: { tone: 'warm' }, research: '# notes', meta: { humanScore: 80 },
    });
    assert.equal(c.dir, first.dir);
    for (const f of ['Priya_Lumen_Cover_Letter.pdf', 'cover-letter.txt', 'cover-letter.json', 'company-research.md']) assert.ok(c.files.includes(f), f);
    const loaded = loadApplication(root, listed.id);
    assert.equal(loaded.coverLetter.text, 'Dear team,\n\nHello.');
    assert.equal(loaded.coverLetter.humanScore, 80);
    assert.equal(listApplications(root)[0].hasCoverLetter, true);

    appSave(); // saving the résumé again keeps the letter
    const again = loadApplication(root, listed.id);
    assert.equal(again.app.files.coverLetterPdf, 'Priya_Lumen_Cover_Letter.pdf');
    assert.equal(again.coverLetter.text, 'Dear team,\n\nHello.');

    // a letter for a new job gets its own folder, listed without a résumé
    const solo = saveCoverLetter({
      root, company: 'Acme', jobTitle: 'Designer', date: '2026-11-25', jd: 'Acme JD',
      pdf: Buffer.from('%PDF-c'), pdfName: 'Acme_Cover_Letter.pdf', text: 'Hi', candidateName: 'Priya',
    });
    assert.match(solo.dir, /Acme[\\/]Designer \(2026-11-25\)$/);
    const acme = listApplications(root).find((a) => a.company === 'Acme');
    assert.equal(acme.hasResume, false);
    assert.equal(acme.hasCoverLetter, true);
    assert.match(fs.readFileSync(path.join(solo.dir, 'job-description.txt'), 'utf8'), /Acme JD/);
    // writing it again goes to the same folder
    const again2 = saveCoverLetter({ root, company: 'Acme', jobTitle: 'Designer', date: '2026-11-26', pdf: Buffer.from('%PDF-c'), pdfName: 'Acme_Cover_Letter.pdf', text: 'Hi 2' });
    assert.equal(again2.dir, solo.dir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- research helpers ----------

test('the company website is found in the job description, skipping job boards', () => {
  assert.equal(companySiteFromJd('Apply at https://boards.greenhouse.io/lumen or email careers@lumenanalytics.com', 'Lumen Analytics'), 'https://www.lumenanalytics.com');
  assert.equal(companySiteFromJd('See lumen.io/about for more. Posted on linkedin.com', 'Lumen Analytics'), 'https://www.lumen.io');
  assert.equal(companySiteFromJd('Apply on https://www.linkedin.com/jobs/1 and use Node.js', 'Acme'), null);
  assert.equal(normaliseSite('acme.com/about'), 'https://acme.com');
  assert.equal(normaliseSite('http://localhost:3000'), null);
  assert.equal(isPublicUrl('http://192.168.1.4/'), false);
  assert.equal(isPublicUrl('https://example.org/x'), true);
});

test('pageText and interestingLinks read a page', () => {
  const html = `<html><head><title>Acme &amp; Co</title><meta name="description" content="We make rockets."></head>
    <body><nav><a href="/login">Log in</a></nav><script>var x = 1;</script>
    <h1>Hello</h1><p>We launched Orbit in March 2026.</p>
    <a href="/about-us">About</a><a href="https://acme.com/newsroom/">News</a><a href="/blog">Blog</a><a href="https://other.com/about">x</a><a href="/careers">Jobs</a>
    </body></html>`;
  const t = pageText(html);
  assert.equal(t.title, 'Acme & Co');
  assert.equal(t.description, 'We make rockets.');
  assert.match(t.text, /We launched Orbit in March 2026\./);
  assert.doesNotMatch(t.text, /var x|Log in/);
  assert.deepEqual(interestingLinks(html, 'https://acme.com/', 3), ['https://acme.com/about-us', 'https://acme.com/newsroom', 'https://acme.com/blog']);
});

test('parseNewsRss reads Google News items', () => {
  const xml = `<rss><channel><item><title>Acme launches Orbit - The Verge</title><link>https://news.google.com/a</link><pubDate>Tue, 18 Nov 2026 10:00:00 GMT</pubDate><source url="https://www.theverge.com">The Verge</source></item></channel></rss>`;
  const [n] = parseNewsRss(xml);
  assert.equal(n.title, 'Acme launches Orbit');
  assert.equal(n.source, 'The Verge');
  assert.equal(n.date.getUTCDate(), 18);
});

test('grounded facts are matched to the search results that support them', () => {
  const facts = [
    { fact: 'Acme launched Orbit in March 2026.', relevance: '', angle: '', date: '' },
    { fact: 'Acme has an office on the moon.', relevance: '', angle: '', date: '' },
  ];
  const out = attachGroundingSources(facts, {
    chunks: [{ web: { uri: 'https://v.example/1', title: 'theverge.com' } }],
    supports: [{ segment: { text: 'Acme launched Orbit in March 2026.' }, groundingChunkIndices: [0] }],
  });
  assert.equal(out[0].verified, true);
  assert.equal(out[0].sources[0].url, 'https://v.example/1');
  assert.equal(out[1].verified, false);
});

test('researchMarkdown records the facts and marks the ones used', () => {
  const md = researchMarkdown({
    company: 'Acme',
    research: { method: 'web', summary: 'Makes rockets.', facts: [{ fact: 'Launched Orbit.', sources: [{ title: 'Verge', url: 'https://x' }] }], note: '' },
    selected: [0],
  });
  assert.match(md, /Launched Orbit\. \(used in the letter\)/);
  assert.match(md, /\[Verge\]\(https:\/\/x\)/);
});

test('research dates are shown as month and year', () => {
  assert.equal(tidyDate('2026-11'), 'Nov 2026');
  assert.equal(tidyDate('11-2026'), 'Nov 2026');
  assert.equal(tidyDate('March 2026'), 'March 2026');
});
