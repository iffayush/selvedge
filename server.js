// Selvedge in browser mode (for development): `npm start`.
// Serves the app on 127.0.0.1, opens it in your browser, and stops when no tab has checked in
// for a while. The desktop app (electron/main.mjs) uses the same server module.
import { spawn } from 'node:child_process';
import { startServer } from './lib/server-app.js';

const PORT = Number(process.env.SELVEDGE_PORT || 5178);
const IDLE_MS = Number(process.env.SELVEDGE_IDLE_MINUTES || 10) * 60 * 1000;
const NO_OPEN = process.env.SELVEDGE_NO_OPEN === '1';

function openInBrowser(url) {
  if (NO_OPEN) return;
  spawn('explorer.exe', [url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

try {
  const { url } = await startServer({ port: PORT, idleMs: IDLE_MS, onQuit: () => process.exit(0) });
  console.log(`Selvedge is running at ${url}`);
  openInBrowser(url);
} catch (err) {
  const url = `http://127.0.0.1:${PORT}`;
  if (err.code === 'EADDRINUSE') {
    // Probably already running: just open it.
    try {
      const j = await (await fetch(`${url}/api/health`)).json();
      if (j?.app === 'selvedge') {
        console.log('Selvedge is already running; opening it.');
        openInBrowser(url);
        process.exit(0);
      }
    } catch {}
    console.error(`Port ${PORT} is in use by another program. Set SELVEDGE_PORT to use a different port.`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
}
