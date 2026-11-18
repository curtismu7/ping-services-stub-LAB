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

async function probePingoneUserApp(settings) {
  const env = settings.PINGONE_ENVIRONMENT_ID;
  if (!env) return { product: 'pingone-user', url: '', ok: false, detail: 'no PINGONE_ENVIRONMENT_ID in settings (the row checks the user app record the pi.flow sign-in depends on)' };
  const region = REGION_ALIAS[String(settings.PINGONE_REGION || 'com').toLowerCase()] || 'com';
  const url = `https://auth.pingone.${region}/${env}/as/.well-known/openid-configuration`;
  const r = await fetchProbe(url);
  return { product: 'pingone-user', url, ok: r.ok, status: r.status, detail: r.ok ? 'environment issuer answers (the app record itself is checked by the Test button)' : 'issuer unreachable' };
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
// 7809). The Privilege Agent Gateway has no ping-shared default; it stays configurable
// (PRIVILEGE_GATEWAY_HOST/PORT) and reports DOWN with a hint until the operator names it.
// Each target can be repointed with <PRODUCT>_HOST / <PRODUCT>_PORT for a non-default
// stack (for example an AI-DEMO2 checkout on its own ports).
const pingfederateTarget = () => ({
  host: process.env.PINGFEDERATE_HOST || '127.0.0.1',
  port: Number(process.env.PINGFEDERATE_PORT || 4732),
  probe: '/pf/heartbeat.ping', ok: [200], tls: true,
});
const pinggatewayTarget = () => ({
  host: process.env.PINGGATEWAY_HOST || '127.0.0.1',
  port: Number(process.env.PINGGATEWAY_PORT || 7809),
  probe: '/health', ok: [200],
  // ping-shared's 7809 is plain http; AI-DEMO2's 3036 serves TLS (self-signed). Override with PINGGATEWAY_TLS=true.
  tls: String(process.env.PINGGATEWAY_TLS || '').toLowerCase() === 'true' || (process.env.PINGGATEWAY_PORT === '3036'),
});
const privilegeGatewayTarget = () => ({
  host: process.env.PRIVILEGE_GATEWAY_HOST || '',
  port: Number(process.env.PRIVILEGE_GATEWAY_PORT || 0),
  probe: '/', ok: [200],
  // The mcpgw REST API on the host is plain http; PRIVILEGE_GATEWAY_TLS=true for a TLS front.
  tls: String(process.env.PRIVILEGE_GATEWAY_TLS || '').toLowerCase() === 'true',
});

function sharedUrl(t) {
  const scheme = t.tls ? 'https' : 'http';
  return `${scheme}://${t.host}:${t.port}${t.probe}`;
}

async function probeTarget(product, t) {
  if (!t.host || !t.port) {
    return { product, url: '', ok: false, detail: `not configured: set ${product === 'privilege-gateway' ? 'PRIVILEGE_GATEWAY_HOST and PRIVILEGE_GATEWAY_PORT' : `${product.toUpperCase()}_HOST and ${product.toUpperCase()}_PORT`} (or start the shared stack)` };
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

async function probeShared(product) {
  const t = product === 'pingfederate' ? pingfederateTarget()
    : product === 'pinggateway' ? pinggatewayTarget()
    : privilegeGatewayTarget();
  return probeTarget(product, t);
}

export async function probeAll(settings = loadSettings()) {
  const [pf, pg, priv, p1, p1user, p1priv, sepf] = await Promise.all([
    probeShared('pingfederate'),
    probeShared('pinggateway'),
    probeShared('privilege-gateway'),
    probePingoneSaas(settings),
    probePingoneUserApp(settings),
    probePrivilegeConsole(settings),
    probeSePf(settings),
  ]);
  return [pf, pg, priv, p1, p1user, p1priv, sepf];
}

export { tcpProbe };
