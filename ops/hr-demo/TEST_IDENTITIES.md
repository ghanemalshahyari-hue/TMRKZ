# Synthetic identities for acceptance (large profile)

A small set of synthetic people from the demo Oracle HR (`sh ops/hr-demo/up.sh --large`, fixed seed, so the same
people and IDs on every build) and the synthetic enterprise directory (`sh ops/hr-demo/synthetic-ad/load.sh`). Usernames
only; every synthetic account signs in as `<login>@tmrkz.test` with the one test password in
`ops/hr-demo/.generated/ad-people-password` (never committed). Demo only — nothing here is a real person.

All but the last two belong to one main unit, **1000895 «ورشة الطاقة ٦»** (level 6; 34 units, about 360 people in
service), so the request scope of ADR-094 (the person's own main unit's tree) can be seen from inside and from outside.
The roles are given inside TMRKZ by its administrator; the directory and HR know nothing of them.

| Purpose | Login | Rank · position | Unit ID · name (level) | Main unit |
|---|---|---|---|---|
| A completely new user (never signed in) | `khalid.aamry22` | وكيل أول · مدير مكتب | 1001390 «سرية البحث» (L11) | 1000895 |
| An existing zero-access user (signed in once, no role) | `abdulla.blwshy30` | وكيل · مدرب | 1000956 «فصيل النشر» (L7) | 1000895 |
| Holder of a normal request role | `mariam.aamry10` | وكيل أول · مدير مكتب | 1001170 «مجموعة الوقود» (L9) | 1000895 |
| Access manager (unit permissions manager) | `mohammed.jnyby` | ملازم أول · قائد الوحدة | 1001064 «وحدة الرادار» (L8) | 1000895 |
| Final access approver | `darwish.hbsy` | لواء · قائد الوحدة | 1001065 «فرع الرادار ١١» (L8) | 1000895 |
| A transferred person (see below) | `mohammed.kaby29` | ملازم · مدير مكتب | 1001065 «فرع الرادار ١١» (L8) → 1000185 «مكتب العمليات» (L10) | 1000895 → 1000086 |
| An inactive person (متقاعد; directory account disabled) | `majed.hbsy152` | وكيل عريف · مدرب | 1001168 «شعبة البيئة» (L9) | 1000895 |
| A person under a different main unit | `hamad.ghfly31` | وكيل أول · مدرب | 1000185 «مكتب العمليات» (L10) | 1000086 «وحدة النقل ٥» (L8) |

Load the directory with `sh ops/hr-demo/synthetic-ad/load.sh --all` (under five minutes): the default 20,000 are the
first people by PRS_ID, the unit commanders, and most of these identities come later.

Before the run: sign `abdulla.blwshy30` in once and give them nothing; give `mariam.aamry10` a request role,
`mohammed.jnyby` the access-manager role and `darwish.hbsy` the final-approval role of main unit 1000895.

## The transfer

`mohammed.kaby29` starts in 1001065 (main unit 1000895). During the acceptance run, move them to 1000185, a unit of
another main unit, in both sources at once:

```sh
sh ops/hr-demo/transfer_person.sh mohammed.kaby29 1000185
```

The script updates the Oracle row (`ORG_UNIT_ID`, `ORG_UNIT_NAME`, `ORG_UNIT_FULL_PATH`, `MAIN_ORG_UNT_ID`,
`MAIN_ORG_UNIT_NAME`, unit status «منقول») and the directory user (`MilUnitId`, `MilMainUnitId`, `MilCurrentUnitName`).
TMRKZ sees the move on the person's next sign-in or on-demand refresh (ADR-094). To move them back:
`sh ops/hr-demo/transfer_person.sh mohammed.kaby29 1001065`. Rebuilding the demo Oracle (`up.sh --large`) restores the
generated data; the directory user keeps whatever the last transfer set until `load.sh` runs after a `down.sh --wipe`.

## Checking a person in the sources

```sh
# Oracle, through the read-only account TMRKZ uses
sh ops/hr-demo/up.sh --verify
# the directory (inside the container; the number, unit and main unit as TMRKZ reads them)
docker exec tmrkz-synthetic-ad ldbsearch -H /var/lib/samba/private/sam.ldb -b OU=People,DC=tmrkz,DC=test \
  '(sAMAccountName=khalid.aamry22)' MilNumber MilRankName MilUnitId MilMainUnitId userAccountControl
```
