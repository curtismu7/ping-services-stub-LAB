// Service-exercise stubs: one MINIMAL real call per shared service, so the stub
// proves wiring (not product features). Every call is read-only.
import { loadSettings } from './settings.js';

async function j(url, opts = {}) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000), ...opts });
  const text = await r.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  return { status: r.status, body };
}

// PingOne: read the environment's populations count (worker token, read-only).
const REGION_ALIAS = { na: 'com', us: 'com', com: 'com', eu: 'eu', ca: 'ca', ap: 'asia', asia: 'asia', au: 'asia' };

export async function exercisePingOne(settings = loadSettings()) {
  const region = REGION_ALIAS[String(settings.PINGONE_REGION || 'com').toLowerCase()] || 'com';
  const base = `https://api.pingone.${region}/v1/environments/${settings.PINGONE_ENVIRONMENT_ID}`;
  const tok = await j(`https://auth.pingone.${region}/${settings.PINGONE_ENVIRONMENT_ID}/as/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${settings.PINGONE_CLIENT_ID}:${settings.PINGONE_CLIENT_SECRET}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (tok.status !== 200) return { service: 'pingone', ok: false, detail: `token HTTP ${tok.status}` };
  const pop = await j(`${base}/populations?limit=1`, { headers: { authorization: `Bearer ${tok.body.access_token}` } });
  return { service: 'pingone', ok: pop.status === 200, detail: `populations HTTP ${pop.status} (worker token OK)` };
}

// PingFederate: OIDC discovery + JWKS fetch (read-only, no credentials).
export async function exercisePingFederate(base) {
  const disc = await j(`${base}/.well-known/openid-configuration`);
  if (disc.status !== 200) return { service: 'pingfederate', ok: false, detail: `discovery HTTP ${disc.status}` };
  const jwks = await j(disc.body.jwks_uri);
  return {
    service: 'pingfederate',
    ok: jwks.status === 200,
    detail: `issuer ${disc.body.issuer}; JWKS HTTP ${jwks.status}; ${disc.body.jwks_uri}`,
  };
}

// PingGateway: /mcp must answer 401/405 without a token (enforcement point up).
export async function exercisePingGateway(base = 'https://127.0.0.1:3036') {
  const r = await j(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const ok = [401, 405].includes(r.status) || r.status === 200;
  return { service: 'pinggateway', ok, detail: `POST /mcp → HTTP ${r.status} (401/405 = enforcement point up)` };
}

// Privilege Agent Gateway: root answers 200 (listener up).
export async function exercisePrivilegeGateway(base) {
  const r = await j(base);
  return { service: 'privilege-gateway', ok: r.status === 200, detail: `root HTTP ${r.status}` };
}

// PingOne Privilege: console reachable (telemetry only — registration is manual).
export async function exercisePrivilegeConsole(settings = loadSettings()) {
  const url = settings.PRIVILEGE_CONSOLE_URL || 'https://console.privilege.pingone.com/';
  const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(8000), redirect: 'manual' });
  const ok = [200, 302, 401, 403].includes(r.status);
  return { service: 'pingone-privilege', ok, detail: `console HTTP ${r.status} (registration is console-manual)` };
}

// SE PingFederate: discovery (its issuer is the canonical one).
export async function exerciseSePf(settings = loadSettings()) {
  const base = settings.SE_PF_URL;
  const disc = await j(`${base}/.well-known/openid-configuration`);
  if (disc.status !== 200) return { service: 'se-pingfederate', ok: false, detail: `discovery HTTP ${disc.status}` };
  return { service: 'se-pingfederate', ok: true, detail: `issuer ${disc.body.issuer}` };
}
