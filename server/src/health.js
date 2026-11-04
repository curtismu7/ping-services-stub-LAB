// Health contract: GET /api/health → demo-health/1
import { loadSettings } from './settings.js';
import { probeAll } from './probes.js';

export function createHealth() {
  const startedAt = new Date().toISOString();
  return {
    snapshot() {
      return {
        schema: 'demo-health/1',
        at: new Date().toISOString(),
        state: 'ready',
        runtime: 'offline',
        demo: { id: 'ping-services-stub', name: 'Ping Services Stub', version: '0.1.0' },
      };
    },
    async ready() { return true; },
    stop() {},
  };
}

export async function servicesSnapshot() {
  const settings = loadSettings();
  const probes = await probeAll(settings);
  return {
    at: new Date().toISOString(),
    mode: process.env.SERVICE_MODE || 'real',
    realAvailable: settings.realAvailable,
    services: probes,
  };
}
