// Selvedge's HTTP server as a reusable module. Used by:
//  - server.js (development / browser mode: opens a browser tab, stops when idle)
//  - electron/main.mjs (the desktop app: shows it in its own window)
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig, saveConfig, publicConfig, UPLOAD_DIR } from './config.js';
import { askStructured, generateJson, listModels, resolveApiKey, AIError } from './gemini.js';
import {
  AnalysisSchema, AnalysisInputSchema, ANALYSIS_JSON_SCHEMA, ANALYZE_SYSTEM, analyzePrompt,
  TailorSchema, TAILOR_JSON_SCHEMA, TAILOR_SYSTEM, tailorPrompt,
  RecheckSchema, RECHECK_JSON_SCHEMA, RECHECK_SYSTEM, recheckPrompt,
  ResumeInputSchema,
} from './prompts.js';
import { parseResume, ParseError } from './parse.js';
import { computeScores, resumeToText, generatedMeta, findPlaceholders, unconfirmedAdditions, changedNumbers, matchKeywords } from './ats.js';
import { buildResumePdf, layoutResumePdf, resumeFileName } from './pdf.js';
import { buildReport } from './report.js';
import { saveApplication, listApplications, loadApplication, isInside, todayISO } from './library.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(here, '..', 'public');

// ---------- helpers ----------

function sendError(res, status, code, message, detail) {
  res.status(status).json({ error: { code, message, detail: detail ? String(detail).slice(0, 2000) : undefined } });
}

function handleError(res, err) {
  if (err instanceof AIError) {
    const status = {
      no_key: 401, auth: 401, model: 400, limit: 429, overloaded: 503, network: 503, timeout: 504, cancelled: 499,
    }[err.code] ?? 502;
    return sendError(res, status, err.code, err.message, err.detail);
  }
  if (err instanceof ParseError) return sendError(res, 422, err.code, err.message);
  if (err?.code === 'bad_path') return sendError(res, 400, 'bad_path', err.message);
  if (err?.code === 'bad_request') return sendError(res, 400, 'bad_request', err.message);
  if (err?.code === 'not_found') return sendError(res, 404, 'not_found', err.message);
  if (err?.name === 'ZodError') return sendError(res, 400, 'bad_request', 'The request data was not in the expected shape.', err.message);
  console.error(err);
  return sendError(res, 500, 'internal', err?.message || 'Something went wrong.');
}

/** Gemini settings for one call. */
function aiContext() {
  const cfg = loadConfig();
  return { cfg, apiKey: resolveApiKey(cfg)?.key, model: cfg.model };
}

function requireText(value, name, max = 60000) {
  const s = String(value ?? '').trim();
  if (!s) throw Object.assign(new Error(`${name} is empty.`), { code: 'bad_request' });
  return s.slice(0, max);
}

/** Default folder picker: the native Windows dialog, through PowerShell. Resolves a path or null. */
export function powershellChooseFolder(start) {
  return new Promise((resolve, reject) => {
    const script = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$f.Description = 'Choose where Selvedge saves your applications'",
      '$f.ShowNewFolderButton = $true',
      'if ($env:RT_START -and (Test-Path $env:RT_START)) { $f.SelectedPath = $env:RT_START }',
      '$owner = New-Object System.Windows.Forms.Form -Property @{TopMost = $true; ShowInTaskbar = $false}',
      "if ($f.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($f.SelectedPath) }",
    ].join('; ');
    const ps = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      env: { ...process.env, RT_START: start || '' },
      windowsHide: true,
    });
    let out = '';
    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', (d) => (out += d));
    ps.on('error', reject);
    ps.on('close', () => resolve(out.trim() || null));
  });
}

/** Default "open folder": Windows Explorer. */
export function explorerOpenPath(target) {
  spawn('explorer.exe', [path.resolve(target)], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function tidyUploads() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  // remove uploads older than 7 days
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    const p = path.join(UPLOAD_DIR, f);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > 7 * 24 * 3600 * 1000) fs.rmSync(p, { force: true });
    } catch {}
  }
}

