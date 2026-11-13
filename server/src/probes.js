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
// privilege-gateway: since the 2026-11-12 v1.261112-NYL binary swap the mcpgw :8623
// listener is GONE (the binary derives :443 from SERVER_URL); its published REST API
// on 8620 is the port that still answers on the host.
const SHARED_PORTS = {
  // The shared PF cert's SAN covers local.ping-devops.com only — a probe by IP or
  // host.docker.internal dies on TLS before it can report the service's real state.
  pingfederate: { host: 'local.ping-devops.com', port: 9031, url: '127.0.0.1:9031/pf/heartbeat.ping (host)', probe: '/pf/heartbeat.ping', ok: [200], tls: true },
  pinggateway: { host: 'local.ping-devops.com', port: 3036, url: '127.0.0.1:3036/mcp (host)', probe: '/mcp', ok: [200, 401, 405], tls: true },
  'privilege-gateway': { host: 'local.ping-devops.com', port: 8620, url: '127.0.0.1:8620/ (host; mcpgw REST API, post-261112)', probe: '/', ok: [200], tls: false },
};

async function probeShared(product) {
  const t = SHARED_PORTS[product];
  const host = t.host;
  const scheme = t.tls ? 'https' : 'http';
  const up = await tcpProbe(host, t.port);
  if (!up) return { product, url: t.url, ok: false, detail: `nothing on ${host}:${t.port} (start the shared stack)` };
  // TCP is open: make the real call so a half-dead front (a shim, nginx, a proxy to a
  // stopped container) reports DOWN, not UP.
  try {
    const init = t.probe === '/mcp' ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' } : {};
    const r = await fetch(`${scheme}://${host}:${t.port}${t.probe}`, { ...init, signal: AbortSignal.timeout(5000) });
    const ok = t.ok.includes(r.status);
    return { product, url: t.url, ok, detail: ok ? `HTTP ${r.status} on ${host}:${t.port}` : `port ${host}:${t.port} open but the service answered HTTP ${r.status} (start the shared stack)` };
  } catch (e) {
    return { product, url: t.url, ok: false, detail: `port ${host}:${t.port} open but the call failed (${e.cause?.code || e.message})` };
  }
}

export async function probeAll(settings = loadSettings()) {
  const [pf, pg, priv, p1, p1priv, sepf] = await Promise.all([
    probeShared('pingfederate'),
    probeShared('pinggateway'),
    probeShared('privilege-gateway'),
    probePingoneSaas(settings),
    probePrivilegeConsole(settings),
    probeSePf(settings),
  ]);
  return [pf, pg, priv, p1, p1priv, sepf];
}

export { tcpProbe };
