// Behind the family lab-proxy: Host is this stub's LAB_ALLOWED_HOSTS name with its PORT, the browser's Origin is the
// launcher's, and the proxy says so in X-Forwarded-Host/-Proto. Placeholder names here; compose sets the real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp, labProxyHosts } from '../server/src/app.js';
import { loadSettings } from '../server/src/settings.js';

const NAME = 'ping-services-stub.proxy.example';
const XFH = 'launcher.example:8443';
const PROXY = `https://${XFH}`;
const HOST = `${NAME}:6300`;
const fwd = { 'x-forwarded-host': XFH, 'x-forwarded-proto': 'https' };
const health = { snapshot: () => ({ schema: 'demo-health/1', at: '', state: 'ready', runtime: 'offline', demo: {} }), ready: async () => true, stop() {} };

async function withStub(fn) {
  const app = createApp({ health, proxyHosts: labProxyHosts({ LAB_ALLOWED_HOSTS: ` ${NAME.toUpperCase()} `, PORT: '6300' }) });
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  try { await fn(server.address().port); } finally { await new Promise((r) => server.close(r)); }
}
const send = (port, method, p, headers, body) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, text: b }));
  });
  req.on('error', reject); req.end(body);
});
const write = (port, headers) => send(port, 'POST', '/api/mode', headers, JSON.stringify({ source: 'mock' }));

test('LAB_ALLOWED_HOSTS: unset is loopback only; names become <name>:<PORT>; a port or URL is refused', () => {
  assert.deepEqual([...labProxyHosts({})], []);
  assert.deepEqual([...labProxyHosts({ LAB_ALLOWED_HOSTS: 'A.example, b.example,', PORT: '6300' })], ['a.example:6300', 'b.example:6300']);
  for (const bad of ['a.example:6300', 'http://a.example', 'a.example/x']) assert.throws(() => labProxyHosts({ LAB_ALLOWED_HOSTS: bad }));
});

test('launcher Host <name>:<PORT> is accepted; the bare name, another port or a Host outside the set is refused', async () => {
  await withStub(async (port) => {
    assert.equal((await send(port, 'GET', '/api/health', { host: HOST })).status, 200);
    for (const host of [NAME, `${NAME}:1`, 'proxy.example:6300', XFH, 'evil.example:6300']) assert.equal((await send(port, 'GET', '/api/health', { host })).status, 403, host);
  });
});

test('a proxied same-origin write is accepted; a foreign or mismatched Origin is refused', async () => {
  await withStub(async (port) => {
    const ok = await write(port, { host: HOST, ...fwd, origin: PROXY, 'sec-fetch-site': 'same-origin' });
    assert.equal(ok.status, 200, ok.text);
    for (const origin of ['https://evil.example', `http://${XFH}`, `https://${XFH.split(':')[0]}`]) assert.equal((await write(port, { host: HOST, ...fwd, origin })).status, 403, origin);
    assert.equal((await write(port, { host: HOST, ...fwd, 'x-forwarded-proto': 'ftp', origin: `ftp://${XFH}` })).status, 403);
    assert.equal((await write(port, { host: HOST, 'x-forwarded-proto': 'https', origin: 'https://' })).status, 403, 'empty X-Forwarded-Host');
    assert.equal((await write(port, { host: HOST, 'x-forwarded-host': XFH, origin: PROXY })).status, 403, 'no X-Forwarded-Proto');
    assert.equal((await write(port, { host: HOST, 'sec-fetch-site': 'cross-site' })).status, 403, 'cross-site');
  });
});

test('loopback writes: same-origin passes, forwarded headers are ignored, a Host outside the set is refused', async () => {
  await withStub(async (port) => {
    assert.equal((await write(port, { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` })).status, 200);
    assert.equal((await write(port, { host: `127.0.0.1:${port}` })).status, 200, 'no Origin (curl)');
    assert.equal((await write(port, { host: `127.0.0.1:${port}`, ...fwd, origin: PROXY })).status, 403);
    assert.equal((await write(port, { host: `localhost:${port}`, 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', origin: 'https://evil.example' })).status, 403);
    const res = await write(port, { host: 'evil.example:6300', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    assert.match(res.text, /forbidden host/);
  });
});

test('settings: a folder where the settings file should be (Docker, file missing) reads as absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-settings-'));
  try {
    const s = loadSettings(dir);
    assert.equal(s.present, false);
    assert.equal(s.realAvailable, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