function uploadPath(uploadId) {
  if (!/^[a-f0-9]{24}\.(pdf|docx)$/.test(String(uploadId || ''))) return null;
  const p = path.join(UPLOAD_DIR, uploadId);
  return fs.existsSync(p) ? p : null;
}

/**
 * Build the Express app.
 * @param {object} o
 * @param {() => number} o.getPort        the port actually bound (for the Host check)
 * @param {string} o.host
 * @param {() => void} o.onQuit           called after POST /api/quit has answered
 * @param {(start: string) => Promise<string|null>} o.chooseFolder
 * @param {(dir: string) => void} o.openPath
 * @param {() => void} o.onActivity       called on heartbeats and after each AI call
 * The returned app exposes app.locals.isBusy(): whether an AI call is running.
 */
export function createApp({ getPort, host, onQuit, chooseFolder, openPath, onActivity }) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '8mb' }));

  // One AI call at a time.
  let busy = false;
  app.locals.isBusy = () => busy;
  async function withAI(req, res, fn) {
    if (busy) return sendError(res, 409, 'busy', 'Gemini is already working on something. Wait for it to finish.');
    busy = true;
    const ctl = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ctl.abort();
    });
    try {
      const result = await fn(ctl.signal);
      if (!res.headersSent) res.json(result);
    } catch (err) {
      if (!res.headersSent) handleError(res, err);
    } finally {
      busy = false;
      onActivity();
    }
  }

  // Only accept requests addressed to this machine (blocks DNS-rebinding style access).
  app.use((req, res, next) => {
    const port = getPort();
    const reqHost = String(req.headers.host || '');
    if (reqHost !== `${host}:${port}` && reqHost !== `localhost:${port}`) return sendError(res, 403, 'forbidden', 'Forbidden host.');
    if (req.method !== 'GET' && req.headers.origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(req.headers.origin)) {
      return sendError(res, 403, 'forbidden', 'Forbidden origin.');
    }
    next();
  });

  app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

  app.get('/api/health', (req, res) => res.json({ ok: true, app: 'selvedge' }));

  app.post('/api/heartbeat', (req, res) => {
    onActivity();
    res.json({ ok: true });
  });

  app.post('/api/quit', (req, res) => {
    res.json({ ok: true });
    setTimeout(onQuit, 200);
  });

  // ----- settings -----

  app.get('/api/settings', (req, res) => {
    res.json(publicConfig(loadConfig()));
  });

  app.post('/api/settings', (req, res) => {
    try {
      const body = req.body || {};
      const patch = {};
      for (const k of ['model', 'rootFolder']) if (typeof body[k] === 'string') patch[k] = body[k];
      if (typeof body.geminiKey === 'string') patch.geminiKey = body.geminiKey.replace(/\s+/g, '');
      if (body.clearKey === true) patch.geminiKey = '';
      if (patch.rootFolder !== undefined) {
        const dir = patch.rootFolder.trim();
        if (!dir || !path.isAbsolute(dir)) return sendError(res, 400, 'bad_folder', 'Choose a full folder path, like C:\\Users\\you\\Documents\\Selvedge.');
        fs.mkdirSync(dir, { recursive: true });
      }
      res.json(publicConfig(saveConfig(patch)));
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/api/models', async (req, res) => {
    try {
      const { apiKey, model } = aiContext();
      res.json({ models: await listModels(apiKey), current: model });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post('/api/choose-folder', async (req, res) => {
    try {
      res.json({ path: (await chooseFolder(loadConfig().rootFolder)) || null });
    } catch (err) {
      sendError(res, 500, 'picker', `Could not open the folder picker: ${err.message}`);
    }
  });

  // Quick check that the key works with the chosen model.
  app.post('/api/test-ai', (req, res) =>
    withAI(req, res, async (signal) => {
      const { apiKey, model } = aiContext();
      const started = Date.now();
      const { data } = await generateJson({
        apiKey,
        model,
        systemPrompt: 'You are a connection test.',
        prompt: 'Reply with {"ok": true}.',
        jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        timeoutMs: 90000,
        signal,
      });
      return { ok: data?.ok === true, model, seconds: Math.round((Date.now() - started) / 100) / 10 };
    }),
  );

  // ----- parsing -----

  app.post('/api/parse', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return sendError(res, 400, 'no_file', 'Choose a PDF or DOCX file.');
      const { text, meta } = await parseResume(req.file.buffer, req.file.originalname);
      const ext = meta.kind === 'pdf' ? '.pdf' : '.docx';
      const uploadId = crypto.randomBytes(12).toString('hex') + ext;
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      fs.writeFileSync(path.join(UPLOAD_DIR, uploadId), req.file.buffer);
      res.json({ uploadId, fileName: req.file.originalname, text, meta });
    } catch (err) {
      handleError(res, err);
    }
  });

  // ----- Gemini: analyze, tailor, recheck -----

  app.post('/api/analyze', (req, res) =>
    withAI(req, res, async (signal) => {
      const resumeText = requireText(req.body.resumeText, 'The resume');
      const jd = requireText(req.body.jd, 'The job description');
      const meta = req.body.meta && typeof req.body.meta === 'object' ? req.body.meta : {};
      const { apiKey, model } = aiContext();
      const { data: analysis, model: modelUsed } = await askStructured({
        apiKey,
        model,
        systemPrompt: ANALYZE_SYSTEM,
        prompt: analyzePrompt({ resumeText, jd, jobTitle: req.body.jobTitle, company: req.body.company }),
        zodSchema: AnalysisSchema,
        jsonSchema: ANALYSIS_JSON_SCHEMA,
        signal,
      });
      analysis.fitScore = Math.max(0, Math.min(100, Math.round(analysis.fitScore)));
      if (req.body.company && !analysis.company) analysis.company = String(req.body.company);
      if (req.body.jobTitle && !analysis.jobTitle) analysis.jobTitle = String(req.body.jobTitle);
      const scores = computeScores({
        text: resumeText,
        meta,
        keywords: analysis.keywords,
        requirements: analysis.requirements,
        fitScore: analysis.fitScore,
      });
      return { analysis, scores, model: modelUsed };
    }),
  );

  app.post('/api/tailor', (req, res) =>
    withAI(req, res, async (signal) => {
      const resumeText = requireText(req.body.resumeText, 'The resume');
      const jd = requireText(req.body.jd, 'The job description');
      const analysis = AnalysisInputSchema.parse(req.body.analysis);
      const confirmed = Array.isArray(req.body.confirmedKeywords) ? req.body.confirmedKeywords.map(String).slice(0, 50) : [];
      // Keywords the original already matches: named explicitly so tailoring never loses one.
      const keepKeywords = matchKeywords(resumeText, analysis.keywords)
        .filter((m) => m.matched)
        .map((m) => (m.matchedAs && m.matchedAs !== m.term ? `${m.term} (written as "${m.matchedAs}" in the original)` : m.term));
      const { apiKey, model } = aiContext();
      const { data: result, model: modelUsed } = await askStructured({
        apiKey,
        model,
        systemPrompt: TAILOR_SYSTEM,
        prompt: tailorPrompt({ resumeText, jd, analysis, confirmedKeywords: confirmed, keepKeywords }),
        zodSchema: TailorSchema,
        jsonSchema: TAILOR_JSON_SCHEMA,
        signal,
      });
      const text = resumeToText(result.resume);
      const scores = computeScores({
        text,
        meta: generatedMeta(text),
        keywords: analysis.keywords,
        requirements: analysis.requirements,
        fitScore: analysis.fitScore,
      });
      const { pages, fontSize, fits } = await layoutResumePdf(result.resume);
      return {
        ...result,
        scores,
        placeholdersFound: findPlaceholders(text),
        unconfirmed: unconfirmedAdditions(resumeText, text, analysis.keywords, confirmed),
        changedNumbers: changedNumbers(resumeText, text),
        pdf: { pages, fontSize, fits },
        model: modelUsed,
      };
    }),
  );

  app.post('/api/recheck', (req, res) =>
    withAI(req, res, async (signal) => {
      const resume = ResumeInputSchema.parse(req.body.resume);
      const jd = requireText(req.body.jd, 'The job description');
      const analysis = AnalysisInputSchema.parse(req.body.analysis);
      const text = resumeToText(resume);
      const { apiKey, model } = aiContext();
      const { data: check, model: modelUsed } = await askStructured({
        apiKey,
        model,
        systemPrompt: RECHECK_SYSTEM,
        prompt: recheckPrompt({ resumeText: text, jd, requirements: analysis.requirements }),
        zodSchema: RecheckSchema,
        jsonSchema: RECHECK_JSON_SCHEMA,
        signal,
      });
      const requirements = analysis.requirements.map((r, i) => {
        const hit = check.requirements.find((c) => Math.round(c.index) === i);
        return hit ? { ...r, status: hit.status, evidence: hit.evidence } : r;
      });
      const fitScore = Math.max(0, Math.min(100, Math.round(check.fitScore)));
      const scores = computeScores({ text, meta: generatedMeta(text), keywords: analysis.keywords, requirements, fitScore });
      return { requirements, fitScore, fitRationale: check.fitRationale, scores, model: modelUsed };
    }),
  );

  // Deterministic re-score while the user edits the tailored resume (no AI call).
  app.post('/api/score', async (req, res) => {
    try {
      const resume = ResumeInputSchema.parse(req.body.resume);
      const analysis = AnalysisInputSchema.parse(req.body.analysis);
      const requirements = Array.isArray(req.body.requirements) ? req.body.requirements : analysis.requirements;
      const fitScore = Number.isFinite(req.body.fitScore) ? req.body.fitScore : analysis.fitScore;
      const text = resumeToText(resume);
      const confirmed = Array.isArray(req.body.confirmedKeywords) ? req.body.confirmedKeywords.map(String) : [];
      const { pages, fontSize, fits } = await layoutResumePdf(resume);
      const original = typeof req.body.originalText === 'string' ? req.body.originalText.trim() : '';
      res.json({
        scores: computeScores({ text, meta: generatedMeta(text), keywords: analysis.keywords, requirements, fitScore }),
        placeholdersFound: findPlaceholders(text),
        unconfirmed: original ? unconfirmedAdditions(original, text, analysis.keywords, confirmed) : [],
        changedNumbers: original ? changedNumbers(original, text) : [],
        pdf: { pages, fontSize, fits },
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  // ----- PDF and saving -----

  app.post('/api/pdf', async (req, res) => {
    try {
      const resume = ResumeInputSchema.parse(req.body.resume);
      const { pdf, pages } = await layoutResumePdf(resume);
      const name = resumeFileName(resume.name, req.body.jobTitle);
      res.setHeader('X-Resume-Pages', String(pages));
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      res.send(pdf);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post('/api/save', async (req, res) => {
    try {
      const body = req.body || {};
      const resume = ResumeInputSchema.parse(body.resume);
      const analysis = AnalysisInputSchema.parse(body.analysis);
      const cfg = loadConfig();
      const root = cfg.rootFolder;
      if (!root || !path.isAbsolute(root)) return sendError(res, 400, 'no_root', 'Set a folder for saved applications in Settings first.');
      fs.mkdirSync(root, { recursive: true });

      const text = resumeToText(resume);
      const left = findPlaceholders(text);
      if (left.length) return sendError(res, 400, 'placeholders', `Fill in or remove these placeholders first: ${left.join(', ')}`);

      const company = String(body.company || analysis.company || '').trim();
      const jobTitle = String(body.jobTitle || analysis.jobTitle || '').trim();
      const date = todayISO();
      const pdf = await buildResumePdf(resume);
      const pdfName = resumeFileName(resume.name, jobTitle);
      const before = body.scoresBefore || null;
      const after = body.scoresAfter || null;
      const report = buildReport({ company, jobTitle, date, model: body.model || cfg.model, analysis, before, after, changes: body.changes || [] });

      const previousDir = typeof body.previousDir === 'string' && isInside(root, body.previousDir) ? body.previousDir : undefined;
      const originalPath = uploadPath(body.uploadId);
      const saved = saveApplication({
        root,
        company,
        jobTitle,
        date,
        previousDir,
        pdf,
        pdfName,
        jd: body.jd || '',
        report,
        resume,
        originalPath,
        originalExt: originalPath ? path.extname(originalPath) : undefined,
        app: {
          candidateName: resume.name,
          model: body.model || cfg.model,
          originalFileName: body.originalFileName || null,
          originalResumeText: body.originalResumeText || '',
          originalMeta: body.originalMeta || null,
          confirmedKeywords: body.confirmedKeywords || [],
          analysis,
          changes: body.changes || [],
          recheck: body.recheck || null,
          scoresBefore: before,
          scoresAfter: after,
          scoresSummary: {
            atsBefore: before?.ats?.score ?? null,
            atsAfter: after?.ats?.score ?? null,
            confidenceBefore: before?.confidence?.score ?? null,
            confidenceAfter: after?.confidence?.score ?? null,
            confidenceLabel: (after ?? before)?.confidence?.label ?? null,
          },
        },
      });
      res.json({ dir: saved.dir, id: saved.id, files: saved.files });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/api/applications', (req, res) => {
    try {
      const root = loadConfig().rootFolder;
      res.json({ root, applications: root && fs.existsSync(root) ? listApplications(root) : [] });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/api/applications/:id', (req, res) => {
    try {
      res.json(loadApplication(loadConfig().rootFolder, req.params.id));
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post('/api/open-folder', (req, res) => {
    const root = loadConfig().rootFolder;
    const dir = String(req.body?.dir || '');
    const target = dir === root ? root : dir;
    if (!target || !(target === root || isInside(root, target)) || !fs.existsSync(target)) {
      return sendError(res, 400, 'bad_path', 'That folder is not inside your applications folder.');
    }
    try {
      openPath(path.resolve(target));
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.use('/api', (req, res) => sendError(res, 404, 'not_found', 'Unknown API route.'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      return sendError(res, 413, 'too_large', err.code === 'LIMIT_FILE_SIZE' ? 'That file is over 15 MB.' : err.message);
    }
    if (err?.type === 'entity.too.large') return sendError(res, 413, 'too_large', 'That request is too large.');
    handleError(res, err);
  });

  return app;
}

/**
 * Start the server.
 * @param {object} [opts]
 * @param {number} [opts.port=5178]   0 picks a free port
 * @param {string} [opts.host='127.0.0.1']
 * @param {() => void} [opts.onQuit]  default: exit the process
 * @param {(start: string) => Promise<string|null>} [opts.chooseFolder]
 * @param {(dir: string) => void} [opts.openPath]
 * @param {number} [opts.idleMs=0]    stop (onQuit) after this long without a heartbeat; 0 = never
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>, server: import('node:http').Server}>}
 *          Rejects with the listen error (e.g. code EADDRINUSE).
 */
export function startServer(opts = {}) {
  const host = opts.host || '127.0.0.1';
  const onQuit = opts.onQuit || (() => process.exit(0));
  let boundPort = opts.port ?? 5178;
  let lastBeat = Date.now();
  tidyUploads();

  const app = createApp({
    getPort: () => boundPort,
    host,
    onQuit,
    chooseFolder: opts.chooseFolder || powershellChooseFolder,
    openPath: opts.openPath || explorerOpenPath,
    onActivity: () => {
      lastBeat = Date.now();
    },
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(boundPort, host);
    server.once('error', reject);
    server.once('listening', () => {
      server.off('error', reject);
      boundPort = server.address().port;
      let idleTimer = null;
      if (opts.idleMs > 0) {
        idleTimer = setInterval(() => {
          if (!app.locals.isBusy() && Date.now() - lastBeat > opts.idleMs) {
            console.log('No open Selvedge window; shutting down.');
            onQuit();
          }
        }, 30 * 1000);
        idleTimer.unref();
      }
      resolve({
        url: `http://${host}:${boundPort}`,
        port: boundPort,
        server,
        close: () =>
          new Promise((done) => {
            if (idleTimer) clearInterval(idleTimer);
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
