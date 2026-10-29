# MOVER API v1 — implemented contract

All paths are prefixed with `/api/v1`. JSON in/out, UTF-8. Times are ISO-8601 UTC strings
(`2026-11-02T00:00:00Z`); the UI renders them in `Asia/Dubai`. Periods are half-open `[start, end)`;
`end: null` means open-ended (permanent use).

The machine-readable description is [`openapi.json`](openapi.json), generated from the controllers by
`python ops/tools/gen-openapi.py` and also served by the backend at `GET /api/v1/openapi.json`.

## Conventions

| Topic | Rule |
|---|---|
| Session | `POST /auth/login` sets an `HttpOnly; SameSite=Strict` cookie `MOVER_SESSION`. Server-side session row; revocation is immediate. |
| CSRF guard | Every non-GET request must carry `X-Requested-With: mover`. Missing → `403 FORBIDDEN`. |
| Actor | Always taken from the session. Bodies never carry actor ids or approval roles. |
| Idempotency | `Idempotency-Key: <uuid>` accepted on submit, decision, close, execution-complete, exports. Same key + same body → stored result replayed. Same key + different body → `409 IDEMPOTENCY_CONFLICT`. |
| Optimistic locking | Draft edits carry `expectedVersion`; decisions carry `expectedRevision`. Mismatch → `409 STALE_REVISION`. |
| Paging | `?page=0&size=50` (max 200). Response `{ items: T[], page, size, total }`. |
| Errors | `{ "code": "RESERVATION_CONFLICT", "message": "<Arabic message>", "details": {…}, "traceId": "…" }` |

Error codes: `VALIDATION_FAILED` 400, `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `RESOURCE_NOT_FOUND` 404,
`STALE_REVISION` 409, `TASK_ALREADY_COMPLETED` 409, `RESERVATION_CONFLICT` 409, `IDEMPOTENCY_CONFLICT` 409,
`ATTACHMENT_NOT_READY` 409, `WORKFLOW_NOT_PUBLISHED` 409, `INVALID_WORKFLOW` 400, `SIGNATURE_REQUIRED` 400,
`SIGNATURE_PROVIDER_UNAVAILABLE` 503. Objects outside the caller's scope are reported as `404`, never `403`,
so their existence is not disclosed.

## Shared types (TypeScript notation)

```ts
type Permission = 'VIEW'|'CREATE'|'REVIEW'|'APPROVE'|'EXPORT'|'CONFIGURE'|'AUDIT'|'EXECUTE';
type Scope = 'ALL'|'ORGANIZATION'|'SITE'|'ORGANIZATION_AND_SITE';
type Ref = { id: string; name: string; code?: string };
type Period = { start: string; end: string | null };
type Page<T> = { items: T[]; page: number; size: number; total: number };

type RequestStatus = 'DRAFT'|'SUBMITTED'|'RETURNED'|'REJECTED'|'APPROVED'|'CLOSED';
type RequestKind = 'NEW_RESERVATION'|'EXTENSION'|'MODIFICATION'|'CANCELLATION'|'EVACUATION';
type ViewLevel = 'FULL'|'SUMMARY';
type Availability = 'FREE'|'PENDING'|'BUSY';
type Administrative = 'APPROVED'|'PENDING'|'NONE';

type Rule =
  | { all: Rule[] } | { any: Rule[] } | { not: Rule }
  | { field: string; op: RuleOp; value?: string | number | boolean | (string|number)[] }
  | { fact: 'resourceCount'|'durationDays'|'durationHours'|'participantCount'|'requestType'; op: RuleOp; value?: string | number | string[] };
type RuleOp = 'eq'|'neq'|'gt'|'gte'|'lt'|'lte'|'in'|'empty'|'notEmpty';
```

## Session & identity

| Method & path | Body | Response |
|---|---|---|
| `GET /auth/status` | – | `{ provider: 'OIDC', configured, reachable }` (public) |
| `GET /auth/oidc/start?return=/path` | – | 302 to the identity provider; sets the browser-binding cookie (public) |
| `GET /auth/oidc/callback?code&state` | – | 302 to `return` with the session cookie, or to `/#auth-error=CODE[&reason=…]` (public) |
| `POST /auth/reauth` | `{ returnTo }` | `{ redirect }` — step-up at the provider before a sensitive action |
| `POST /auth/logout` | – | `{ redirect }` — the provider's end-session address |
| `GET /identity-issues` | – | sign-ins waiting for an access manager (MANAGE_ACCESS; source ids only with VIEW_SOURCE_IDENTIFIERS) |
| `POST /identity-issues/{id}/resolve` | `{ personId?, reason }` | 204 — link to an active person, or dismiss |
| `GET /me` | – | `Me` |
| `GET /me/capabilities` | – | `{ permissions: Permission[], grants: Grant[] }` |

