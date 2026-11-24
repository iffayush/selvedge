// Saved applications: <root>\<Company>\<Role> (<YYYY-MM-DD>)\ with the resume, JD and reports.
import fs from 'node:fs';
import path from 'node:path';

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export const FILES = {
  jd: 'job-description.txt',
  report: 'ats-report.md',
  resumeJson: 'tailored-resume.json',
  app: 'application.json',
};

/** Make a string safe to use as one Windows folder name. */
export function sanitizeName(input, fallback = 'Untitled', max = 80) {
  let s = String(input ?? '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/[. ]+$/g, '').replace(/^[. ]+/g, '');
  if (s.length > max) s = s.slice(0, max).replace(/[. ]+$/g, '');
  if (!s) s = fallback;
  if (RESERVED.test(s)) s = `_${s}`;
  return s;
}

/** Join under root and refuse anything that resolves outside it. */
export function safeJoin(root, ...parts) {
  const base = path.resolve(root);
  const full = path.resolve(base, ...parts);
  const rel = path.relative(base, full);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw Object.assign(new Error('Path is outside the applications folder.'), { code: 'bad_path' });
  }
  return full;
}

export function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function todayISO(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function encodeId(root, dir) {
  return Buffer.from(path.relative(path.resolve(root), dir), 'utf8').toString('base64url');
}

export function decodeId(root, id) {
  const rel = Buffer.from(String(id), 'base64url').toString('utf8');
  return safeJoin(root, rel);
}

/**
 * Pick the application folder. Reuses `previousDir` when it is the same company and role
 * (saving again in one session overwrites), otherwise picks the first free "Role (date)" name.
 */
export function chooseAppDir(root, company, jobTitle, date, previousDir) {
  const companyDir = safeJoin(root, sanitizeName(company, 'Unknown Company'));
  const role = sanitizeName(jobTitle, 'Role', 70);
  const base = `${role} (${date})`;
  // Same company and role as the folder saved earlier (any date): overwrite it.
  if (previousDir && isInside(root, previousDir) && path.dirname(path.resolve(previousDir)) === companyDir) {
    const name = path.basename(previousDir);
    if (name.startsWith(`${role} (`) && /\(\d{4}-\d{2}-\d{2}\)( \(\d+\))?$/.test(name)) return path.resolve(previousDir);
  }
  let dir = path.join(companyDir, base);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(companyDir, `${base} (${n})`);
  return dir;
}

/**
 * Write one application folder.
 * @param {object} p
 * @param {string} p.root            applications root folder
 * @param {string} p.company
 * @param {string} p.jobTitle
 * @param {string} [p.date]          YYYY-MM-DD
 * @param {string} [p.previousDir]   folder saved earlier in this session
 * @param {Buffer} p.pdf             tailored resume PDF
 * @param {string} p.pdfName
 * @param {string} p.jd
 * @param {string} p.report          markdown
 * @param {object} p.resume          structured tailored resume
 * @param {object} p.app             application.json contents
 * @param {string} [p.originalPath]  uploaded original file on disk
 * @param {string} [p.originalExt]   .pdf or .docx
 */
export function saveApplication(p) {
  let date = p.date || todayISO();
  const dir = chooseAppDir(p.root, p.company, p.jobTitle, date, p.previousDir);
  // Overwriting an earlier save keeps its original date, matching the folder name.
  const existing = readJson(path.join(dir, FILES.app));
  if (existing?.date && /^\d{4}-\d{2}-\d{2}$/.test(existing.date)) date = existing.date;
  fs.mkdirSync(dir, { recursive: true });

  // a renamed candidate or role would leave an old PDF behind
  for (const f of fs.readdirSync(dir)) {
    if (/_Resume\.pdf$/i.test(f) && f !== p.pdfName) fs.rmSync(path.join(dir, f), { force: true });
  }
  fs.writeFileSync(path.join(dir, p.pdfName), p.pdf);

  const header = [
    `Company: ${p.company || 'Unknown Company'}`,
    `Role: ${p.jobTitle || ''}`,
    `Saved: ${date}`,
    '-'.repeat(48),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, FILES.jd), header + String(p.jd || '').trim() + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, FILES.report), p.report, 'utf8');
  fs.writeFileSync(path.join(dir, FILES.resumeJson), JSON.stringify(p.resume, null, 2), 'utf8');

  let originalFile = null;
  if (p.originalPath && fs.existsSync(p.originalPath)) {
    const ext = (p.originalExt || path.extname(p.originalPath) || '.pdf').toLowerCase();
    originalFile = `original-resume${ext}`;
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('original-resume') && f !== originalFile) fs.rmSync(path.join(dir, f), { force: true });
    }
    fs.copyFileSync(p.originalPath, path.join(dir, originalFile));
  }

  const appJson = {
    version: 1,
    ...p.app,
    company: p.company,
    jobTitle: p.jobTitle,
    date,
    savedAt: new Date().toISOString(),
    files: {
      resumePdf: p.pdfName,
      jobDescription: FILES.jd,
      report: FILES.report,
      tailoredResume: FILES.resumeJson,
      originalResume: originalFile,
    },
  };
  fs.writeFileSync(path.join(dir, FILES.app), JSON.stringify(appJson, null, 2), 'utf8');
  return { dir, id: encodeId(p.root, dir), files: fs.readdirSync(dir) };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/** All saved applications under root, newest first. */
export function listApplications(root) {
  const out = [];
  for (const company of subdirs(root)) {
    for (const role of subdirs(path.join(root, company))) {
      const dir = path.join(root, company, role);
      const app = readJson(path.join(dir, FILES.app));
      if (!app) continue;
      out.push({
        id: encodeId(root, dir),
        dir,
        company: app.company || company,
        jobTitle: app.jobTitle || role,
        date: app.date || '',
        savedAt: app.savedAt || '',
        candidateName: app.candidateName || '',
        scores: app.scoresSummary || null,
      });
    }
  }
  out.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  return out;
}

/** Load one application back for editing. */
export function loadApplication(root, id) {
  const dir = decodeId(root, id);
  const app = readJson(path.join(dir, FILES.app));
  if (!app) throw Object.assign(new Error('That saved application could not be found.'), { code: 'not_found' });
  const resume = readJson(path.join(dir, FILES.resumeJson));
  let jd = '';
  try {
    const raw = fs.readFileSync(path.join(dir, FILES.jd), 'utf8');
    const sep = raw.indexOf('-'.repeat(48));
    jd = (sep >= 0 ? raw.slice(sep + 48) : raw).trim();
  } catch {}
  return { id, dir, app, resume, jd };
}
