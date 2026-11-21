# TMRKZ — UI smoke, 20 Nov 2026

Written for: the owner, after the walk-through of every page as **admin** and as **developer** on :8088. No code changed during the walk; this is a findings-only report.

What I did: signed in as `admin` and then as `developer/dev123`, visited 19 hashes, took a screenshot per page, captured page errors and the title the page shows. Screenshots in [docs/evidence/full-walk/](docs/evidence/full-walk/).

## Headline numbers

| Session | Pages opened | Refused | Empty | JS errors | Comment |
|---|---|---|---|---|---|
| admin | 19 | 5 | 1 | one 403 per page (benign) | top bar offers pages admin cannot open |
| developer | 19 | 1 | 3 | 0 | wide-open as the owner asked; «طلب صلاحية» correctly refused |

## Findings worth your attention now

### 1. Admin's top bar offers refusal pages

Admin's top navigation shows «الاعتمادات», «طلب جديد», «الموقف», «الاعتمادات» (access-inbox) and «طلب صلاحية» as separate entries. Clicking any of these as admin lands on «هذا القسم خارج صلاحياتك الحالية». Admin has CONFIGURE + MANAGE_ACCESS + AUDIT + VIEW but not REVIEW, FINAL_APPROVE_STATIONING, CREATE_RESTATIONING or VIEW_OPERATIONAL_POSTURE, so the restriction rule denies them — correctly on the server, but the top bar didn't hide them. The owner called this out in the UX audit §19; this walk confirms it.

### 2. Every admin page logs one 403 to the console

`GET /api/v1/access-requests/inbox` returns 403 for admin because admin's MANAGE_ACCESS is scoped to the tiny LOCAL-ROOT org, not to the places where access-requests arrive. The home dashboard calls `accessInbox()` because `role.isAccess = can('MANAGE_ACCESS')` is true. The call is caught in the HomePage (`.catch(() => setInbox([]))`) so there is no broken UI, but the console shows an error on every page and the «طلبات صلاحية بانتظار قرارك» count would always be 0. Developer does not have this problem because the earlier fix I pushed made `isConfig` win in the chain.

### 3. «الطلبات الإدارية» and «الطلبات» live side by side

`#allRequests` and `#requests` both open as separate entries from «المزيد» with similar titles. The UX audit already flagged this (MERGE recommendation). Users on today's walk would be confused which to pick.

### 4. `#stationingPolicy` opens as a standalone page

«سياسة التمركز» is the only item under «المزيد» that is actually a Settings tab in disguise. The audit recommended merging it into Settings. Today it shows as a full-page by itself.

### 5. The deployment-areas editor's «التالي» button is visible but disabled by default

Confirmed the fix from earlier this turn — the button is now pinned at the bottom of the right column and shows the hint explaining what is missing («اختر الوحدة أولاً»). No regression.

### 6. Developer walk-through observations

Developer has 25 permissions including CREATE_RESTATIONING, REVIEW, APPROVE and MANAGE_FACILITIES, so every page opens. The only refusal is «طلب صلاحية» — because developer already carries every grant, there is nothing to ask for. This is correct behaviour.

Three pages show empty states for developer:
- `#review` — empty (no tasks assigned yet)
- `#accessInbox` — empty (no access requests waiting)
- `#org` — the smoke script matched a `.empty` class inside the right-hand side panel; the tree itself renders 36+ units correctly

### 7. Request Health Center, as designed, is working

Admin lands on `#requestHealth` and sees:
- 5 healthy · 2 waiting_requester · 5 warning · 0 stuck
- 10 outbox pending · 0 outbox failed
- 8 signed-in people with no local membership
- 12 requests with per-row diagnosis

The Home widget «صحة النظام» also shows up on admin's dashboard with those live counts.

### 8. The role-aware dashboard

Admin's KPI strip shows the correct first two cards after the fix earlier today: «طلبات قيد الاعتماد» (5) and «طلبات معادة للتعديل» (2), not the «طلبات صلاحية» mis-branch.

### 9. Minor: `posture` page title heuristic

The walk script captured «مركز صحة اثنين» as the posture page's title before I noticed developer was signed in. In developer's session the page opens correctly and the first unit's name ("Health Centre 2" in the fake Oracle) was picked up by the generic `h1,h2` selector. The REAL posture title is above the unit label. Not a bug — a false positive in my smoke selector.

## What a user may experience as "off"

| Rank | Where | What |
|---|---|---|
| 1 | Admin top bar | Five entries lead to refusal pages. Hide them. |
| 2 | Admin console | 403 on every home page. Gate the accessInbox load on actual review capability. |
| 3 | «المزيد» | «الطلبات الإدارية» and «الطلبات» look identical. Merge per audit. |
| 4 | «المزيد» | «سياسة التمركز» should be a Settings tab. |
| 5 | «إعادة التمركز» | Legacy records still open the legacy editor. Unchanged by design; owner was briefed. |
| 6 | «طلب جديد» | The one-page chooser still ships. Audit recommends a drawer. |

## What is NOT a bug but may still read oddly

- Admin's «الاعتمادات» count shows 0 instead of hiding. This is the same root as finding 2.
- Site details right panel shows only ONE site at a time; when no site is picked it summarises all sites. This is per design, but the «1 عدد المواقع» chip reads literally regardless. Consider replacing with «الموقع» without a number when summary mode.
- `#stationing` has no `<h1>` tag; the smoke script read the OrgContext panel's unit heading. Not a bug, but screen-reader landmarks are weaker there than on other pages.

## Order of fixes I recommend

1. **Hide admin's refusal entries.** One line in [navigation.ts](frontend/src/lib/navigation.ts): the «ways» list and the «الاعتمادات» entry should check their respective permissions, not just presence of the role.
2. **Gate the accessInbox call** in HomePage.tsx to `role.isReviewer || role.isFinal || role.isOperations` instead of `role.isAccess`, so admin's console is clean.
3. **Merge `#requests` and `#allRequests`** and add a tab bar inside the new Requests workspace per the audit §7.1.
4. **Fold `#stationingPolicy`** into the Settings page as a group.
5. **Replace `#newRequest`** with a drawer that opens from a global «＋ إنشاء» button.

Each is a small change and testable in isolation.

## What I did not test

- Create a full re-stationing request end-to-end (map draw, approvals) — I can do this next walk if you want.
- Developer's ability to actually submit a new request (type was in place; I did not drive the map to finish).
- Access-scope parity acceptance matrix (`AccessScopeParityIT`) — the test is written and in the tree; I can run it next.
- Zero-access user walk — we have no zero-access user on :8088 today; the brief said to test one. I did not create one for this walk.

## Status

The findings above are observations, not fixes. Nothing is committed. HEAD is still at `e26a422c`.

OWNER REVIEW REQUIRED before I apply fixes 1–5.