```ts
type Me = {
  id: string; username: string; displayName: string; employeeNo: string; initials: string;
  primaryRole: { code: string; name: string } | null;
  primaryOrg: Ref | null;
  permissions: Permission[];          // union of active grants
  summaryOnly: boolean;               // every VIEW grant is summary-only
  grants: Grant[];
  serverTime: string; timezone: string;
};
type Grant = {
  roleCode: string; roleName: string; permissions: Permission[]; scope: Scope; summaryOnly: boolean;
  organization: Ref | null; site: Ref | null; validTo: string | null;
  viaDelegation: { id: string; delegatorName: string; validTo: string } | null;
};
```

## Organizations, people, memberships, delegations, roles

| Method & path | Notes |
|---|---|
| `GET /organizations/tree` | Scoped tree: `OrgNode[]` where `OrgNode = { id, code, name, parentId, status, children: OrgNode[], siteCount, memberCount }` |
| `GET /organizations/{id}` | `{ org: OrgNode (no children), members: Member[], sites: SiteSummary[] }` |
| `GET /organizations/{id}/children` | `OrgNode[]` (lazy loading for large trees) |
| `GET /people?q=&page=&size=` | `Page<{ id, displayName, employeeNo, username, status }>` — CONFIGURE |
| `POST /memberships` | `{ personId, organizationId, roleCode, positionTitle?, siteScopeId?, validFrom, validTo? }` — CONFIGURE |
| `POST /memberships/{id}/end` | `{ endAt?, reason }` — CONFIGURE. Open tasks re-pool to the remaining role holders (audited). |
| `GET /delegations` | Delegations I gave or received; all for CONFIGURE. `Delegation[]` |
| `POST /delegations` | `{ delegateId, membershipId, validFrom, validTo, reason }` — delegator = caller; scope never wider than the source membership |
| `POST /delegations/{id}/revoke` | `{ reason }` |
| `GET /roles` | `RoleDef[]` = `{ code, name, permissions: Permission[], scope: Scope, summaryOnly, system: boolean }` |
| `PUT /roles/{code}` | `{ permissions, scope, summaryOnly }` — CONFIGURE; `SYSTEM_ADMIN` immutable |

```ts
type Member = { membershipId: string; person: { id: string; displayName: string; employeeNo: string };
  role: { code: string; name: string }; positionTitle: string | null; site: Ref | null;
  validFrom: string; validTo: string | null; active: boolean };
type Delegation = { id: string; delegator: Ref; delegate: Ref; role: { code: string; name: string };
  organization: Ref; validFrom: string; validTo: string; reason: string;
  revokedAt: string | null; active: boolean };
```

## Facilities & map

```ts
type Resource = { id: string; code: string; name: string; kind: string; policy: 'EXCLUSIVE'|'SHARED';
  parentResourceId: string | null; handoverMinutes: number; capacity: number | null; siteId: string; label: string };
type Site = { id: string; code: string; name: string; kind: string; parentId: string | null; status: 'ACTIVE'|'RETIRED';
  capacity: number | null; location: { lat: number; lng: number } | null;
  responsibleOrg?: Ref;               // omitted for SUMMARY viewers
  resources: Resource[]; view: ViewLevel };
```

