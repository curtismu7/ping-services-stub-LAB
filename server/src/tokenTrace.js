// Token trace: get tokens from the shared PingOne (worker M2M) and the shared
// PingFederate (M2M via password grant at the SE? no — LOCAL PF pi.flow for the
// user path; P1 worker for the machine path), then trace: decode, fetch the
// issuer's JWKS, verify the signature, and check the rules a resource server
// would check. Every call read-only in effect (a token grant changes nothing).
//
// Honest scope: tokens are minted for THIS stub's clients; nothing is replayed
// against a resource server. Validation is done here, rule by rule.
import crypto from 'node:crypto';
import { loadSettings } from './settings.js';
import { REGION_ALIAS } from './probes.js';

const PF_URL = () => process.env.TRACE_PF_URL || 'https://local.ping-devops.com:9031';
const PF_CLIENT_ID = () => process.env.TRACE_PF_CLIENT_ID || 'id-jag-kit';
const PF_CLIENT_SECRET = () => process.env.TRACE_PF_CLIENT_SECRET || '';

const b64u = (s) => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '='), 'base64url').toString('utf8'));

function decodeJwt(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) throw new Error('not a three-part JWT');
  return { header: b64u(parts[0]), claims: b64u(parts[1]), signature: parts[2], signingInput: `${parts[0]}.${parts[1]}` };
}

// Simpler correct signature verify (closure-free):
async function verifyJwt(jwt, jwks) {
  const [h, p, sig] = jwt.split('.');
  const header = b64u(h);
  if (header.alg !== 'RS256') return { ok: false, rule: 'signature', detail: `alg ${header.alg} is not RS256` };
  const key = (jwks.keys || []).find((k) => k.kid === header.kid && k.kty === 'RSA' && (!k.use || k.use === 'sig'));
  if (!key) return { ok: false, rule: 'signature', detail: `no RSA signing key with kid "${header.kid}" in the JWKS` };
  const keyObject = crypto.createPublicKey({ key: { kty: 'RSA', n: key.n, e: key.e }, format: 'jwk' });
  const ok = crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(keyObject, Buffer.from(sig, 'base64url'));
  return { ok, rule: 'signature', detail: ok ? `RS256 signature verified against the JWKS (kid ${header.kid})` : 'signature does not verify against any JWKS key' };
}

const ALG_ALIAS = { na: 'com', us: 'com', com: 'com', eu: 'eu', ca: 'ca', ap: 'asia', asia: 'asia', au: 'asia' };

