# https for TMRKZ (ADR-051)

TMRKZ serves https itself, as TNQL does: an optional `proxy` service (profile `tls`, the web image's nginx) holds the
server certificate issued by the organisation's internal CA and passes every request to the web entry point. Plain http
on port 80 only redirects. TLS 1.2 and 1.3, HSTS.

## Steps on the server

1. **Key and request.** `sh ops/tls/make-csr.sh <name users open> [more names or IPs]`, for example
   `sh ops/tls/make-csr.sh tmrkz.example.local`. The key `ops/tls/private/server.key` is made here and never leaves the
   server. Send **only** `ops/tls/private/server.csr` to the PKI team: template «Web Server», and ask for the issued
   certificate and the CA chain (issuing CA and root), as `.cer`/`.crt` (PEM or DER) or `.p7b`.
2. **Install.** `sh ops/tls/install-cert.sh <issued certificate> <CA chain>`. It refuses a certificate for another key,
   one missing a requested name, one not for server authentication, an expired one, or one that does not chain to the
   given root; nothing changes when a check fails.
3. **Switch on.** `sh ops/tls/enable.sh [project] [port]` (defaults `tmrkz-mover`, 443). It keeps a copy of `.env`, sets
   `TMRKZ_PUBLIC_URL=https://<name>`, `MOVER_SECURE_COOKIE=true`, `COMPOSE_PROFILES=tls`, `MOVER_HTTP_BIND=127.0.0.1` and
   `TMRKZ_HTTPS_PORT`, and gives the identity provider the new address (`ops/keycloak/set-public-url.sh`). Then restart:
   `docker compose -p <project> up -d` (this folder: `sh start.sh`).
4. **DNS and clients.** The name must resolve in the organisation's DNS to this server. Domain PCs already trust the
   organisation's CA; others need its root certificate installed.

Renewal: run step 1 again after moving `ops/tls/private` aside (a new key), or ask the PKI team to renew for the same
request; then step 2 and `docker compose -p <project> restart proxy`.

## Check

`sh ops/tls/test-tls.sh [project]` rehearses steps 1–2 with a throw-away test CA and, next to a running stack, the https
entry point on 127.0.0.1:9443: trust through the CA only, TLS 1.1 refused, TLS 1.3 offered, the application, backend and
identity provider reachable, HSTS, and the redirect. It never touches `ops/tls/private`, `.env` or the identity provider.
