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
import { p1SigninStart, p1SigninCredentials } from './p1Signin.js';
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

// Exercise base URLs: the shared PF cert's SAN covers local.ping-devops.com, not loopback
// (and the container reaches the host via PROBE_HOST), so the host name comes from env.
const PF_BASE = process.env.EXERCISE_PF_BASE || 'https://local.ping-devops.com:9031';
const PG_BASE = process.env.EXERCISE_PG_BASE || 'https://local.ping-devops.com:3036';
const PRIV_BASE = process.env.EXERCISE_PRIV_BASE || 'http://host.docker.internal:8620/';

const EXERCISERS = {
  pingone: () => exercisePingOne(settings),
  pingfederate: () => exercisePingFederate(PF_BASE),
  pinggateway: () => exercisePingGateway(PG_BASE),
  'privilege-gateway': () => exercisePrivilegeGateway(PRIV_BASE),
  'pingone-privilege': () => exercisePrivilegeConsole(settings),
  'se-pingfederate': () => exerciseSePf(settings),
};

// LAB_ALLOWED_HOSTS: comma list of host names (no ports), each accepted in Host only as "<name>:<PORT>". Unset = loopback only.
export function labProxyHosts(env = process.env) {
  const names = String(env.LAB_ALLOWED_HOSTS || '').split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
  for (const n of names) if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(n)) throw new Error(`LAB_ALLOWED_HOSTS: "${n}" is not a host name`);
  const port = Number(env.PORT || 6300);
  return new Set(names.map((n) => `${n}:${port}`));
}

