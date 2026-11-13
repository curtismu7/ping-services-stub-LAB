// PingOne pi.flow sign-in: authorization code + PKCE with response_mode=pi.flow
// (the same driver pattern the BFF uses, reduced to what the trace needs).
// The user path at PingOne — NOT the worker (client_credentials) path, whose
// tokens are scope-less by design. Tokens stay server-side; the trace shows
// decoded claims only.
import crypto from 'node:crypto';
import { loadSettings } from './settings.js';
import { REGION_ALIAS } from './probes.js';

const FLOW_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const flows = new Map(); // flowId -> { cookies, startedAt, attempts, state, verifier, settings }
const b64url = (b) => Buffer.from(b).toString('base64url');

function cookiesHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}
function mergeCookies(jar, res) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
}

// The PingOne user app (authorization code): TRACE_P1_* env wins, then the shared
// settings file's PINGONE_USER_* keys (the app the BFF's user sign-in uses).
function p1Client(settings) {
  const envId = settings.PINGONE_ENVIRONMENT_ID;
  const region = REGION_ALIAS[String(settings.PINGONE_REGION || 'com').toLowerCase()] || 'com';
  const id = process.env.TRACE_P1_CLIENT_ID || settings.PINGONE_USER_CLIENT_ID || '';
  const secret = process.env.TRACE_P1_CLIENT_SECRET || settings.PINGONE_USER_CLIENT_SECRET || '';
  const redirectUri = process.env.TRACE_P1_REDIRECT_URI || settings.PINGONE_USER_REDIRECT_URI
    || 'https://local.ping-devops.com:4000/api/auth/oauth/user/callback';
  const base = `https://auth.pingone.${region}/${envId}`;
  return { envId, region, id, secret, redirectUri, base };
}

export async function p1SigninStart() {
  const settings = loadSettings();
  const c = p1Client(settings);
  if (!c.id || !c.secret) {
    throw Object.assign(new Error('The PingOne user (authorization code) app is not configured (need PINGONE_USER_CLIENT_ID / PINGONE_USER_CLIENT_SECRET in the shared settings file)'), { status: 409, code: 'not_configured' });
  }
  const verifier = b64url(crypto.randomBytes(32));
  const state = b64url(crypto.randomBytes(16));
  const url = new URL(`${c.base}/as/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', c.id);
  url.searchParams.set('redirect_uri', c.redirectUri);
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', crypto.createHash('sha256').update(verifier).digest('base64url'));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('response_mode', 'pi.flow');
  const jar = {};
  const r = await fetch(url, { headers: { Accept: '*/*' }, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  mergeCookies(jar, r);
  const data = await r.json().catch(() => ({}));
  if (typeof data.id !== 'string' || !data.id) {
    throw Object.assign(new Error(`PingOne authorize answered HTTP ${r.status} (${data.code || data.error || 'unexpected response'})`), { status: 502, code: 'p1_error' });
  }
  flows.set(data.id, { cookies: jar, startedAt: Date.now(), attempts: 0, state, verifier, settings });
  return { flowId: data.id, status: data.status || null };
}

export async function p1SigninCredentials({ flowId, username, password }) {
  const flow = flows.get(flowId);
  if (!flow || Date.now() - flow.startedAt > FLOW_TTL_MS) {
    flows.delete(flowId);
    throw Object.assign(new Error('no active flow — start one first'), { status: 409, code: 'flow_not_started' });
  }
  flow.attempts += 1;
  if (flow.attempts > MAX_ATTEMPTS) {
    flows.delete(flowId);
    throw Object.assign(new Error('too many attempts'), { status: 429, code: 'too_many_attempts' });
  }
  const c = p1Client(flow.settings);
  const check = await fetch(`${c.base}/flows/${flowId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/vnd.pingidentity.usernamePassword.check+json',
      Accept: '*/*',
      Cookie: cookiesHeader(flow.cookies),
    },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(10_000),
  });
  mergeCookies(flow.cookies, check);
  const data = await check.json().catch(() => ({}));
  if (check.status === 400 && (data.details || []).some((d) => d?.code === 'INVALID_CREDENTIALS' || d?.code === 'CREDENTIAL_VALIDATION_FAILED')) {
    throw Object.assign(new Error('Username or password is incorrect.'), { status: 401, code: 'invalid_credentials' });
  }
  if (data.status && data.status !== 'COMPLETED') {
    throw Object.assign(new Error(`PingOne flow is at ${data.status} — this stub drives the username/password step only`), { status: 502, code: 'p1_error' });
  }
  // COMPLETED: resume to get the code (PingOne binds the ST session cookie; replay the jar).
  const resume = await fetch(`${c.base}/as/resume?flowId=${flowId}`, {
    headers: { Accept: '*/*', Cookie: cookiesHeader(flow.cookies) },
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  mergeCookies(flow.cookies, resume);
  let code = '';
  if ((resume.headers.get('content-type') || '').includes('json')) {
    code = (await resume.json().catch(() => ({})))?.authorizeResponse?.code || '';
  }
  if (!code && resume.headers.get('location')) {
    try { code = new URL(resume.headers.get('location')).searchParams.get('code') || ''; } catch { /* not a URL */ }
  }
  if (!code) {
    throw Object.assign(new Error(`PingOne sign-in did not produce a code (resume HTTP ${resume.status})`), { status: 502, code: 'p1_error' });
  }
  flows.delete(flowId);
  // trade the code + verifier for tokens. The user app authenticates with
  // client_secret_post (PINGONE_USER_TOKEN_ENDPOINT_AUTH_METHOD) — Basic auth is refused.
  const token = await fetch(`${c.base}/as/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code,
      redirect_uri: c.redirectUri,
      code_verifier: flow.verifier,
      client_id: c.id,
      client_secret: c.secret,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const tb = await token.json().catch(() => ({}));
  if (token.status !== 200) throw Object.assign(new Error(`PingOne token endpoint answered HTTP ${token.status} (${tb.error || '?'})`), { status: 502, code: 'p1_error' });
  return { accessToken: tb.access_token, idToken: tb.id_token, refreshToken: tb.refresh_token ? '[refresh token held server-side, not shown]' : null, issuer: `${c.base}/as`, grantedBy: `authorization code + PKCE via pi.flow (${c.id} as ${username})` };
}
