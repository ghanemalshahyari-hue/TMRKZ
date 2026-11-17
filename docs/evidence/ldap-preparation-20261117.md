# LDAP preparation — 17 Nov 2026

## Verified without changing the source applications

- Duty's active directory configuration was inspected read-only. It uses real LDAPS and a configured public CA.
- A non-credential probe confirmed a **trusted TLS handshake with hostname verification**. The deliberately invalid probe bind was refused, as expected.
- The public LDAP CA was copied to TMRKZ's local, non-root-readable truststore: `${HOME}/.cache/tmrkz-mover/enterprise-truststore`.
- The corresponding AD mapping and users DN were derived from the source's supported direct-bind helpers and staged locally in `/tmp/tmrkz-enterprise-directory-stage.json`. That protected local stage is not part of this public document or a source-controlled configuration file.
- No hostnames, usernames, passwords, tokens, personal records or private keys are included in this document.

## Not completed

The required TMRKZ read-only directory service bind cannot be retrieved from the inspected authentication flows:

- Duty's active LDAP integration is a **direct user-bind** flow. It holds no LDAP service-bind password in its integrations configuration. Its secret registry is for other integrations and does not supply this account.
- MOVER's mounted `config/.env` has direct-bind LDAP settings, but **`LDAP_BIND_DN` and `LDAP_BIND_PASSWORD` are not configured**. MOVER's own description marks these optional fields as unused in its default self-bind flow.
- `ops/keycloak/set-directory.sh` requires a bind DN and credential before its connection and authenticated-bind tests. Its tests cannot be completed with the details currently present in either source application.

Therefore, no enterprise-directory activation, account-level identity verification or application administrator assignment was performed. TMRKZ's current local stand-in directory, provider configuration, people and administrator grants remain unchanged, and the existing protected `developer` platform account was not renamed or replaced. No TLS validation or host verification was disabled.

## Remaining input

An approved **read-only** LDAP bind DN and its credential must be provided through an authorised local file/channel. The file path, not its contents, should be supplied to the operator session. It should be provisioned for the enterprise user-search scope required by TMRKZ, not as a directory administrator account.

After that material is available, the next steps are a fresh backup, trusted connection and bind tests, verification of exactly one requested directory account, authenticated activation, and only then the authorised role-assignment workflow. The first successful LDAP bind check does not by itself grant the requested business role.
