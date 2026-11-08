import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/src/app.js';

// Regression: the header "Shelf" button reads GET /api/shelf. It must answer straight after start
// (it used to be registered inside the /api/services handler), with no web build.
test('GET /api/shelf returns SHELF_URL (trailing slash trimmed) before any other call; POST is not 200', async () => {
  const prev = process.env.SHELF_URL;
  process.env.SHELF_URL = 'https://shelf.example:8443/';
  const app = createApp({
    health: { snapshot: () => ({ schema: 'demo-health/1', at: '', state: 'ready', runtime: 'offline', demo: {} }), ready: async () => true, stop() {} },
  });
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/api/shelf`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { shelfUrl: 'https://shelf.example:8443' });
    const p = await fetch(`${base}/api/shelf`, { method: 'POST', headers: { origin: base } });
    assert.notEqual(p.status, 200);
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /fetch\('\/api\/shelf'/);
    assert.match(html, /a\.className = 'shelf-link'/);
  } finally {
    if (prev === undefined) delete process.env.SHELF_URL; else process.env.SHELF_URL = prev;
    await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  }
});
