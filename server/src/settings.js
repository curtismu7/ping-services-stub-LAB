// Shared settings loader — the family contract (ping-shared rule 94).
// Reads ~/Development/.env (or STANDALONE_ENV) and the SE-PF override env.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEYS = [
  'PINGONE_ENVIRONMENT_ID', 'PINGONE_REGION', 'PINGONE_CLIENT_ID', 'PINGONE_CLIENT_SECRET',
  'PF_URL', 'PF_AUDIENCE', 'PF_CA_FILE',
  'PRIVILEGE_CONSOLE_URL', 'PRIVILEGE_GATEWAY_URL',
  'PRIVILEGE_SSO_CLIENT_ID', 'PRIVILEGE_SSO_CLIENT_SECRET', 'PRIVILEGE_SSO_ENV_ID',
  // SE K8s PingFederate (cmuir) — this lab's extra
  'SE_PF_URL',
];

export function loadSettings(envPath) {
  const p = envPath || process.env.STANDALONE_ENV || join(homedir(), 'Development', '.env');
  const out = { path: p, present: false, realAvailable: false };
  for (const k of KEYS) out[k] = '';
  // A regular file only: Docker mounts an empty folder when the host file is missing.
  let isFile = false;
  try { isFile = statSync(p).isFile(); } catch { /* missing */ }
  if (isFile) {
    out.present = true;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && m[1] in out) out[m[1]] = m[2].trim();
    }
  }
  // SE PF default (owner's namespace); overridable via env or settings file
  out.SE_PF_URL = process.env.SE_PF_URL || out.SE_PF_URL || 'https://cmuir-pf-acme.ping-devops.com';
  out.realAvailable = Boolean(out.PINGONE_ENVIRONMENT_ID && out.PINGONE_CLIENT_ID && out.PINGONE_CLIENT_SECRET);
  return out;
}
