# STATIONING_REQUESTER — assignment & enforcement audit

**Status:** every one of the 9 requirements is already satisfied by the current code and data model. No code
change is needed. This document is the audit trail with file:line evidence.

**Date:** 2026-11-21. Repository at `410b5f4` (branch `main`).

**Scope:** STATIONING_REQUESTER is the «مقدم الطلب» role installed by `V49__stationing_permissions_simplified.sql`,
holding `VIEW`, `CREATE_RESTATIONING`, `REQUEST_SITE_REGISTRATION` ([V49:55](backend/src/main/resources/db/migration/V49__stationing_permissions_simplified.sql#L55)).

---

## 1. Can assign: this unit only / this unit + descendants / selected descendant levels / selected units — **MET**

The grant admin service [`GrantAdminService`](backend/src/main/java/ae/mover/authz/GrantAdminService.java) exposes
all four modes:

| Requested mode | How it's expressed |
|---|---|
| this unit only | `TargetInput{kind='ORGANIZATION', id=<unit>, includeDescendants=false}` (defaulted at [`GrantAdminService.java:157`](backend/src/main/java/ae/mover/authz/GrantAdminService.java#L157)) |
| this unit + descendants | same target with `includeDescendants=true` (default) |
| **selected descendant levels** | `TargetInput{..., levels=[1,2,…]}` ([`GrantAdminService.java:160-169`](backend/src/main/java/ae/mover/authz/GrantAdminService.java#L160-L169)) — a per-level subset of the descendants, backed by `membership_scope_target.levels int[]` ([`GrantAdminService.java:221`](backend/src/main/java/ae/mover/authz/GrantAdminService.java#L221)). Guard at L161: levels only make sense when `includeDescendants` is true. |
| selected units | multiple `TargetInput` entries in one grant ([`GrantAdminService.java:172-174`](backend/src/main/java/ae/mover/authz/GrantAdminService.java#L172-L174), de-duplicated by (kind, id)) |

The quick-pick list exposed to access requesters (`access_request_offer.scope_modes`) supports the four coarse
modes `UNIT`, `UNIT_TREE`, `UNITS`, `SITES` ([V43:17](backend/src/main/resources/db/migration/V43__access_request_advice.sql#L17)).
The finer-grained "selected descendant levels" is reached through the grants studio directly, not the quick-pick
request list — which is consistent with how other TNQL-style grants have been scoped.

---

## 2. `CREATE_RESTATIONING` must use `ctx.canFor(..., selectedRequestingUnit)` — **MET**

[`RestationingService.create(...)` lines 190-203](backend/src/main/java/ae/mover/stationing/RestationingService.java#L190-L203):

```java
Permission create = createPermission(purpose);  // CREATE_RESTATIONING or REQUEST_SITE_REGISTRATION
if (!ctx.canFor(create, in.requestingUnitId())) {
    throw ApiException.forbidden(...);
}
```

The check reads the requesting unit from the caller's input and asks `canFor(permission, unit)` — not a global
`ctx.has(permission)` and not a reach check that would allow a different unit. A caller cannot assert authority
over a unit they do not actually hold the right for.

`createPermission(purpose)` ([L231-237](backend/src/main/java/ae/mover/stationing/RestationingService.java#L231-L237))
returns `CREATE_RESTATIONING` for `RESTATIONING` / `DEPLOYMENT_AREAS` / legacy `INITIAL_STATIONING`, and
`REQUEST_SITE_REGISTRATION` for `SITE_REGISTRATION`. Both take the same enforcement path at L199.

---

## 3. `REQUEST_SITE_REGISTRATION` must use `ctx.canFor(..., selectedRequestingUnit)` — **MET**

Same site as §2. The dispatch is purpose-driven; a caller submitting `purpose: SITE_REGISTRATION` lands on the
same `ctx.canFor(REQUEST_SITE_REGISTRATION, requestingUnitId)` guard.

---

## 4. Unit selector must show ONLY units covered by the person's effective requester scope — **MET**

Three UI entry points, three server-filtered endpoints — each scoped by the appropriate reach:

| UI page | Fetch | Backend | Scope |
|---|---|---|---|
| New request hub ([`NewRequestPage.tsx:19`](frontend/src/pages/NewRequestPage.tsx#L19)) | `api.requestHub()` | [`RequestHubService.hub()`](backend/src/main/java/ae/mover/stationing/RequestHubService.java#L96) | `reach(CREATE_RESTATIONING) ∪ reach(REQUEST_SITE_REGISTRATION)` ([`RequestHubService.java:31`](backend/src/main/java/ae/mover/stationing/RequestHubService.java#L31)) — the union covers both re-stationing and site-registration flows |
| Re-stationing editor ([`RestationingEditor.tsx:196`](frontend/src/pages/RestationingEditor.tsx#L196)) | `api.restationingUnits()` → `GET /restationing-requests/units` | [`RestationingService.requestableUnits()`](backend/src/main/java/ae/mover/stationing/RestationingService.java#L1362) | `reach(CREATE_RESTATIONING)` only — the right flow |
| Deployment areas editor ([`DeploymentAreasRequest.tsx:135`](frontend/src/pages/DeploymentAreasRequest.tsx#L135)) | `api.requestHub()` | same as new-request hub | both reaches (DEPLOYMENT_AREAS is covered by CREATE_RESTATIONING per ADR-078) |
| Site registration entry ([`NewRequestPage.tsx:39`](frontend/src/pages/NewRequestPage.tsx#L39)) | hub action with `action='SITE_REGISTRATION' && allowed` | per-unit `canFor(REQUEST_SITE_REGISTRATION, unit)` at [`RequestHubService.java:90`](backend/src/main/java/ae/mover/stationing/RequestHubService.java#L90) | server-confirmed, per-unit |

Every unit in the list went through `reach()` then — for the per-unit actions column —
`ctx.canFor(permission, unit)` ([`RequestHubService.java:81`](backend/src/main/java/ae/mover/stationing/RequestHubService.java#L81) and [:90](backend/src/main/java/ae/mover/stationing/RequestHubService.java#L90)).
A unit outside the person's requester scope never reaches the client.

---

## 5. STATIONING_REQUESTER includes VIEW so the person can see covered units/sites — **MET**

[V49:55](backend/src/main/resources/db/migration/V49__stationing_permissions_simplified.sql#L55) explicitly sets:
```sql
v_perms := array['VIEW', 'CREATE_RESTATIONING', 'REQUEST_SITE_REGISTRATION'];
```

The role's scope mirrors where the three rights reach. The `VIEW` permission is independent (can be granted on
its own, held by other roles, etc.), but STATIONING_REQUESTER bundles it so a requester can see what they can
act on. No other role is affected by this bundling.

---

## 6. Two people may hold STATIONING_REQUESTER over the same unit/scope simultaneously — **MET**

`membership` ([V1:179-183](backend/src/main/resources/db/migration/V1__core_schema.sql#L179-L183)) has only an
index on `organization_id`, **no** `UNIQUE (person_id, organization_id, role_code)` constraint:
```
create index membership_org_idx on membership(organization_id);
```

Nothing in `GrantAdminService.grant(...)` rejects a second grant over the same (person, unit, role). Both grants
coexist; both resolve to `canFor() == true` for the covered units; both appear in `ctx.grants()`.

(The `unit_member` table has a unique index on `(person_id, organization_id)` where `ended_at is null`, but
`unit_member` is the matrix-membership for the access-studio UI, not the grant store. Grants live in `membership`
and `unit_grant`. Confirmed by cross-reference: [V33:21](backend/src/main/resources/db/migration/V33__unit_member.sql#L21) vs. the `membership` table used throughout `AccessContext`.)

---

## 7. A higher-scope requester remains allowed even when a lower-scope requester is assigned — DO NOT implement nearest-wins — **MET**

The `nearest-wins` mechanism (`Stations.nearestGrants(...)` at [`Stations.java:102`](backend/src/main/java/ae/mover/access/Stations.java#L102)) exists but is **not** on the requester path. It is called only from:

- [`RestationingLifecycle.java:411`](backend/src/main/java/ae/mover/stationing/RestationingLifecycle.java#L411) — picking the approver for an in-progress lifecycle action
- [`RestationingService.java:578`](backend/src/main/java/ae/mover/stationing/RestationingService.java#L578) — resolving the named decider for an approval-chain stage (`NEAREST_SCOPE` stage kinds)
- [`StationingRoutes.java:237`](backend/src/main/java/ae/mover/stationing/StationingRoutes.java#L237) — counting approver holders at a stage
- [`DecisionService.java:155-468`](backend/src/main/java/ae/mover/requests/DecisionService.java#L155-L468) — gating `by_scope` decisions

All four are approval-chain concerns. The `ctx.canFor(CREATE_RESTATIONING, unit)` /
`ctx.canFor(REQUEST_SITE_REGISTRATION, unit)` check at
[`RestationingService.java:199`](backend/src/main/java/ae/mover/stationing/RestationingService.java#L199) returns
true for **any** grant that covers the unit — be it a `UNIT`-scoped grant on that exact unit, a `UNIT_TREE`
grant on an ancestor, or an ALL grant. A grant at a higher scope is not disqualified by the existence of a
narrower grant.

---

## 8. Request ownership — requesting unit = owner, human requester = audit/history — **MET**

Persisted at create time ([`RestationingService.java:211-217`](backend/src/main/java/ae/mover/stationing/RestationingService.java#L211-L217)):

```sql
insert into restationing_request(id, number, requester_id, requesting_unit_id, state, kind, ...)
values (:id, :n, :by, :unit, ...)
-- :by  = ctx.personId()          (human, for audit/history)
-- :unit = in.requestingUnitId()  (unit, for ownership)
```

Enforced at every mutation site:

- Visibility ([`RestationingService.java:1646-1672`](backend/src/main/java/ae/mover/stationing/RestationingService.java#L1646-L1672)) checks rights against `r.unit()`, the requesting unit — not `r.requester()`.
- Editability ([`RestationingService.java:1685-1696`](backend/src/main/java/ae/mover/stationing/RestationingService.java#L1685-L1696)) is gated by `ctx.canFor(createPermission(r.purpose()), r.unit())` — comment says it verbatim: *"the request belongs to the requesting unit, not to the person who started it (owner, 16 Nov 2026): anyone who holds this request's right for that unit edits and sends it — the one who started it is kept for the history; one who no longer holds the right no longer edits it."*

A human requester who later loses their grant can no longer edit; another grantee for the same unit can take
over. That is the §8 contract exactly.

---

## 9. Existing separation-of-duties remains unchanged — **MET**

V49 touches only role composition and retires the obsolete MOVER roles. It does not alter the SoD rules enforced
in `DecisionService` (requester-is-not-their-own-approver), the stage resolution in `RestationingService.submit`,
or the final-approver chain in `RestationingLifecycle`. Nothing in this audit proposes changes to those rules
either.

---

## Summary

| # | Requirement | Verdict | Evidence |
|---|---|:---:|---|
| 1 | assign: unit / unit+desc / selected levels / selected units | ✔ | `GrantAdminService` targets + `levels[]` |
| 2 | `CREATE_RESTATIONING` uses `canFor(..., selectedRequestingUnit)` | ✔ | `RestationingService.create():199` |
| 3 | `REQUEST_SITE_REGISTRATION` uses `canFor(..., selectedRequestingUnit)` | ✔ | same site, purpose-dispatched |
| 4 | unit selector shows only reach units | ✔ | `/request-hub` + `/restationing-requests/units`, server-filtered |
| 5 | STATIONING_REQUESTER includes VIEW | ✔ | `V49:55` sets `['VIEW','CREATE_RESTATIONING','REQUEST_SITE_REGISTRATION']` |
| 6 | concurrent holders allowed | ✔ | `membership` has no unique (person, org, role) |
| 7 | no nearest-wins for requester | ✔ | `nearestGrants` used only for approvers; `canFor()` returns true for any covering grant |
| 8 | requesting unit = owner, human = audit | ✔ | `requesting_unit_id` + `requester_id` split, visibility/edit gates use `r.unit()` |
| 9 | SoD unchanged | ✔ | V49 does not touch approval rules |

**No code change required for this spec.** The existing model satisfies it. If a future quick-pick wants to
expose the «selected descendant levels» mode without going through the grants studio, that would be an
additive UI change (new `ScopeMode` enum value + `access_request_offer.scope_modes` accepting it) but is not
required by the current ask.
