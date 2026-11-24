// Captures the README screenshots from the real app, using the fictional demo data.
//   node scripts/make-demo-data.mjs     (once, needs GEMINI_API_KEY)
//   npx electron scripts/screenshots.mjs
//   node scripts/pdf-preview.mjs        (the PDF image)
// Writes PNGs to docs/screenshots. Uses a throwaway settings folder; file paths shown in the
// UI are replaced with a generic one so no local folder names end up in the images.
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const SCALE = 1.5;
const GENERIC_ROOT = 'C:\\Users\\you\\Documents\\Selvedge';

app.disableHardwareAcceleration();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'selvedge-shots-'));
process.env.SELVEDGE_CONFIG_DIR = path.join(tmp, 'config');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Copy docs/example into a temp applications folder so History has an entry. */
function seedApplications() {
  const example = path.join(ROOT, 'docs', 'example');
  const { company, role } = JSON.parse(fs.readFileSync(path.join(example, 'folder.json'), 'utf8'));
  const dir = path.join(tmp, 'apps', company, role);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(example)) if (f !== 'folder.json') fs.copyFileSync(path.join(example, f), path.join(dir, f));
  return path.join(tmp, 'apps');
}

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const appsRoot = seedApplications();
  const { startServer } = await import('../lib/server-app.js');
  const server = await startServer({ port: 0, onQuit: () => {}, chooseFolder: async () => null, openPath: () => {} });
  await fetch(`${server.url}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootFolder: appsRoot }),
  });
  const session = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'demo', 'session.json'), 'utf8'));

  const win = new BrowserWindow({
    show: false,
    width: 1440 * SCALE,
    height: 900 * SCALE,
    backgroundColor: '#F3F5EF',
    webPreferences: { offscreen: true, contextIsolation: true, sandbox: true },
  });
  win.webContents.setFrameRate(30);
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(SCALE);
    // no scrollbars in the images
    win.webContents.insertCSS('html { scrollbar-width: none; } ::-webkit-scrollbar { display: none; }');
  });

  const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
  const settle = async () => {
    await js('await document.fonts.ready; return true;');
    await wait(700);
  };
  const tidy = () =>
    js(`
      const generic = ${JSON.stringify(GENERIC_ROOT)};
      const hr = document.querySelector('#historyRoot'); if (hr && hr.textContent) hr.textContent = 'Saved in ' + generic;
      const sp = document.querySelector('#savePreview');
      if (sp && sp.textContent) sp.textContent = sp.textContent.replace(/(Saves to|Updates) .*?(\\\\[^\\\\]+\\\\[^\\\\]+)$/, '$1 ' + generic + '$2');
      document.querySelector('#aiBadge')?.classList.add('ok');
      document.querySelectorAll('.toast').forEach((t) => t.remove());
      return true;`);

  async function shot(name, { height = 900, setup = '', element = null, pad = 28 } = {}) {
    win.setContentSize(Math.round(1440 * SCALE), Math.round(height * SCALE));
    await wait(250);
    if (setup) await js(setup);
    await settle();
    await tidy();
    await wait(200);
    let rect;
    if (element) {
      const r = await js(`const el = document.querySelector(${JSON.stringify(element)}); el.scrollIntoView({block: 'start'}); window.scrollBy(0, -${pad}); await new Promise(r => setTimeout(r, 300)); const b = el.getBoundingClientRect(); return {x: b.x, y: b.y, width: b.width, height: b.height};`);
      await wait(300);
      // CSS pixels -> window pixels
      const x = Math.max(0, r.x - pad);
      const y = Math.max(0, r.y - pad);
      rect = {
        x: Math.floor(x * SCALE),
        y: Math.floor(y * SCALE),
        width: Math.ceil((r.width + pad * 2) * SCALE),
        height: Math.ceil(Math.min(r.height + pad * 2, height - y) * SCALE),
      };
    }
    const img = await win.webContents.capturePage(rect);
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    const size = img.getSize();
    console.log(`  ${name}.png  ${size.width}×${size.height}`);
  }

  // Load the app with the demo session in place.
  await win.loadURL(server.url);
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('selvedge-session-v1', ${JSON.stringify(JSON.stringify(session))}); return true;`);
  await win.loadURL(server.url);
  await settle();

  console.log('Capturing:');
  await shot('intake', { height: 900, setup: `window.scrollTo(0, 0); document.querySelector('#company').value = ''; return true;` });
  await shot('analysis', {
    height: 940,
    setup: `const s = document.querySelector('#results .step-head'); s.scrollIntoView({block: 'start'}); window.scrollBy(0, -36); return true;`,
  });
  await shot('keywords', { height: 1400, setup: `document.querySelector('[data-sub="keywords"]').click(); return true;`, element: '#results .detail-card' });
  await shot('requirements', { height: 1600, setup: `document.querySelector('[data-sub="reqs"]').click(); return true;`, element: '#results .detail-card' });
  await shot('projects', { height: 1500, setup: `document.querySelector('[data-sub="projects"]').click(); return true;`, element: '#results .detail-card' });
  await shot('tailored', {
    height: 1000,
    setup: `const t = document.querySelector('#tailored'); t.scrollIntoView({block: 'start'}); window.scrollBy(0, -28); return true;`,
  });
  await shot('history', { height: 540, setup: `document.querySelector('.tab[data-view="history"]').click(); await new Promise(r => setTimeout(r, 800)); window.scrollTo(0, 0); return true;` });

  // Cover letters (node scripts/make-cover-demo.mjs writes these states)
  const coverFile = path.join(ROOT, 'docs', 'demo', 'cover.json');
  if (fs.existsSync(coverFile)) {
    const cover = JSON.parse(fs.readFileSync(coverFile, 'utf8'));
    const openCover = async (state) => {
      await js(`localStorage.setItem('selvedge-cover-v1', ${JSON.stringify(JSON.stringify(state))}); return true;`);
      await win.loadURL(server.url);
      await settle();
      await js(`document.querySelector('.tab[data-view="cover"]').click(); await new Promise(r => setTimeout(r, 1000)); return true;`);
    };
    await openCover(cover);
    await shot('cover-questions', { height: 1700, element: '#coverPersonal' });
    await shot('cover-letter', { height: 1250, element: '#coverResult' });

    const { company, jobTitle, research } = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'demo', 'cover-research.json'), 'utf8'));
    await openCover({ ...cover, company, jobTitle, research, researchState: 'done', selected: [Math.max(0, research.facts.findIndex((f) => f.sources.some((s) => s.kind === 'news')))].slice(0, research.facts.length), website: '' });
    await shot('cover-research', { height: 1400, element: '.research-card', pad: 20 });
  }

  // First run: no API key anywhere.
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  await js(`localStorage.clear(); sessionStorage.clear(); return true;`);
  await win.loadURL(server.url);
  await settle();
  await shot('welcome', { height: 900, setup: `await new Promise(r => setTimeout(r, 500)); return true;` });

  win.destroy();
  await server.close();
}

app.whenReady()
  .then(run)
  .then(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    app.exit(0);
  })
  .catch((err) => {
    console.error(err);
    app.exit(1);
  });
