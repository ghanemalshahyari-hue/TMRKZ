// Mirrors docs/api/API_V1.md. Keep in sync with the backend contract.

export type Permission =
  | 'VIEW'
  | 'VIEW_SUMMARY'
  | 'CREATE'
  | 'EDIT'
  | 'REVIEW'
  | 'APPROVE'
  | 'EXPORT'
  | 'EXECUTE'
  | 'MANAGE_FACILITIES'
  | 'MANAGE_ACCESS'
  | 'CONFIGURE'
  | 'AUDIT'
  | 'VIEW_SOURCE_IDENTIFIERS';
export type Scope = 'ALL' | 'ORGANIZATION' | 'SITE' | 'ORGANIZATION_AND_SITE';
export type Ref = { id: string; name: string; code?: string };
export type Period = { start: string; end: string | null };
export type Page<T> = { items: T[]; page: number; size: number; total: number };

export type RequestStatus = 'DRAFT' | 'SUBMITTED' | 'RETURNED' | 'REJECTED' | 'APPROVED' | 'CLOSED';
export type RequestKind = 'NEW_RESERVATION' | 'EXTENSION' | 'MODIFICATION' | 'CANCELLATION' | 'EVACUATION';
export type ViewLevel = 'FULL' | 'SUMMARY' | 'CONTEXT';
/** Site availability for a period: BUSY only when every requested resource is blocked; PARTIAL when some are. */
export type Availability = 'FREE' | 'PARTIAL' | 'BUSY' | 'NO_RESOURCES';
/** Calendar grid cell (day): availability, or PENDING when a request is under review and nothing blocks. */
export type GridCell = Availability | 'PENDING';
export type ResourceStateName = 'FREE' | 'BLOCKED' | 'SHARED_IN_USE';
export type Administrative = 'APPROVED' | 'PENDING' | 'NONE';

export type RuleOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'empty' | 'notEmpty';
export type RuleValue = string | number | boolean | (string | number)[];
export type FactName = 'resourceCount' | 'durationDays' | 'durationHours' | 'participantCount' | 'requestType';
export type Rule =
  | { all: Rule[] }
  | { any: Rule[] }
  | { not: Rule }
  | { field: string; op: RuleOp; value?: RuleValue }
  | { fact: FactName; op: RuleOp; value?: RuleValue };

// ---------- identity ----------
export type Grant = {
  roleCode: string;
  roleName: string;
  permissions: Permission[];
  scope: Scope | 'CUSTOM';
  all?: boolean;
  summaryOnly: boolean;
  organization: Ref | null;
  site: Ref | null;
  validTo: string | null;
  viaDelegation: { id: string; delegatorName: string; validTo: string } | null;
};

export type Me = {
  id: string;
  username: string;
  displayName: string;
  employeeNo: string;
  initials: string;
  primaryRole: { code: string; name: string } | null;
  primaryOrg: Ref | null;
  permissions: Permission[];
  summaryOnly: boolean;
  grants: Grant[];
  signInMethod: 'PROVIDER' | 'DIRECTORY';
  serverTime: string;
  timezone: string;
};

export type AuthStatus = { provider: 'OIDC'; configured: boolean; reachable: boolean; manual: boolean };

// ---------- organizations ----------
export type OrgNode = {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  status: string;
  children: OrgNode[];
  siteCount: number;
  memberCount: number;
};
export type Member = {
  membershipId: string;
  person: { id: string; displayName: string; employeeNo: string };
  role: { code: string; name: string };
  positionTitle: string | null;
  site: Ref | null;
  validFrom: string;
  validTo: string | null;
  active: boolean;
};
export type SiteSummary = { id: string; code: string; name: string; kind: string; capacity: number | null };
export type OrgDetail = { org: Omit<OrgNode, 'children'> & { children?: OrgNode[] }; members: Member[]; sites: SiteSummary[] };
export type Person = { id: string; displayName: string; employeeNo: string; username: string; status: string };
export type Delegation = {
  id: string;
  delegator: Ref;
  delegate: Ref;
  role: { code: string; name: string };
  organization: Ref;
  validFrom: string;
  validTo: string;
  reason: string;
  revokedAt: string | null;
  active: boolean;
};
export type RoleDef = { code: string; name: string; permissions: Permission[]; scope: Scope; summaryOnly: boolean; system: boolean; grantableRoles: string[]; policyVersion: number | null };

