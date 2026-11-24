// Runs the cover letter flow end to end on the fictional sample (docs/example: Priya Sharma applying
// to the fictional Lumen Analytics) and writes the state the screenshot script loads:
//   docs/demo/cover.json            the Cover letter view after writing the letter
//   docs/demo/cover-research.json   company research on a real public company, for the research image
//                                   (the sample company is fictional, so there is nothing to find)
// Needs GEMINI_API_KEY (4 to 6 Gemini calls). Uses a throwaway settings folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'selvedge-cover-demo-'));
process.env.SELVEDGE_CONFIG_DIR = path.join(tmp, 'config');
const GENERIC_DIR = 'C:\\Users\\you\\Documents\\Selvedge';

// The fictional candidate's answers, in the order the questions are asked (story, why them, analogy).
const ANSWERS = [
  'The test showed no lift for two weeks. I split the results by device and saw mobile users dropping at the address form, so we cut it to three fields. That is where the 6% came from.',
  "My first job was helping in my uncle's shop. He never had time for reports, so tools that make data simple for small retailers matter to me.",
  'I bake sourdough at weekends. You feed the starter a little at a time and watch it before you trust it, which is how I treat a new metric.',
  '',
];
const RESEARCH_DEMO = {
  company: 'Spotify',
  jobTitle: 'Data Analyst, Podcasts',
  jd: 'Spotify is looking for a Data Analyst to join the Podcasts insights team. You will use SQL and Python to analyse listening behaviour, build dashboards, design and evaluate A/B tests, and partner with product managers on new features for creators and listeners.',
};

const { startServer } = await import('../lib/server-app.js');
const server = await startServer({ port: 0, onQuit: () => {} });
// Gemini is sometimes "busy" (503) for minutes at a time: be patient rather than fail.
const api = async (p, body, { ok = () => true } = {}) => {
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    const r = await fetch(server.url + p, body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    const busy = r.status === 503 || r.status === 429 || (r.ok && !ok(j));
    if (busy && attempt < 16) {
      console.log(`  ${p}: Gemini busy, retrying in 20s (attempt ${attempt})`);
      await new Promise((res) => setTimeout(res, 20000));
      continue;
    }
    if (!r.ok) throw new Error(`${p}: ${j?.error?.message || r.status}`);
    console.log(`  ${p} ${Math.round((Date.now() - started) / 1000)}s`);
    return j;
  }
};

try {
  // the saved example application, as History would show it
  const example = path.join(root, 'docs', 'example');
  const { company, role } = JSON.parse(fs.readFileSync(path.join(example, 'folder.json'), 'utf8'));
  const dir = path.join(tmp, 'apps', company, role);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(example)) if (f !== 'folder.json') fs.copyFileSync(path.join(example, f), path.join(dir, f));
  await api('/api/settings', { rootFolder: path.join(tmp, 'apps') });
  const [listed] = (await api('/api/applications')).applications;
  const app = await api(`/api/applications/${encodeURIComponent(listed.id)}`);

  console.log('Questions and research…');
  const header = { name: app.resume.name, contact: app.resume.contact };
  const [prep, research] = await Promise.all([
    api('/api/cover/prepare', { resumeText: app.resumeText, jd: app.jd, company: app.app.company, jobTitle: app.app.jobTitle }),
    api('/api/cover/research', { company: app.app.company, jobTitle: app.app.jobTitle, jd: app.jd }),
  ]);
  const answers = prep.questions.map((q, i) => ({ question: q.question, answer: ANSWERS[i] || '' }));
  const format = prep.formatAdvice.recommended;

  console.log('Writing and humanising…');
  const body = {
    resumeText: app.resumeText,
    jd: app.jd,
    company: app.app.company,
    jobTitle: app.app.jobTitle,
    header,
    answers: answers.filter((a) => a.answer),
    companyNote: '',
    facts: [],
    hiringManager: '',
    tone: 'warm',
    format,
    jdSkills: prep.jdSkills,
  };
  // the demo should show a humanised letter, so a pass skipped for a busy Gemini counts as busy
  const w = await api('/api/cover/write', body, { ok: (j) => !(j.passes || []).some((x) => x.skipped) });

  const state = {
    source: 'saved',
    appId: listed.id,
    appInfo: { dir: `${GENERIC_DIR}\\${company}\\${role}`, company: app.app.company, jobTitle: app.app.jobTitle, date: app.app.date, hasResume: true, coverLetter: null },
    newJob: { company: '', jobTitle: '', jd: '' },
    newResume: { from: '', text: '', label: '' },
    company: app.app.company,
    jobTitle: app.app.jobTitle,
    jd: app.jd,
    resumeText: app.resumeText,
    header,
    prep: { questions: prep.questions, jdSkills: prep.jdSkills, formatAdvice: prep.formatAdvice },
    answers,
    companyNote: '',
    website: '',
    hiringManager: '',
    tone: 'warm',
    format,
    formatChosen: false,
    research,
    researchState: 'done',
    researchError: '',
    selected: [],
    letter: w.letter,
    draft: w.draft,
    human: w.human,
    humanStart: w.humanStart,
    passes: w.passes,
    scrubChanges: w.scrubChanges,
    flags: w.flags,
    pdfInfo: w.pdf,
    model: w.model,
    savedDir: `${GENERIC_DIR}\\${company}\\${role}`,
    savedText: '',
    saveCompany: '',
    saveRole: '',
  };

  console.log(`Researching ${RESEARCH_DEMO.company} for the research image…`);
  const real = await api('/api/cover/research', RESEARCH_DEMO);

  fs.mkdirSync(path.join(root, 'docs', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'demo', 'cover.json'), JSON.stringify(state, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'docs', 'demo', 'cover-research.json'), JSON.stringify({ ...RESEARCH_DEMO, research: real }, null, 2) + '\n');
  console.log(`Human read ${w.humanStart.score} → ${w.human.score} (${w.human.label}); format ${format}; ${w.passes.length} editing pass(es)`);
  console.log(`Flags: ${JSON.stringify(w.flags)}; research on ${RESEARCH_DEMO.company}: ${real.method}, ${real.facts.length} facts`);
} finally {
  await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
