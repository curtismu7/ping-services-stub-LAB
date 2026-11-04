// Minimal pi.flow sign-in at the shared PingFederate (pattern proven in the
// ID-JAG lab): start a flow, submit credentials, trade the code for tokens.
// The user's tokens stay server-side; the trace shows decoded claims only.
import crypto from 'node:crypto';
import { loadSettings } from './settings.js';

const PF_URL = () => process.env.TRACE_PF_URL || 'https://local.ping-devops.com:9031';
const CLIENT = () => process.env.TRACE_PF_CLIENT_ID || 'id-jag-kit';
const SECRET = () => process.env.TRACE_PF_CLIENT_SECRET || process.env.PF_EXCHANGE_CLIENT_SECRET || '';

const FLOW_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const flows = new Map(); // flowId -> { cookies, startedAt, attempts, state, verifier }
const b64url = (b) => Buffer.from(b).toString('base64url');

function cookiesHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}
function mergeCookies(jar, res) {
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
}

export async function pfSigninStart() {
  const settings = loadSettings();
  if (!SECRET()) throw Object.assign(new Error('TRACE_PF_CLIENT_SECRET is not set (the shared PF id-jag-kit client secret)'), { status: 409, code: 'not_configured' });
  const verifier = b64url(crypto.randomBytes(32));
  const state = b64url(crypto.randomBytes(16));
  const url = new URL(`${PF_URL()}/as/authorization.oauth2`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT());
  const appOrigin = `http://localhost:${process.env.PORT || 6300}`;
  url.searchParams.set('redirect_uri', `${appOrigin}/auth/callback`);
  url.searchParams.set('scope', 'openid profile email offline_access');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', crypto.createHash('sha256').update(verifier).digest('base64url'));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('response_mode', 'pi.flow');
  const jar = {};
  const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  mergeCookies(jar, r);
  const data = await r.json().catch(() => ({}));
  if (typeof data.id !== 'string' || data.status !== 'USERNAME_PASSWORD_REQUIRED') {
    throw Object.assign(new Error(`PF authorize answered HTTP ${r.status} (${data.code || data.error || 'unexpected response'})`), { status: 502, code: 'pf_error' });
  }
  flows.set(data.id, { cookies: jar, startedAt: Date.now(), attempts: 0, state, verifier });
  return { flowId: data.id };
}

export async function pfSigninCredentials({ flowId, username, password }) {
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
  const check = await fetch(`${PF_URL()}/pf-ws/authn/flows/${flowId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/vnd.pingidentity.checkUsernamePassword+json',
      Accept: 'application/json',
      'X-XSRF-Header': 'PingFederate',
      Cookie: cookiesHeader(flow.cookies),
    },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(10_000),
  });
  mergeCookies(flow.cookies, check);
  const data = await check.json().catch(() => ({}));
  if (check.status === 400 && (data.details || []).some((d) => d?.code === 'CREDENTIAL_VALIDATION_FAILED')) {
    throw Object.assign(new Error('Username or password is incorrect.'), { status: 401, code: 'invalid_credentials' });
  }
  if (!check.ok || data.status !== 'COMPLETED' || typeof data.authorizeResponse?.code !== 'string') {
    throw Object.assign(new Error(`PF sign-in did not complete (HTTP ${check.status}, status ${data.status || '?'})`), { status: 502, code: 'pf_error' });
  }
  flows.delete(flowId);
  const code = data.authorizeResponse.code;
  // trade the code + verifier for tokens
  const token = await fetch(`${PF_URL()}/as/token.oauth2`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${CLIENT()}:${SECRET()}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code,
      redirect_uri: `http://localhost:${process.env.PORT || 6300}/auth/callback`,
      code_verifier: flow.verifier,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const tb = await token.json().catch(() => ({}));
  if (token.status !== 200) throw Object.assign(new Error(`token endpoint answered HTTP ${token.status} (${tb.error || '?'})`), { status: 502, code: 'pf_error' });
  return { accessToken: tb.access_token, idToken: tb.id_token, refreshToken: tb.refresh_token ? '[refresh token held server-side, not shown]' : null, issuer: PF_URL(), grantedBy: `authorization code + PKCE (${CLIENT()} as ${username})` };
}