export function createApp({ health = createHealth(), proxyHosts = labProxyHosts() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  // Host check: loopback only by default (rule 2), plus "<LAB_ALLOWED_HOSTS name>:<PORT>" (the family lab-proxy).
  const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
  app.use((req, res, next) => {
    const raw = String(req.headers.host || '').toLowerCase();
    const host = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0];
    if (!loopback.has(host) && !proxyHosts.has(raw)) return res.status(403).send('forbidden host');
    next();
  });

  // Same-origin writes (rule 2). A write that carries an Origin must match Host; or, on a LAB_ALLOWED_HOSTS Host only, equal
  // X-Forwarded-Proto://X-Forwarded-Host (the lab-proxy's origin). Forwarded headers are ignored on any other Host.
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const refuse = () => res.status(403).json({ error: 'cross_origin', message: 'writes must be same-origin' });
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return refuse();
    const origin = req.headers.origin;
    if (origin === undefined) return next();
    const raw = String(req.headers.host || '').toLowerCase();
    const xfh = String(req.headers['x-forwarded-host'] || '').trim().toLowerCase();
    const xfp = String(req.headers['x-forwarded-proto'] || '').trim().toLowerCase();
    if (proxyHosts.has(raw) && xfh !== '' && (xfp === 'https' || xfp === 'http') && origin === `${xfp}://${xfh}`) return next();
    let same = false;
    try { same = new URL(origin).host.toLowerCase() === raw; } catch { /* malformed */ }
    return same ? next() : refuse();
  });

  app.get('/standalone-ui.css', (_req, res) => { res.type('css').send(fs.readFileSync(new URL('../../standalone-ui.css', import.meta.url))); });
  app.get('/top-menu.css', (_req, res) => { res.type('css').send(fs.readFileSync(new URL('../../top-menu.css', import.meta.url))); });
  // The presenter script (docs/talk-track.md), served as plain text for the Talk-track panel.
  app.get('/api/talk-track', (_req, res) => {
    try {
      res.type('text/plain; charset=utf-8').set('Cache-Control', 'no-store').send(fs.readFileSync(new URL('../../docs/talk-track.md', import.meta.url), 'utf8'));
    } catch {
      res.status(404).json({ error: 'no_talk_track' });
    }
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

  app.get('/api/shelf', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json(shelfInfo()); }); // the header "Shelf" button

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
      // 200 + ok:false, NOT 502: the lab-proxy intercepts any 502 from a lab and replaces
      // the body with its "Lab not running" HTML page, which would hide the honest detail.
      res.json({ service: product, ok: false, detail: e.cause?.code || e.message });
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

  // pi.flow sign-in (user path): PingOne (primary) and the shared PF. Tokens stay
  // server-side; the trace response shows decoded claims, never the raw token.
  app.get('/auth/p1/start', async (req, res) => {
    try {
      res.json(await p1SigninStart());
    } catch (e) {
      res.status(e.status || 502).json({ error: e.code || 'p1_error', detail: e.message });
    }
  });

  app.post('/auth/p1/credentials', async (req, res) => {
    const { flowId, username, password } = req.body || {};
    if (typeof flowId !== 'string' || typeof username !== 'string' || typeof password !== 'string' || !flowId || !username || !password || username.length > 128 || password.length > 128) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    try {
      const got = await p1SigninCredentials({ flowId, username, password });
      const trace = await traceToken(got.accessToken);
      const idTrace = got.idToken ? await traceToken(got.idToken) : null;
      res.json({ grantedBy: got.grantedBy, issuer: got.issuer, accessToken: { ...trace }, idToken: idTrace });
    } catch (e) {
      res.status(e.status || 502).json({ error: e.code || 'p1_error', detail: e.message });
    }
  });

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
<title>Ping Services Stub</title><link rel="stylesheet" href="/standalone-ui.css"><link rel="stylesheet" href="/top-menu.css"><style>
html { font-size: var(--fs, 16px); }
/* Talk track: a fixed side panel (family presenter-script pattern). */
#talktrack-panel { position: fixed; top: 0; right: 0; bottom: 0; width: min(26rem, 90vw); overflow-y: auto; background: var(--surface); color: var(--text); border-left: 2px solid var(--accent); box-shadow: -4px 0 16px var(--shadow-ink); padding: 1rem; z-index: 50; white-space: pre-wrap; font-size: .875rem; line-height: 1.5; }
#talktrack-panel h2 { margin-top: 0; }
#talktrack-panel[hidden] { display: none; }
/* shell-bar layout (app-owned per the family standard; tokens come from standalone-ui.css) */
.shell-bar { display: flex; align-items: flex-start; gap: 1rem; flex-wrap: wrap; padding: .65rem 1.25rem; background: var(--box-dark); color: var(--on-box); border-bottom: 3px solid transparent; border-image: var(--accent-gradient) 1; position: relative; }
.shell-brand { display: inline-flex; align-items: center; gap: .6rem; font-weight: 700; letter-spacing: .02em; }
.shell-logo { width: 1.9rem; height: 1.9rem; border-radius: 4px; background: var(--accent-gradient); color: var(--on-accent); display: inline-flex; align-items: center; justify-content: center; font-size: .7rem; font-weight: 700; }
.shell-badge { padding: .1rem .55rem; border-radius: 999px; background: var(--accent-gradient); color: var(--on-accent); font-size: .68rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.shell-nav { display: flex; gap: .25rem; flex: 1; flex-wrap: wrap; }
.shell-nav a { padding: .3rem .75rem; border-radius: 999px; color: var(--on-box); border: 1px solid transparent; text-decoration: none; font-size: .85rem; font-weight: 500; align-self: center; }
.shell-nav a:hover { border-color: var(--on-box); }
.shell-nav a[aria-current="page"] { background: var(--accent-gradient); color: var(--on-accent); font-weight: 600; }
.shell-bar button { font: inherit; font-size: .85rem; }
button[aria-busy="true"] { position: relative; color: transparent !important; }
button[aria-busy="true"]::after { content: ""; position: absolute; inset: 0; margin: auto; width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--border); border-top-color: var(--accent); animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
td.x button { min-width: 5.5rem; }
.shell-bar :focus-visible { outline: 3px solid var(--on-box); outline-offset: 2px; }
@media (max-width: 600px) { .shell-bar { gap: .75rem; padding: .6rem 1rem; } .shell-nav { order: 3; flex-basis: 100%; } }
main { padding: 1rem; max-width: 60rem; margin: 0 auto; }
.banner { border: 1px solid var(--border); border-left: 4px solid var(--accent); border-radius: 8px; background: var(--surface); padding: .6rem 1rem; margin: 1rem 0; }
h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
td, th { border: 1px solid var(--border); padding: .4rem .6rem; text-align: left; }
.ok { color: var(--status-ok); font-weight: 700; } .fail { color: var(--danger-text); font-weight: 700; }
code { font-family: var(--font-mono); font-size: .85em; }
pre { background: var(--surface-2); padding: .75rem; border-radius: 6px; overflow-x: auto; }
.tt-actions { display: flex; gap: .5rem; flex-wrap: wrap; margin: .5rem 0; }
#tt-signin-dialog[hidden] { display: none; }
/* Sign-in card: a draggable floating panel with a pop-out button (the AI-DEMO2 DraggableModal pattern). */
#tt-signin-card { position: fixed; top: 8rem; left: 50%; transform: translateX(-50%); width: min(24rem, 92vw); background: var(--surface); color: var(--text); border: 1px solid var(--border); border-top: 4px solid var(--accent); border-radius: 10px; box-shadow: 0 20px 48px var(--shadow-ink); z-index: 60; }
#tt-signin-card[hidden] { display: none; }
.tt-card-bar { display: flex; align-items: center; justify-content: space-between; padding: .45rem .75rem; background: var(--box-dark); color: var(--on-box); border-radius: 6px 6px 0 0; cursor: move; user-select: none; touch-action: none; }
.tt-card-title { font-weight: 700; font-size: .875rem; }
.tt-card-controls { display: inline-flex; gap: .35rem; }
.tt-card-controls button { min-width: 28px; height: 28px; padding: 0 .4rem; border-radius: 6px; background: transparent; color: var(--on-box); border: 1px solid var(--on-accent-border); cursor: pointer; font: inherit; }
.tt-card-controls button:hover { border-color: var(--on-box); }
.tt-card-body { display: grid; gap: .5rem; padding: .9rem; }
.tt-card-body label { display: grid; gap: .2rem; font-size: .85rem; font-weight: 600; }
.tt-card-body input { font: inherit; padding: .35rem .5rem; }
#tt-signin-state { font-size: .85rem; min-height: 1.2em; }
/* Pop-out window body: the same card, standalone. */
body.tt-popout { background: var(--bg); display: grid; place-items: center; min-height: 100vh; margin: 0; }
body.tt-popout #tt-signin-card { position: static; transform: none; }
@media (max-width: 600px) { .shell-nav { order: 3; flex-basis: 100%; } }
</style>
<script>(function(){try{var t=localStorage.getItem('pss.theme');if(t&&t!=='auto')document.documentElement.dataset.theme=t;}catch(e){}})();</script>
</head>
<body>
<header class="shell-bar" style="position:relative">
  <span class="shell-brand"><span class="shell-logo" aria-hidden="true">PSS</span> Ping Services Stub <span class="shell-badge">${mode === 'real' ? 'Real' : 'Mock'}</span></span>
  <nav class="shell-nav" aria-label="Sections">
    <a href="./" aria-current="page">Services</a>
    <a href="#result" title="Last exercise result">Exercise</a>
    <a href="#tt-result" title="Token trace">Token trace</a>
  </nav>
  <span class="top-menu" data-testid="top-menu">
    <span class="top-menu__row">
      <label class="top-menu__ctl top-menu__theme">Mode
        <select class="top-menu__mode" id="mode-select" aria-label="Mock or Real" data-testid="mode-select">
          <option value="mock" ${mode === 'mock' ? 'selected' : ''}>Mock</option>
          <option value="real" data-testid="mode-real" ${realAvailable ? '' : 'disabled'} title="${realAvailable ? '' : 'Real is not configured. Mock keeps working.'}">Real</option>
        </select>
      </label>
      <button type="button" id="talktrack-btn" aria-pressed="false" data-testid="talk-track-toggle" title="Show the presenter script alongside the page">Talk track</button>
      <a class="top-menu__shelf top-menu__shelf--accent" id="shelf-link" hidden href="#" target="_blank" rel="noreferrer" title="Open the demo shelf (launcher)" data-testid="shelf-link">Shelf</a>
      <a class="top-menu__shelf" href="https://github.com/curtismu7/ping-services-stub-LAB#readme" target="_blank" rel="noreferrer" title="Open this lab's documentation" data-testid="help-link">Help</a>
      <button type="button" data-testid="version" title="About this lab">v0.1.0</button>
      <button type="button" id="reset-btn" data-testid="reset">Reset</button>
    </span>
    <span class="top-menu__row">
      <label class="top-menu__ctl top-menu__theme">Theme
        <select id="theme-select" aria-label="Theme" data-testid="theme-select">
          <option value="auto">Auto</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <label class="top-menu__ctl">Text size
        <select id="font-select" aria-label="Font size" data-testid="font-select"><option value="S">S</option><option value="M">M</option><option value="L">L</option></select>
      </label>
      <span role="group" aria-label="Font size stepper" data-testid="font-stepper">
        <button type="button" id="font-minus" aria-label="Smaller text">A&minus;</button>
        <button type="button" id="font-plus" aria-label="Larger text">A+</button>
      </span>
    </span>
  </span>
</header>
<main>
  <div class="banner" role="note">SIMULATION: this stub makes one read-only call per service. It provisions nothing.</div>
  <h1>What this lab is</h1>
  <p>Every lab in this family reuses shared Ping infrastructure: one local PingFederate, one PingGateway, one Privilege Agent Gateway (all Docker), plus the PingOne SaaS environment from the shared settings file and the SE-K8s PingFederate. When one of them is down, half the family's demos fail with the same confusing error. This stub is the family's circuit tester: <strong>one page, six services, one read-only call each</strong> — the minimum that proves the wiring is live, so you know in ten seconds whether the shared stack is up before a demo.</p>
  <h2>What the sections do</h2>
  <ul>
    <li><strong>Services table</strong> — each row probes one shared service (a TCP connect, or discovery/console reachability) and shows UP/DOWN with where it probed. Press <em>Exercise</em> for the real, read-only call that proves the service answers (PF discovery + JWKS, PingGateway 401 enforcement point, Privilege REST API, PingOne populations, console reachability, SE-PF heartbeat).</li>
    <li><strong>Token trace</strong> — sign in at PingOne or PingFederate (authorization code + PKCE via <code>pi.flow</code>, the user path), then the stub traces the resulting access token the way a resource server would: decode, verify the RS256 signature against the issuer's JWKS, and check typ / iss / exp / nbf / sub / scope / client_id rule by rule, with an honest verdict. Tokens never leave the server — you see decoded claims only. You can also paste any token you already have and trace it.</li>
    <li><strong>Mock / Real</strong> (header) — Real makes the actual calls; Mock answers canned results with zero network, so the demo works offline or on a plane.</li>
  </ul>
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
  <p>Sign in (authorization code + PKCE via <code>pi.flow</code> — the user path, tokens carry a real <code>sub</code> and scopes), then trace the access token the way a resource server would: decode, verify the signature against the issuer's JWKS, and check the rules (typ, iss, exp, nbf, sub, scope, client_id) one by one. Tokens stay server-side; you see decoded claims only.</p>
  <div class="tt-actions">
    <button id="tt-p1-signin" class="primary">Sign in at PingOne</button>
    <button id="tt-pf-signin" class="primary">Sign in at PingFederate</button>
    <button id="tt-pf-m2m" title="Machine path (password grant at the SE PingFederate); needs TRACE_PF_M2M_* env. Not a user token.">PF M2M (machine)</button>
  </div>
  <div id="tt-signin-card" hidden role="dialog" aria-label="Sign in" data-testid="signin-card">
    <div class="tt-card-bar" id="tt-card-bar">
      <span class="tt-card-title">Sign in</span>
      <span class="tt-card-controls">
        <button type="button" id="tt-card-popout" title="Pop out to new window" aria-label="Pop out to new window">&#x1FA9F;</button>
        <button type="button" id="tt-card-close" title="Close" aria-label="Close">&#x2715;</button>
      </span>
    </div>
    <div class="tt-card-body">
      <label>Username <input id="tt-user" autocomplete="username"></label>
      <label>Password <input id="tt-pass" type="password" autocomplete="current-password"></label>
      <button id="tt-signin-go" class="primary">Sign in</button>
      <span id="tt-signin-state" role="status"></span>
    </div>
  </div>
  <pre id="tt-result">Get a token or paste one below.</pre>
  <label style="display:block">Or trace a token you already have (it is sent to this server, which decodes and validates it — nothing else):
    <textarea id="tt-paste" rows="3" style="width:100%" placeholder="eyJ..."></textarea>
  </label>
  <button id="tt-trace">Trace pasted token</button>
</main>
<aside id="talktrack-panel" hidden aria-label="Talk track">
  <h2>Talk track</h2>
  <div id="talktrack-body">Loading…</div>
</aside>
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
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      const prev = btn.textContent;
      btn.textContent = 'Running…';
      document.getElementById('result').textContent = 'Running ' + s.product + '…';
      try {
        const res = await fetch('/api/exercise/' + s.product, { method: 'POST', signal: AbortSignal.timeout(30000) });
        const d = await res.json();
        document.getElementById('result').textContent = JSON.stringify(d, null, 2);
      } catch (e) {
        document.getElementById('result').textContent = 'ERROR: ' + (e.name === 'TimeoutError' ? 'no answer in 30s' : e.message);
      } finally {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        btn.textContent = prev;
      }
    };
    row.querySelector('td.x').replaceChildren(btn);
  }
}
// Shelf button (family behaviour): shown only when GET /api/shelf returns a URL.
fetch('/api/shelf', { credentials: 'omit', headers: { Accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)).then((d) => {
  if (!d || !d.shelfUrl) return;
  const a = document.getElementById('shelf-link');
  a.href = d.shelfUrl; a.hidden = false;
}).catch(() => {});
async function setMode(m) {
  const r = await fetch('/api/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: m }) });
  if (!r.ok) { const d = await r.json(); alert(d.detail || d.error); return; }
  location.reload();
}
document.getElementById('mode-select').onchange = (e) => setMode(e.target.value);
document.getElementById('reset-btn').onclick = async () => { await fetch('/api/reset', { method: 'POST' }); location.reload(); };
// Talk track: toggle the side panel; content loads once from /api/talk-track.
(function(){
  const btn = document.getElementById('talktrack-btn'), panel = document.getElementById('talktrack-panel');
  btn.onclick = () => {
    const show = panel.hidden;
    panel.hidden = !show;
    btn.setAttribute('aria-pressed', String(show));
    if (show && document.getElementById('talktrack-body').textContent === 'Loading…') {
      fetch('/api/talk-track').then((r) => (r.ok ? r.text() : 'No talk track.'))
        .then((t) => { document.getElementById('talktrack-body').textContent = t; })
        .catch(() => { document.getElementById('talktrack-body').textContent = 'No talk track.'; });
    }
  };
})();
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
document.getElementById('tt-pf-m2m').onclick = async () => { const d = await post('/api/token/pf-m2m'); if (d) showTrace(d); };
document.getElementById('tt-trace').onclick = async () => {
  const t = document.getElementById('tt-paste').value.trim();
  if (!t) return;
  const d = await post('/api/trace', { token: t });
  if (d) showTrace(d);
};
// pi.flow sign-in, either provider. PingOne is the primary (its access tokens are
// JWTs with sub + scope); PF's access tokens are opaque, so there the ID token is
// traced and the answer says so.
let signinFlow = { provider: null, flowId: null };
const providerLabel = { pingone: 'PingOne', pingfederate: 'PingFederate' };
for (const provider of ['pingone', 'pingfederate']) {
  document.getElementById(provider === 'pingone' ? 'tt-p1-signin' : 'tt-pf-signin').onclick = async () => {
    const state = document.getElementById('tt-signin-state');
    const r = await fetch(provider === 'pingone' ? '/auth/p1/start' : '/auth/pf/start');
    const d = await r.json();
    if (!r.ok) { document.getElementById('tt-result').textContent = 'ERROR ' + r.status + ': ' + (d.detail || d.error); return; }
    signinFlow = { provider, flowId: d.flowId };
    document.getElementById('tt-signin-card').hidden = false;
    state.textContent = 'Flow started at ' + providerLabel[provider] + '.';
  };
}
// ---- Sign-in card: drag + pop-out (the AI-DEMO2 DraggableModal pattern, vanilla) ----
(function(){
  const card = document.getElementById('tt-signin-card');
  const bar = document.getElementById('tt-card-bar');
  // drag: pointer events on the title bar move the card
  let drag = null;
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const rect = card.getBoundingClientRect();
    card.style.transform = 'none';
    card.style.left = rect.left + 'px';
    card.style.top = rect.top + 'px';
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    bar.setPointerCapture(e.pointerId);
  });
  bar.addEventListener('pointermove', (e) => {
    if (!drag) return;
    card.style.left = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - drag.dx)) + 'px';
    card.style.top = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.dy)) + 'px';
  });
  bar.addEventListener('pointerup', () => { drag = null; });
  document.getElementById('tt-card-close').onclick = () => { card.hidden = true; };
  // pop-out: move the card DOM into a real popup window (styles copied along);
  // the same nodes keep working there, and "pop back" returns them.
  let popWin = null;
  document.getElementById('tt-card-popout').onclick = () => {
    if (popWin && !popWin.closed) { popWin.focus(); return; }
    const rect = card.getBoundingClientRect();
    popWin = window.open('', 'pss_signin', 'width=' + Math.ceil(rect.width + 40) + ',height=' + Math.ceil(rect.height + 120) + ',left=' + Math.ceil(rect.left) + ',top=' + Math.ceil(rect.top) + ',resizable=yes,scrollbars=no');
    if (!popWin) return;
    const styleLinks = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map((el) => '<link rel="stylesheet" href="' + el.href + '">').join('');
    const inlineStyles = Array.from(document.querySelectorAll('style')).map((el) => '<' + 'style>' + el.textContent + '<' + '/style>').join('');
    const theme = document.documentElement.dataset.theme || '';
    popWin.document.write('<!DOCTYPE html><html' + (theme ? ' data-theme="' + theme + '"' : '') + '><head><meta charset="utf-8"><title>Sign in — Ping Services Stub</title>' + styleLinks + inlineStyles + '</head><body class="tt-popout"></body></html>');
    popWin.document.close();
    // move the card itself; its event listeners travel with the nodes
    popWin.document.body.appendChild(card);
    card.hidden = false;
    // swap the pop-out button into a "pop back" control
    const popBtn = document.getElementById('tt-card-popout');
    popBtn.title = 'Pop back into the page'; popBtn.textContent = '\u21B0';
    popBtn.onclick = () => {
      document.body.appendChild(card);
      if (popWin && !popWin.closed) popWin.close();
      popWin = null;
      openPopoutRebind();
    };
    popWin.addEventListener('beforeunload', () => {
      // window closed directly: bring the card home
      if (card.isConnected && card.ownerDocument === document) return;
      document.body.appendChild(card);
      popWin = null;
      openPopoutRebind();
    });
  };
  // keep a named handle so the pop-back button can re-arm the original pop-out
  window.__pssOpenPopout = document.getElementById('tt-card-popout').onclick;
  function openPopoutRebind() {
    const b = document.getElementById('tt-card-popout');
    b.onclick = window.__pssOpenPopout;
    b.title = 'Pop out to new window'; b.textContent = '\u{1FA9F}';
  }
})();
document.getElementById('tt-signin-go').onclick = async () => {
  const { provider, flowId } = signinFlow;
  if (!flowId) return;
  const state = document.getElementById('tt-signin-state');
  const r = await fetch(provider === 'pingone' ? '/auth/p1/credentials' : '/auth/pf/credentials', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flowId, username: document.getElementById('tt-user').value, password: document.getElementById('tt-pass').value }) });
  const d = await r.json();
  if (!r.ok) { state.textContent = (d.detail || d.error); return; }
  state.textContent = 'Signed in at ' + providerLabel[provider] + '.';
  document.getElementById('tt-pass').value = '';
  // PF mints opaque access tokens; trace the ID token instead and say so,
  // rather than showing a dead end.
  const at = d.accessToken || {};
  if (at.verdict === 'not a JWT' && d.idToken && d.idToken.checks) {
    showTrace({ ...d.idToken, grantedBy: d.grantedBy + ' — access token is opaque (not a JWT); showing the ID token instead', issuer: d.issuer });
  } else showTrace(d.accessToken);
};
</script>
<script>(function(){var sel=document.getElementById('theme-select');try{sel.value=localStorage.getItem('pss.theme')||'auto';}catch(e){sel.value='auto';}sel.addEventListener('change',function(){var v=sel.value;if(v==='auto')delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=v;try{localStorage.setItem('pss.theme',v);}catch(e){}});})();</script>
<script>
(function(){var STEP={S:"14px",M:"16px",L:"18px"},order=["S","M","L"];
function apply(step){document.documentElement.style.setProperty("--fs",STEP[step]||"16px");try{localStorage.setItem("pss.font",step)}catch(e){}var s=document.getElementById("font-select");if(s)s.value=step;}
var sel=document.getElementById("font-select");
sel.addEventListener("change",function(){apply(sel.value)});
document.getElementById("font-minus").addEventListener("click",function(){apply(order[Math.max(0,order.indexOf(sel.value)-1)])});
document.getElementById("font-plus").addEventListener("click",function(){apply(order[Math.min(2,order.indexOf(sel.value)+1)])});
apply(localStorage.getItem("pss.font")||"M");})();
</script></body></html>`;
}
