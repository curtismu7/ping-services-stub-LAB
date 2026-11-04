# Ping Services Stub LAB — agent notes

## What it is
A **Tester-tier** stub: one read-only call per shared Ping service (PF, PingGateway,
Privilege GW, PingOne, P1-Privilege console, SE-K8s PF). Proves wiring, not features.

## Run / test
- `npm start` → http://127.0.0.1:6300 (loopback only)
- `npm run doctor` — PASS/FAIL per service; exit 1 on any FAIL
- `npm test` — node:test glob (never a directory)
- `npm run reset` — stateless; resets mode only

## The rules that bite
- **Mock/Real is rule 19**: `POST /api/mode {source}`, `GET /api/info` returns mode +
  realAvailable; Real disabled + 409 when settings missing. Toggle must work both
  directions without a restart (the page reloads data; server state switches live).
- **Settings** come from `~/Development/.env` (ping-shared rule 94 contract).
  Agents never use live creds — the tests stub them.
- **Loopback-only bind** (PORT 6300), Host check allows 127.0.0.1/localhost/
  local.ping-devops.com (+LAB_ALLOWED_HOSTS).
- **SE PF** (`cmuir-pf-acme.ping-devops.com`) is publicly CA-signed — plain fetch,
  no CA override. Local PFs are mkcert — the tests never contact them.
- Never add identifiers from other repos (forbidden-strings: cmuir_pingcorp,
  AI-DEMO2/, local.ping-devops.com in *this repo's* files — use LAB_ALLOWED_HOSTS
  runtime values instead; check ci.yml's forbidden-strings job for the exact list).
