# Demo HR source and synthetic enterprise directory

Two fake sources for demonstrating and testing TMRKZ's «units on demand / people on demand» flow (owner, 20 Nov 2026;
ADR-094: «a fake Oracle HR (about 30,000 units in an irregular tree, main units at varying depths, about 200,000 people)
and a fake directory holding the same people»). Everything is synthetic: no real names, hosts or numbers.

**Development and acceptance only — the profile `synthetic-enterprise`.** Neither source is part of the folder
installation's compose project or of the transfer package; they start only by the scripts here, on this machine, and
must never start in production. The directory container does not come back by itself after a Docker restart.

1. **The demo Oracle HR** — a real Oracle Database Free (`gvenzl/oracle-free`, container `tmrkz-hr-demo-oracle`) on the
   application's internal network, filled by `build_oracle_hr.py`: schema `HR_AI`, the read-only views `HR_ENV_UNITS_AI`
   and `HR_PRS_EMPLOYEES_ALL`, read by the account `TMRKZ_HR` (no base tables, no health data).
2. **The synthetic enterprise directory** — a throw-away Samba AD (`smblds/smblds`, container `tmrkz-synthetic-ad`,
   compose profile `synthetic-enterprise`), as MOVER's test directory `mover-test-ldap`: realm `TMRKZ.TEST`, base
   `DC=tmrkz,DC=test`, LDAPS 636 on the internal network only (no published port), a certificate signed by a CA
   generated here, and the User class extended with `MilNumber`, `MilLegacyNumber`, `MilRankName`, `MilOccupation`,
   `MilCurrentUnitName`, `MilUnitId`, `MilMainUnitId` (OIDs `1.3.6.1.4.1.99999.77.1–7`). `ad_accounts.py` puts the SAME
   generated people in it as users (`sAMAccountName` = `PERSON_USER_ID`, `user@tmrkz.test`, name, numbers, rank,
   position, unit, main unit; disabled when not in service); `objectGUID` is the stable UUID TMRKZ reads.

Secrets are generated once into `.generated/` (git-ignored): `oracle_hr.env`, `synthetic-ad.env` (the directory's
administrator), `synthetic-ad/tls/` (CA and server certificate), `ad-people-password` (the one test password).

## Build

```sh
sh ops/hr-demo/up.sh            # the default profile: the agreed reference organisation, 200,000 people at L7–L10
sh ops/hr-demo/up.sh --large    # the large profile (ADR-094), see below
sh ops/hr-demo/up.sh --verify   # verification queries only, counts only
```

TMRKZ must be running (`sh start.sh`): the container joins `tmrkz-mover_internal`. The first start pulls the image and
takes a few minutes. The build is deterministic (fixed seeds); running it again rebuilds the same data. The application
network is isolated, so the Oracle driver is downloaded once on this machine into `.generated/wheels`.

Then the directory and its people:

```sh
sh ops/hr-demo/synthetic-ad/up.sh                 # start, wait, apply the schema, print the values for «إعدادات التكامل»
sh ops/hr-demo/synthetic-ad/load.sh               # the first 20,000 people (PRS_ID order)
sh ops/hr-demo/synthetic-ad/load.sh --limit 500   # a quick subset
sh ops/hr-demo/synthetic-ad/load.sh --all         # every person: 200,000 fit in under an hour
sh ops/hr-demo/synthetic-ad/load.sh --count       # users in OU=People
sh ops/hr-demo/synthetic-ad/down.sh [--wipe]      # stop; --wipe also removes the directory's data
```

`load.sh` reads the people from the demo Oracle into `.generated/ad-people.ldif` and adds them to `sam.ldb` with
`ldbadd` in batches of 5,000, the password written as its NT hash under Samba's bypass control (DSDB password-hash
bypass, as Samba's own join writes an account; measured ~670 users/s against ~60/s the clear-text way, where Samba
derives Kerberos keys per user). A simple LDAPS bind still checks the NT hash, so sign-in works and a wrong password
is refused; only Kerberos keys are absent, and TMRKZ never uses them. Only `MilNumber` is indexed (one entry per
unique number); indexing `MilUnitId` / `MilMainUnitId` instead grew their lists to hundreds of entries per unit and
batch times climbed from seconds to hours. Users already there are skipped. Every account has the same test password,
`.generated/ad-people-password`. Nothing here touches TMRKZ's database. `TEST_IDENTITIES.md` names the people for
acceptance; `transfer_person.sh` moves one person to another unit in both sources.

## The large profile (`--large`)

