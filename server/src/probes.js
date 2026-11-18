// Service probes — reuse before spawn (rule 20). Wraps the shared ping-shared
// probe contract and adds the SE-K8s PingFederate and PingOne-Privilege.
// Each probe returns { product, url, ok, detail }.
import net from 'node:net';
import { loadSettings } from './settings.js';


function tcpProbe(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: timeoutMs });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

async function fetchProbe(url, { timeoutMs = 5000, ok = [200] } = {}) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: ok.includes(r.status), status: r.status };
  } catch (e) {
    return { ok: false, status: 0, detail: e.cause?.code || e.message };
  }
}

// SE PingFederate serves a real publicly-CA-signed cert — plain fetch works.
async function probeSePf(settings) {
  const base = settings.SE_PF_URL;
  const r = await fetchProbe(`${base}/pf/heartbeat.ping`);
  return { product: 'se-pingfederate', url: `${base}/pf/heartbeat.ping`, ok: r.ok, status: r.status, detail: r.detail || 'SE K8s PingFederate (ping-devops-cmuir)' };
}

export const REGION_ALIAS = { na: 'com', us: 'com', com: 'com', eu: 'eu', ca: 'ca', ap: 'asia', asia: 'asia', au: 'asia' };

async function probePingoneSaas(settings) {
  const region = REGION_ALIAS[String(settings.PINGONE_REGION || 'com').toLowerCase()] || 'com';
  const env = settings.PINGONE_ENVIRONMENT_ID;
  if (!env) return { product: 'pingone', url: '', ok: false, detail: 'no PINGONE_ENVIRONMENT_ID in settings' };
  const url = `https://auth.pingone.${region}/${env}/as/.well-known/openid-configuration`;
  const r = await fetchProbe(url);
  return { product: 'pingone', url, ok: r.ok, status: r.status };
}

async function probePrivilegeConsole(settings) {
  const url = settings.PRIVILEGE_CONSOLE_URL || 'https://console.privilege.pingone.com/';
  const r = await fetchProbe(url, { ok: [200, 302, 401, 403] });
  return { product: 'pingone-privilege', url, ok: r.ok, status: r.status, detail: 'SaaS console reachable = telemetry only; registration stays manual' };
}

// The three Docker products are probed with a real HTTP call (not just a TCP connect):
// a TCP connect reports UP while the port is held by a dead shim/proxy that answers 502
// (the metadata shim in front of a stopped PingFederate did exactly that). The URL that
// the HTTP probe checks is what the UP/DOWN cell shows.
// Defaults are ping-shared's fixed infrastructure ports (PF engine 4732, PingGateway
// 7809; the gateway's host port follows ping-shared's PINGGATEWAY_HOST_PORT). The
// Privilege Agent Gateway has no ping-shared default and no built-in address: the user
// supplies PRIVILEGE_GATEWAY_URL (environment or the settings file), or
// PRIVILEGE_GATEWAY_HOST/PORT, and the row reports "not configured" until then.
// Each target can be repointed with <PRODUCT>_HOST / <PRODUCT>_PORT for another stack.
export const pinggatewayPort = (env = process.env) => Number(env.PINGGATEWAY_PORT || env.PINGGATEWAY_HOST_PORT || 7809);

const pingfederateTarget = () => ({
  host: process.env.PINGFEDERATE_HOST || '127.0.0.1',
  port: Number(process.env.PINGFEDERATE_PORT || 4732),
  probe: '/pf/heartbeat.ping', ok: [200], tls: true,
});
const pinggatewayTarget = () => ({
  host: process.env.PINGGATEWAY_HOST || '127.0.0.1',
  port: pinggatewayPort(),
  probe: '/health', ok: [200], tls: false,
});

// The Privilege gateway address the user supplied, as a base URL ('' when none).
export function privilegeGatewayBase(settings = loadSettings(), env = process.env) {
  const url = env.PRIVILEGE_GATEWAY_URL || settings.PRIVILEGE_GATEWAY_URL || '';
  if (url) return url.replace(/\/+$/, '');
  if (env.PRIVILEGE_GATEWAY_HOST && env.PRIVILEGE_GATEWAY_PORT) return `http://${env.PRIVILEGE_GATEWAY_HOST}:${env.PRIVILEGE_GATEWAY_PORT}`;
  return '';
}

export function privilegeGatewayTarget(settings = loadSettings(), env = process.env) {
  const base = privilegeGatewayBase(settings, env);
  let u = null;
  try { u = base ? new URL(base) : null; } catch { /* not a URL: treated as not configured */ }
  if (!u) return { host: '', port: 0, probe: '/', ok: [200], tls: false };
  const tls = u.protocol === 'https:';
  return { host: u.hostname, port: Number(u.port || (tls ? 443 : 80)), probe: `${u.pathname.replace(/\/+$/, '')}/`, ok: [200], tls };
}

function sharedUrl(t) {
  const scheme = t.tls ? 'https' : 'http';
  return `${scheme}://${t.host}:${t.port}${t.probe}`;
}

async function probeTarget(product, t) {
  if (!t.host || !t.port) {
    return { product, url: '', ok: false, detail: `not configured: set ${product === 'privilege-gateway' ? 'PRIVILEGE_GATEWAY_URL (your own Privilege gateway; there is no default)' : `${product.toUpperCase()}_HOST and ${product.toUpperCase()}_PORT`} (or start the shared stack)` };
  }
  const up = await tcpProbe(t.host, t.port);
  if (!up) return { product, url: `${t.host}:${t.port}${t.probe}`, ok: false, detail: `nothing on ${t.host}:${t.port} (start the shared stack)` };
  // TCP is open: make the real call so a half-dead front (a shim, nginx, a proxy to a
  // stopped container) reports DOWN, not UP.
  try {
    const scheme = t.tls ? 'https' : 'http';
    const r = await fetch(`${scheme}://${t.host}:${t.port}${t.probe}`, { signal: AbortSignal.timeout(5000) });
    const ok = t.ok.includes(r.status);
    return { product, url: `${t.host}:${t.port}${t.probe}`, ok, detail: ok ? `HTTP ${r.status} on ${t.host}:${t.port}` : `port ${t.host}:${t.port} open but the service answered HTTP ${r.status} (start the shared stack)` };
  } catch (e) {
    return { product, url: `${t.host}:${t.port}${t.probe}`, ok: false, detail: `port ${t.host}:${t.port} open but the call failed (${e.cause?.code || e.message})` };
  }
}

async function probeShared(product, settings = loadSettings()) {
  const t = product === 'pingfederate' ? pingfederateTarget()
    : product === 'pinggateway' ? pinggatewayTarget()
    : privilegeGatewayTarget(settings);
  return probeTarget(product, t);
}

export async function probeAll(settings = loadSettings()) {
  const [pf, pg, priv, p1, p1priv, sepf] = await Promise.all([
    probeShared('pingfederate'),
    probeShared('pinggateway'),
    probeShared('privilege-gateway', settings),
    probePingoneSaas(settings),
    probePrivilegeConsole(settings),
    probeSePf(settings),
  ]);
  return [pf, pg, priv, p1, p1priv, sepf];
}

export { tcpProbe };