// ---------- facilities & map ----------
export type Resource = {
  id: string;
  code: string;
  name: string;
  kind: string;
  policy: 'EXCLUSIVE' | 'SHARED';
  parentResourceId: string | null;
  handoverMinutes: number;
  capacity: number | null;
  siteId: string;
  label: string;
  childBlocking: boolean;
  sharedLimit: number | null;
};
export type Site = {
  id: string;
  code: string;
  name: string;
  kind: string;
  parentId: string | null;
  status: 'ACTIVE' | 'RETIRED';
  capacity: number | null;
  location: { lat: number; lng: number } | null;
  responsibleOrg?: Ref;
  resources: Resource[];
  view: ViewLevel;
};
export type OccupancyItem = { reservationId: string; resourceName: string; org?: Ref; period: Period; status: string };
export type GeometryType = 'Point' | 'Polygon' | 'MultiPolygon';
export type GeoJsonGeometry = { type: GeometryType; coordinates: unknown };
export type SiteDetail = Site & {
  geometry: { version: number; type: GeometryType; crs: string; source: string; validFrom: string; geojson: GeoJsonGeometry } | null;
  boundaryStatus: 'REGISTERED' | 'NOT_REGISTERED';
  geometryVersion: number | null;
  occupancy: OccupancyItem[];
  path: Ref[];
  canManage: boolean;
};
export type PackageKind = 'ROADS' | 'AERIAL' | 'FACILITY_PLAN' | 'SOURCE_DATA';
export type PackageStatus = 'PENDING_REVIEW' | 'ACTIVE' | 'DISABLED' | 'REJECTED' | 'RETIRED';
export type MapPackage = {
  id: string;
  code: string;
  name: string;
  source: string;
  license: string;
  attributionHtml: string;
  coverage: { minLat: number; minLng: number; maxLat: number; maxLng: number };
  crs: string;
  version: string;
  dataDate: string;
  format: 'SVG_OVERLAY' | 'RASTER_IMAGE' | 'GEOJSON';
  role: 'overlay' | 'source';
  kind: PackageKind;
  minZoom?: number;
  maxZoom?: number;
  status: PackageStatus;
  storage: 'BUILTIN' | 'MANAGED';
  sha256?: string;
  statusReason?: string;
  contentUrl: string;
};
export type ResourceState = {
  id: string;
  code: string;
  name: string;
  label: string;
  kind: string;
  policy: 'EXCLUSIVE' | 'SHARED';
  parentResourceId?: string;
  state: ResourceStateName;
  reason?: string;
  pending?: boolean;
  handoverMinutes?: number;
};
export type MapFeature = {
  siteId: string;
  code: string;
  name: string;
  kind: string;
  parentId: string | null;
  view: ViewLevel;
  lat: number | null;
  lng: number | null;
  boundary: { version: number; type: GeometryType; geojson: GeoJsonGeometry; simplified: boolean } | null;
  boundaryStatus: 'REGISTERED' | 'NOT_REGISTERED';
  availability: Availability;
  administrative: Administrative;
  pendingCount?: number;
  responsibleOrg?: Ref;
  occupants?: Ref[];
  relations?: ('RESPONSIBLE' | 'OCCUPANT')[];
  resources: ResourceState[];
  requestsVisible: boolean;
};
export type CoverageStatus = 'FULL' | 'PARTIAL' | 'NONE' | 'NO_PACKAGE' | 'ZOOM_OUT_OF_RANGE' | 'UNKNOWN';
export type Coverage = { status: CoverageStatus; message: string | null; fraction?: number; packageId?: string; packageName?: string };
export type MapFeatures = {
  asOf: string;
  period: { start: string; end: string | null };
  dataVersion: string;
  coverage: Coverage;
  features: MapFeature[];
};
export type MapContext = {
  extent?: [number, number, number, number];
  siteCount: number;
  backgrounds: MapPackage[];
  aerialInstalled: boolean;
  canManagePackages: boolean;
  canEditBoundaries: boolean;
  canExport: boolean;
  timezone: string;
};
export type OrgBranch = { id: string; code: string; name: string; parentId: string | null; childCount: number; siteCount: number; path?: Ref[] };
export type SiteNode = {
  id: string;
  code: string;
  name: string;
  kind?: string;
  parentId: string | null;
  view: ViewLevel;
  childCount: number;
  hasMarker: boolean;
  hasBoundary: boolean;
  resourceCount: number;
  path?: Ref[];
};
export type GeometryCheck = {
  valid: boolean;
  type?: string;
  vertices: number;
  areaM2?: number;
  problems: string[];
  normalized?: GeoJsonGeometry;
  bbox?: number[];
  crs?: string;
  transform?: string;
};
export type BoundaryVersion = {
  siteId: string;
  version: number;
  type: GeometryType;
  crs: string;
  source: string;
  format: string;
  originalCrs?: string;
  transform?: string;
  reason?: string;
  createdBy?: Ref;
  createdAt: string;
  importJobId?: string;
  geojson?: GeoJsonGeometry;
  areaM2?: number;
};
export type ImportFeature = {
  index: number;
  siteCode?: string;
  label?: string;
  siteId?: string;
  siteName?: string;
  type?: string;
  vertices: number;
  areaM2?: number;
  currentVersion?: number;
  problems: string[];
  geojson?: GeoJsonGeometry;
};
export type ImportJob = {
  id: string;
  fileName: string;
  format: 'GEOJSON' | 'KML';
  declaredCrs?: string;
  fileCrs?: string;
  effectiveCrs?: string;
  axisOrder: string;
  status: 'PREVIEWED' | 'REJECTED' | 'PUBLISHED' | 'CANCELLED';
  publishable: boolean;
  fileProblems: string[];
  features: ImportFeature[];
  createdAt: string;
  decidedAt?: string;
  reason?: string;
};
export type PinnedBoundary = {
  siteId: string;
  siteCode: string;
  siteName: string;
  version: number | null;
  type: GeometryType | 'NONE';
  geojson: GeoJsonGeometry | null;
  currentVersion: number | null;
};
export type RequestBoundaries = { requestId: string; revision: number; pinned: boolean; recorded: boolean; boundaries: PinnedBoundary[] };
export type AvailabilityGrid = { days: string[]; rows: { siteId: string; cells: GridCell[] }[] };
export type AvailabilityCheck = {
  available: boolean;
  conflicts: { resourceId: string; resourceName: string }[];
  pendingRequests: number | null;
  note: string;
};

