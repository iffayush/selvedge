import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Settings go to a throwaway folder; set before the modules read it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-server-'));
process.env.SELVEDGE_CONFIG_DIR = tmp;
delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_API_KEY;

const { startServer } = await import('../lib/server-app.js');
const config = await import('../lib/config.js');

function request(url, { method = 'GET', host, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method, headers: { host: host || u.host, 'content-type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null }));
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('starts on a free port, checks the Host header, and uses the injected hooks', async () => {
  let quit = 0;
  let opened = null;
  const s = await startServer({
    port: 0,
    onQuit: () => quit++,
    chooseFolder: async () => 'C:\\Picked\\Folder',
    openPath: (dir) => (opened = dir),
  });
  try {
    assert.ok(s.port > 0);
    assert.equal(s.url, `http://127.0.0.1:${s.port}`);

    const ok = await request(`${s.url}/api/health`);
    assert.deepEqual(ok.json, { ok: true, app: 'selvedge' });

    const evil = await request(`${s.url}/api/health`, { host: `evil.example:${s.port}` });
    assert.equal(evil.status, 403);
    const wrongPort = await request(`${s.url}/api/health`, { host: '127.0.0.1:1' });
    assert.equal(wrongPort.status, 403);

    const picked = await request(`${s.url}/api/choose-folder`, { method: 'POST', body: {} });
    assert.equal(picked.json.path, 'C:\\Picked\\Folder');

    const settings = await request(`${s.url}/api/settings`);
    assert.equal(settings.json.keySource, null);

    // open-folder only works inside the applications folder, and then uses the injected opener
    const root = path.join(tmp, 'apps');
    fs.mkdirSync(path.join(root, 'Acme'), { recursive: true });
    await request(`${s.url}/api/settings`, { method: 'POST', body: { rootFolder: root } });
    const outside = await request(`${s.url}/api/open-folder`, { method: 'POST', body: { dir: tmp } });
    assert.equal(outside.status, 400);
    const inside = await request(`${s.url}/api/open-folder`, { method: 'POST', body: { dir: path.join(root, 'Acme') } });
    assert.equal(inside.status, 200);
    assert.equal(opened, path.join(root, 'Acme'));

    await request(`${s.url}/api/quit`, { method: 'POST', body: {} });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(quit, 1);
  } finally {
    await s.close();
  }
});

test('a busy port is reported as EADDRINUSE', async () => {
  const a = await startServer({ port: 0, onQuit: () => {} });
  try {
    await assert.rejects(startServer({ port: a.port, onQuit: () => {} }), (err) => err.code === 'EADDRINUSE');
  } finally {
    await a.close();
  }
});

test('with a secret store the key is saved encrypted, and still read back', () => {
  const file = path.join(tmp, 'config.json');
  // a reversible stand-in for Windows DPAPI
  config.setSecretStore({
    encrypt: (s) => 'enc:' + Buffer.from(s).toString('base64'),
    decrypt: (s) => Buffer.from(s.replace(/^enc:/, ''), 'base64').toString(),
  });
  config.saveConfig({ geminiKey: 'AIzaTEST-1234' });
  let disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.geminiKey, '');
  assert.match(disk.geminiKeyEnc, /^enc:/);
  assert.equal(config.loadConfig().geminiKey, 'AIzaTEST-1234');
  assert.equal(config.publicConfig().keySource, 'settings');
  assert.equal(config.publicConfig().keyHint, '…1234');

  // saving something else keeps the key encrypted
  config.saveConfig({ model: 'gemini-3.5-flash' });
  disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.geminiKey, '');
  assert.match(disk.geminiKeyEnc, /^enc:/);

  // clearing removes it
  config.saveConfig({ geminiKey: '' });
  disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.geminiKeyEnc, undefined);
  assert.equal(config.publicConfig().keySource, null);

  // a key stored in plain text earlier gets encrypted
  config.setSecretStore(null);
  config.saveConfig({ geminiKey: 'AIzaPLAIN-9999' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).geminiKey, 'AIzaPLAIN-9999');
  config.setSecretStore({
    encrypt: (s) => 'enc:' + Buffer.from(s).toString('base64'),
    decrypt: (s) => Buffer.from(s.replace(/^enc:/, ''), 'base64').toString(),
  });
  assert.equal(config.encryptStoredKey(), true);
  disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.geminiKey, '');
  assert.equal(config.loadConfig().geminiKey, 'AIzaPLAIN-9999');

  // without the store (browser mode) the encrypted key is kept untouched when saving other settings
  config.setSecretStore(null);
  config.saveConfig({ model: 'gemini-3.6-flash' });
  disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.match(disk.geminiKeyEnc, /^enc:/);
});
