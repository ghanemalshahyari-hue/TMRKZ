# Manual platform sign-in and direct enterprise LDAP — 17 Nov 2026

## What was requested

The owner asked that manual sign-in support the existing local platform accounts and that the requested enterprise U-account authenticate through LDAP like the other working applications. Enterprise automatic sign-in was not selected: it remains subject to the separate read-only LDAP service-bind dependency.

## Implemented in source, not yet a running backend release

- `AuthController manual route`: the configured `admin`/`developer` logins go only to a dedicated Keycloak password client. Every other login goes to the directory. A rejected platform password never falls through to LDAP; a directory identity never receives `tmrkz-platform`.
- `OidcClient.platformPassword`: verifies provider keys, signature, issuer, dedicated audience, expiry, matching login, installation allow-list and `tmrkz-platform` role. A verified provider-backed TMRKZ session retains identity continuity, logout and normal OIDC step-up.
- **Measured Keycloak exception:** Keycloak 26.7.5's direct password grant does not emit `auth_time`. Only for this synchronous grant, a freshly issued, cryptographically verified `iat` is accepted as the password-authentication time, within the same clock-skew/freshness bounds. If `auth_time` is emitted it is mandatory and fresh. Browser authorization-code sign-in and step-up still require `auth_time`; no `iat` substitution was made there.
- `LdapProperties.directBindPattern` and `DirectoryAuthenticator`: support the working TNQL/Duty direct user-bind pattern with exactly one `{username}` marker. After the user's own TLS bind, the same authenticated connection finds exactly one account and reads its stable identifier and configured profile attributes. Service-account search followed by user bind remains available when no direct pattern is set.
- Direct reauthentication normalizes the linked login and stable UUID; wrong passwords, duplicate/unknown accounts, absent stable IDs, invalid templates, unavailable/TLS-untrusted/wrong-host directory answers and empty passwords fail closed. Empty-password anonymous bind is never attempted.
- LDAPS and StartTLS now explicitly set JSSE HTTPS endpoint identification. `TrustedSocketFactory` also covers the StartTLS wrapping socket rather than relying on the comment alone.
- Separate `TMRKZ_MANUAL_LDAP_*` backend overrides let manual enterprise LDAP coexist with the current local Keycloak platform accounts. Base `LDAP_*` values still configure shared/federated LDAP when no manual override exists.
- `ops/keycloak/set-platform-password-client.sh` provisions one confidential client, with no browser flow and no service account, and its sole platform-realm role mapping. New realm imports include the same client; `ops/local/up.sh` reprovisions both it and the accounts idempotently.
- The approved three login labels are retained. Explanatory text now distinguishes local Keycloak accounts from directory accounts. The stale shared manual browser selector was corrected.

## Runtime changes actually applied

1. Fresh backup `backups/tmrkz-mover-20261117T035454Z` before identity/configuration work. `sh ops/verify-backup.sh` passed: seven manifest checksums, three readable dumps, restored V44 business schema and 20 equal table fingerprints.
2. Dedicated Keycloak client created in the existing local realm. A real password-grant check as the existing `developer` (password not printed) returned:
   - expected user: PASS;
   - `tmrkz-platform` role: PASS;
   - dedicated audience: PASS;
   - fresh `iat`: PASS;
   - `auth_time`: absent, which triggered the explicit implementation rule above.
3. Local `.env` gained only the random client secret and non-secret `TMRKZ_MANUAL_*` endpoint settings generated from the protected staged source metadata and the working direct-bind pattern. The enterprise user's password was neither copied nor stored. The base Keycloak/stand-in configuration was not replaced.
4. `tmrkz-mover-ldap-relay-1` (`nginx:1.27-alpine`) runs with the host network namespace but its stream listener is bound only to the internal Docker bridge gateway and approved directory port. Its generated Nginx stream forwards raw TLS to one fixed upstream. Application containers remain on `tmrkz-mover_internal`; only that one DNS name resolves to the gateway in the manual-directory overlay.
5. Credential-free verification through the relay:
   - trusted TLS handshake and correct hostname: PASS;
   - deliberate wrong-host TLS verification refusal: PASS;
   - wildcard-listener configuration absent: PASS;
   - `ldapsearch` from a disposable container on `tmrkz-mover_internal`, using the enterprise CA and no user credentials: PASS;
   - `sh ops/local/offline.sh check`: PASS, application network internal=true and no general internet route.

Local Oracle/HR settings, TNQL/Duty runtimes/databases, business grants, people, platforms accounts and existing volumes were not changed by the relay setup. No requested enterprise identity was created or granted a privileged role.

## Current working runtime and browser evidence

