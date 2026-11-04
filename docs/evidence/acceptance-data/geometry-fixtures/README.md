# Geometry editing performance fixtures on `tmrkz-test` (4 Nov 2026)

**Owner gate:** «GEOMETRY IMPLEMENTATION → `tmrkz-test` ACCEPTANCE GO», item 6. It approves two fictional performance
fixtures, a four-part MultiPolygon and a polygon of about 1,500 vertices, provisioned by an acceptance-only script and
never by ad-hoc SQL.

**Script:**
- `ops/test-env/provision-acceptance-v3-geometry.sh`, running `ops/test-env/acceptance-v3-geometry.sql`.
- **Plan by default:** the transaction is rolled back and the script exits with code 3.
- **Writes only with `CONFIRM_TARGET=tmrkz-test`.**

## What it guarantees

| Requirement | How |
|---|---|
| Refuses any database not labelled ACCEPTANCE | Checked twice: by the wrapper (database comment) and by the SQL itself. `refusals.txt`: refused on an unlabelled throwaway PostGIS database. |
| Refuses the owner-retained project | Refused by the wrapper before any contact (`refusals.txt`). |
| Requires schema V20 | `flyway_schema_history` must stop at exactly V20. |
| Plan / dry run | Default mode. Run 2 in `provision-runs.txt`. |
| Idempotent, stable fictional IDs | Every id is an md5 of a fixed fictional key: `t:org:…`, `t:site:…`, `t:sgv:…`, `t:resp:…`, `t:stn:…`. Runs 2 and 3 report `total_changes = 0`. |
| Clear labels | Sites `ACC-GEO-MP4` and `ACC-GEO-DENSE`, kind «موقع قبول وهمي (أداء تحرير الهندسة)». Sections named «… (بيانات قبول وهمية)». Stationing reference `ACCEPTANCE-V3-GEOMETRY`. Audit event `ACCEPTANCE_DATA_PROVISIONED` / `stationing-v3-geometry-performance`. |
| Never overwrites | The run stops in any of these cases: a fixture code used by another site or unit; a different boundary under a fixture code; a fixture section stationed elsewhere; a fixture boundary touching any current boundary. |
| No change to existing Stationing records | Nothing existing is updated: only inserts guarded by `on conflict do nothing` / `not exists`. |
| Not the development seed | `dev-v3-geometry-seed.sql` is neither copied nor run. It refuses ACCEPTANCE databases, and it replaces sites and re-stations existing units, which this script never does. |

## Why two new local sections

- Every fictional unit on `tmrkz-test` already had a current stationing.
- The building-projects units (`HR-T-PM-1`, `HR-T-PM-1-1` and `HR-T-PM-1-1-1`) also carry open requests (approved and draft).
- Re-pointing their current site would have changed existing Stationing records under those requests.

So each fixture is carried by a new fictional local section of «قسم مشاريع المباني» (`HR-T-PM-1`), the same kind as the
existing `T-SS-1` and `T-SS-2`:

| Section | Site | Geometry |
|---|---|---|
| `T-PM-1-G4` «قسم قبول الأداء — موقع من أربعة أجزاء» | `ACC-GEO-MP4` | MultiPolygon, 4 parts, 15 vertices (19 points with each ring's closing point), 62,060 m² |
| `T-PM-1-G1500` «قسم قبول الأداء — موقع كثيف الرؤوس» | `ACC-GEO-DENSE` | Polygon, 1,500 vertices (1,501 points), 46,324 m² |

- **Changes nothing else:** no HR unit, level, policy, terrain, existing site or existing stationing.
- **No request drifts:** a child section changes no requesting unit's own path, which is what hierarchy-drift detection
  compares.
- **Authorisation:** OpenFGA received the structure through the organisation trigger: both `parent` tuples, both
  `responsible` links, 0 pending changes.
- **Who requests:** `t.requester.pm` (requester for `HR-T-PM-1` and its descendants).

## Placement

- **Location:** about 4–6 km from every existing boundary, near 55.40–55.42 E, 25.23 N.
- **Overlap:** none with any current boundary, which the script checks.
- **Terrain:** inside the GLO-30 extent (51–57 E, 22–27 N).
- **Not production locations:** these are not real or proposed locations.

## Runs (`provision-runs.txt`)

| Run | Mode | Result |
|---|---|---|
| 1 | apply | 2 sections, 2 sites, 2 boundaries, 2 responsibilities, 2 stationings: `total_changes = 10` |
| 2 | plan | `total_changes = 0` |
| 3 | apply again | `total_changes = 0` |