/** M2M: PingOne worker client_credentials. Returns the access token + issuer. */
export async function getPingOneToken(settings = loadSettings()) {
  const region = REGION_ALIAS[String(settings.PINGONE_REGION || 'com').toLowerCase()] || 'com';
  const env = settings.PINGONE_ENVIRONMENT_ID;
  if (!env || !settings.PINGONE_CLIENT_ID || !settings.PINGONE_CLIENT_SECRET) {
    throw Object.assign(new Error('PingOne worker credentials are not configured (need PINGONE_ENVIRONMENT_ID, PINGONE_CLIENT_ID, PINGONE_CLIENT_SECRET in the shared settings file)'), { status: 409, code: 'not_configured' });
  }
  const issuer = `https://auth.pingone.${region}/${env}`;
  const r = await fetch(`${issuer}/as/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${settings.PINGONE_CLIENT_ID}:${settings.PINGONE_CLIENT_SECRET}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(10_000),
  });
  const body = await r.json().catch(() => ({}));
  if (r.status !== 200) throw Object.assign(new Error(`PingOne token endpoint answered HTTP ${r.status} (${body.error || 'unknown error'})`), { status: 502, code: 'issuer_error' });
  return { token: body.access_token, issuer, grantedBy: 'client_credentials (PingOne worker)' };
}

/** M2M at the SE PingFederate? No: the shared LOCAL PF has no client_credentials
 * client this stub may use. The SE PF's acme-agent has a password grant (owner
 * provisioned). Guarded by an env switch because it sends a password. */
export async function getPfM2mToken(settings = loadSettings()) {
  const base = (settings.SE_PF_URL || 'https://cmuir-pf-acme.ping-devops.com').replace(/\/$/, '');
  const client = process.env.TRACE_PF_M2M_CLIENT_ID || 'acme-agent';
  const secret = process.env.TRACE_PF_M2M_CLIENT_SECRET || '';
  const username = process.env.TRACE_PF_M2M_USERNAME || 'acme-user';
  const password = process.env.TRACE_PF_M2M_PASSWORD || '';
  if (!secret || !password) {
    throw Object.assign(new Error('PF M2M trace needs TRACE_PF_M2M_CLIENT_SECRET and TRACE_PF_M2M_PASSWORD (password grant — env-gated on purpose)'), { status: 409, code: 'not_configured' });
  }
  const r = await fetch(`${base}/as/token.oauth2`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${client}:${secret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'password', username, password }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await r.json().catch(() => ({}));
  if (r.status !== 200) throw Object.assign(new Error(`PF token endpoint answered HTTP ${r.status} (${body.error || 'unknown'})`), { status: 502, code: 'issuer_error' });
  return { token: body.access_token, issuer: base, grantedBy: `password grant (${client} as ${username})` };
}

/** Trace a token: decode → JWKS → signature → the rules a resource server checks. */
export async function traceToken(token, { now = Date.now() } = {}) {
  const checks = [];
  let header; let claims;
  try {
    ({ header, claims } = decodeJwt(token));
    checks.push({ rule: 'three parts', ok: true, detail: 'header.claims.signature with base64url segments' });
  } catch (e) {
    return { checks: [{ rule: 'three parts', ok: false, detail: e.message }], verdict: 'not a JWT' };
  }
  const add = (rule, ok, detail) => checks.push({ rule, ok, detail });

  // typ
  const typ = header.typ || '';
  const typOk = /^(at\+jwt|access_jwt|jwt)$/i.test(typ);
  const typMissing = typ === '';
  add('typ', typOk || typMissing, `typ "${typ}" ${typOk ? 'is an access-token type' : typMissing ? 'is absent — some issuers (PingOne) omit it; a resource server MAY require it (RFC 9068 recommends at+jwt)' : 'is not a recognized access-token type'}`);

  // issuer + discovery + JWKS + signature
  const iss = claims.iss;
  if (!iss) {
    add('iss', false, 'no iss claim');
    add('signature', false, 'cannot verify without an issuer');
  } else {
    const isHttps = /^https:\/\//.test(iss);
    const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(iss);
    add('iss', isHttps || isLoopback, `iss "${iss}" ${isHttps ? '' : isLoopback ? '(loopback http: acceptable for native apps, RFC 8252)' : 'is not https'}`);
    let jwks = null;
    let discoveryIssuer = null;
    try {
      const wellKnown = iss === PF_URL()
        ? `${iss}/.well-known/openid-configuration`
        : iss.includes('/as/') ? `${iss}/.well-known/openid-configuration` : `${iss}/.well-known/openid-configuration`;
      const d = await (await fetch(wellKnown, { signal: AbortSignal.timeout(8000) })).json();
      discoveryIssuer = d.issuer;
      const jwksUrl = d.jwks_uri;
      jwks = await (await fetch(jwksUrl, { signal: AbortSignal.timeout(8000) })).json();
      add('discovery', true, `discovery at ${wellKnown}, JWKS at ${jwksUrl}`);
      add('iss matches discovery', discoveryIssuer.replace(/\/$/, '') === iss.replace(/\/$/, ''), `token iss ${iss} vs discovery ${discoveryIssuer}`);
    } catch (e) {
      add('discovery', false, `could not read discovery/JWKS for ${iss}: ${e.cause?.code || e.message}`);
      add('signature', false, 'skipped: no JWKS');
    }
    if (jwks) {
      add('signature', ...(await (async () => {
        const v = await verifyJwt(token, jwks);
        return [v.ok, v.detail];
      })()));
    }
  }

  // time claims
  const nowSec = Math.floor(now / 1000);
  const exp = claims.exp;
  const nbf = claims.nbf;
  if (typeof exp !== 'number') add('exp', false, 'no exp claim');
  else add('exp', exp > nowSec, `exp ${new Date(exp * 1000).toISOString()} ${exp > nowSec ? 'is in the future' : 'has PASSED'} (lifetime ${typeof nbf === 'number' ? `${exp - nbf}s` : 'unknown'})`);
  if (typeof nbf === 'number') add('nbf', nbf <= nowSec, `nbf ${new Date(nbf * 1000).toISOString()} ${nbf <= nowSec ? 'has passed' : 'is in the FUTURE'}`);

  // sub / scope / client_id
  add('sub', typeof claims.sub === 'string' && claims.sub.length > 0, claims.sub ? `sub "${claims.sub.slice(0, 40)}"` : 'no sub claim');
  const scope = typeof claims.scope === 'string' ? claims.scope : Array.isArray(claims.scope) ? claims.scope.join(' ') : '';
  add('scope', scope.length > 0, scope ? `scope "${scope}"` : 'no scope claim (may be scope-less by design for some M2M tokens)');
  add('client_id', typeof claims.client_id === 'string' && claims.client_id.length > 0, claims.client_id ? `client_id "${claims.client_id}"` : 'no client_id claim');

  // jti (single-use is a resource-AS choice, presence is good hygiene)
  add('jti', typeof claims.jti === 'string' || claims.jti === undefined, claims.jti ? `jti present (single-use enforcement is the resource server's choice)` : 'no jti (common for bearer access tokens)');

  const passed = checks.filter((c) => c.ok).length;
  const fatal = checks.some((c) => !c.ok && ['three parts', 'signature', 'exp', 'nbf'].includes(c.rule)) || checks.some((c) => c.rule === 'typ' && !c.ok && !/absent/.test(c.detail));
  return { header, claims, checks, verdict: fatal ? 'REJECTED' : passed === checks.length ? 'ACCEPTED' : 'ACCEPTED WITH NOTES', passed, total: checks.length };
}
