# Ping Services Stub LAB

Tier: Tester.
Repo: https://github.com/curtismu7/ping-services-stub-LAB

One stub that exercises **every shared Ping service the family deploys** (rule 20, shared-first):

| Service | Where | What the stub does |
|---|---|---|
| PingFederate (shared, local) | `127.0.0.1:4732` via ping-shared | OIDC discovery + JWKS fetch |
| PingGateway (shared, local) | `127.0.0.1:7809` via ping-shared | `POST /mcp` unauthenticated → 401/405 proves the enforcement point |
| Privilege Agent Gateway | **bring your own**: no default address. Set `PRIVILEGE_GATEWAY_URL` (environment or the settings file); until then the row says "not configured" | root listener probe |
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

Docker (OrbStack; reads the settings file, `~/Development/.env` by default, read-only):

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

Trace targets default to ping-shared's fixed ports (PF engine `https://127.0.0.1:4732`); override with `TRACE_PF_URL`. With the shared PF's self-signed cert, run the stub with `NODE_EXTRA_CA_CERTS=deploy/pf-rootCA.pem TRACE_PF_URL=https://127.0.0.1:4732 TRACE_PF_CLIENT_ID=id-jag-kit TRACE_PF_CLIENT_SECRET=...` (the secret lives in `~/.config/demo-kit/provisioning.json` under `pingfederate.idJagKitClientSecret`).

### PF sign-in prerequisites (shared local PingFederate)

The pi.flow sign-in drives the client named by `TRACE_PF_CLIENT_ID` (default `id-jag-kit`, the client ping-shared's PingFederate setup uses) and a user that exists in that PingFederate. It needs three things to match, and the only symptom of a mismatch is `Username or password is incorrect` or `invalid_client`/`invalid_grant` at the token step:

1. **A user** you know the password of in the PingFederate's password credential validator (this lab does not create one).
2. **The client secret**: `TRACE_PF_CLIENT_SECRET`, or `PF_EXCHANGE_CLIENT_SECRET` in the settings file, must equal the client's secret in PingFederate.
3. **The redirect URI**: the client's `redirectUris` must include `http://localhost:6300/auth/callback` (this lab's callback; change the port if you changed `PORT`).

PingFederate locks an account for a short period after 3 failed passwords: wait it out rather than retrying. This sign-in path is UNVERIFIED against a live PingFederate from this repo (tests use stubs only).

## Settings

The lab reads one settings file (default `~/Development/.env`, or the file `STANDALONE_ENV` names; `.env.example` lists the names). Environment variables win over the file where noted.

| Setting | Meaning | Default |
|---|---|---|
| `PINGFEDERATE_HOST`, `PINGFEDERATE_PORT` | PingFederate engine probe target | `127.0.0.1`, `4732` (ping-shared) |
| `PINGGATEWAY_HOST`, `PINGGATEWAY_PORT` or `PINGGATEWAY_HOST_PORT` | PingGateway probe target; `PINGGATEWAY_HOST_PORT` is the name ping-shared uses | `127.0.0.1`, `7809` (ping-shared) |
| `EXERCISE_PF_BASE`, `EXERCISE_PG_BASE` | base URLs for the "Test" calls | `https://127.0.0.1:4732`, `http://127.0.0.1:<gateway port>` |
| `PRIVILEGE_GATEWAY_URL` | your own Privilege Agent Gateway (env or settings file); `EXERCISE_PRIV_BASE` overrides it for the "Test" call | none: row reports "not configured" |
| `PINGONE_*`, `PRIVILEGE_CONSOLE_URL`, `SE_PF_URL` | PingOne SaaS, Privilege console and an SE PingFederate | see `.env.example` |

Run from a clone, `127.0.0.1` is the machine the lab runs on, which is where ping-shared publishes its ports. In the Docker form `127.0.0.1` is the container itself, so `deploy/docker-compose.yml` points the PingFederate and PingGateway targets at `host.docker.internal`. The image trusts the CA in `deploy/pf-rootCA.pem`; ping-shared's PingFederate uses a self-signed certificate, so from the container its TLS calls may be refused (the row then says so). UNVERIFIED against a running ping-shared; run from a clone for the straightforward path.

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

---

## Real mode: through the PingOne Privilege gateway

**Privilege objects this lab uses:** one real, read-only probe per shared Ping service, the Privilege Agent Gateway included

Settings keys: `PSS_GW_URL`, `PSS_GW_APPS`, at least one `PSS_GW_KEY_<NAME>`
in the shared settings file (`~/Development/.env`, or the file `STANDALONE_ENV` names). The key
is write-only: it is scrubbed from every message, error and log line.
