// PingOne pi.flow sign-in: authorization code + PKCE with response_mode=pi.flow
// (the same driver pattern the BFF uses, reduced to what the trace needs).
// The user path at PingOne — NOT the worker (client_credentials) path, whose
// tokens are scope-less by design. Tokens stay server-side; the trace shows
// decoded claims only.
//
// MFA: the flow opens with acr_values=mfa_only, so the environment's Multi_Factor
// sign-on policy drives identifier-first → device selection (or OTP directly) →
// otp.check. Supported steps: SIGN_ON_REQUIRED (user lookup), PASSWORD_REQUIRED,
// DEVICE_SELECTION_REQUIRED, OTP_REQUIRED, COMPLETED. FIDO2/passkey devices are
// offered but the stub cannot run the WebAuthn ceremony — it says so.
import crypto from 'node:crypto';
import { loadSettings } from './settings.js';
import { REGION_ALIAS } from './probes.js';

const FLOW_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
// flowId -> { cookies, startedAt, attempts, state, verifier, settings, username }
const flows = new Map();
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

async function flowStep(flow, flowId, contentType, body, base) {
  const r = await fetch(`${base}/flows/${flowId}`, {
    method: 'POST',
    headers: { 'content-type': contentType, Accept: '*/*', Cookie: cookiesHeader(flow.cookies) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  mergeCookies(flow.cookies, r);
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

// Resume a COMPLETED flow for the authorization code.
async function resumeForCode(flow, flowId, base) {
  const resume = await fetch(`${base}/as/resume?flowId=${flowId}`, {
    headers: { Accept: '*/*', Cookie: cookiesHeader(flow.cookies) },
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  mergeCookies(flow.cookies, resume);
  if ((resume.headers.get('content-type') || '').includes('json')) {
    const code = (await resume.json().catch(() => ({})))?.authorizeResponse?.code || '';
    if (code) return code;
  }
  if (resume.headers.get('location')) {
    try {
      const code = new URL(resume.headers.get('location')).searchParams.get('code') || '';
      if (code) return code;
    } catch { /* not a URL */ }
  }
  throw Object.assign(new Error(`PingOne sign-in did not produce a code (resume HTTP ${resume.status})`), { status: 502, code: 'p1_error' });
}

async function exchangeCode(flow, flowId, code, username, base, c) {
  // The user app authenticates with client_secret_post (PINGONE_USER_TOKEN_ENDPOINT_AUTH_METHOD).
  const token = await fetch(`${base}/as/token`, {
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
  flows.delete(flowId);
  return { accessToken: tb.access_token, idToken: tb.id_token, refreshToken: tb.refresh_token ? '[refresh token held server-side, not shown]' : null, issuer: `${base}/as`, grantedBy: `authorization code + PKCE via pi.flow, MFA (${c.id} as ${username})` };
}

const DEVICE_LABEL = { EMAIL: 'Email', SMS: 'SMS', FIDO2: 'Passkey', TOTP: 'Authenticator app' };
function deviceLabel(d) {
  const kind = DEVICE_LABEL[d.type] || d.type;
  if (d.type === 'EMAIL') return `${kind} · ${d.email || ''}`;
  if (d.type === 'SMS') return `${kind} · ${d.phone || ''}`;
  return kind;
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
  // mfa_only: the sign-on policy's MFA action fires on every sign-in (identifier
  // first → device selection / OTP), so the trace always shows a user token that
  // MFA happened on — the thing a resource server would verify.
  url.searchParams.set('acr_values', 'mfa_only');
  const jar = {};
  const r = await fetch(url, { headers: { Accept: '*/*' }, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  mergeCookies(jar, r);
  const data = await r.json().catch(() => ({}));
  if (typeof data.id !== 'string' || !data.id) {
    throw Object.assign(new Error(`PingOne authorize answered HTTP ${r.status} (${data.code || data.error || 'unexpected response'})`), { status: 502, code: 'p1_error' });
  }
  flows.set(data.id, { cookies: jar, startedAt: Date.now(), attempts: 0, state, verifier, settings, status: data.status || null });
  return { flowId: data.id, status: data.status || null };
}

// Step 1: identifier (and password when the flow asks for it). Returns the new
// flow state; the browser polls POST /auth/p1/step until it sees a final form.
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
  flow.username = username;
  let step;
  if (flow.status === 'SIGN_ON_REQUIRED') {
    // identifier-first policy: user.lookup, then password when asked
    step = await flowStep(flow, flowId, 'application/vnd.pingidentity.user.lookup+json', { username }, c.base);
    if (step.data.status === 'PASSWORD_REQUIRED') {
      step = await flowStep(flow, flowId, 'application/vnd.pingidentity.usernamePassword.check+json', { username, password }, c.base);
    }
  } else {
    // combined username+password validator
    step = await flowStep(flow, flowId, 'application/vnd.pingidentity.usernamePassword.check+json', { username, password }, c.base);
  }
  const { status: http, data } = step;
  if (http === 400 && (data.details || []).some((d) => d?.code === 'INVALID_CREDENTIALS' || d?.code === 'CREDENTIAL_VALIDATION_FAILED')) {
    throw Object.assign(new Error('Username or password is incorrect.'), { status: 401, code: 'invalid_credentials' });
  }
  if (http !== 200 && http !== 201) {
    throw Object.assign(new Error(`PingOne flow step failed (HTTP ${http}, ${data.code || '?'})`), { status: 502, code: 'p1_error' });
  }
  flow.status = data.status;
  return { status: data.status, next: nextStep(data), devices: devicesOf(data) };
}

// Step 2a: pick an MFA device (from DEVICE_SELECTION_REQUIRED).
export async function p1SigninDevice({ flowId, deviceId }) {
  const flow = flows.get(flowId);
  if (!flow || Date.now() - flow.startedAt > FLOW_TTL_MS) {
    flows.delete(flowId);
    throw Object.assign(new Error('no active flow — start one first'), { status: 409, code: 'flow_not_started' });
  }
  const c = p1Client(flow.settings);
  // PingOne nests the device id: { device: { id } } — a bare { id } is a 400.
  const step = await flowStep(flow, flowId, 'application/vnd.pingidentity.device.select+json', { device: { id: deviceId } }, c.base);
  const { status: http, data } = step;
  if (http !== 200 && http !== 201) {
    throw Object.assign(new Error(`device selection failed (HTTP ${http}, ${data.code || '?'})`), { status: 502, code: 'p1_error' });
  }
  flow.status = data.status;
  return { status: data.status, next: nextStep(data), devices: devicesOf(data) };
}

// Step 2b: submit the OTP (OTP_REQUIRED), or start/pass on a FIDO2 device.
export async function p1SigninOtp({ flowId, otp, fido2 }) {
  const flow = flows.get(flowId);
  if (!flow || Date.now() - flow.startedAt > FLOW_TTL_MS) {
    flows.delete(flowId);
    throw Object.assign(new Error('no active flow — start one first'), { status: 409, code: 'flow_not_started' });
  }
  const c = p1Client(flow.settings);
  if (fido2) {
    throw Object.assign(new Error('Passkey (FIDO2) verification needs the WebAuthn browser ceremony, which this stub does not run. Pick an Email or SMS device instead.'), { status: 400, code: 'fido2_unsupported' });
  }
  const step = await flowStep(flow, flowId, 'application/vnd.pingidentity.otp.check+json', { otp: String(otp || '').trim() }, c.base);
  const { status: http, data } = step;
  if (http === 400 && (data.details || []).some((d) => d?.code === 'INVALID_OTP')) {
    throw Object.assign(new Error('That code is not correct (or expired). Check the latest message.'), { status: 401, code: 'invalid_otp' });
  }
  if (http !== 200 && http !== 201) {
    throw Object.assign(new Error(`OTP check failed (HTTP ${http}, ${data.code || '?'})`), { status: 502, code: 'p1_error' });
  }
  flow.status = data.status;
  if (data.status !== 'COMPLETED') return { status: data.status, next: nextStep(data), devices: devicesOf(data) };
  const code = await resumeForCode(flow, flowId, c.base);
  return exchangeCode(flow, flowId, code, flow.username || '', c.base, c);
}

// Complete a flow that reached COMPLETED (used straight after password when no MFA fired).
export async function p1SigninComplete({ flowId }) {
  const flow = flows.get(flowId);
  if (!flow) throw Object.assign(new Error('no active flow — start one first'), { status: 409, code: 'flow_not_started' });
  const c = p1Client(flow.settings);
  const code = await resumeForCode(flow, flowId, c.base);
  return exchangeCode(flow, flowId, code, flow.username || '', c.base, c);
}

// What the UI should render for a flow state.
function nextStep(data) {
  switch (data.status) {
    case 'COMPLETED': return 'complete';
    case 'DEVICE_SELECTION_REQUIRED': return 'device';
    case 'OTP_REQUIRED': return 'otp';
    case 'PASSWORD_REQUIRED': return 'password';
    default: return `unexpected:${data.status}`;
  }
}
function devicesOf(data) {
  const list = (data._embedded?.devices || data.devices || [])
    .filter((d) => d.usableStatus?.status === 'ENABLED')
    .map((d) => ({ id: d.id, type: d.type, label: deviceLabel(d), fido2: d.type === 'FIDO2' }));
  return list;
}
