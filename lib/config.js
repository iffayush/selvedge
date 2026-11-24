// App settings, stored outside the project folder in %APPDATA%\Selvedge\config.json.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { DEFAULT_MODEL, resolveApiKey } from './gemini.js';

const appDataRoot = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

export const APP_DIR = process.env.SELVEDGE_CONFIG_DIR || path.join(appDataRoot, 'Selvedge');
export const CONFIG_FILE = path.join(APP_DIR, 'config.json');
export const UPLOAD_DIR = path.join(APP_DIR, 'uploads');

// The app used to be called "Resume Tailor". Bring its settings across once.
const LEGACY_CONFIG_FILE = path.join(appDataRoot, 'ResumeTailor', 'config.json');
if (!process.env.SELVEDGE_CONFIG_DIR && !fs.existsSync(CONFIG_FILE) && fs.existsSync(LEGACY_CONFIG_FILE)) {
  try {
    fs.mkdirSync(APP_DIR, { recursive: true });
    fs.copyFileSync(LEGACY_CONFIG_FILE, CONFIG_FILE);
  } catch {
    // start with defaults
  }
}

let documentsDirCache;

/** The user's real Documents folder (it may be redirected to OneDrive). */
export function documentsDir() {
  if (documentsDirCache) return documentsDirCache;
  let dir = path.join(os.homedir(), 'Documents');
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Personal'],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const m = out.match(/Personal\s+REG_(?:EXPAND_)?SZ\s+(.+)/);
      if (m) {
        const expanded = m[1].trim().replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`);
        if (!expanded.includes('%')) dir = expanded;
      }
    } catch {
      // fall back to ~/Documents
    }
  }
  documentsDirCache = dir;
  return dir;
}

/** Default applications folder: Documents\Selvedge, or the older Documents\Resume Tailor if that's where they are. */
export function defaultRootFolder(docs = documentsDir()) {
  const current = path.join(docs, 'Selvedge');
  const legacy = path.join(docs, 'Resume Tailor');
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
}

function defaults() {
  return {
    model: DEFAULT_MODEL,
    geminiKey: '',
    rootFolder: defaultRootFolder(),
  };
}

// The desktop app plugs in Windows DPAPI (Electron safeStorage) here so a pasted API key is
// stored encrypted as `geminiKeyEnc`. Without a store (browser mode) the key is stored as before.
let secretStore = null;

/** @param {{encrypt: (s: string) => string, decrypt: (s: string) => string} | null} store */
export function setSecretStore(store) {
  secretStore = store;
}

export function loadConfig() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}
  const cfg = { ...defaults(), ...saved };
  if (cfg.geminiKeyEnc && secretStore && !cfg.geminiKey) {
    try {
      cfg.geminiKey = secretStore.decrypt(cfg.geminiKeyEnc);
    } catch {
      // encrypted for another Windows account: treat as no key
    }
  }
  return cfg;
}

export function saveConfig(patch) {
  const allowed = ['model', 'geminiKey', 'rootFolder'];
  const clean = {};
  for (const key of allowed) {
    if (key in patch && typeof patch[key] === 'string') clean[key] = patch[key].trim();
  }
  if (clean.model !== undefined && !/^[\w.\-]{3,80}$/.test(clean.model)) delete clean.model;
  const current = loadConfig();
  const next = { ...current, ...clean };

  // What goes to disk: never a plain key when a secret store is available.
  const toWrite = { ...next };
  const key = 'geminiKey' in clean ? clean.geminiKey : current.geminiKey;
  if ('geminiKey' in clean) delete toWrite.geminiKeyEnc;
  if (secretStore && key) {
    toWrite.geminiKeyEnc = 'geminiKey' in clean || !current.geminiKeyEnc ? secretStore.encrypt(key) : current.geminiKeyEnc;
    toWrite.geminiKey = '';
  }
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(toWrite, null, 2));
  return next;
}

/** Re-save a key that is still stored in plain text, now that a secret store is available. */
export function encryptStoredKey() {
  if (!secretStore) return false;
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (saved.geminiKey && !saved.geminiKeyEnc) {
      saveConfig({});
      return true;
    }
  } catch {}
  return false;
}

/** Settings as the browser may see them: the key itself is never sent back. */
export function publicConfig(cfg = loadConfig()) {
  const key = resolveApiKey(cfg);
  return {
    model: cfg.model,
    rootFolder: cfg.rootFolder,
    keySource: key?.source ?? null,
    keyHint: key ? `…${key.key.slice(-4)}` : '',
  };
}
