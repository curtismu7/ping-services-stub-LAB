// FIDO2 passkey enrollment: create a FIDO2 device for the demo user via the
// PingOne MFA API (worker token), hand the browser the creation options, then
// activate the device with the attestation the browser produced. Read-only
// except for the device record itself, which is the point.
import { loadSettings } from './settings.js';

const REGION_ALIAS = { na: 'com', us: 'com', com: 'com', eu: 'eu', ca: 'ca', ap: 'asia', asia: 'asia', au: 'asia' };

function apiBase(settings) {
  const region = REGION_ALIAS[String(settings.PINGONE_REGION || 'com').toLowerCase()] || 'com';
  return `https://api.pingone.${region}/v1/environments/${settings.PINGONE_ENVIRONMENT_ID}`;
}

async function workerToken(settings) {
  const region = REGION_ALIAS[String(settings.PINGONE_REGION || 'com').toLowerCase()] || 'com';
  const r = await fetch(`https://auth.pingone.${region}/${settings.PINGONE_ENVIRONMENT_ID}/as/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${settings.PINGONE_CLIENT_ID}:${settings.PINGONE_CLIENT_SECRET}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(10_000),
  });
  const b = await r.json().catch(() => ({}));
  if (r.status !== 200) throw Object.assign(new Error(`worker token HTTP ${r.status}`), { status: 502, code: 'p1_error' });
  return b.access_token;
}

async function findUserId(settings, username) {
  const base = apiBase(settings);
  const tok = await workerToken(settings);
  const r = await fetch(`${base}/users?filter=username eq "${username}"&limit=1`, {
    headers: { authorization: `Bearer ${tok}` },
    signal: AbortSignal.timeout(10_000),
  });
  const b = await r.json().catch(() => ({}));
  const u = (b._embedded?.users || [])[0];
  if (!u) throw Object.assign(new Error(`user "${username}" not found in the environment`), { status: 404, code: 'user_not_found' });
  return { userId: u.id, username: u.username, worker: tok };
}

// Step 1: create the device (status ACTIVATION_REQUIRED) and return the
// publicKeyCredentialCreationOptions for the browser's credentials.create().
export async function enrollStart(settings = loadSettings()) {
  if (!settings.PINGONE_CLIENT_ID || !settings.PINGONE_CLIENT_SECRET) {
    throw Object.assign(new Error('Passkey enrollment needs the PingOne worker app (PINGONE_CLIENT_ID / PINGONE_CLIENT_SECRET in the shared settings file)'), { status: 409, code: 'not_configured' });
  }
  const username = process.env.PINGONE_ENROLL_USERNAME || 'demoUser';
  const { userId, username: found, worker } = await findUserId(settings, username);
  const base = apiBase(settings);
  const r = await fetch(`${base}/users/${userId}/devices`, {
    method: 'POST',
    headers: { authorization: `Bearer ${worker}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'FIDO2', nickname: 'Enrolled from Ping Services Stub' }),
    signal: AbortSignal.timeout(10_000),
  });
  const b = await r.json().catch(() => ({}));
  if (r.status !== 201) {
    throw Object.assign(new Error(`device create answered HTTP ${r.status} (${b.code || b.message || '?'})`), { status: 502, code: 'p1_error' });
  }
  // The create response itself carries publicKeyCredentialCreationOptions
  // (string or object — challenge/user.id may be signed byte arrays).
  const opts = b.publicKeyCredentialCreationOptions ?? null;
  if (!opts) {
    throw Object.assign(new Error(`device created (${b.id}) but no publicKeyCredentialCreationOptions in the create response (device status ${b.status || '?'})`), { status: 502, code: 'p1_error' });
  }
  return { userId, username: found, deviceId: b.id, status: b.status, publicKeyCredentialCreationOptions: opts };
}

// Step 2: activate with the browser's attestation. PingOne wants the credential
// as a JSON string plus status ACTIVE.
export async function enrollComplete({ userId, deviceId, credential }, settings = loadSettings()) {
  if (!userId || !deviceId || !credential || typeof credential !== 'object') {
    throw Object.assign(new Error('body must be { userId, deviceId, credential }'), { status: 400, code: 'invalid_request' });
  }
  const base = apiBase(settings);
  const tok = await workerToken(settings);
  const r = await fetch(`${base}/users/${userId}/devices/${deviceId}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'ACTIVE', publicKeyCredential: JSON.stringify(credential) }),
    signal: AbortSignal.timeout(10_000),
  });
  const b = await r.json().catch(() => ({}));
  if (r.status !== 200 && r.status !== 201) {
    throw Object.assign(new Error(`device activation answered HTTP ${r.status} (${b.code || b.message || '?'})`), { status: 502, code: 'p1_error' });
  }
  return { ok: true, status: b.status || 'ACTIVE', deviceId, nickname: b.nickname || null };
}
