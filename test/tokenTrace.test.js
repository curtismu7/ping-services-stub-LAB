import { test } from 'node:test';
import { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { traceToken } from '../server/src/tokenTrace.js';

// A real RSA keypair so the signature rule can actually pass.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
const b64u = (b) => Buffer.from(b).toString('base64url');
const sign = (h, p) => crypto.createSign('RSA-SHA256').update(`${h}.${p}`).sign(privateKey, 'base64url');

function makeJwt({ header = { alg: 'RS256', typ: 'at+jwt', kid: 'test-key' }, claims, expired = false }) {
  const now = Math.floor(Date.now() / 1000);
  const c = { iss: 'https://issuer.test', sub: 'user-1', client_id: 'client-1', scope: 'read', iat: now, jti: 'jti-1', ...claims };
  if (expired) { c.exp = now - 100; c.nbf = now - 200; } else { c.exp = now + 600; c.nbf = now - 10; }
  const h = b64u(JSON.stringify(header));
  const p = b64u(JSON.stringify(c));
  return `${h}.${p}.${sign(h, p)}`;
}

// The trace fetches <iss>/.well-known/openid-configuration — point global fetch at a local JWKS server.
import http from 'node:http';
let server; let base;
async function startJwks() {
  if (server) return;
  server = http.createServer((req, res) => {
    if (req.url === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ issuer: `${base}`, jwks_uri: `${base}/jwks` }));
    } else if (req.url === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [{ ...jwk, use: 'sig', kid: 'test-key' }] }));
    } else { res.writeHead(404).end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
}
test('trace: a well-formed token passes every rule', async () => {
  await startJwks();
  const t = makeJwt({ claims: { iss: base } });
  const d = await traceToken(t);
  assert.equal(d.verdict, 'ACCEPTED');
  assert.equal(d.passed, d.total);
});


test('trace: expired token is REJECTED on the exp rule', async () => {
  await startJwks();
  const t = makeJwt({ claims: { iss: base }, expired: true });
  const d = await traceToken(t);
  assert.equal(d.verdict, 'REJECTED');
  const exp = d.checks.find((c) => c.rule === 'exp');
  assert.equal(exp.ok, false);
});


test('trace: tampered signature fails and the verdict is REJECTED', async () => {
  await startJwks();
  const t = makeJwt({ claims: { iss: base } });
  const parts = t.split('.');
  parts[2] = parts[2].slice(0, -2) + (parts[2].endsWith('AA') ? 'BB' : 'AA');
  const d = await traceToken(parts.join('.'));
  const sig = d.checks.find((c) => c.rule === 'signature');
  assert.equal(sig.ok, false);
  assert.equal(d.verdict, 'REJECTED');
});


test('trace: wrong typ is flagged', async () => {
  await startJwks();
  const t = makeJwt({ header: { alg: 'RS256', typ: 'weird', kid: 'test-key' }, claims: { iss: base } });
  const d = await traceToken(t);
  const typ = d.checks.find((c) => c.rule === 'typ');
  assert.equal(typ.ok, false);
});


test('trace: not a JWT at all → honest verdict', async () => {
  const d = await traceToken('hello world');
  assert.equal(d.verdict, 'NOT A JWT (opaque token)');
  assert.equal(d.checks[0].ok, false);
  assert.match(d.checks[0].detail, /introspection/);
  assert.equal(d.passed, 0);
  assert.equal(d.total, 1);
});

after(() => new Promise((r) => server?.close(r)));
