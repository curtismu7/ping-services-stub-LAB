import fs from 'node:fs';
// HTTP API: /api/health, /api/info, /api/mode, /api/services, /api/exercise/:product
import express from 'express';
import { createHealth, servicesSnapshot } from './health.js';
import { loadSettings } from './settings.js';
import {
  exercisePingOne, exercisePingFederate, exercisePingGateway,
  exercisePrivilegeGateway, exercisePrivilegeConsole, exerciseSePf,
} from './exercises.js';
import { getPingOneToken, getPfM2mToken, traceToken } from './tokenTrace.js';
import { pfSigninStart, pfSigninCredentials } from './pfSignin.js';
import { shelfInfo } from './shelfLink.js';

// SERVICE_MODE: 'real' (default when settings exist) or 'mock' (no outbound calls;
// probes return canned offline answers). The toggle (rule 19) switches at runtime.
const state = { mode: process.env.SERVICE_MODE || 'real' };
let settings = loadSettings();
if (state.mode === 'real' && !settings.realAvailable && process.env.SERVICE_MODE === undefined) state.mode = 'mock';

const MOCK_SERVICES = [
  { product: 'pingfederate', url: 'mock://pingfederate', ok: true, detail: 'MOCK: canned probe' },
  { product: 'pinggateway', url: 'mock://pinggateway', ok: true, detail: 'MOCK: canned probe' },
  { product: 'privilege-gateway', url: 'mock://privilege-gateway', ok: true, detail: 'MOCK: canned probe' },
  { product: 'pingone', url: 'mock://pingone', ok: true, detail: 'MOCK: canned probe' },
  { product: 'pingone-privilege', url: 'mock://pingone-privilege', ok: true, detail: 'MOCK: canned probe' },
  { product: 'se-pingfederate', url: 'mock://se-pingfederate', ok: true, detail: 'MOCK: canned probe' },
];

const EXERCISERS = {
  pingone: () => exercisePingOne(settings),
  pingfederate: () => exercisePingFederate('https://local.ping-devops.com:9031'),
  pinggateway: () => exercisePingGateway(),
  'privilege-gateway': () => exercisePrivilegeGateway('http://127.0.0.1:8623/'),
  'pingone-privilege': () => exercisePrivilegeConsole(settings),
  'se-pingfederate': () => exerciseSePf(settings),
};

