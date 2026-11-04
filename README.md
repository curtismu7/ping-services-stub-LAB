# Ping Services Stub LAB

One stub that exercises **every shared Ping service the family deploys** (rule 20, shared-first):

| Service | Where | What the stub does |
|---|---|---|
| PingFederate (shared, local) | `127.0.0.1:9031` via ping-shared | OIDC discovery + JWKS fetch |
| PingGateway (shared, local) | `127.0.0.1:3036` | `POST /mcp` unauthenticated → 401/405 proves the enforcement point |
| Privilege Agent Gateway (shared, local) | `127.0.0.1:8623` | root listener probe |
| PingOne (SaaS) | `auth.pingone.<region>` | worker `client_credentials` + populations read |
| PingOne Privilege (SaaS console) | `console.privilege.pingone.com` | reachability probe (registration stays console-manual) |
| PingFederate (SE K8s, cmuir) | `https://cmuir-pf-acme.ping-devops.com` | discovery + heartbeat |

## Run

```sh
npm install
npm start            # http://127.0.0.1:6300
npm run doctor       # PASS/FAIL per service
npm test
```

Docker (OrbStack; reads `~/Development/.env` read-only):

```sh
docker compose -f deploy/docker-compose.yml up -d --build
```

## Token trace

**Get a token, then trace it** the way a resource server would — without the token ever being copied through a chat or shown raw:

- **Get PingOne worker token (M2M)**: `client_credentials` with the shared settings file's worker client; the trace decodes it, verifies the RS256 signature against PingOne's JWKS, and checks typ/iss/exp/nbf/sub/scope/client_id rule by rule.
- **Get PF token (M2M, password grant)**: guarded behind `TRACE_PF_M2M_*` env (it sends a password); traces an SE-PF token, signature verified against the SE PF's JWKS.
- **Sign in at PingFederate**: pi.flow at the shared PF (`id-jag-kit`, code + PKCE); the browser never sees a token — the server holds it, traces the ID token, and reports the access token honestly (this PF's ATM mints opaque access tokens, so the trace says "not a JWT" rather than pretending).
- **Trace a pasted token**: paste anything; the server decodes and validates it, nothing else.

Tokens stay server-side; the page shows decoded claims and rule-by-rule pass/fail only. The trace never replays the token against a resource server.

To trace the shared local PF (self-signed cert), run the stub with `NODE_EXTRA_CA_CERTS=deploy/pf-rootCA.pem TRACE_PF_URL=https://127.0.0.1:4732 TRACE_PF_CLIENT_ID=id-jag-kit TRACE_PF_CLIENT_SECRET=...` (the secret lives in `~/.config/demo-kit/provisioning.json` under `pingfederate.idJagKitClientSecret`).

## Mock / Real (rule 19)

- **Real** (default when `~/Development/.env` has worker creds): probes + exercises hit the real services, one read-only call each.
- **Mock**: canned probe answers, zero outbound calls, fully offline.
- The header toggle switches at runtime (`POST /api/mode`); Real is disabled with a how-to tooltip when settings are missing (server answers 409).

## Honest-scope notes

- Every real call is **read-only**: discovery, heartbeat, JWKS, populations list, root probes. The stub provisions nothing, registers nothing, changes nothing.
- PingOne Privilege console registration cannot be automated (console rejects worker tokens) — this lab probes reachability only.
- `catalogId D114` is a placeholder pending a real catalog row.

## Run from the shelf

`docs/shelf-entry.json` registers it; clone next to the shelf and press Deploy (or Start once installed).