- Backend remains `mover/backend:local-733b4aa4-v44`; web remains `mover/web:local-733b4aa4-tnql-login`. The new authentication Java code and source frontend text are **not deployed**. Starting the relay alone did not change the old backend's manual behavior.
- Real browser on the current runtime: both sign-in choices render; manual reveals its form and «العودة لخيارات الدخول» restores both options; normal automatic sign-in as the pre-existing local `developer` reaches the signed-in application shell. The shell's existing WebGL2 map compatibility message remains an unrelated recorded limitation.
- OpenAPI source documentation regenerated (`257 operations across 235 paths`). This is source-contract generation, not a claim that the running backend implements them yet.

## Checks completed

| Check | Result |
|---|---|
| `tsc -b frontend/tsconfig.json --noEmit` | Pass |
| Realm JSON parsing | Pass |
| Python configuration-helper compilation | Pass |
| Necessary shell syntax checks (`set-platform-password-client`, `init-env`, `local/up`, `platform-accounts`) | Pass |
| `node --check tests/acceptance/lib/browser.mjs` | Pass |
| Full four-file Compose configuration interpolation/validation | Pass after correcting initial nested/empty-default expressions; no failed attempt reached container startup |
| OpenAPI generation | Pass, 257 operations / 235 paths |
| Backup verification | Pass, as above |
| Enterprise relay and internal-network checks | Pass, as above |

## Blocking failures — do not represent these as passed tests

1. `sh ops/test-backend.sh EnterpriseSignInIT` failed **before compilation or tests** with Docker exit 125: `maven:3.9.16-eclipse-temurin-25` is not present locally and Docker Hub DNS resolution timed out. No Maven + JDK 25 distribution, Maven builder image/archive or populated Maven cache exists on this offline host. Direct Maven Central and Adoptium DNS lookups also fail. The full run was not retried needlessly.
2. `npm --prefix frontend test` failed **before Vitest ran any tests**: `@rollup/rollup-linux-x64-gnu` 4.65.1 is absent from the copied dependency tree and local npm cache. Only Win32 optional Rollup binaries are present; no compatible Linux package was found in adjacent application dependency trees. TypeScript itself passed.
3. Consequently, the added `manualPlatformAccounts`, `wrongHostname` and `DirectDirectorySignInIT` cases are written but **unexecuted**. A backend test result, source-built backend image, proper frontend Vitest/build result and deployed manual sign-in are not claimed.
4. The requested enterprise user's actual password sign-in has not been attempted (correctly, no password was requested in chat). If the account has no current HR match, the remaining approved action is the application's existing **User ID without HR** registration, with no business/administrator role grant, followed by the owner entering the password in the manual form.

## Required to finish and deploy

- Transfer an official `maven:3.9.16-eclipse-temurin-25` image archive **and a populated Maven dependency cache**, then run focused `DirectorySignInIT`, `DirectDirectorySignInIT` and `EnterpriseSignInIT` tests followed by the backend build with no network pulls.
- Supply `@rollup/rollup-linux-x64-gnu` **4.65.1** through npm cache/offline package or run a proper connected-host `npm ci`, `npm test` and `npm run build` using the unchanged lockfile.
- Build and deploy the reviewed backend/web artifacts without deleting volumes, then verify both manual platform accounts, direct enterprise authentication and no-privilege identity behavior in the real browser.
- Enterprise **automatic** sign-in remains separately blocked: Keycloak federation still needs an approved read-only service-bind DN and credential through the authorised local secret channel and exact-account verification. Direct manual LDAP does not remove that dependency.

## Expanded other-application build-tool search (owner requested)

An additional read-only search inspected all **22 unique loaded Docker image IDs**, their image/archive layers, **77** archived package collections, other application source/dependency trees and both readable npm caches (1,544 content objects total). This includes MOVER/TNQL, Duty, TAJARUB, KEYCLOAK, EW_Redaness and notify packages rather than only filenames or lockfiles.

- No Java 25 compiler, Maven 3.9.16, or Maven dependency cache was found. The other applications are Python/static services; TMRKZ backend images contain a reduced Java 25 **JRE**, not a compiler; the Keycloak image has Java 21. Existing `backend/target/classes` files are build outputs, not a compiler.
- No `@rollup/rollup-linux-x64-gnu` 4.65.1 payload or exact-version cached tarball was found. TAJARUB contains an empty package directory and a 4.62.3 lockfile; KEYCLOAK archives have only 4.62.4 lock references. Those packages were not substituted.
- No internet, package installation, runtime/database mutation or substitute-version download was used. So the build blockers above remain confirmed, not assumed from a filename-only search.