| Method & path | Notes |
|---|---|
| `GET /sites` | Visible sites (flat, includes the main site with `parentId=null`) |
| `GET /sites/{id}` | `Site & { geometry: { version, crs, source, validFrom, geojson } | null, occupancy: OccupancyItem[] }` — occupancy is current + historical reservations (`org` omitted for SUMMARY) |
| `POST /sites` / `PUT /sites/{id}` | CONFIGURE. `{ code, name, kind, parentId?, responsibleOrgId, capacity?, location? }`. Cycles rejected. |
| `POST /sites/{id}/retire` | CONFIGURE. No destructive delete exists. |
| `POST /resources` | CONFIGURE. `{ siteId, code, name, kind, policy, parentResourceId?, handoverMinutes, capacity? }` |
| `GET /resources/{id}/reservations?from=&to=` | `ReservationItem[]` |
| `GET /map/packages` | `MapPackage[]` |
| `GET /map/packages/{id}/content` | File stream (local volume) |
| `GET /map/features?bbox=minLng,minLat,maxLng,maxLat&time=ISO` | `MapFeatures` |
| `GET /availability/grid?from=YYYY-MM-DD&days=7` | `{ days: string[]; rows: { siteId: string; cells: Availability[] }[] }` (days in Asia/Dubai) |
| `POST /availability/check` | `{ resourceIds, start, end, excludeReservationId? }` → `{ available, conflicts: { resourceId, resourceName }[], pendingRequests: number, note }` (preview only) |

```ts
type OccupancyItem = { reservationId: string; resourceName: string; org?: Ref; period: Period; status: string };
type MapPackage = { id: string; code: string; name: string; source: string; license: string; attributionHtml: string;
  coverage: { minLat: number; minLng: number; maxLat: number; maxLng: number }; crs: string;
  version: string; dataDate: string; format: 'SVG_OVERLAY'|'GEOJSON'; contentUrl: string };
type MapFeatures = { asOf: string; dataVersion: string;
  coverage: { covered: boolean; packageIds: string[]; message: string | null };
  features: { siteId: string; code: string; name: string; lat: number; lng: number;
    availability: Availability; administrative: Administrative; occupantOrg?: Ref; pendingCount: number }[] };
```

## Request types, requests, attachments

```ts
type RequestType = { code: string; name: string; kind: RequestKind; multiSites: boolean; multiOrgs: boolean;
  requiresTargetReservation: boolean;
  formVersion: { id: string; version: number; schema: FormSchema };
  workflowVersion: { id: string; version: number; name: string; stages: { key: string; name: string }[] } | null };

type RequestListItem = { id: string; number: string; type: { code: string; name: string; kind: RequestKind };
  status: RequestStatus; subject: string; ownerOrg?: Ref; resources: { id: string; name: string; siteId: string }[];
  period: Period; revision: number; view: ViewLevel; updatedAt: string; createdByMe: boolean };

type RequestDetail = RequestListItem & {
  version: number;                    // optimistic lock for drafts
  unit: 'DAYS'|'HOURS';
  origin: 'MAP'|'LIST';
  participantOrgs?: Ref[]; infoOrgs?: Ref[];
  values?: Record<string, unknown>;
  attachments?: Attachment[];
  targetReservation: { id: string; resourceName: string; period: Period; status: string } | null;
  formVersion: { id: string; version: number; schema?: FormSchema };
  workflowVersion: { id: string; version: number; name: string } | null;
  createdBy?: Ref; createdAt: string; submittedAt: string | null;
  lastNote: string | null;
  stages: StageView[];
  history: { event: string; actor: string; at: string; note?: string | null }[];
  approvalDocument: { revision: number; sha256: string; signatureMode: 'INTERNAL_ATTESTATION'|'PKI';
     signatureLabel: string; signerName: string; signerRole: string; signedAt: string } | null;
  reservations: { id: string; resourceName: string; period: Period; status: string }[];
  executionTasks: ExecutionTask[];
  actions: { canEditDraft: boolean; canSubmit: boolean; canClose: boolean;
     myTasks: { taskId: string; stageKey: string; stageName: string; roleName: string; final: boolean; requiresSignature: boolean }[] };
};
type StageView = { key: string; name: string; mode: 'ALL'|'ANY'; slaDays: number;
  state: 'PENDING'|'ACTIVE'|'COMPLETE'|'SKIPPED'|'CARRIED';
  tasks: { id: string; roleName: string; orgName: string | null;
     state: 'PENDING'|'OPEN'|'APPROVED'|'RETURNED'|'REJECTED'|'CLOSED_BY_POLICY'|'CANCELLED';   // PENDING = stage not reached yet (id null)
     decidedBy: string | null; decidedAt: string | null }[] };
type Attachment = { id: string; fieldId: string; fileName: string; contentType: string; size: number; sha256: string;
  version: number; scanStatus: 'PENDING'|'CLEAN'|'REJECTED'; scanDetail: string | null; uploadedAt: string };
type ExecutionTask = { id: string; key: string; name: string; roleName: string; orgName: string | null; dueAt: string;
  status: 'OPEN'|'DONE'; evidenceRequired: boolean; completedBy: string | null; completedAt: string | null;
  note: string | null; overdue: boolean; canComplete: boolean };
```

