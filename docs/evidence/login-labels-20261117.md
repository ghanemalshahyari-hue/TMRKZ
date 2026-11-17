# Login labels aligned with TNQL — 17 Nov 2026

## Changed presentation only

Reference, inspected read-only: `TNQL_V2/app/templates/auth/login.html`:
- line 744: **الدخول الآلي برقم الــــ U**
- line 754: **إدخال رقم الـــــ U وكلمة المرور يدويا**
- line 832: **العودة لخيارات الدخول**

Updated in TMRKZ:
- `frontend/src/pages/LoginPage.tsx:179` — automatic/OIDC choice
- `frontend/src/pages/LoginPage.tsx:185` — manual directory-choice button
- `frontend/src/pages/LoginPage.tsx:229` — back to the choices
- Matching selectors in `tests/acceptance/lib/browser.mjs:64,74`, `tests/acceptance/map-workspace.mjs:985`, and `tests/acceptance/audit/p1-verify.mjs:58`.

The Keycloak credential-submit button was already **تسجيل الدخول**, as in the reference, so its logic and wording were not changed. Manual input still uses directory authentication; automatic input still uses Keycloak/OIDC. No routing, identity-linking, directory configuration, account, permission or HR behaviour was changed by the label update.

## Initial attempted runtime (superseded below)

- Web image: `mover/web:local-733b4aa4-tnql-login`
- Image ID at verification: `sha256:576766d7ddeff6f7754f7f5940e6b2f67e465c7f210f2cc967a4f0eb4e3f4f41`
- Archive: `images/mover_web_local-733b4aa4-tnql-login.tar`
- Archive SHA-256: `215a395204592e25539b456e9e5f7ee40f473ebf7880c9994b834c70a3d99826`
- Preserved original: `mover/web:offline-original`.

Because this host's copied dependency tree lacks the Linux Rollup binary, the existing compiled artifact was updated with **only the three literal label substitutions**, plus a cache-busting reference in `frontend/dist/index.html`. It is **not a rebuilt frontend release**. The final image was committed from the known-working original web container after confirming its unchanged runtime user (`Config.User == ""`), Nginx configuration and served content. No credential-bearing image environment settings were found before export.

Intermediate image variants failed static-file permission and startup checks. They were not retained as the delivered runtime. The original working frontend was restored first and returned HTTP 200; only then was the corrected immutable-image candidate deployed. Duplicate startup retries created by this session were stopped; the root frontend rollback was verified before the final change. No database/account volumes or source applications were modified.

## Observed checks

| Check | Observed result |
|---|---|
| `tsc -b --noEmit` | Pass |
| `node --check` on the three affected acceptance scripts | Pass |
| `git diff --check` | Pass |
| `nginx -t` | Pass |
| Homepage and corrected JavaScript asset | HTTP 200; all three labels served |
| Real in-app browser | Shows automatic **الدخول الآلي برقم الــــ U** and manual **إدخال رقم الـــــ U وكلمة المرور يدويا**. Selecting manual and **العودة لخيارات الدخول** both work, with no credentials entered. |
| Normal OIDC sign-in as the pre-existing local `developer` | Succeeded; `CONFIGURE` and `MANAGE_ACCESS` present, two grants. The primary-display choice may be AUDITOR, but the administrative grant is still present. |
| Image export and manifest checks | All archive checksums match the final entry above |

The full frontend build/test gate was **not** re-run: the missing `@rollup/rollup-linux-x64-gnu` native package remains an environment limitation. There is no new full frontend test, release-build or production-readiness claim. A connected build host should regenerate the proper frontend bundle and run its normal gates from the updated source.

The separate existing WebGL2 map compatibility issue is not fixed or claimed to be fixed by this label-only change.

## Account status at the end

- The existing local **`developer`** account is intact, enabled and verified through normal OIDC; it does not require replacing or password exposure.
- **The requested enterprise user was not created**. It cannot be used for enterprise LDAP sign-in in this installation until the approved read-only bind account is supplied, the directory is activated, and the exact directory account is verified.
- No admin/platform privilege was granted to that username, and no existing `developer` identity or role was renamed or replaced.
- The service-bind limitation is independently recorded in `docs/evidence/ldap-preparation-20261117.md`. Correct button labels do not activate LDAP or create an account.

## Owner review and original-layout restoration

The owner rejected the broader frontend replacement because it changed more than the writing. The exact original frontend image was restored first. The original index and asset were then used rather than replacing the page with another built artifact.

Final **text-only** change:
- The original `index-B3vYdWVQ.js` was edited only at the three literal strings.
- A new cache filename, `index-B3vYdWVQ-text-v1.js`, forces collection of that corrected asset; the original index differs only in that script reference. No new template, layout, styling or authentication flow was introduced.
- Browser inspection confirms the original login structure rendered correctly, with only the requested text substitutions.
- The committed candidate is `mover/web:local-733b4aa4-tnql-login`, ID `sha256:75bb4abe45d5396e34f36458378a2836d7dd1cd9403b2bf2d564e2b9a6ba4b31`.
- Final archive SHA-256: `9f1c9084d6390382c3eb4c7a1d6ff5d5482bd34c7aa24a0217f4345ceb6d29aa`. This supersedes the earlier rejected image/archive for this local presentation change.
- Nginx and the frontend are healthy with the original inherited runtime user.

The previous candidates remain relevant as failed regression history; the final running frontend is the original page plus these three exact label strings, not a different login-page build.
