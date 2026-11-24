import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildResumePdf, resumeFileName } from '../lib/pdf.js';
import { parseResume, htmlToText, detectKind, countOddChars, ParseError } from '../lib/parse.js';
import { formatChecks } from '../lib/ats.js';

const sample = JSON.parse(fs.readFileSync(new URL('../samples/sample-resume.json', import.meta.url), 'utf8'));

test('generated PDF reads back with names, headings and bullets intact', async () => {
  const pdf = await buildResumePdf(sample);
  assert.ok(pdf.subarray(0, 4).toString() === '%PDF');
  const { text, meta } = await parseResume(pdf, 'resume.pdf');
  assert.equal(meta.kind, 'pdf');
  assert.equal(meta.multiColumn, false);
  assert.equal(meta.oddChars, 0);
  for (const s of ['Priya Sharma', 'priya.sharma@example.com', 'EXPERIENCE', 'EDUCATION', 'SKILLS', 'Northwind Retail', 'Jan 2022']) {
    assert.ok(text.includes(s), `missing "${s}"`);
  }
  assert.match(text, /• Built 12 Tableau dashboards/);
  const failing = formatChecks(text, meta).filter((c) => c.status === 'fail');
  assert.deepEqual(failing, []);
});

test('a PDF with no text is reported as scanned', async () => {
  const empty = await buildResumePdf({ name: '', headline: '', contact: [], summary: '', skills: [], experience: [], projects: [], education: [], certifications: [], extras: [] });
  await assert.rejects(parseResume(empty, 'scan.pdf'), (err) => err instanceof ParseError && err.code === 'scanned');
});

test('file type is detected from content, and .doc is refused', () => {
  assert.equal(detectKind(Buffer.from('%PDF-1.7'), 'x.pdf'), 'pdf');
  assert.equal(detectKind(Buffer.from('PK\u0003\u0004'), 'x.docx'), 'docx');
  assert.throws(() => detectKind(Buffer.from('ÐÏ\u0011à'), 'old.doc'), /\.doc files are not supported/);
});

test('Word HTML becomes text with bullets kept', () => {
  const text = htmlToText('<h1>Experience</h1><ul><li>Built &amp; shipped</li><li>Led 4 people</li></ul><p>Done</p>');
  assert.equal(text, 'Experience\n\n• Built & shipped\n\n• Led 4 people\nDone');
});

test('icon-font and emoji characters are counted', () => {
  assert.equal(countOddChars('Phone  Email ✉️ ok'), 2);
  assert.equal(countOddChars('Plain text – fine'), 0);
});

test('resume file name is tidy', () => {
  assert.equal(resumeFileName('Priya Sharma', 'Senior Data Analyst'), 'Priya_Sharma_Senior_Data_Analyst_Resume.pdf');
  assert.equal(resumeFileName('José Núñez', 'C++ Dev / Lead'), 'Jose_Nunez_C_Dev_Lead_Resume.pdf');
});

test('a long resume is shrunk to fit one page; a huge one reports that it does not fit', async () => {
  const { layoutResumePdf, LAYOUTS } = await import('../lib/pdf.js');
  const short = await layoutResumePdf(sample);
  assert.equal(short.pages, 1);
  assert.equal(short.fontSize, LAYOUTS[0].base);

  // grow the resume until it no longer fits at the roomiest layout
  const long = structuredClone(sample);
  while ((await layoutResumePdf(long, { fitOnePage: false })).pages === 1) {
    long.projects.push(structuredClone(sample.projects[0]));
  }
  const fitted = await layoutResumePdf(long);
  assert.equal(fitted.pages, 1);
  assert.equal(fitted.fits, true);
  assert.ok(fitted.fontSize < LAYOUTS[0].base, `expected a smaller font, got ${fitted.fontSize}`);

  const huge = structuredClone(sample);
  huge.experience = Array.from({ length: 16 }, () => structuredClone(sample.experience[0]));
  const over = await layoutResumePdf(huge);
  assert.equal(over.fits, false);
  assert.ok(over.pages >= 2);
});