| Method & path | Body | Response |
|---|---|---|
| `GET /request-types` | – | `RequestType[]` |
| `GET /requests?status=&q=&page=&size=&excludeDrafts=` | – | `Page<RequestListItem>` |
| `POST /requests` | `{ typeCode, origin, ownerOrgId?, resourceIds?, participantOrgIds?, infoOrgIds?, subject?, unit?, period?, values?, targetReservationId? }` | `RequestDetail` (DRAFT) |
| `GET /requests/{id}` | – | `RequestDetail` |
| `PATCH /requests/{id}/draft` | same fields as POST + `expectedVersion` | `RequestDetail` |
| `POST /requests/{id}/submit` | `{ expectedVersion, resubmissionReason? }` | `RequestDetail` |
| `POST /requests/{id}/close` | `{ note? }` | `RequestDetail` (requires all execution tasks DONE; reservation untouched) |
| `POST /requests/{id}/attachments` | multipart `fieldId`, `file` | `Attachment` (scan result inline) |
| `GET /attachments/{id}/content` | – | file (403/404 if no FULL access, 409 if not CLEAN) |
| `POST /reservations/{id}/change-requests` | `{ typeCode }` | `RequestDetail` — draft change request targeting the reservation |

## Review tasks & decisions

| Method & path | Body | Response |
|---|---|---|
| `GET /tasks` | – | `TaskItem[]` — open tasks the caller may decide now |
| `GET /tasks/{id}/approval-document` | – | `{ revision, sha256, signatureMode, signatureLabel, lines: { label, value }[] }` |
| `POST /tasks/{id}/decision` | `{ decision: 'APPROVE'|'RETURN'|'REJECT', note?, reasonCode?, expectedRevision, signature?: { password: string; confirm: boolean } }` | `RequestDetail` |

`TaskItem = { id, requestId, requestNumber, requestType, stageKey, stageName, roleName, orgName, createdAt, dueAt, overdue, final, requiresSignature }`.
Return/reject need a note ≥ 5 chars. `reasonCode ∈ INCOMPLETE_DATA|PERIOD_CONFLICT|WRONG_FACILITY|MISSING_ATTACHMENT|OTHER`.
Final approval with `signatureRequired` needs `signature.confirm=true` and the caller's password (internal attestation, **not** a PKI signature).

## Reservations & execution

| Method & path | Response |
|---|---|
| `GET /reservations?from=&to=&resourceId=&status=` | `ReservationItem[]` = `{ id, resource: { id, name, siteId }, org?: Ref, period, status: 'ACTIVE'|'CANCELLED'|'RELEASED', requestId: string|null, requestNumber: string|null, source: 'APPROVAL'|'SEED_IMPORT' }` |
| `GET /execution-tasks` | `ExecutionTask & { requestId, requestNumber }`[] (mine) |
| `POST /execution-tasks/{id}/complete` `{ note, evidenceAttachmentId? }` | `ExecutionTask` |

## Studios (CONFIGURE)

```ts
type FormSchema = { fields: FormField[] };
type FormField = { id: string; label: string; kind: 'text'|'textarea'|'number'|'date'|'select'|'files';
  required: boolean; visible: boolean; options?: string[]; min?: number; max?: number; minLength?: number; maxLength?: number;
  visibleWhen?: Rule | null; requiredWhen?: Rule | null;
  autofill?: 'CURRENT_USER_NAME'|'OWNER_ORG_NAME'|null;
  changePolicy: 'DESCRIPTIVE'|'RESTART_STAGES'|'FULL_REAPPROVAL'; affectsStages?: string[] };
type WorkflowDefinition = { name: string; stages: WfStage[]; execution: WfExec[] };
type WfStage = { key: string; name: string; mode: 'ALL'|'ANY'; slaDays: number;
  assignees: { role: string; orgFrom: 'REQUEST_ORG'|'RESOURCE_ORG'|'ANY' }[];
  condition?: Rule | null; final?: boolean; requiresSignature?: boolean };
type WfExec = { key: string; name: string; role: string; orgFrom: 'REQUEST_ORG'|'RESOURCE_ORG'|'ANY'; dueDays: number; evidenceRequired: boolean };
type VersionInfo = { id: string; version: number; status: 'DRAFT'|'PUBLISHED'|'RETIRED'; createdAt: string; publishedAt: string | null; publishedBy: string | null };
```