export function createApp({ health = createHealth() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  // Host check: loopback only by default (rule 2).
  const allowed = new Set(['127.0.0.1', 'localhost', '[::1]', 'local.ping-devops.com', process.env.LAB_ALLOWED_HOSTS].filter(Boolean));
  app.use((req, res, next) => {
    const host = (req.headers.host || '').split(':')[0];
    if (!allowed.has(host)) return res.status(403).send('forbidden host');
    next();
  });


  app.get('/standalone-ui.css', (_req, res) => { res.type('css').send(fs.readFileSync(new URL('../../standalone-ui.css', import.meta.url))); });
  app.get('/api/health', (req, res) => res.json(health.snapshot()));

  app.get('/api/info', (req, res) => {
    res.json({
      schema: 'ping-services-stub-info/1',
      mode: state.mode,
      realAvailable: settings.realAvailable,
      simulated: true,
      products: ['pingfederate', 'pinggateway', 'privilege-gateway', 'pingone', 'pingone-privilege', 'se-pingfederate'],
    });
  });

  app.post('/api/mode', (req, res) => {
    const source = req.body?.source;
    if (source !== 'mock' && source !== 'real') return res.status(400).json({ error: 'invalid_request', detail: 'source must be mock|real' });
    if (source === 'real' && !settings.realAvailable) {
      return res.status(409).json({ error: 'real_not_configured', detail: `No settings at ${settings.path}: need PINGONE_ENVIRONMENT_ID, PINGONE_CLIENT_ID, PINGONE_CLIENT_SECRET.` });
    }
    state.mode = source;
    res.json({ mode: state.mode });
  });

  app.get('/api/services', async (req, res) => {
  app.get('/api/shelf', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json(shelfInfo()); }); // the header "Shelf" button
    if (state.mode === 'mock') return res.json({ ...await servicesSnapshot(), mode: 'mock', services: MOCK_SERVICES });
    res.json(await servicesSnapshot());
  });

  app.post('/api/exercise/:product', async (req, res) => {
    const { product } = req.params;
    if (state.mode === 'mock') {
      const mock = MOCK_SERVICES.find((m) => m.product === product);
      if (!mock) return res.status(404).json({ error: 'unknown_product' });
      return res.json({ service: product, ok: true, detail: `${mock.detail} — no call made (mock mode)` });
    }
    const fn = EXERCISERS[product];
    if (!fn) return res.status(404).json({ error: 'unknown_product' });
    try {
      res.json(await fn());
    } catch (e) {
      res.status(502).json({ service: product, ok: false, detail: e.cause?.code || e.message });
    }
  });

  // ---- Token trace (rule 19: Mock answers canned, Real hits the real issuers) ----
  app.post('/api/token/:source', async (req, res) => {
    if (state.mode === 'mock') {
      return res.status(409).json({ error: 'mock_mode', detail: 'Token trace is real-only: there is nothing honest to show from a canned token. Switch to Real.' });
    }
    try {
      const got = req.params.source === 'pingone' ? await getPingOneToken(settings)
        : req.params.source === 'pf-m2m' ? await getPfM2mToken(settings)
        : null;
      if (!got) return res.status(404).json({ error: 'unknown_source', detail: 'token sources: pingone | pf-m2m' });
      // PF M2M tokens may be opaque (reference) — trace handles that by reporting the decode failure honestly.
      const trace = await traceToken(got.token);
      res.json({ grantedBy: got.grantedBy, issuer: got.issuer, ...trace });
    } catch (e) {
      res.status(e.status || 502).json({ error: e.code || 'token_error', detail: e.message });
    }
  });

  app.post('/api/trace', async (req, res) => {
    const { token } = req.body || {};
    if (typeof token !== 'string' || !token.trim() || token.length > 8192) return res.status(400).json({ error: 'invalid_request', detail: 'body must be { token: "..." }' });
    try {
      res.json(await traceToken(token.trim()));
    } catch (e) {
      res.status(500).json({ error: 'trace_error', detail: e.message });
    }
  });

  // pi.flow sign-in at the shared PF (user path). Tokens stay server-side; the
  // trace response shows decoded claims, never the raw token.
  app.get('/auth/pf/start', async (req, res) => {
    try {
      res.json(await pfSigninStart());
    } catch (e) {
      res.status(e.status || 502).json({ error: e.code || 'pf_error', detail: e.message });
    }
  });

  app.post('/auth/pf/credentials', async (req, res) => {
    const { flowId, username, password } = req.body || {};
    if (typeof flowId !== 'string' || typeof username !== 'string' || typeof password !== 'string' || !flowId || !username || !password || username.length > 128 || password.length > 128) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    try {
      const got = await pfSigninCredentials({ flowId, username, password });
      const trace = await traceToken(got.accessToken);
      const idTrace = got.idToken ? await traceToken(got.idToken) : null;
      res.json({ grantedBy: got.grantedBy, issuer: got.issuer, accessToken: { ...trace }, idToken: idTrace });
    } catch (e) {
      res.status(e.status || 502).json({ error: e.code || 'pf_error', detail: e.message });
    }
  });

  // Reset (rule 3): clears in-memory mode back to the default; no persistent state exists.
  app.post('/api/reset', (req, res) => {
    settings = loadSettings();
    state.mode = settings.realAvailable ? 'real' : 'mock';
    res.json({ ok: true, mode: state.mode });
  });

  // UI: a single server-rendered page (no build step).
  app.get('/', (req, res) => {
    res.type('html').send(page(state.mode, settings.realAvailable, settings.path));
  });

  return app;
}

