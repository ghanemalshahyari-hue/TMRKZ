# Oracle unit-only preparation — 17 Nov 2026

## Scope

The owner requested **only organisational units from the HR/Oracle-derived data**, not people. This preparation does not include any employee rows, employee identifiers, contact fields, medical data, directory-password material or Oracle host credentials. It also does not introduce military movement, position optimisation or tactical graphics.

## Source and validated dataset

The source used was the **existing read-only Oracle-derived unit mirror in Duty**, not a fresh live Oracle query. The unit mirror records:

- Source unit-sync timestamp: **2026-11-10 04:17:08 UTC**.
- Units: **76,848** total, **22,516** marked active.
- Duplicate unit identifiers: **0**.
- Missing names: **0**.
- Names over 200 characters: **0**.
- Missing ID hierarchy paths: **0**.
- Collisions between incoming source identifiers and existing demo source identifiers: **0**.
- Potential collisions with generated `HR-<source-id>` codes: **0**.

The dataset is staged at `/var/lib/mover/unit-import/oracle-units-20261110T041708Z.json`, readable by the backend's application user (`640`, owner `100:101`).

- **14,222,089 bytes**.
- SHA-256: `972d2a56b1b6cbbc1de278daee517fc2e8efbfac1678cd644cab35fb97514db0`.
- Contains only unit identifiers, names, canonical hierarchy paths, status and main-unit references needed for an authorised unit-only import. Attribute mappings and source timestamps are part of the local payload's contract.
- Source applications and their databases were not modified.

The path/source timestamps must remain visible in any later import report. The older source is not represented as a current live Oracle synchronisation, and TMRKZ's disabled HR source was not enabled.

## Verified recovery point

Before import preparation, `sh ops/backup.sh` created:

`backups/tmrkz-mover-20261117T032617Z`

`sh ops/verify-backup.sh` passed archive checksums, readable business/identity/authorisation dumps, clean business restoration, 20-table fingerprint equality and restored schema V44 equality.

## Not completed

**No unit snapshot has been published and no organisation has been created, renamed or retired by this preparation.** No people have been imported, joined, authorised or changed.

The ordinary generic organisation-file importer is not sufficient for this dataset: it assumes active local rows, omits source/main-unit metadata, and has a 20,000-row batch limit. Using it for this mirror would not preserve Oracle's unit semantics.

The offline application image supplies a JRE, not a JDK/compiler. Both direct external compiler access and the exact project Maven/JDK 25 image pull were attempted; access to Docker Hub could not be completed because registry lookup/network access failed. No backend unit-import handler has been compiled or deployed, and no full backend unit-import test or live Oracle acceptance is claimed.

Next step: provide the prepared Maven/JDK 25 builder image (or another approved offline compiler/build path), then implement and test the authorised unit-only operation using a preview, metadata validation, atomic publication, preservation checks, and the existing person-scope protection. A refresh from the live Oracle endpoint requires its own listener/network fix; it is not proved by this staged mirror.
