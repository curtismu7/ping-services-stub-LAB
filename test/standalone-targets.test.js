// Pins the standalone defaults: ping-shared's ports, no AI-DEMO2 address anywhere,
// and the Privilege gateway only from what the user supplies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeAll, pinggatewayPort, privilegeGatewayBase, privilegeGatewayTarget } from '../server/src/probes.js';
import { exercisePrivilegeGateway } from '../server/src/exercises.js';

const KEYS = ['PINGFEDERATE_HOST', 'PINGFEDERATE_PORT', 'PINGGATEWAY_HOST', 'PINGGATEWAY_PORT', 'PINGGATEWAY_HOST_PORT',
  'PRIVILEGE_GATEWAY_URL', 'PRIVILEGE_GATEWAY_HOST', 'PRIVILEGE_GATEWAY_PORT'];
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
const noSettings = { PRIVILEGE_GATEWAY_URL: '', SE_PF_URL: 'https://se-pf.example', PRIVILEGE_CONSOLE_URL: 'https://console.example/' };
const listen = () => new Promise((res) => { const s = net.createServer((c) => c.destroy()); s.listen(0, '127.0.0.1', () => res(s)); });

test('defaults: PingFederate 127.0.0.1:4732 and PingGateway 127.0.0.1:7809, privilege gateway not configured', async () => {
  await withEnv({}, async () => {
    const rows = await probeAll({ ...noSettings, realAvailable: false });
    const by = Object.fromEntries(rows.map((r) => [r.product, r]));
    // Nothing needs to be listening: the probe target is named either in the url (host:port) or the detail.
    assert.match(`${by.pingfederate.url} ${by.pingfederate.detail}`, /127\.0\.0\.1:4732/);
    assert.match(`${by.pinggateway.url} ${by.pinggateway.detail}`, /127\.0\.0\.1:7809/);
    assert.equal(by['privilege-gateway'].ok, false);
    assert.equal(by['privilege-gateway'].url, '');
    assert.match(by['privilege-gateway'].detail, /not configured.*PRIVILEGE_GATEWAY_URL/);
    assert.equal(pinggatewayPort(), 7809);
  });
});

test('PINGGATEWAY_HOST_PORT moves the gateway target (ping-shared name); PINGGATEWAY_PORT wins over it', async () => {
  await withEnv({ PINGGATEWAY_HOST_PORT: '7811' }, async () => {
    assert.equal(pinggatewayPort(), 7811);
    const rows = await probeAll({ ...noSettings });
    assert.match(rows.find((r) => r.product === 'pinggateway').detail, /127\.0\.0\.1:7811/);
  });
  await withEnv({ PINGGATEWAY_HOST_PORT: '7811', PINGGATEWAY_PORT: '7812' }, async () => {
    assert.equal(pinggatewayPort(), 7812);
  });
});

test('privilege gateway comes only from the user: URL in env, URL in settings, or host+port; none by default', async () => {
  await withEnv({}, async () => {
    assert.equal(privilegeGatewayBase({}, {}), '');
    assert.equal(privilegeGatewayTarget({}, {}).host, '');
    assert.equal(privilegeGatewayBase({ PRIVILEGE_GATEWAY_URL: 'https://gw.example:9443/' }, {}), 'https://gw.example:9443');
    assert.equal(privilegeGatewayBase({ PRIVILEGE_GATEWAY_URL: 'https://settings.example' }, { PRIVILEGE_GATEWAY_URL: 'https://env.example' }), 'https://env.example');
    assert.equal(privilegeGatewayBase({}, { PRIVILEGE_GATEWAY_HOST: 'gw.example', PRIVILEGE_GATEWAY_PORT: '9000' }), 'http://gw.example:9000');
    const t = privilegeGatewayTarget({ PRIVILEGE_GATEWAY_URL: 'https://gw.example:9443/base/' }, {});
    assert.deepEqual([t.host, t.port, t.tls, t.probe], ['gw.example', 9443, true, '/base/']);
    assert.equal(privilegeGatewayTarget({ PRIVILEGE_GATEWAY_URL: 'not a url' }, {}).host, '');
  });
});

test('probe reaches a stub listener named by PRIVILEGE_GATEWAY_URL (loopback stub, no real gateway)', async () => {
  const srv = await new Promise((res) => {
    import('node:http').then(({ default: http }) => {
      const s = http.createServer((q, r) => { r.statusCode = 200; r.end('ok'); });
      s.listen(0, '127.0.0.1', () => res(s));
    });
  });
  try {
    const url = `http://127.0.0.1:${srv.address().port}`;
    await withEnv({ PRIVILEGE_GATEWAY_URL: url }, async () => {
      const row = (await probeAll({ ...noSettings })).find((r) => r.product === 'privilege-gateway');
      assert.equal(row.ok, true, row.detail);
      const ex = await exercisePrivilegeGateway(privilegeGatewayBase({}));
      assert.equal(ex.ok, true);
    });
  } finally { await new Promise((res) => srv.close(res)); }
});

test('exercise: unconfigured Privilege gateway answers an honest not-configured', async () => {
  const r = await exercisePrivilegeGateway('');
  assert.equal(r.ok, false);
  assert.match(r.detail, /not configured.*PRIVILEGE_GATEWAY_URL/);
});

test('an open port with no HTTP service named as PingFederate is reported DOWN, not UP', async () => {
  const s = await listen();
  try {
    await withEnv({ PINGFEDERATE_PORT: String(s.address().port) }, async () => {
      const pf = (await probeAll({ ...noSettings })).find((r) => r.product === 'pingfederate');
      assert.equal(pf.ok, false);
      assert.match(pf.url, new RegExp(`127\\.0\\.0\\.1:${s.address().port}`));
    });
  } finally { await new Promise((res) => s.close(res)); }
});

test('no AI-DEMO2 address or name in code, compose, README, .env.example (the repo is standalone)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.git', 'test', 'dist'].includes(e.name)) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(js|mjs|jsx|json|md|yml|yaml|sh|example)$/.test(e.name) && e.name !== 'package-lock.json') files.push(f);
    }
  };
  walk(root);
  const bad = /localhost:(3036|9031|8623)|127\.0\.0\.1:(3036|9031|8623)|local\.ping-devops\.com:9031|\bPINGFEDERATE_PORT[^\n]*9031|ai-demo2|ai-demo-pf|aiDemoPf/i;
  const hits = files.filter((f) => !/(ci\.yml|CLAUDE\.md)$/.test(f) && bad.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f));
  assert.deepEqual(hits, []);
  // The compose file defaults the gateway host port to ping-shared's 7809.
  assert.match(fs.readFileSync(path.join(root, 'deploy/docker-compose.yml'), 'utf8'), /PINGGATEWAY_HOST_PORT:-7809/);
});