`large_structure.py` builds, with one seed, about 30,000 units in an irregular tree: one root at level 1; branches of
different shapes and depths (some stop at level 4, others reach 13–15; branching varies per branch and per level; no
branch is a copy of another); main units at levels 4–9 by the owner's rule — `MAIN_UNIT_ID = ID` on a main unit, every
unit below points up to it, units above every main unit have none; `UNIT_PATH` is the ID path («\1\2\3»), the parent its
second-to-last segment; the flag column carries no meaning; short synthetic Arabic names («قيادة», «إدارة», «قسم», «شعبة»,
«فرع»… mixed, not tied to depth); `STATUS` 1 nearly everywhere, 0 on a few leaves.

200,000 people sit in the units at level 4 and below that belong to a main unit's tree (none above level 4; a
commander in every such unit, the rest spread unevenly). Every person has a unique `PERSON_USER_ID` (`first.family123`,
ASCII), `MIL_NUMBER` and `NEW_MIL_NO`, an Arabic name, rank, position and job; `MAIN_ORG_UNT_ID` is the unit's main unit;
status mostly «في الخدمة» (88 %), the rest «متقاعد», «منتهي الخدمة», «مفصول من الخدمة».

Counts produced (build of 20 Nov 2026): 30,000 units (213 inactive) over 15 levels, 2,018 main units
(L4 192 · L5 312 · L6 397 · L7 359 · L8 357 · L9 401), 200,000 people (176,000 in service, 15,924 retired, 5,955 ended,
2,121 dismissed) in 27,756 units. `--verify` prints the counts per level and per status.

## Pointing TMRKZ at them

**«إعدادات النظام ← مصدر الموارد البشرية»** (`PUT /hr/source`): server `tmrkz-hr-demo-oracle`, port `1521`, service
`FREEPDB1` (`service_name`), user `TMRKZ_HR`, password `ORACLE_MOVER_PASSWORD` from `.generated/oracle_hr.env`, unit view
`HR_ENV_UNITS_AI`, person view `HR_PRS_EMPLOYEES_ALL`. Mapping as MOVER's (`docs/MOVER_SETTINGS_PARITY_AR.md`): units
`ID`, `NAME`, parent ← `UNIT_PATH` with `path_parent`, `STATUS = 1`, `CODE`, `NAME_E`, `UNT_LEVEL`, main unit ←
`MAIN_UNIT_ID`; people `PRS_ID`, number ← `NEW_MIL_NO` else `MIL_NUMBER` (`first_non_empty`), legacy number `MIL_NUMBER`,
domain account `PERSON_USER_ID`, `FULL_NAME`, `ORG_UNIT_ID`, `EMP_STATUS_DESC = «في الخدمة»`, `POSITION_ID`,
`EMP_POSITION_DESC`, `JOB_NAME`, rank `GRADE_NAME`, leave `EMP_WORK_STATUS_DESC`. `node ops/local/mover-settings.mjs`
sets this mapping.

**«إعدادات التكامل» → الدليل** (`LdapProperties`, printed by `synthetic-ad/up.sh`): server `tmrkz-synthetic-ad`, port
`636`, security `ldaps`, sign-in domain `tmrkz.test` (the person binds as `user@tmrkz.test`), base `DC=tmrkz,DC=test`,
the preset «Active Directory (كما في MOVER)» — login `sAMAccountName`, UUID `objectGUID`, object class `user`, number
`MilNumber`, rank `MilRankName`, position `MilOccupation`, unit name `MilCurrentUnitName` — plus unit ID `MilUnitId` and
main unit ID `MilMainUnitId`; the CA certificate `.generated/synthetic-ad/tls/ca.crt` pasted as PEM. The users also
carry `employeeNumber` (= `MilNumber`) and `MilLegacyNumber` (the old `MIL_NUMBER`).

## Files

`up.sh`, `compose.yml` (the Oracle container), `build_oracle_hr.py` (schema, data, grants, `--verify`, `--profile`),
`reference_structure.py` (default profile), `large_structure.py` (large profile), `main_unit_rule.py` and
`extend_levels.py` (earlier in-place changes of the default demo), `ad_accounts.py` (the directory's users),
`transfer_person.sh`, `TEST_IDENTITIES.md`; `synthetic-ad/`: `compose.yml`, `up.sh`, `down.sh`, `load.sh`,
`entrypoint.d/10-tls-schema.sh` (TLS and schema-update setting before samba starts), `schema/` (the Mil* attributes,
the User class, OU=People), `tls/ext.cnf` (SAN `DNS:tmrkz-synthetic-ad`).
