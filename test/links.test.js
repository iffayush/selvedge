import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { changedNumbers, resumeToText } from '../lib/ats.js';
import { htmlToText, addLinkTargets, parseResume } from '../lib/parse.js';
import { hrefFor, layoutResumePdf } from '../lib/pdf.js';
import { ResumeInputSchema } from '../lib/prompts.js';

const sample = JSON.parse(fs.readFileSync(new URL('../samples/sample-resume.json', import.meta.url), 'utf8'));

test('a metric Gemini changed is flagged; same values in other formats are not', () => {
  const original = 'Reduced incident response time by ~70%. 500+ automated tests. Phone +91 98765 43210. 2024 – 2028. github.com/me/repo2';
  const tailored = 'Reduced incident response time by ~54%.\nRan over 500 automated tests. Phone +91 98765 43210. 2024 – 2028. github.com/me/repo2';
  const flagged = changedNumbers(original, tailored);
  assert.deepEqual(flagged.map((f) => f.value), ['54']);
  assert.match(flagged[0].context, /incident response time by ~54%/);
  assert.deepEqual(changedNumbers('Cut costs by 1,200 USD', 'Cut costs by 1200 USD'), []);
});

test('Word hyperlinks keep their address unless it is already visible', () => {
  const text = htmlToText('<p>Hearth <a href="https://github.com/me/hearth">GitHub</a> | <a href="https://github.com/me/aegis">github.com/me/aegis</a></p>');
  assert.equal(text, 'Hearth GitHub (github.com/me/hearth) | github.com/me/aegis');
});

test('PDF link annotations add hidden addresses to the right line', () => {
  const lines = [{ y: 700 }, { y: 680 }];
  const texts = ['Hearth | Python   GitHub', 'Contact me@x.com'];
  addLinkTargets(lines, texts, [
    { subtype: 'Link', url: 'https://github.com/me/hearth/', rect: [400, 697, 440, 709] },
    { subtype: 'Link', url: 'mailto:me@x.com', rect: [100, 677, 160, 689] },
    { subtype: 'Link', url: '#page2', rect: [0, 0, 1, 1] },
  ]);
  assert.deepEqual(texts, ['Hearth | Python   GitHub (github.com/me/hearth)', 'Contact me@x.com']);
});

test('contact items and links get the right click targets', () => {
  assert.equal(hrefFor('me@example.com'), 'mailto:me@example.com');
  assert.equal(hrefFor('linkedin.com/in/me'), 'https://linkedin.com/in/me');
  assert.equal(hrefFor('https://me.dev'), 'https://me.dev');
  assert.equal(hrefFor('me.dev'), 'https://me.dev');
  assert.equal(hrefFor('+91 98765 43210'), null);
  assert.equal(hrefFor('Pune, India'), null);
});

test('project links appear in the PDF as readable text and as clickable links', async () => {
  const resume = structuredClone(sample);
  resume.projects[0].link = 'https://github.com/example/churn-model';
  const { pdf } = await layoutResumePdf(resume);
  const { text } = await parseResume(pdf, 'x.pdf');
  assert.match(text, /Customer churn model.*github\.com\/example\/churn-model/);
  const raw = pdf.toString('latin1');
  assert.match(raw, /https:\/\/github\.com\/example\/churn-model/);
  assert.match(raw, /mailto:priya\.sharma@example\.com/);
  assert.match(resumeToText(resume), /github\.com\/example\/churn-model/);
});

test('resumes saved before project links existed still load', () => {
  const old = structuredClone(sample);
  for (const p of old.projects) delete p.link;
  const parsed = ResumeInputSchema.parse(old);
  assert.equal(parsed.projects[0].link, '');
});

test('the creator mark lives only in the PDF properties, never in the page text', async () => {
  const { PDF_CREATOR, PDF_PRODUCER } = await import('../lib/pdf.js');
  const { pdf } = await layoutResumePdf(sample);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0 }).promise;
  const { info } = await doc.getMetadata();
  assert.equal(info.Creator, 'Selvedge by @iffayush');
  assert.equal(info.Creator, PDF_CREATOR);
  assert.match(info.Producer, /^Selvedge \d+\.\d+\.\d+$/);
  assert.equal(info.Producer, PDF_PRODUCER);
  await doc.destroy?.();
  const { text } = await parseResume(pdf, 'x.pdf');
  assert.doesNotMatch(text, /selvedge|iffayush/i);
});
