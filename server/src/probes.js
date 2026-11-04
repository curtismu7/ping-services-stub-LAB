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

const REGION_ALIAS = { na: 'com', us: 'com', com: 'com', eu: 'eu', ca: 'ca', ap: 'asia', asia: 'asia', au: 'asia' };

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

// The three Docker products are probed directly (in-process, works inside Docker):
// a TCP connect to the published loopback port, exactly what the shared probe checks.
const SHARED_PORTS = {
  pingfederate: { port: 9031, url: '127.0.0.1:9031/pf/heartbeat.ping (host)' },
  pinggateway: { port: 3036, url: '127.0.0.1:3036/mcp (host)' },
  'privilege-gateway': { port: 8623, url: '127.0.0.1:8623/ (host)' },
};

async function probeShared(product) {
  const t = SHARED_PORTS[product];
  const host = process.env.PROBE_HOST || '127.0.0.1';
  const up = await tcpProbe(host, t.port);
  return { product, url: t.url, ok: up, detail: up ? `listening on ${host}:${t.port}` : `nothing on ${host}:${t.port} (start the shared stack)` };
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
