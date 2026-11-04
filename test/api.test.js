import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadSettings } from '../server/src/settings.js';
import { createApp } from '../server/src/app.js';

let server; let base;
async function start() {
  if (server) return;
  const app = createApp({
    health: { snapshot: () => ({ schema: 'demo-health/1', at: '', state: 'ready', runtime: 'offline', demo: {} }), ready: async () => true, stop() {} },
  });
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}`;
}
const api = async (path, opts = {}) => {
  await start();
  const r = await fetch(base + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
};

test('health contract: demo-health/1 with ready state', async () => {
  const r = await api('/api/health');
  assert.equal(r.json.schema, 'demo-health/1');
  assert.equal(r.json.state, 'ready');
});

test('mode toggle: both directions, 409 when real not configured, invalid rejected', async () => {
  let r = await api('/api/mode', { method: 'POST', body: { source: 'real' } });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'real_not_configured');
  r = await api('/api/mode', { method: 'POST', body: { source: 'mock' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.mode, 'mock');
  r = await api('/api/mode', { method: 'POST', body: { source: 'real' } });
  assert.equal(r.status, 409);
  r = await api('/api/mode', { method: 'POST', body: { source: 'bogus' } });
  assert.equal(r.status, 400);
});

test('mock mode: /api/services returns canned answers, exercise makes no call', async () => {
  await api('/api/mode', { method: 'POST', body: { source: 'mock' } });
  const r = await api('/api/services');
  assert.equal(r.json.mode, 'mock');
  assert.equal(r.json.services.length, 6);
  for (const s of r.json.services) assert.equal(s.ok, true, `${s.product} should be up in mock`);
  const ex = await api('/api/exercise/pingfederate', { method: 'POST' });
  assert.equal(ex.status, 200);
  assert.match(ex.json.detail, /mock mode/);
});

test('unknown product exercise → 404', async () => {
  const r = await api('/api/exercise/nope', { method: 'POST' });
  assert.equal(r.status, 404);
});

test('reset restores defaults', async () => {
  await api('/api/mode', { method: 'POST', body: { source: 'mock' } });
  const r = await api('/api/reset', { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test('host check: forbidden host rejected', async () => {
  await start();
  const u = new URL(base + '/api/info');
  const status = await new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: u.port, path: '/api/info', headers: { Host: 'evil.example' }, method: 'GET' },
      (res) => { res.resume(); resolve(res.statusCode); },
    );
    req.on('error', () => resolve(0));
    req.end();
  });
  assert.equal(status, 403);
});

test('info: mode + realAvailable + products list', async () => {
  const r = await api('/api/info');
  assert.ok(Array.isArray(r.json.products) && r.json.products.length === 6);
  assert.equal(typeof r.json.realAvailable, 'boolean');
});

test('settings loader: missing file → present false, SE PF default applied', async () => {
  const s = loadSettings('/nonexistent/.env');
  assert.equal(s.present, false);
  assert.match(s.SE_PF_URL, /cmuir-pf-acme\.ping-devops\.com/);
});

test('teardown: close server', async () => {
  await new Promise((res) => server?.close(res));
});
