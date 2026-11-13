# Ping Services Stub LAB

Tier: Tester.
Repo: https://github.com/curtismu7/ping-services-stub-LAB

One stub that exercises **every shared Ping service the family deploys** (rule 20, shared-first):

| Service | Where | What the stub does |
|---|---|---|
| PingFederate (shared, local) | `127.0.0.1:9031` via ping-shared | OIDC discovery + JWKS fetch |
| PingGateway (shared, local) | `127.0.0.1:3036` | `POST /mcp` unauthenticated → 401/405 proves the enforcement point |
| Privilege Agent Gateway (shared, local) | `127.0.0.1:8620` | root listener probe (mcpgw REST API; the old `:8623` listener is gone since the v1.261112-NYL binary swap) |
| PingOne (SaaS) | `auth.pingone.<region>` | worker `client_credentials` + populations read |
| PingOne Privilege (SaaS console) | `console.privilege.pingone.com` | reachability probe (registration stays console-manual) |
| PingFederate (SE K8s, owner namespace) | host recorded in the owner notes | discovery + heartbeat |

## Run from a clone

Prerequisites: Node 26. Docker (OrbStack) only for the Docker form.

```
git clone https://github.com/curtismu7/ping-services-stub-LAB.git
cd ping-services-stub-LAB
npm ci
npm run build
npm run doctor
npm start
```

## Ports, and what to do if the port is taken

```
Ports: ping-services-stub-LAB listens on 6300 (set with PORT, default 6300).
Port range for this app: 6300-6399.

If the port is taken:
1. Find what is using it:
   lsof -iTCP:6300 -sTCP:LISTEN -n -P
2. If it is an old copy of this app, stop that process: kill <PID>.
3. If it is something else, stop it, or start this app on another port:
   PORT=<other port> npm start
```

Other variable: `HOST_PORT=6300` (Docker host port). Keep both inside 6300-6399.

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

### PF sign-in prerequisites (shared local PingFederate)

The pi.flow sign-in at the shared PF drives client `ai-demo-pf-id-jag` and user `demoUser` (stored in the `aiDemoPfSimplePcv` simple password validator). Three pieces of PF config must match the shared settings file — PF drifts from them over time and the only symptom is `Username or password is incorrect` or `invalid_client`/`invalid_grant` at the token step. Check, in this order:

1. **User password** — `demoUser`'s password in the PCV must equal the demo password (`DEMO_USER_PASSWORD` in the AI-DEMO2 api-server env / vault). Read/patch via admin API: `GET/PUT /pf-admin-api/v1/passwordCredentialValidators/aiDemoPfSimplePcv` (set `Password` + `Confirm Password` values on the `demoUser` row).
2. **Client secret** — `ai-demo-pf-id-jag`'s secret must equal `PF_EXCHANGE_CLIENT_SECRET` in `~/Development/.env`. Verify with `POST /as/token.oauth2 -u ai-demo-pf-id-jag:<secret> -d grant_type=client_credentials` (401 = mismatch); patch via `PUT /pf-admin-api/v1/oauth/clients/ai-demo-pf-id-jag`, `clientAuth: { type: SECRET, secret: ... }`.
3. **Stub redirect URI** — the client's `redirectUris` must include `http://localhost:6300/auth/callback` (the stub's callback). Additive; existing URIs are unaffected.

Admin auth is `administrator` + `PF_ADMIN_CONSOLE_PASSWORD` (secrets vault) with header `X-XSRF-Header: PingFederate`. Note: 3 failed passwords lock the account for **1 minute** (`LockoutPeriod` in `AccountLockingService`) — wait it out rather than hammering.

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
