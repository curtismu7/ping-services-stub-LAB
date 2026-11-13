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
import { p1SigninStart, p1SigninCredentials, p1SigninDevice, p1SigninOtp, p1SigninAssertion, p1SigninComplete } from './p1Signin.js';
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
      const step = await p1SigninCredentials({ flowId, username, password });
      if (step.status === 'COMPLETED') {
        const got = await p1SigninComplete({ flowId });
        const trace = await traceToken(got.accessToken);
        const idTrace = got.idToken ? await traceToken(got.idToken) : null;
        return res.json({ grantedBy: got.grantedBy, issuer: got.issuer, accessToken: { ...trace }, idToken: idTrace });
      }
      // MFA in progress: the browser drives the next step (device / otp).
      res.json({ mfa: true, status: step.status, next: step.next, devices: step.devices });
    } catch (e) {
      res.status(e.status || 502).json({ error: e.code || 'p1_error', detail: e.message });
    }
  });

  app.post('/auth/p1/device', async (req, res) => {
    const { flowId, deviceId } = req.body || {};
    if (typeof flowId !== 'string' || typeof deviceId !== 'string' || !flowId || !deviceId) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    try {
      const step = await p1SigninDevice({ flowId, deviceId });
      if (step.status === 'COMPLETED') {
        const got = await p1SigninComplete({ flowId });
        const trace = await traceToken(got.accessToken);
        const idTrace = got.idToken ? await traceToken(got.idToken) : null;
        return res.json({ grantedBy: got.grantedBy, issuer: got.issuer, accessToken: { ...trace }, idToken: idTrace });
      }
      res.json({ mfa: true, status: step.status, next: step.next, devices: step.devices, publicKeyCredentialRequestOptions: step.publicKeyCredentialRequestOptions });
    } catch (e) {
      res.status(e.status || 502).json({ error: e.code || 'p1_error', detail: e.message });
    }
  });

  app.post('/auth/p1/otp', async (req, res) => {
    const { flowId, otp } = req.body || {};
    if (typeof flowId !== 'string' || !flowId || typeof otp !== 'string') {
      return res.status(400).json({ error: 'invalid_request' });
    }
    try {
      const got = await p1SigninOtp({ flowId, otp });
      if (got.mfa) return res.json(got);
      const trace = await traceToken(got.accessToken);
      const idTrace = got.idToken ? await traceToken(got.idToken) : null;
      res.json({ grantedBy: got.grantedBy, issuer: got.issuer, accessToken: { ...trace }, idToken: idTrace });
    } catch (e) {
      res.status(e.status || 502).json({ error: e.code || 'p1_error', detail: e.message });
    }
  });

  // FIDO2 passkey: the browser runs navigator.credentials.get() with the options
  // the device-select step returned, then posts the signed assertion here. PingOne
  // validates the origin inside clientDataJSON, so the ceremony must run on the
  // page the user is on (same-origin write rules already apply).
  app.post('/auth/p1/assertion', async (req, res) => {
    const { flowId, assertion } = req.body || {};
    const origin = String(req.headers.origin || '');
    if (typeof flowId !== 'string' || !flowId || !assertion || typeof assertion !== 'object') {
      return res.status(400).json({ error: 'invalid_request' });
    }
    try {
      const got = await p1SigninAssertion({ flowId, assertion, origin });
      if (got.mfa) return res.json(got);
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

  // Start the shared stack through the shelf's own start API: it runs compose start
  // for the demo AND its declared shared containers (startSharedContainers). The
  // Origin must be the browser-facing origin, so this is proxied from the UI's fetch
  // (the browser's own Origin is forwarded) — the server-side relay below only works
  // when the shelf accepts it; a same-origin fetch from the page is the reliable path.
  app.post('/api/shared-start', async (req, res) => {
    if (state.mode === 'mock') return res.status(409).json({ error: 'mock_mode', detail: 'Starting the shared stack is real-only.' });
    const shelf = shelfInfo().shelfUrl;
    if (!shelf) return res.status(409).json({ error: 'no_shelf', detail: 'SHELF_URL is not configured; start the shared stack from the demo shelf.' });
    // SHELF_URL may point at the shelf's host port (127.0.0.1:4400), which this container
    // cannot reach. The lab-proxy serves the shelf at <shelf>/demo-shelf and IS reachable
    // from here (extra_hosts maps the name), so try that first, then SHELF_URL itself.
    const base = shelf.replace(/\/$/, '');
    const candidates = [];
    if (/127\.0\.0\.1|localhost/.test(base)) candidates.push(base.replace(/^https?:\/\/[^/]+/, 'https://local.ping-devops.com:8443') + '/demo-shelf');
    candidates.push(base);
    let lastErr = '';
    for (const c of candidates) {
      try {
        const r = await fetch(`${c}/api/demos/ping-services-stub/start`, {
          method: 'POST',
          headers: { Origin: 'https://local.ping-devops.com:8443' },
          signal: AbortSignal.timeout(120_000),
        });
        const body = await r.json().catch(() => ({}));
        return res.status(r.status).json(body);
      } catch (e) { lastErr = e.cause?.code || e.message; }
    }
    return res.status(502).json({ ok: false, error: 'shelf_unreachable', detail: lastErr });
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
/* Present mode: projector-friendly type sizes; the talk-track panel opens with it. */
body.present main { font-size: 1.15rem; }
body.present table { font-size: 1.05rem; }
body.present .banner { font-size: 1.05rem; }
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
/* Result boxes: pretty view by default, toggleable colored JSON. */
.resultbox { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); padding: .75rem 1rem; margin: .5rem 0; }
.resultbox-pretty { font-size: .9rem; line-height: 1.55; overflow-x: auto; }
.resultbox-actions { margin-top: .5rem; }
.resultbox-actions button { font: inherit; font-size: .8rem; padding: .2rem .6rem; border-radius: 6px; background: transparent; color: var(--text); border: 1px solid var(--border); cursor: pointer; }
.resultbox-actions button:hover { border-color: var(--accent); }
.resultbox-actions button[aria-pressed="true"] { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
/* Colored JSON (shared with the claims block) */
.json-tok-key { color: var(--status-info); font-weight: 600; }
.json-tok-str { color: var(--status-ok); }
.json-tok-num { color: var(--status-warn); }
.json-tok-bool { color: var(--accent); font-weight: 600; }
.json-tok-null { color: var(--muted); }
/* Pretty result rendering */
.rb-head { font-weight: 700; margin-bottom: .35rem; }
.rb-verdict { display: inline-block; padding: .1rem .55rem; border-radius: 999px; font-size: .78rem; font-weight: 700; letter-spacing: .03em; }
.rb-verdict--ok { background: var(--status-ok); color: #fff; }
.rb-verdict--warn { background: var(--status-warn); color: #fff; }
.rb-verdict--bad { background: var(--danger-text); color: #fff; }
.rb-granted { color: var(--muted); margin-bottom: .5rem; }
.rb-checks { margin: 0; padding: 0; list-style: none; }
.rb-checks li { padding: .18rem 0; border-bottom: 1px solid var(--surface-2); font-size: .85rem; }
.rb-checks li:last-child { border-bottom: none; }
.rb-checks .ic { font-weight: 700; margin-right: .35rem; }
.rb-checks .rule { font-weight: 700; }
.rb-checks .why { color: var(--muted); }
.rb-claims { margin-top: .6rem; }
.rb-claims summary { cursor: pointer; font-weight: 700; font-size: .85rem; }
.rb-claims pre { margin: .35rem 0 0; font-size: .8rem; }
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
      <button type="button" id="present-btn" aria-pressed="false" data-testid="presenter" title="Bigger text for a projector; Esc exits">Present (P)</button>
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
    <li><strong>Services table</strong> — each row probes one shared service (a TCP connect, or discovery/console reachability) and shows UP/DOWN with where it probed. Press <em>Test</em> for the real, read-only call that proves the service answers (PF discovery + JWKS, PingGateway 401 enforcement point, Privilege REST API, PingOne populations, console reachability, SE-PF heartbeat).</li>
    <li><strong>Token trace</strong> — sign in at PingOne or PingFederate (authorization code + PKCE via <code>pi.flow</code>, the user path), then the stub traces the resulting access token the way a resource server would: decode, verify the RS256 signature against the issuer's JWKS, and check typ / iss / exp / nbf / sub / scope / client_id rule by rule, with an honest verdict. Tokens never leave the server — you see decoded claims only. You can also paste any token you already have and trace it.</li>
    <li><strong>Mock / Real</strong> (header) — Real makes the actual calls; Mock answers canned results with zero network, so the demo works offline or on a plane.</li>
  </ul>
  <table id="services"><thead><tr><th>Service</th><th>Probed at</th><th>Status</th><th>Test (real call)</th></tr></thead><tbody>
    <tr data-p="pingfederate"><td>PingFederate (shared, local)</td><td colspan="3">…</td></tr>
    <tr data-p="pinggateway"><td>PingGateway (shared, local)</td><td colspan="3">…</td></tr>
    <tr data-p="privilege-gateway"><td>Privilege Agent Gateway (shared, local)</td><td colspan="3">…</td></tr>
    <tr data-p="pingone"><td>PingOne (SaaS)</td><td colspan="3">…</td></tr>
    <tr data-p="pingone-privilege"><td>PingOne Privilege (SaaS console)</td><td colspan="3">…</td></tr>
    <tr data-p="se-pingfederate"><td>PingFederate (SE K8s, cmuir)</td><td colspan="3">…</td></tr>
  </tbody></table>
  <h2>Last test result</h2>
  <div class="resultbox" id="result-box">
    <div class="resultbox-pretty" id="result-pretty">Press a Test button.</div>
    <pre id="result" class="resultbox-json" hidden>Press a Test button.</pre>
    <div class="resultbox-actions"><button type="button" id="result-toggle" aria-pressed="false">Show JSON</button></div>
  </div>
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
      <div id="tt-step-user">
        <label>Username <input id="tt-user" autocomplete="username"></label>
        <label>Password <input id="tt-pass" type="password" autocomplete="current-password"></label>
      </div>
      <div id="tt-step-device" hidden>
        <div style="font-size:.85rem;font-weight:600">Verify your identity — pick a device</div>
        <div id="tt-devices" role="radiogroup" aria-label="MFA device" style="display:grid;gap:.3rem"></div>
      </div>
      <div id="tt-step-otp" hidden>
        <label id="tt-otp-label">One-time code <input id="tt-otp" inputmode="numeric" autocomplete="one-time-code"></label>
      </div>
      <button id="tt-signin-go" class="primary">Sign in</button>
      <span id="tt-signin-state" role="status"></span>
    </div>
  </div>
  <div class="resultbox" id="tt-result-box">
    <div class="resultbox-pretty" id="tt-result-pretty">Get a token or paste one below.</div>
    <pre id="tt-result" class="resultbox-json" hidden>Get a token or paste one below.</pre>
    <div class="resultbox-actions"><button type="button" id="tt-result-toggle" aria-pressed="false">Show JSON</button></div>
  </div>
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
// ---- shared: colored JSON + pretty/JSON toggle panes ----
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function colorJson(obj) {
  const json = JSON.stringify(obj, null, 2);
  // sequential tokenizer over the HTML-escaped JSON: key / string / number / bool / null
  const s = esc(json);
  const re = /("(?:[^"\\\\]|\\\\.)*")(\\s*:)?|\\b(true|false)\\b|\\bnull\\b|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?/g;
  let out = '';
  let last = 0;
  for (let m; (m = re.exec(s));) {
    out += s.slice(last, m.index);
    if (m[1] !== undefined) {
      out += m[2] !== undefined
        ? '<span class="json-tok-key">' + m[1] + '</span>' + m[2]
        : '<span class="json-tok-str">' + m[1] + '</span>';
    } else if (m[3] !== undefined) out += '<span class="json-tok-bool">' + m[3] + '</span>';
    else if (m[0] === 'null') out += '<span class="json-tok-null">null</span>';
    else out += '<span class="json-tok-num">' + m[0] + '</span>';
    last = m.index + m[0].length;
  }
  return out + s.slice(last);
}
// A pane holds one result in both forms; the toggle swaps the views.
function makePane(paneId) {
  const box = document.getElementById(paneId);
  const pretty = box.querySelector('.resultbox-pretty');
  const jsonEl = box.querySelector('.resultbox-json');
  const toggle = box.querySelector('.resultbox-actions button');
  let data = null;
  toggle.onclick = () => {
    const showJson = toggle.getAttribute('aria-pressed') !== 'true';
    toggle.setAttribute('aria-pressed', String(showJson));
    toggle.textContent = showJson ? 'Pretty view' : 'Show JSON';
    pretty.hidden = showJson;
    jsonEl.hidden = !showJson;
  };
  return {
    // text-only message (no JSON behind it): the toggle hides itself
    msg(t) { data = null; toggle.hidden = true; pretty.innerHTML = t; jsonEl.hidden = true; pretty.hidden = false; },
    // object result: pretty by default, JSON one toggle away
    set(obj, prettyHtml) {
      data = obj; toggle.hidden = false;
      jsonEl.innerHTML = colorJson(obj);
      pretty.innerHTML = prettyHtml;
    },
  };
}
const resultPane = makePane('result-box');
const ttPane = makePane('tt-result-box');
resultPane.msg('Press a Test button.');
// Pretty rendering for a test result {service, ok, detail}.
function prettyExercise(d) {
  const ok = !!d.ok;
  return '<div class="rb-head"><span class="rb-verdict ' + (ok ? 'rb-verdict--ok' : 'rb-verdict--bad') + '">' + (ok ? 'PASS' : 'FAIL') + '</span> <strong>' + esc(d.service || '') + '</strong></div>'
    + '<div>' + esc(d.detail || '') + '</div>';
}
</script>
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
    btn.className = 'primary';
    btn.textContent = 'Test';
    btn.setAttribute('aria-label', 'Test ' + row.cells[0].textContent);
    btn.onclick = async () => {
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      const prev = btn.textContent;
      btn.textContent = 'Testing…';
      resultPane.msg('Testing ' + esc(row.cells[0].textContent) + '…');
      try {
        const res = await fetch('/api/exercise/' + s.product, { method: 'POST', signal: AbortSignal.timeout(30000) });
        const d = await res.json();
        resultPane.set(d, prettyExercise(d));
      } catch (e) {
        resultPane.msg('<span class="fail">ERROR: ' + esc(e.name === 'TimeoutError' ? 'no answer in 30s' : e.message) + '</span>');
      } finally {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        btn.textContent = prev;
      }
    };
    // DOWN rows for the shared Docker products get a "Start shared stack" button:
    // it calls the shelf's start API, which runs compose start for the shared
    // containers this lab declares (startSharedContainers).
    const SHARED_STARTABLE = ['pingfederate', 'pinggateway', 'privilege-gateway'];
    if (!s.ok && SHARED_STARTABLE.includes(s.product)) {
      const startBtn = document.createElement('button');
      startBtn.textContent = 'Start shared stack';
      startBtn.title = 'Ask the demo shelf to start the shared containers (compose start). Takes a minute or two.';
      startBtn.onclick = async () => {
        startBtn.disabled = true;
        startBtn.textContent = 'Starting…';
        document.getElementById('result').textContent = 'Asking the shelf to start the shared stack…';
        try {
          const res = await fetch('/api/shared-start', { method: 'POST', signal: AbortSignal.timeout(150000) });
          const d = await res.json();
          document.getElementById('result').textContent = 'Shelf start: ' + JSON.stringify(d, null, 2);
        } catch (e) {
          document.getElementById('result').textContent = 'ERROR: ' + (e.name === 'TimeoutError' ? 'shelf start timed out after 150s' : e.message);
        }
        startBtn.disabled = false;
        startBtn.textContent = 'Start shared stack';
        refresh();
      };
      const cell = document.createElement('td');
      cell.style.whiteSpace = 'nowrap';
      cell.append(btn, ' ', startBtn);
      row.querySelector('td.x').replaceChildren(cell);
      return;
    }
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
// Present mode: bigger type + the talk track opens alongside (they pair); Esc exits.
(function(){
  const btn = document.getElementById('present-btn'), ttBtn = document.getElementById('talktrack-btn');
  function setPresent(on) {
    document.body.classList.toggle('present', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? 'Exit present (Esc)' : 'Present (P)';
    // Present pairs with the talk track: entering present opens the script.
    if (on && ttBtn.getAttribute('aria-pressed') !== 'true') ttBtn.click();
  }
  btn.onclick = () => setPresent(!document.body.classList.contains('present'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('present')) setPresent(false);
    if ((e.key === 'p' || e.key === 'P') && !e.metaKey && !e.ctrlKey && !e.altKey
      && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) setPresent(!document.body.classList.contains('present'));
  });
})();
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
  if (!d || !d.checks) { ttPane.set(d, '<pre style="margin:0">' + esc(JSON.stringify(d, null, 2)) + '</pre>'); return; }
  const verdictClass = d.verdict === 'ACCEPTED' ? 'rb-verdict--ok'
    : /ACCEPTED/.test(d.verdict) ? 'rb-verdict--warn' : 'rb-verdict--bad';
  let html = '<div class="rb-head"><span class="rb-verdict ' + verdictClass + '">' + esc(d.verdict) + '</span> <strong>' + d.passed + '/' + d.total + ' checks pass</strong></div>';
  if (d.grantedBy) html += '<div class="rb-granted">Granted by ' + esc(d.grantedBy) + (d.issuer ? ' — issuer ' + esc(d.issuer) : '') + '</div>';
  html += '<ul class="rb-checks">' + d.checks.map(c =>
    '<li><span class="ic">' + (c.ok ? '\u2705' : '\u274c') + '</span><span class="rule">' + esc(c.rule) + '</span> <span class="why">' + esc(c.detail) + '</span></li>').join('') + '</ul>';
  if (d.claims) html += '<details class="rb-claims"><summary>Claims</summary><pre>' + colorJson(d.claims) + '</pre></details>';
  ttPane.set(d, html);
}
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const d = await r.json();
  if (!r.ok) { ttPane.msg('<span class="fail">ERROR ' + r.status + ': ' + esc(d.detail || d.error) + '</span>'); return null; }
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
    if (!r.ok) { ttPane.msg('<span class="fail">ERROR ' + r.status + ': ' + esc(d.detail || d.error) + '</span>'); return; }
    signinFlow = { provider, flowId: d.flowId, step: 'user' };
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
// The sign-in is multi-step for PingOne MFA: username/password → (device picker) →
// (OTP) → done. signinFlow.step tracks where the card is; tt-signin-go acts per step.
function cardStep(step) {
  document.getElementById('tt-step-user').hidden = step !== 'user';
  document.getElementById('tt-step-device').hidden = step !== 'device';
  document.getElementById('tt-step-otp').hidden = step !== 'otp';
  document.getElementById('tt-signin-go').textContent = step === 'otp' ? 'Verify code' : step === 'device' ? 'Next' : 'Sign in';
  if (step === 'otp') setTimeout(() => document.getElementById('tt-otp').focus(), 50);
}
function cardReset() {
  cardStep('user');
  document.getElementById('tt-pass').value = '';
  document.getElementById('tt-otp').value = '';
  document.getElementById('tt-otp').parentElement.hidden = false;
}
function traceResult(d) {
  const at = d.accessToken || {};
  if (at.verdict === 'not a JWT' && d.idToken && d.idToken.checks) {
    showTrace({ ...d.idToken, grantedBy: d.grantedBy + ' — access token is opaque (not a JWT); showing the ID token instead', issuer: d.issuer });
  } else showTrace(d.accessToken);
}
function closeCardAfterSuccess() {
  setTimeout(() => {
    const card = document.getElementById('tt-signin-card');
    if (card && card.ownerDocument === document) card.hidden = true;
    else if (window.opener && !window.opener.closed) window.close();
  }, 700);
  signinFlow = { provider: null, flowId: null };
}
document.getElementById('tt-signin-go').onclick = async () => {
  const flow = signinFlow;
  if (!flow.flowId) return;
  const state = document.getElementById('tt-signin-state');
  let r; let d;
  if (flow.provider === 'pingfederate') {
    r = await fetch('/auth/pf/credentials', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flowId: flow.flowId, username: document.getElementById('tt-user').value, password: document.getElementById('tt-pass').value }) });
    d = await r.json();
    if (!r.ok) { state.textContent = (d.detail || d.error); return; }
    state.textContent = 'Signed in at PingFederate.';
    cardReset(); closeCardAfterSuccess(); traceResult(d); return;
  }
  // PingOne, per step
  if (flow.step === 'device') {
    const pick = document.querySelector('input[name="tt-device"]:checked');
    if (!pick) { state.textContent = 'Pick a device first.'; return; }
    r = await fetch('/auth/p1/device', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flowId: flow.flowId, deviceId: pick.value }) });
    d = await r.json();
    if (!r.ok) { state.textContent = (d.detail || d.error); return; }
    if (d.mfa) { mfaStep(d); return; }
    state.textContent = 'Signed in at PingOne.'; cardReset(); closeCardAfterSuccess(); traceResult(d); return;
  }
  if (flow.step === 'otp') {
    r = await fetch('/auth/p1/otp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flowId: flow.flowId, otp: document.getElementById('tt-otp').value }) });
    d = await r.json();
    if (!r.ok) { state.textContent = (d.detail || d.error); return; }
    if (d.mfa) { mfaStep(d); return; }
    state.textContent = 'Signed in at PingOne (MFA verified).';
    cardReset(); closeCardAfterSuccess(); traceResult(d); return;
  }
  r = await fetch('/auth/p1/credentials', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flowId: flow.flowId, username: document.getElementById('tt-user').value, password: document.getElementById('tt-pass').value }) });
  d = await r.json();
  if (!r.ok) { state.textContent = (d.detail || d.error); return; }
  if (d.mfa) { state.textContent = 'Password verified — one more step.'; mfaStep(d); return; }
  state.textContent = 'Signed in at PingOne.';
  cardReset(); closeCardAfterSuccess(); traceResult(d);
};
// Render whatever the MFA state asks for next: a device radio list or an OTP box.
function mfaStep(d) {
  const flow = signinFlow;
  flow.step = d.next;
  if (d.next === 'device') {
    const wrap = document.getElementById('tt-devices');
    wrap.innerHTML = (d.devices || []).map((dev) =>
      '<label style="display:inline-flex;gap:.4rem;align-items:center;font-weight:400">'
      + '<input type="radio" name="tt-device" value="' + esc(dev.id) + '"' + (dev.fido2 ? ' data-fido2="1"' : '') + '> ' + esc(dev.label) + '</label>').join('');
    cardStep('device');
    document.getElementById('tt-signin-state').textContent = 'Pick how to verify.';
    return;
  }
  if (d.next === 'otp') {
    cardStep('otp');
    document.getElementById('tt-signin-state').textContent = 'Code sent — check your email/messages.';
    return;
  }
  if (d.next === 'passkey' && d.publicKeyCredentialRequestOptions) {
    runPasskey(d.publicKeyCredentialRequestOptions);
    return;
  }
  document.getElementById('tt-signin-state').textContent = 'Unexpected flow state: ' + (d.status || '?');
}
// ---- WebAuthn passkey ceremony (browser side) ----
// b64url / signed-byte-array → Uint8Array (PingOne's shape; mirrors the BFF's passkeyCeremony).
function b64ToBytes(val) {
  if (val instanceof Uint8Array) return val;
  if (Array.isArray(val)) return new Uint8Array(val.map((b) => b & 0xff));
  const stripped = String(val).replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const padded = stripped + '='.repeat((4 - (stripped.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}
function bytesToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
async function runPasskey(rawOptions) {
  const state = document.getElementById('tt-signin-state');
  try {
    const opts = typeof rawOptions === 'string' ? JSON.parse(rawOptions) : rawOptions;
    const publicKey = { challenge: b64ToBytes(opts.challenge) };
    if ('rpId' in opts) publicKey.rpId = opts.rpId;
    if ('timeout' in opts) publicKey.timeout = opts.timeout;
    if ('userVerification' in opts) publicKey.userVerification = opts.userVerification;
    if (Array.isArray(opts.allowCredentials)) {
      publicKey.allowCredentials = opts.allowCredentials.map((c) => {
        const cred = { type: c.type || 'public-key', id: b64ToBytes(c.id) };
        if (c.transports) cred.transports = c.transports;
        return cred;
      });
    }
    cardStep('otp'); // reuse the OTP pane: hide inputs, show "touch your passkey"
    document.getElementById('tt-otp').parentElement.hidden = true;
    state.textContent = 'Use your passkey (Touch ID / security key)…';
    const credential = await navigator.credentials.get({ publicKey });
    if (!credential) throw new Error('No passkey credential was returned');
    const assertion = {
      id: credential.id,
      rawId: bytesToB64(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: bytesToB64(credential.response.clientDataJSON),
        authenticatorData: bytesToB64(credential.response.authenticatorData),
        signature: bytesToB64(credential.response.signature),
        userHandle: credential.response.userHandle ? bytesToB64(credential.response.userHandle) : null,
      },
    };
    state.textContent = 'Verifying passkey…';
    const r = await fetch('/auth/p1/assertion', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flowId: signinFlow.flowId, assertion }) });
    const d = await r.json();
    if (!r.ok) { state.textContent = (d.detail || d.error); document.getElementById('tt-otp').parentElement.hidden = false; return; }
    if (d.mfa) { mfaStep(d); return; }
    state.textContent = 'Signed in at PingOne (passkey).';
    cardReset(); closeCardAfterSuccess(); traceResult(d);
  } catch (e) {
    state.textContent = 'Passkey failed: ' + (e.message || e.name);
    document.getElementById('tt-otp').parentElement.hidden = false;
    cardStep('device'); // back to the picker so another device can be chosen
    state.textContent = 'Passkey failed — pick another device.';
  }
}
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