// ---------- forms & workflows ----------
export type FieldKind = 'text' | 'textarea' | 'number' | 'date' | 'select' | 'files';
export type ChangePolicy = 'DESCRIPTIVE' | 'RESTART_STAGES' | 'FULL_REAPPROVAL';
export type FormField = {
  id: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  visible: boolean;
  options?: string[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  visibleWhen?: Rule | null;
  requiredWhen?: Rule | null;
  autofill?: 'CURRENT_USER_NAME' | 'OWNER_ORG_NAME' | null;
  changePolicy: ChangePolicy;
  affectsStages?: string[];
};
export type FormSchema = { fields: FormField[] };

export type OrgFrom = 'REQUEST_ORG' | 'RESOURCE_ORG' | 'ANY';
export type WfStage = {
  key: string;
  name: string;
  mode: 'ALL' | 'ANY';
  slaDays: number;
  assignees: { role: string; orgFrom: OrgFrom }[];
  condition?: Rule | null;
  final?: boolean;
  requiresSignature?: boolean;
};
export type WfExec = { key: string; name: string; role: string; orgFrom: OrgFrom; dueDays: number; evidenceRequired: boolean };
export type WorkflowDefinition = { name: string; stages: WfStage[]; execution: WfExec[] };

export type VersionStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';
export type VersionInfo = {
  id: string;
  version: number;
  status: VersionStatus;
  createdAt: string;
  publishedAt: string | null;
  publishedBy: string | null;
};
export type StudioItem = { id: string; requestType: Ref & { code: string }; published: VersionInfo | null; draft: VersionInfo | null };
export type FormVersion = VersionInfo & { formId: string; schema: FormSchema };
export type WorkflowVersion = VersionInfo & { workflowId: string; definition: WorkflowDefinition; activeRequests: number };
export type ValidationResult = { valid: boolean; errors: { path: string; message: string }[] };
export type SimulationResult = {
  valid: boolean;
  errors: { path: string; message: string }[];
  path: { key: string; name: string; runs: boolean }[];
  impact: { inFlightOnOlderVersions: number; message: string };
};

// ---------- requests ----------
export type RequestType = {
  code: string;
  name: string;
  kind: RequestKind;
  multiSites: boolean;
  multiOrgs: boolean;
  requiresTargetReservation: boolean;
  openEndAllowed: boolean;
  formVersion: { id: string; version: number; schema: FormSchema };
  workflowVersion: { id: string; version: number; name: string; stages: { key: string; name: string }[] } | null;
};

export type RequestListItem = {
  id: string;
  number: string;
  type: { code: string; name: string; kind: RequestKind };
  status: RequestStatus;
  subject: string;
  ownerOrg?: Ref;
  resources: { id: string; name: string; siteId: string }[];
  period: Period;
  revision: number;
  view: ViewLevel;
  updatedAt: string;
  createdByMe: boolean;
};

export type TaskState = 'PENDING' | 'OPEN' | 'APPROVED' | 'RETURNED' | 'REJECTED' | 'CLOSED_BY_POLICY' | 'CANCELLED';
export type StageView = {
  key: string;
  name: string;
  mode: 'ALL' | 'ANY';
  slaDays: number;
  state: 'PENDING' | 'ACTIVE' | 'COMPLETE' | 'SKIPPED' | 'CARRIED';
  tasks: { id: string; roleName: string; orgName: string | null; state: TaskState; decidedBy: string | null; decidedAt: string | null }[];
};
export type Attachment = {
  id: string;
  fieldId: string;
  fileName: string;
  contentType: string;
  size: number;
  sha256: string;
  version: number;
  scanStatus: 'PENDING' | 'CLEAN' | 'REJECTED';
  scanDetail: string | null;
  uploadedAt: string;
};
export type ExecutionTask = {
  id: string;
  key: string;
  name: string;
  roleName: string;
  orgName: string | null;
  dueAt: string;
  status: 'OPEN' | 'DONE';
  evidenceRequired: boolean;
  completedBy: string | null;
  completedAt: string | null;
  note: string | null;
  overdue: boolean;
  canComplete: boolean;
};
export type MyTask = { taskId: string; stageKey: string; stageName: string; roleName: string; final: boolean; requiresSignature: boolean };
export type SignatureMode = 'INTERNAL_ATTESTATION' | 'PKI';

export type RequestDetail = RequestListItem & {
  version: number;
  unit: 'DAYS' | 'HOURS';
  origin: 'MAP' | 'LIST';
  participantOrgs?: Ref[];
  infoOrgs?: Ref[];
  values?: Record<string, unknown>;
  attachments?: Attachment[];
  targetReservation: { id: string; resourceName: string; period: Period; status: string } | null;
  formVersion: { id: string; version: number; schema?: FormSchema };
  workflowVersion: { id: string; version: number; name: string } | null;
  createdBy?: Ref;
  createdAt: string;
  submittedAt: string | null;
  lastNote: string | null;
  stages: StageView[];
  history: { event: string; actor: string; at: string; note?: string | null }[];
  approvalDocument: {
    revision: number;
    sha256: string;
    signatureMode: SignatureMode;
    signatureLabel: string;
    signerName: string;
    signerRole: string;
    signedAt: string;
    boundaryVersions?: { siteCode: string; version: number | null; type: string }[];
  } | null;
  reservations: { id: string; resourceName: string; period: Period; status: string }[];
  executionTasks: ExecutionTask[];
  actions: { canEditDraft: boolean; canSubmit: boolean; canClose: boolean; myTasks: MyTask[] };
};

export type DraftInput = {
  typeCode?: string;
  origin?: 'MAP' | 'LIST';
  ownerOrgId?: string;
  resourceIds?: string[];
  participantOrgIds?: string[];
  infoOrgIds?: string[];
  subject?: string;
  unit?: 'DAYS' | 'HOURS';
  period?: Period;
  values?: Record<string, unknown>;
  targetReservationId?: string | null;
};

export type TaskItem = {
  id: string;
  requestId: string;
  requestNumber: string;
  requestType: string;
  stageKey: string;
  stageName: string;
  roleName: string;
  orgName: string | null;
  createdAt: string;
  dueAt: string;
  overdue: boolean;
  final: boolean;
  requiresSignature: boolean;
};
export type ApprovalDocument = {
  revision: number;
  sha256: string;
  signatureMode: SignatureMode;
  signatureLabel: string;
  lines: { label: string; value: string }[];
};
export type DecisionKind = 'APPROVE' | 'RETURN' | 'REJECT';
export type ReasonCode = 'INCOMPLETE_DATA' | 'PERIOD_CONFLICT' | 'WRONG_FACILITY' | 'MISSING_ATTACHMENT' | 'OTHER';
export type DecisionInput = {
  decision: DecisionKind;
  note?: string;
  reasonCode?: ReasonCode;
  expectedRevision: number;
  signature?: { confirm: boolean };
};

// ---------- reservations & execution ----------
export type ReservationItem = {
  id: string;
  resource: { id: string; name: string; siteId: string };
  org?: Ref;
  period: Period;
  status: 'ACTIVE' | 'CANCELLED' | 'RELEASED';
  requestId: string | null;
  requestNumber: string | null;
  source: 'APPROVAL' | 'SEED_IMPORT';
};
export type MyExecutionTask = ExecutionTask & { requestId: string; requestNumber: string };

// ---------- policies, integrations, system ----------
export type Settings = {
  multiSites: boolean;
  multiOrgs: boolean;
  signatureRequired: boolean;
  signatureMode: SignatureMode;
  defaultUnit: 'DAYS' | 'HOURS';
  attachmentMaxBytes: number;
  allowedAttachmentTypes: string[];
  timezone: string;
};
export type PolicyVersion = { id: string; version: number; settings: Settings; publishedAt: string | null; publishedBy: string | null };
export type PolicyDraft = { id: string; version: number; status: 'DRAFT'; errors: { path?: string; message: string }[] };
export type Integration = {
  code: string;
  name: string;
  status: 'NOT_CONNECTED' | 'FILE_IMPORT' | 'BUILT_IN';
  description: string;
  lastRun: { id: string; status: string; startedAt: string; stats: Record<string, unknown> } | null;
};
export type OrgImportPreview = {
  runId: string;
  valid: boolean;
  errors: { row: number; code: string; message: string }[];
  summary: { create: number; update: number; unchanged: number };
};
export type SystemInfo = {
  version: string;
  timezone: string;
  serverTime: string;
  database: string;
  outboxPending: number;
  mapPackages: number;
};

// ---------- audit, reports, exports, notifications ----------
export type AuditEvent = {
  id: string;
  at: string;
  actor: { name: string; role: string; org: string } | null;
  action: string;
  actionLabel: string;
  entityType: string;
  entityId: string;
  entityLabel: string;
  detail: string;
  reason: string | null;
};
export type Kpis = {
  definitions: Record<string, string>;
  reviewTime: { count: number; avgHours: number; p50Hours: number; p95Hours: number; byStage: { stageName: string; count: number; avgHours: number }[] };
  returnReasons: { code: string; label: string; count: number }[];
  occupancy: { resourceId: string; resourceName: string; reservedHours: number; totalHours: number; ratio: number }[];
  overdueExecution: { count: number; items: { id: string; name: string; requestNumber: string; dueAt: string }[] };
  overdueReview: { count: number };
};
export type ExportJob = { id: string; status: string; rowCount: number; createdAt: string };
export type Notification = {
  id: string;
  kind: string;
  title: string;
  body: string;
  requestId: string | null;
  createdAt: string;
  readAt: string | null;
};

export type ApiErrorBody = { code: string; message: string; details?: Record<string, unknown>; traceId?: string };

// ---- HR source (read-only mirror of the HR views) -------------------------------------------------------------

export type HrRun = {
  id: string;
  trigger: 'SCHEDULED' | 'MANUAL';
  status: 'RUNNING' | 'SUCCEEDED' | 'REJECTED' | 'FAILED' | 'SKIPPED';
  startedAt: string;
  finishedAt: string | null;
  requestedBy: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  overrideReason: string | null;
  counts: Record<string, unknown>;
  issues: number;
};
export type HrStatus = {
  keyConfigured: boolean;
  configured: boolean;
  enabled: boolean;
  sourceName: string | null;
  intervalSeconds: number;
  running: boolean;
  mappingVersion: number | null;
  lastSuccessAt: string | null;
  dataAgeMinutes: number | null;
  maxAgeHours: number;
  stale: boolean;
  published: { units: number; people: number; activeUnits: number; activePeople: number; publishedAt: string } | null;
  lastRun: HrRun | null;
  nextRunAt: string | null;
};
export type HrSource = {
  keyConfigured: boolean;
  exists: boolean;
  id?: string;
  name?: string;
  enabled?: boolean;
  hostOrUrl?: string;
  port?: number;
  serverName?: string;
  nameType?: 'service_name' | 'sid';
  username?: string;
  passwordSet?: boolean;
  unitView?: string;
  personView?: string;
  connectTimeoutS?: number;
  callTimeoutMs?: number;
  dropPercent?: number;
  dropMinimum?: number;
  maxAgeHours?: number;
  lastConnectionOk?: boolean | null;
  lastConnectionAt?: string | null;
  settingsReadable?: boolean;
  settingsError?: string;
};
export type HrSourceInput = {
  name: string;
  enabled: boolean;
  hostOrUrl: string;
  port: number;
  serverName: string;
  nameType: 'service_name' | 'sid';
  username: string;
  password?: string;
  unitView: string;
  personView: string;
  connectTimeoutS: number;
  callTimeoutMs: number;
  dropPercent: number;
  dropMinimum: number;
  maxAgeHours: number;
};
export type HrEntity = 'UNIT' | 'PERSON';
export type HrCanonical = { entity: HrEntity; field: string; required: boolean; label: string };
export type HrField = { entity: HrEntity; field: string; column: string; transform: string; alternates?: string[]; enabled: boolean };
export type HrRule = { column: string; operator: 'EQUALS' | 'IN' | 'NOT_EQUALS'; values: string[] };
export type HrMappingVersion = {
  id: string;
  version: number;
  status: 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';
  fields: HrField[];
  activeRules: Partial<Record<HrEntity, HrRule>>;
  discoveredColumns: Partial<Record<HrEntity, string[]>> | null;
  discoveredAt: string | null;
  publishedAt: string | null;
  problems?: string[];
};
export type HrTestResult = { ok: boolean; databaseVersion?: string; unitColumns?: number; personColumns?: number; failure?: string; message?: string; elapsedMs: number };

export type IdentityIssue = {
  id: string;
  displayName: string | null;
  reason: 'NO_KEY' | 'NO_MATCH' | 'AMBIGUOUS' | 'INACTIVE' | 'STALE_SOURCE' | 'ALREADY_LINKED';
  attempts: number;
  lastSeenAt: string;
  claimedKey?: string;
  subject?: string;
};

// ---- permissions studio (ADR-018) ----------------------------------------------------------------------------------
export type PolicyRole = {
  code: string;
  name: string;
  permissions: Permission[];
  scope: Scope;
  summaryOnly: boolean;
  system: boolean;
  grantableRoles: string[];
  sortOrder: number;
};
export type AccessPolicyVersion = {
  id: string;
  version: number;
  status: 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED' | 'DISCARDED';
  note: string | null;
  createdBy: Ref | null;
  createdAt: string;
  publishedBy: Ref | null;
  publishedAt: string | null;
  restoredFromVersion: number | null;
  basedOnVersion: number | null;
  fgaModelId: string | null;
  roles: PolicyRole[];
};
export type PolicyProblem = { level: 'ERROR' | 'WARNING'; role: string; message: string };
export type RoleImpact = {
  code: string;
  name: string;
  change: 'ADDED' | 'CHANGED' | 'UNCHANGED';
  added: Permission[];
  removed: Permission[];
  scopeFrom: Scope | null;
  scopeTo: Scope;
  summaryFrom: boolean | null;
  summaryTo: boolean;
  grantableAdded: string[];
  grantableRemoved: string[];
  memberships: number;
  delegations: number;
  seats: number;
  persons: number;
};
export type PolicyImpact = { draftVersion: number; publishedVersion: number; roles: RoleImpact[]; problems: PolicyProblem[]; publishable: boolean };
export type GrantTargetKind = 'ORGANIZATION' | 'SITE' | 'RESOURCE';
export type GrantTargetView = { kind: GrantTargetKind; id: string; name: string; includeDescendants: boolean };
export type GrantView = {
  id: string;
  person: { id: string; displayName: string; employeeNo: string };
  role: { code: string; name: string };
  organization: Ref;
  positionTitle: string | null;
  scopeMode: 'ROLE' | 'CUSTOM';
  all: boolean;
  combine: 'AND' | 'OR';
  targets: GrantTargetView[];
  scopeText: string;
  validFrom: string;
  validTo: string | null;
  active: boolean;
  grantedBy: Ref | null;
  endedReason: string | null;
};
export type GrantScopeInput = {
  mode: 'ROLE' | 'CUSTOM';
  all?: boolean;
  combine?: 'AND' | 'OR';
  targets?: { kind: GrantTargetKind; id: string; includeDescendants: boolean }[];
};
export type ExplainReason = { role: string; organization: string; scope: string; validTo: string | null; via: string | null };
export type ExplainVerdict = { allowed: boolean; reasons: ExplainReason[] };
export type ExplainAction = { action: Permission; published: ExplainVerdict; draft: ExplainVerdict | null; openfga: boolean | null; changed: boolean };
export type AccessExplain = {
  person: { id: string; displayName: string; employeeNo: string; status: string };
  target: { organization: Ref | null; site: Ref | null; resource: Ref | null; meaning: string };
  draftVersion: number | null;
  openfgaAvailable: boolean;
  actions: ExplainAction[];
};
export type AuthzStatus = {
  configured: boolean;
  reachable: boolean;
  storeId: string | null;
  modelId: string | null;
  modelHash: string | null;
  appliedSeq: number;
  latestSeq: number;
  pendingChanges: number;
  tuples: number;
  lastSuccessAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
  rebuiltTuples?: number;
  rebuildMs?: number;
};

