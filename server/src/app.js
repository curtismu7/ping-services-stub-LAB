// HTTP API: /api/health, /api/info, /api/mode, /api/services, /api/exercise/:product
import express from 'express';
import { createHealth, servicesSnapshot } from './health.js';
import { loadSettings } from './settings.js';
import {
  exercisePingOne, exercisePingFederate, exercisePingGateway,
  exercisePrivilegeGateway, exercisePrivilegeConsole, exerciseSePf,
} from './exercises.js';

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
<title>Ping Services Stub</title><style>
:root { color-scheme: light dark; }
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
.ok { color: green; } .fail { color: crimson; }
code { font-family: ui-monospace, monospace; font-size: .85em; }
pre { background: color-mix(in srgb, canvastext 6%, transparent); padding: .75rem; border-radius: 6px; overflow-x: auto; }
</style></head>
<body>
<header>
  <h1>Ping Services Stub</h1>
  <span class="note" style="margin:0">SIMULATION: this stub makes one read-only call per service. It provisions nothing.</span>
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
</script>
</body></html>`;
}
