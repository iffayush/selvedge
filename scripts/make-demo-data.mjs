// Runs Selvedge end to end on the fictional sample résumé and job description, and writes:
//   docs/demo/session.json   the app state the screenshot script loads
//   docs/example/*           a real saved application (PDF, ATS report, job description...)
// Needs GEMINI_API_KEY. Uses a throwaway settings folder, so your own settings are untouched.
//   node scripts/make-demo-data.mjs            (full run: 2 Gemini calls)
//   node scripts/make-demo-data.mjs --resave   (rebuild docs/example from the last run)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'selvedge-demo-'));
process.env.SELVEDGE_CONFIG_DIR = path.join(tmp, 'config');
const appsRoot = path.join(tmp, 'apps');
const RESAVE = process.argv.includes('--resave');

const { startServer } = await import('../lib/server-app.js');
const server = await startServer({ port: 0, onQuit: () => {} });
const api = async (p, body) => {
  const r = await fetch(server.url + p, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p}: ${j?.error?.message || r.status}`);
  return j;
};

try {
  await api('/api/settings', { rootFolder: appsRoot });

  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(path.join(root, 'samples', 'sample-resume.pdf'))]), 'priya-sharma-resume.pdf');
  const upload = await (await fetch(server.url + '/api/parse', { method: 'POST', body: fd })).json();
  const jd = fs.readFileSync(path.join(root, 'samples', 'sample-jd.txt'), 'utf8');

  let a, t, confirmed, session;
  if (RESAVE) {
    // Reuse the last run (docs/demo/session.json); only rebuild docs/example.
    session = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'demo', 'session.json'), 'utf8'));
    a = { analysis: session.analysis, scores: session.scoresBefore };
    t = {
      resume: session.tailored.resume,
      changes: session.tailored.changes,
      model: session.model,
      scores: session.scoresAfter,
      placeholdersFound: session.placeholdersFound,
      unconfirmed: session.unconfirmed,
      changedNumbers: session.changedNumbers,
    };
    confirmed = session.confirmed;
  } else {
  console.log('Analyzing…');
  a = await api('/api/analyze', { resumeText: upload.text, jd, meta: upload.meta });
  const missing = a.scores.keywords.matches.filter((m) => !m.matched).map((m) => m.term);
  // The fictional candidate "has" Snowflake, to show how ticked skills are used.
  confirmed = missing.filter((term) => /snowflake/i.test(term)).slice(0, 1);

  console.log('Tailoring…');
  t = await api('/api/tailor', { resumeText: upload.text, jd, analysis: a.analysis, confirmedKeywords: confirmed });

  session = {
    upload: { uploadId: null, fileName: 'priya-sharma-resume.pdf', meta: upload.meta },
    resumeText: upload.text,
    jd,
    company: '',
    jobTitle: '',
    analysis: a.analysis,
    scoresBefore: a.scores,
    model: t.model,
    confirmed,
    tailored: { resume: t.resume, changes: t.changes, placeholders: t.placeholders },
    scoresAfter: t.scores,
    placeholdersFound: t.placeholdersFound,
    unconfirmed: t.unconfirmed,
    changedNumbers: t.changedNumbers,
    pdfInfo: t.pdf,
    recheck: null,
    savedDir: null,
    saveCompany: a.analysis.company,
    saveRole: a.analysis.jobTitle,
    stale: false,
  };
  fs.mkdirSync(path.join(root, 'docs', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'demo', 'session.json'), JSON.stringify(session, null, 2) + '\n');
  }

  // Save it as an application, as a user would, filling any [X] placeholders with sample figures
  // that suit the placeholder ([X%] -> a percentage, [number] -> a count, ...).
  const sampleFigure = (ph) =>
    /%/.test(ph) ? '15%' : /\$|amount|revenue|cost/i.test(ph) ? '$40K' : /hour|day|week|time/i.test(ph) ? '6' : '120';
  const fill = (v) =>
    typeof v === 'string' ? v.replace(/\[[^\]\n]{1,60}\]/g, sampleFigure)
      : Array.isArray(v) ? v.map(fill)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v;
  const filled = fill(t.resume);
  const after = (await api('/api/score', { resume: filled, analysis: a.analysis, originalText: upload.text, confirmedKeywords: confirmed })).scores;
  const saved = await api('/api/save', {
    uploadId: upload.uploadId,
    originalFileName: 'priya-sharma-resume.pdf',
    originalMeta: upload.meta,
    originalResumeText: upload.text,
    company: a.analysis.company,
    jobTitle: a.analysis.jobTitle,
    jd,
    analysis: a.analysis,
    resume: filled,
    changes: t.changes,
    confirmedKeywords: confirmed,
    scoresBefore: a.scores,
    scoresAfter: after,
    model: t.model,
  });

  const exampleDir = path.join(root, 'docs', 'example');
  fs.rmSync(exampleDir, { recursive: true, force: true });
  fs.mkdirSync(exampleDir, { recursive: true });
  for (const f of fs.readdirSync(saved.dir)) fs.copyFileSync(path.join(saved.dir, f), path.join(exampleDir, f));
  fs.writeFileSync(
    path.join(exampleDir, 'folder.json'),
    JSON.stringify({ company: a.analysis.company, role: path.basename(saved.dir) }, null, 2) + '\n',
  );

  console.log(`Model: ${t.model}`);
  console.log(`Scores: ATS ${a.scores.ats.score} → ${t.scores.ats.score}, keywords ${a.scores.keywords.score} → ${t.scores.keywords.score}, confidence ${a.scores.confidence.score} → ${t.scores.confidence.score}`);
  console.log(`Placeholders: ${t.placeholdersFound.join(', ') || 'none'} | unconfirmed: ${t.unconfirmed.join(', ') || 'none'} | changed numbers: ${t.changedNumbers.map((n) => n.value).join(', ') || 'none'}`);
  console.log(`Wrote docs/demo/session.json and docs/example/ (${fs.readdirSync(exampleDir).length} files)`);
} finally {
  await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