function page(mode, realAvailable, settingsPath) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ping Services Stub</title><link rel="stylesheet" href="/standalone-ui.css"><style>
:root { color-scheme: light dark; --status-ok: #1d7a43; --danger-text: #aa0005; --accent: #12538d; --panel: color-mix(in srgb, canvastext 4%, transparent); }
body { font-family: system-ui, sans-serif; margin: 0; background: canvas; color: canvastext; }
header { padding: 1rem; border-bottom: 1px solid color-mix(in srgb, canvastext 15%, transparent); display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; }
h1 { font-size: 1.1rem; margin: 0; }
main { padding: 1rem; max-width: 60rem; margin: 0 auto; }
.note { padding: .5rem .75rem; border: 1px solid color-mix(in srgb, canvastext 25%, transparent); border-radius: 6px; margin: 1rem 0; }
button { border: 1px solid color-mix(in srgb, canvastext 35%, transparent); background: transparent; color: canvastext; padding: .35rem .7rem; border-radius: 5px; cursor: pointer; }
button[aria-pressed="true"] { background: highlight; color: highlighttext; }
button:disabled { opacity: .5; cursor: not-allowed; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
td, th { border: 1px solid color-mix(in srgb, canvastext 20%, transparent); padding: .4rem .6rem; text-align: left; }
.ok { color: var(--status-ok); } .fail { color: var(--danger-text); }
code { font-family: ui-monospace, monospace; font-size: .85em; }
pre { background: color-mix(in srgb, canvastext 6%, transparent); padding: .75rem; border-radius: 6px; overflow-x: auto; }
.tt-actions { display: flex; gap: .5rem; flex-wrap: wrap; margin: .5rem 0; }
#tt-signin-dialog { border: 1px solid color-mix(in srgb, canvastext 25%, transparent); border-radius: 6px; padding: .75rem; margin: .5rem 0; display: grid; gap: .4rem; max-width: 24rem; }
#tt-signin-dialog[hidden] { display: none; }
</style></head>
<body>
<header>
  <h1>Ping Services Stub</h1>
  <span class="note" role="note" style="margin:0">SIMULATION: this stub makes one read-only call per service. It provisions nothing.</span>
  <span>Mode:
    <button id="mock-btn" aria-pressed="${mode === 'mock'}">Mock</button>
    <button id="real-btn" aria-pressed="${mode === 'real'}" ${realAvailable ? '' : 'disabled'} title="${realAvailable ? '' : 'No settings at ' + settingsPath}">Real</button>
  </span>
  <button id="reset-btn">Reset</button>
</header>
<main>
  <p>One stub, six shared services. Each row runs one real, read-only call — the minimum that proves the wiring.</p>
  <table id="services"><thead><tr><th>Service</th><th>Probed at</th><th>Status</th><th>Exercise (real call)</th></tr></thead><tbody>
    <tr data-p="pingfederate"><td>PingFederate (shared, local)</td><td colspan="3">…</td></tr>
    <tr data-p="pinggateway"><td>PingGateway (shared, local)</td><td colspan="3">…</td></tr>
    <tr data-p="privilege-gateway"><td>Privilege Agent Gateway (shared, local)</td><td colspan="3">…</td></tr>
    <tr data-p="pingone"><td>PingOne (SaaS)</td><td colspan="3">…</td></tr>
    <tr data-p="pingone-privilege"><td>PingOne Privilege (SaaS console)</td><td colspan="3">…</td></tr>
    <tr data-p="se-pingfederate"><td>PingFederate (SE K8s, cmuir)</td><td colspan="3">…</td></tr>
  </tbody></table>
  <h2>Last exercise result</h2>
  <pre id="result">Press an Exercise button.</pre>
  <h2>Token trace</h2>
  <p>Get a token from a real issuer, then trace it the way a resource server would: decode, verify the signature against the issuer's JWKS, and check the rules (typ, iss, exp, nbf, sub, scope, client_id) one by one. Tokens stay server-side; you see decoded claims only.</p>
  <div class="tt-actions">
    <button id="tt-p1">Get PingOne worker token (M2M)</button>
    <button id="tt-pf-m2m" title="Password grant at the SE PingFederate; needs TRACE_PF_M2M_* env">Get PF token (M2M, password grant)</button>
    <span id="tt-signin">
      <button id="tt-pf-signin">Sign in at PingFederate</button>
    </span>
  </div>
  <div id="tt-signin-dialog" hidden>
    <label>Username <input id="tt-user" autocomplete="username"></label>
    <label>Password <input id="tt-pass" type="password" autocomplete="current-password"></label>
    <button id="tt-signin-go">Sign in</button>
    <span id="tt-signin-state" role="status"></span>
  </div>
  <pre id="tt-result">Get a token or paste one below.</pre>
  <label style="display:block">Or trace a token you already have (it is sent to this server, which decodes and validates it — nothing else):
    <textarea id="tt-paste" rows="3" style="width:100%" placeholder="eyJ..."></textarea>
  </label>
  <button id="tt-trace">Trace pasted token</button>
</main>
<script>
async function refresh() {
  const r = await fetch('/api/services'); const d = await r.json();
  for (const s of d.services) {
    const row = document.querySelector('tr[data-p="' + s.product + '"]');
    if (!row) continue;
    row.innerHTML = '<td>' + row.cells[0].textContent + '</td>'
      + '<td>' + (s.url || '(not configured)') + '</td>'
      + '<td><span class="' + (s.ok ? 'ok' : 'fail') + '">' + (s.ok ? 'UP' : 'DOWN') + '</span>' + (s.detail ? ' <code>' + String(s.detail).replace(/</g, '&lt;') + '</code>' : '') + '</td>'
      + '<td class="x"></td>';
    const btn = document.createElement('button');
    btn.textContent = 'Exercise';
    btn.onclick = async () => {
      const res = await fetch('/api/exercise/' + s.product, { method: 'POST' });
      document.getElementById('result').textContent = JSON.stringify(await res.json(), null, 2);
    };
    row.querySelector('td.x').replaceChildren(btn);
  }
}
document.getElementById('mock-btn').onclick = () => setMode('mock');
document.getElementById('real-btn').onclick = () => setMode('real');
async function setMode(m) {
  const r = await fetch('/api/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: m }) });
  if (r.status === 409) { const d = await r.json(); alert(d.detail); return; }
  refresh(); location.reload();
}
document.getElementById('reset-btn').onclick = async () => { await fetch('/api/reset', { method: 'POST' }); location.reload(); };
refresh();

// ---- token trace ----
function showTrace(d) {
  const NL = String.fromCharCode(10);
  const el = document.getElementById('tt-result');
  if (d.checks) {
    const rows = d.checks.map(c => (c.ok ? '\u2705' : '\u274c') + ' ' + c.rule + ': ' + c.detail).join(NL);
    const head = (d.grantedBy ? 'Granted by ' + d.grantedBy + ' (issuer ' + d.issuer + ')' + NL + NL : '');
    const claims = d.claims ? NL + NL + 'Claims:' + NL + JSON.stringify(d.claims, null, 2) : '';
    el.textContent = head + 'VERDICT: ' + d.verdict + ' (' + d.passed + '/' + d.total + ' checks pass)' + NL + NL + rows + claims;
  } else el.textContent = JSON.stringify(d, null, 2);
}
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const d = await r.json();
  if (!r.ok) { document.getElementById('tt-result').textContent = 'ERROR ' + r.status + ': ' + (d.detail || d.error); return null; }
  return d;
}
document.getElementById('tt-p1').onclick = async () => { const d = await post('/api/token/pingone'); if (d) showTrace(d); };
document.getElementById('tt-pf-m2m').onclick = async () => { const d = await post('/api/token/pf-m2m'); if (d) showTrace(d); };
document.getElementById('tt-trace').onclick = async () => {
  const t = document.getElementById('tt-paste').value.trim();
  if (!t) return;
  const d = await post('/api/trace', { token: t });
  if (d) showTrace(d);
};
let pfFlowId = null;
document.getElementById('tt-pf-signin').onclick = async () => {
  const r = await fetch('/auth/pf/start');
  const d = await r.json();
  if (!r.ok) { document.getElementById('tt-result').textContent = 'ERROR ' + r.status + ': ' + (d.detail || d.error); return; }
  pfFlowId = d.flowId;
  document.getElementById('tt-signin-dialog').hidden = false;
  document.getElementById('tt-signin-state').textContent = 'Flow started at PingFederate.';
};
document.getElementById('tt-signin-go').onclick = async () => {
  if (!pfFlowId) return;
  const r = await fetch('/auth/pf/credentials', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flowId: pfFlowId, username: document.getElementById('tt-user').value, password: document.getElementById('tt-pass').value }) });
  const d = await r.json();
  if (!r.ok) { document.getElementById('tt-signin-state').textContent = (d.detail || d.error); return; }
  document.getElementById('tt-signin-state').textContent = 'Signed in.';
  document.getElementById('tt-pass').value = '';
  // The access token may be opaque (this PF mints opaque ATs); trace the ID
  // token instead and say so, rather than showing a dead end.
  const at = d.accessToken || {};
  if (at.verdict === 'not a JWT' && d.idToken && d.idToken.checks) {
    showTrace({ ...d.idToken, grantedBy: d.grantedBy + ' — access token is opaque (not a JWT); showing the ID token instead', issuer: d.issuer });
  } else showTrace(d.accessToken);
};
</script>
</body></html>`;
}
