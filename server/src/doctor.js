// Doctor: settings file, probe each shared service, print PASS/FAIL lines. Exit 1 on any FAIL.
import { loadSettings } from './settings.js';
import { probeAll } from './probes.js';

const settings = loadSettings();
const checks = [];
checks.push([settings.present ? 'pass' : 'fail', `settings file ${settings.path}`, settings.present ? 'found' : 'missing (need PINGONE_* keys)']);
if (settings.realAvailable) checks.push(['pass', 'PingOne worker creds', 'present']);
else checks.push(['fail', 'PingOne worker creds', `incomplete in ${settings.path}`]);

const probes = await probeAll(settings);
for (const p of probes) {
  checks.push([p.ok ? 'pass' : 'fail', `${p.product}`, p.ok ? `up at ${p.url}` : p.detail || 'down']);
}

let fails = 0;
for (const [s, what, detail] of checks) {
  if (s === 'fail') fails++;
  console.log(`${s === 'pass' ? '✓' : '✗'} ${what}: ${detail}`);
}
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