| Method & path | Notes |
|---|---|
| `GET /forms` | `{ id, requestType: Ref&{code}, published: VersionInfo|null, draft: VersionInfo|null }[]` |
| `GET /form-versions/{id}` | `VersionInfo & { formId, schema: FormSchema }` |
| `POST /forms/{id}/drafts` | `{ schema }` → creates/replaces the single draft |
| `POST /form-versions/{id}/validate` | `{ valid, errors: { path, message }[] }` |
| `POST /form-versions/{id}/publish` | published version; earlier published → RETIRED (still referenced by old requests) |
| `GET /workflows` | same shape as `/forms` |
| `GET /workflow-versions/{id}` | `VersionInfo & { workflowId, definition: WorkflowDefinition, activeRequests: number }` |
| `POST /workflows/{id}/drafts` | `{ definition }` |
| `POST /workflow-versions/{id}/simulate` | `{ facts?: { resourceCount?, durationDays?, values? } }` → `{ valid, errors, path: { key, name, runs: boolean }[], impact: { inFlightOnOlderVersions: number, message } }` |
| `POST /workflow-versions/{id}/publish` | compiles BPMN, deploys to Flowable |
| `GET /workflow-versions/{id}/bpmn` | BPMN 2.0 XML |

## Policies, integrations, system

| Method & path | Notes |
|---|---|
| `GET /policies/current` | `{ id, version, settings: Settings, publishedAt, publishedBy }` |
| `GET /policies/history` | list of the above |
| `POST /policies/drafts` | `{ settings }` → `{ id, version, status:'DRAFT', errors: [] }` |
| `POST /policy-versions/{id}/publish` | publishes; applies to requests submitted afterwards |
| `GET /integrations` | `{ code, name, status: 'NOT_CONNECTED'|'FILE_IMPORT'|'BUILT_IN', description, lastRun: { id, status, startedAt, stats }|null }[]` |
| `POST /integrations/org-structure/preview` | `{ rows: { code, name, parentCode|null }[] }` → `{ runId, valid, errors: { row, code, message }[], summary: { create, update, unchanged } }` |
| `POST /integrations/org-structure/runs/{runId}/commit` | applies a valid preview |
| `GET /system/info` | `{ version, timezone, serverTime, database: 'UP', outboxPending, mapPackages }` |

```ts
type Settings = { multiSites: boolean; multiOrgs: boolean; signatureRequired: boolean;
  signatureMode: 'INTERNAL_ATTESTATION'|'PKI'; defaultUnit: 'DAYS'|'HOURS';
  attachmentMaxBytes: number; allowedAttachmentTypes: string[]; timezone: string };
```

## Audit, reports, exports, notifications

| Method & path | Notes |
|---|---|
| `GET /audit-events?page=&size=&action=&entityType=` | AUDIT. `Page<{ id, at, actor: { name, role, org }|null, action, actionLabel, entityType, entityId, entityLabel, detail: string (Arabic summary), data: object (structured detail), reason, revision }>` — read-only, no write/delete API exists |
| `GET /reports/kpis?from=&to=` | `{ definitions: Record<string,string>, reviewTime: { count, avgHours, p50Hours, p95Hours, byStage: { stageName, count, avgHours }[] }, returnReasons: { code, label, count }[], occupancy: { resourceId, resourceName, reservedHours, totalHours, ratio }[], overdueExecution: { count, items: { id, name, requestNumber, dueAt }[] }, overdueReview: { count } }` (scoped) |
| `POST /exports` | `{ kind: 'REQUESTS_CSV', filter?: { status? } }` → `{ id, status, rowCount, createdAt }` — EXPORT |
| `GET /exports/{id}` / `GET /exports/{id}/content` | EXPORT re-checked at download |
| `GET /notifications` | `{ id, kind, title, body, requestId|null, createdAt, readAt|null }[]` |
| `POST /notifications/{id}/read` | 204 |
