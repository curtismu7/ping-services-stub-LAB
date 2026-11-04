# Talk track — Ping Services Stub LAB

1. "Every lab in this family reuses shared Ping infrastructure — one PingFederate, one PingGateway, one Privilege gateway per machine (rule 20). This stub proves all of them in one page."
2. "Press Exercise on PingFederate: one discovery call plus a JWKS fetch. Read-only, nothing provisioned."
3. "PingGateway: an unauthenticated POST to /mcp answers 401 — that refusal IS the proof the enforcement point is up."
4. "PingOne: the stub mints a worker token and lists populations — the same settings file every lab shares."
5. "Privilege gateway and the PingOne Privilege console: reachability only. Console registration cannot be automated — worker tokens are rejected there (measured)."
6. "The SE row is our PingFederate in the cmuir namespace on the SE cluster — same stub, same read-only rule."
7. "Flip Mock/Real in the header: Mock answers canned, zero network — the demo works on a plane."
