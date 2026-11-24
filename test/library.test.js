import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeName, safeJoin, saveApplication, listApplications, loadApplication, chooseAppDir, FILES } from '../lib/library.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rt-lib-'));
}

function sampleSave(root, extra = {}) {
  const original = path.join(root, '..', `orig-${process.pid}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(original, '%PDF-1.7 original');
  return saveApplication({
    root,
    company: 'Acme/Corp: Inc.',
    jobTitle: 'Senior Data Analyst',
    date: '2026-11-23',
    pdf: Buffer.from('%PDF-1.7 tailored'),
    pdfName: 'Priya_Sharma_Senior_Data_Analyst_Resume.pdf',
    jd: 'We need SQL.',
    report: '# Report',
    resume: { name: 'Priya Sharma' },
    app: { candidateName: 'Priya Sharma', scoresSummary: { atsAfter: 80 } },
    originalPath: original,
    originalExt: '.pdf',
    ...extra,
  });
}

test('folder names are made safe for Windows', () => {
  assert.equal(sanitizeName('Acme/Corp: Inc.'), 'Acme Corp Inc');
  assert.equal(sanitizeName('  ...  '), 'Untitled');
  assert.equal(sanitizeName('CON'), '_CON');
  assert.equal(sanitizeName('a'.repeat(200)).length, 80);
  assert.equal(sanitizeName('', 'Unknown Company'), 'Unknown Company');
});

test('paths cannot escape the root folder', () => {
  const root = tmpRoot();
  assert.throws(() => safeJoin(root, '..', 'evil'), /outside/);
  assert.throws(() => safeJoin(root, '..\\..\\Windows'), /outside/);
  assert.ok(safeJoin(root, 'Acme', 'Role (2026-01-01)').startsWith(root));
});

test('saving writes all six files in Company\\Role (date)', () => {
  const root = tmpRoot();
  const saved = sampleSave(root);
  assert.equal(saved.dir, path.join(root, 'Acme Corp Inc', 'Senior Data Analyst (2026-11-23)'));
  const files = fs.readdirSync(saved.dir).sort();
  assert.deepEqual(files, [
    'Priya_Sharma_Senior_Data_Analyst_Resume.pdf',
    FILES.app,
    FILES.report,
    FILES.jd,
    'original-resume.pdf',
    FILES.resumeJson,
  ].sort());
  const jd = fs.readFileSync(path.join(saved.dir, FILES.jd), 'utf8');
  assert.match(jd, /^Company: Acme\/Corp: Inc\.\nRole: Senior Data Analyst\nSaved: 2026-11-23/);
  assert.match(jd, /We need SQL\.\n$/);
});

test('a second save of the same role gets a (2) folder; re-saving in a session overwrites', () => {
  const root = tmpRoot();
  const first = sampleSave(root);
  const second = sampleSave(root);
  assert.equal(path.basename(second.dir), 'Senior Data Analyst (2026-11-23) (2)');
  const again = sampleSave(root, { previousDir: second.dir, resume: { name: 'Priya S.' } });
  assert.equal(again.dir, second.dir);
  assert.equal(JSON.parse(fs.readFileSync(path.join(second.dir, FILES.resumeJson), 'utf8')).name, 'Priya S.');
  assert.ok(fs.existsSync(first.dir));
});

test('re-saving a loaded application on a later day keeps its folder and date', () => {
  const root = tmpRoot();
  const first = sampleSave(root);
  const later = sampleSave(root, { previousDir: first.dir, date: '2026-12-01' });
  assert.equal(later.dir, first.dir);
  assert.equal(JSON.parse(fs.readFileSync(path.join(first.dir, FILES.app), 'utf8')).date, '2026-11-23');
});

test('a previous folder for a different company is not reused', () => {
  const root = tmpRoot();
  const first = sampleSave(root);
  const dir = chooseAppDir(root, 'Globex', 'Senior Data Analyst', '2026-11-23', first.dir);
  assert.equal(dir, path.join(root, 'Globex', 'Senior Data Analyst (2026-11-23)'));
});

test('list and load round-trip', () => {
  const root = tmpRoot();
  const saved = sampleSave(root);
  const list = listApplications(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].company, 'Acme/Corp: Inc.');
  assert.equal(list[0].jobTitle, 'Senior Data Analyst');
  assert.equal(list[0].scores.atsAfter, 80);
  const loaded = loadApplication(root, list[0].id);
  assert.equal(loaded.dir, saved.dir);
  assert.equal(loaded.jd, 'We need SQL.');
  assert.equal(loaded.resume.name, 'Priya Sharma');
  assert.throws(() => loadApplication(root, Buffer.from('../../x').toString('base64url')), /outside/);
});

test('default applications folder keeps using an existing "Resume Tailor" folder from before the rename', async () => {
  const { defaultRootFolder } = await import('../lib/config.js');
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-docs-'));
  assert.equal(defaultRootFolder(docs), path.join(docs, 'Selvedge'));
  fs.mkdirSync(path.join(docs, 'Resume Tailor'));
  assert.equal(defaultRootFolder(docs), path.join(docs, 'Resume Tailor'));
  fs.mkdirSync(path.join(docs, 'Selvedge'));
  assert.equal(defaultRootFolder(docs), path.join(docs, 'Selvedge'));
});
