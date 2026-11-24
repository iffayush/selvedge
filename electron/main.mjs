// Selvedge desktop app: the Electron main process.
// Runs the app's local server in-process on 127.0.0.1 and shows it in its own window.
import { app, BrowserWindow, Menu, dialog, safeStorage, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(here, '..', 'assets', 'selvedge.ico');
const PORTS = Array.from({ length: 13 }, (_, i) => 5178 + i); // 5178–5190

let win = null;
let server = null;
let baseUrl = '';
let logFile = null;

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => (p instanceof Error ? p.stack : String(p))).join(' ')}\n`;
  try {
    if (logFile) fs.appendFileSync(logFile, line);
  } catch {}
}

/** Start the server on the first free port in PORTS, so the window's origin stays stable. */
async function startOnFreePort(startServer, hooks) {
  let lastErr;
  for (const port of PORTS) {
    try {
      return await startServer({ port, ...hooks });
    } catch (err) {
      lastErr = err;
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw lastErr;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 420,
    minHeight: 600,
    title: 'Selvedge',
    icon: ICON,
    backgroundColor: '#F3F5EF',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    win = null;
  });

  // External links (e.g. Google AI Studio) open in the default browser; the window never leaves the app.
  const isApp = (target) => target === baseUrl || target.startsWith(`${baseUrl}/`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !isApp(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isApp(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  // A right-click menu for text fields (Electron has none by default), with spelling suggestions.
  win.webContents.on('context-menu', (event, params) => {
    const items = [];
    for (const suggestion of params.dictionarySuggestions.slice(0, 4)) {
      items.push({ label: suggestion, click: () => win.webContents.replaceMisspelling(suggestion) });
    }
    if (params.misspelledWord) {
      items.push({
        label: 'Add to dictionary',
        click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      items.push({ type: 'separator' });
    }
    if (params.isEditable) {
      items.push({ role: 'cut', enabled: params.editFlags.canCut }, { role: 'copy', enabled: params.editFlags.canCopy });
      items.push({ role: 'paste', enabled: params.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll' });
    } else if (params.selectionText.trim()) {
      items.push({ role: 'copy' });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  win.loadURL(baseUrl);
}

async function boot() {
  const config = await import('../lib/config.js');
  logFile = path.join(config.APP_DIR, 'app.log');
  fs.mkdirSync(config.APP_DIR, { recursive: true });

  // Keep a pasted API key encrypted with Windows DPAPI.
  if (safeStorage.isEncryptionAvailable()) {
    config.setSecretStore({
      encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
      decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
    });
    if (config.encryptStoredKey()) log('Encrypted a previously saved API key.');
  }

  // "Download PDF" asks where to save, starting in Downloads.
  session.defaultSession.on('will-download', (event, item) => {
    item.setSaveDialogOptions({
      title: 'Save PDF',
      defaultPath: path.join(app.getPath('downloads'), item.getFilename()),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
  });

  const { startServer } = await import('../lib/server-app.js');
  server = await startOnFreePort(startServer, {
    onQuit: () => app.quit(),
    openPath: (dir) => shell.openPath(dir),
    chooseFolder: async (start) => {
      const result = await dialog.showOpenDialog(win ?? undefined, {
        title: 'Choose where Selvedge saves your applications',
        defaultPath: start || app.getPath('documents'),
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? null : result.filePaths[0] || null;
    },
  });
  baseUrl = server.url;
  log(`Started on ${baseUrl}`);
  createWindow();
}

if (!app.requestSingleInstanceLock()) {
  // Another copy is already open; it will bring its window to the front.
  app.quit();
} else {
  app.setAppUserModelId('app.selvedge.desktop');
  Menu.setApplicationMenu(null);

  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.on('window-all-closed', () => app.quit());

  // Close the local server first; the windows are already gone by now, so exit directly
  // (a second app.quit() from inside will-quit is ignored).
  app.on('will-quit', (event) => {
    if (!server) return;
    event.preventDefault();
    const s = server;
    server = null;
    const timeout = setTimeout(() => app.exit(0), 3000);
    s.close().finally(() => {
      clearTimeout(timeout);
      app.exit(0);
    });
  });

  app.whenReady()
    .then(boot)
    .catch((err) => {
      log('Startup failed:', err);
      dialog.showErrorBox(
        'Selvedge could not start',
        `${err?.message || err}\n\nDetails were written to ${logFile || 'the app log'}.`,
      );
      app.exit(1);
    });
}
