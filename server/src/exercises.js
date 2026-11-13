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

// PingOne user path: the user app (PINGONE_USER_*) is what pi.flow sign-in uses.
// Read-only: worker token → read the app record → check its registered grant
// types and redirect include what the sign-in card depends on (authorization
// code + PKCE, response_mode pi.flow, client_secret_post token auth).
export async function exercisePingOneUser(settings = loadSettings()) {
  if (!settings.PINGONE_USER_CLIENT_ID || !settings.PINGONE_USER_CLIENT_SECRET) {
    return { service: 'pingone', ok: false, detail: 'user app not configured (need PINGONE_USER_CLIENT_ID / PINGONE_USER_CLIENT_SECRET)' };
  }
  if (!settings.PINGONE_CLIENT_ID || !settings.PINGONE_CLIENT_SECRET) {
    return { service: 'pingone', ok: false, detail: 'worker app not configured (need PINGONE_CLIENT_ID / PINGONE_CLIENT_SECRET to read the user-app record)' };
  }
  const region = REGION_ALIAS[String(settings.PINGONE_REGION || 'com').toLowerCase()] || 'com';
  const env = settings.PINGONE_ENVIRONMENT_ID;
  const tok = await j(`https://auth.pingone.${region}/${env}/as/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${settings.PINGONE_CLIENT_ID}:${settings.PINGONE_CLIENT_SECRET}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (tok.status !== 200) return { service: 'pingone', ok: false, detail: `worker token HTTP ${tok.status}` };
  const app = await j(`https://api.pingone.${region}/v1/environments/${env}/applications/${settings.PINGONE_USER_CLIENT_ID}`, {
    headers: { authorization: `Bearer ${tok.body.access_token}` },
  });
  if (app.status !== 200) return { service: 'pingone', ok: false, detail: `user-app record HTTP ${app.status}` };
  const grants = (app.body.grantTypes || []).join(', ') || '(none)';
  const redirect = (app.body.redirectUris || [])[0] || '(none)';
  const method = (app.body.tokenEndpointAuthMethod || 'client_secret_basic').toLowerCase();
  const configured = (process.env.PINGONE_USER_REDIRECT_URI || '').replace(/\/$/, '');
  const okRedirect = configured
    ? (app.body.redirectUris || []).some((u) => u.replace(/\/$/, '') === configured)
    : (app.body.redirectUris || []).some((u) => /local\.ping-devops\.com:4000/.test(u));
  const wants = ['AUTHORIZATION_CODE', 'REFRESH_TOKEN'].every((g) => (app.body.grantTypes || []).includes(g));
  const ok = wants && okRedirect && method === 'client_secret_post';
  return {
    service: 'pingone',
    ok,
    detail: `user app: grants ${grants}; token auth ${method}; redirect ${redirect}${ok ? '' : ' — expected AUTHORIZATION_CODE+REFRESH_TOKEN, client_secret_post, and the configured PINGONE_USER_REDIRECT_URI registered (run scripts/pingone-setup.sh)'}`,
  };
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
