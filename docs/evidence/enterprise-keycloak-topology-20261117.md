# Duty-compatible enterprise Keycloak topology — 17 Nov 2026

## Correction requested by the owner

The initial ADR-070 work preserved TMRKZ's existing automatic **local** Keycloak flow. The owner correctly identified that this was not the same operational idea as Duty: Duty's Keycloak button redirects to an external enterprise realm.

This follow-up does not conflate protocol with topology. TMRKZ already had a stronger authorization-code flow (PKCE S256, nonce, browser-bound single-use state, signed ID-token checks and `auth_time`); the missing requirement was selecting the **external enterprise Keycloak realm** for automatic sign-in. That is now implemented in source through dedicated external client configuration and a separate local platform provider.

## Target and implemented routing

| Flow | Authoritative provider after configuration |
|---|---|
| Automatic sign-in | External enterprise Keycloak realm, dedicated `TMRKZ_ENTERPRISE_OIDC_*` client |
| Manual `admin` / `developer` | Independent local Keycloak platform-password client, as verified on real local Keycloak earlier |
| Manual enterprise users | Direct enterprise LDAP with trusted TLS, exact account lookup and identity/HR rules |
| Platform reauthentication | Local platform browser client, not the external employee realm |
| Platform logout | Local platform issuer and its own end-session endpoint/ID token |
| Enterprise logout | External enterprise issuer and its own end-session endpoint/ID token |

`IdentityService.platform` now requires the approved **local platform issuer**, `tmrkz-platform` and the installation allow-list. An enterprise token carrying a similarly named role does not qualify. The current platform people, identity links and persistent roles are retained.

## Independent configuration

- Base `TMRKZ_OIDC_*` values select the external automatic client when configured.
- Stable `TMRKZ_LOCAL_OIDC_*` values describe the local provider independently.
- `TMRKZ_PLATFORM_OIDC_*` and `TMRKZ_PLATFORM_BROWSER_*` optionally override the local platform settings.
- Distinct key caches, issuer/audience checks, client credentials and token/JWKS endpoints prevent a token from being accepted through the other provider.
- A manual-password-only platform logout needs the direct-password client and its ID-token hint; interactive browser configuration is needed for step-up, not incorrectly required for that logout.

No default is allowed to turn the enterprise issuer into the local platform issuer during cutover. Direct property-based single-provider test configurations still default their platform settings to that one provider. The Compose-hosted installation always supplies the stable local values.

## Callback and session choice without a migration

The local `V4__enterprise_identity.sql` constraint allows `purpose` only `LOGIN` or `REAUTH`. The initial use of `REAUTH_PLATFORM` would therefore have failed before a step-up redirect. It was removed.

The existing attempt now keeps `REAUTH` and stores a provider namespace inside the generated nonce (`platform.` or `enterprise.`). The nonce itself is still sent to the selected provider and verified exactly in the signed ID token. On callback, that server-stored/marked attempt selects the client credentials, redirect URI, token endpoint, expected issuer/audience and its own JWKS source. A provider switch does not modify a user's intended `REAUTH` behavior, and no migration is introduced.

The ordinary automatic start always targets external enterprise Keycloak. Local platform step-up is chosen from the issuer already stored in the server-side session. Logout similarly uses the session issuer; directory sessions continue using direct LDAP step-up and local session logout.

## Static review findings and corrections

A read-only source review identified the following before any deployment. They were corrected in source; this is not represented as executed test evidence.

1. **Attempt constraint:** `REAUTH_PLATFORM` violated the existing `oidc_login.purpose` check. Replaced with the nonce namespace; `LOGIN`/`REAUTH` remain unchanged.
2. **Empty Compose overrides:** empty values could disable local defaults or borrow enterprise defaults. Stable separate local defaults plus constructor normalization now preserve them. Added `OidcPropertiesTest` covering both empty enterprise/platform overrides and enterprise-only automatic configuration.
3. **Manual-only logout:** provider logout no longer requires an interactive browser client when the direct-password client and ID-token hint are already present.
4. **Fixture identity isolation:** the dual-provider test uses a class-specific allow-listed platform login, avoiding duplicate-person link rows with the existing platform tests.
5. **Outcome assertions:** local step-up must redirect to `/#review`, request `prompt=login&max_age=0`, and actual logout must return `401` for `/me`.

## Source tests added (not executed yet)

- `DualProviderSignInIT` uses two issuers and different signing keys. It covers local direct-password login with existing platform rights, local step-up/logout, external automatic ordinary-user linking, external platform-role refusal, and wrong-provider-key refusal.
- `OidcPropertiesTest` checks that empty override values preserve local provider settings and that external enterprise settings never become the local platform defaults.
- Existing `EnterpriseSignInIT`, `DirectorySignInIT` and `DirectDirectorySignInIT` preserve single-provider and LDAP behavior.

## Checks actually run

- `python ops/tools/gen-openapi.py`: **257 operations across 235 paths**.
- Complete four-file Compose interpolation/config validation: **pass**.
- `backend/src/main/resources/application.yml`: parsed as YAML.
- `ops/keycloak/realm/tmrkz-realm.json` and `docs/api/openapi.json`: parsed as JSON.
- TypeScript `tsc -b frontend/tsconfig.json --noEmit`: **pass**.
- Shell syntax and `git diff --check`: completed; only existing shared-copy CRLF normalization warnings were printed.
- `docker inspect` of the working services before provider configuration was altered: existing backend/web/Keycloak healthy.
- Fixed manual-LDAP relay tests, backup verification and current automatic-local developer browser result are in `docs/evidence/manual-sign-in-20261117.md`.

## What remains specifically open

1. **Enterprise client approval/registration:** a new confidential authorization-code client in the enterprise realm, **not** Duty's `MNAWB` client secret and not TMRKZ's whole local realm. Exact public callback/logout URIs, PKCE S256, `openid profile`, signed ID tokens, `preferred_username`, `auth_time`, and any explicitly approved employee/employment claim mappings must be confirmed. Direct grants remain disabled on that client.
2. **Trusted connectivity:** the enterprise browser issuer and back-channel token/JWKS endpoints need approved reachable addresses and Java-trusted certificate handling. An isolated backend back channel needs a narrowly scoped TLS forwarding profile if it cannot reach the approved endpoint; it must not be given general internet egress. This was not activated because no dedicated client profile has been registered.
3. **Build prerequisites:** Java 25/Maven with a populated Maven dependency cache and Linux Rollup 4.65.1 remain unavailable after the exhaustive other-application search. None of the new Java tests or a proper frontend build was run.
4. **Deployment and owner authentication:** current running backend/web images are still the previous build. Enterprise automatic is not configured or claimed connected. `u1257301` has not been signed in or granted privileges.

The earlier statement that automatic enterprise sign-in necessarily requires TMRKZ's own LDAP service-bind account is **superseded**: if the account already works in external enterprise Keycloak, a dedicated TMRKZ client can use that federation. Direct manual LDAP is independent and remains available. The missing inputs now are the dedicated client registration/profile and the build tools, not copying Duty's secret or weakening TMRKZ's authentication checks.
