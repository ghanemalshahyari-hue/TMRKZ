# Sign-out returns to the TMRKZ sign-in page (ADR-109) — evidence (27 Nov 2026)

## `keycloak-signout.out` — real Keycloak 26.7.5: 13 of 13

`bash tests/acceptance/signout/keycloak-signout.sh <evidence>` (run with `MSYS_NO_PATHCONV=1` on Windows): a throwaway container of
TMRKZ's own Keycloak image with the baked `tmrkz` realm, configured as `docker-compose.yml` configures it (public hostname, dynamic
back channel, `/auth`); its directory federation is removed and the platform-password client is registered as
`ops/keycloak/set-platform-password-client.sh` registers it. A fictional user, random passwords; the container and work files are
removed at the end.

1. Automatic sign-in (authorization code + PKCE) through a cookie jar: one Keycloak session; a second automatic sign-in passes
   without the password (SSO, HTTP 302).
2. TMRKZ's sign-out as the server now sends it: form POST to the end-session endpoint over the back channel, `client_id=tmrkz-web`,
   the ID token as `id_token_hint`, no post-logout address → HTTP 200, the user's sessions 0, and the **same browser's** next
   automatic sign-in shows Keycloak's password form (HTTP 200 with `name="password"`).
3. A platform account's manual sign-in (password client, no browser cookie): one session; the same POST with
   `client_id=tmrkz-platform-password` → 200, sessions 0.

## `backend-tests.txt` — the affected backend classes: 21 of 21

`sh ops/test-backend.sh EnterpriseSignInIT,DualProviderSignInIT,DirectorySignInIT,EmbeddedSignInIT` (real PostgreSQL + PostGIS).
The stand-in provider records every end-session call: the browser is answered `/?signed-out=1`, the call carries the session's own
token and client and no post-logout address; with the endpoint failing the answer is `/?signed-out=1&provider-session=1` and the
TMRKZ session still ends; a session of the local platform realm calls that realm only.

Not shown here: the owner's own Keycloak and VM.
