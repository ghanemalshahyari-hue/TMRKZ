import type { SignInBoard } from '../lib/signInNotes';
import type { DirectoryForm, OidcForm } from '../lib/integrationSettings';
import type { DbMigration, DbMigrationBackup, DbMigrationConnectInput, DbMigrationDumpInfo, DbMigrationInbox, DbMigrationListItem, DbMigrationSelectionInput,
  AssistantView,
  AssistantForm,
  AssistantTestResult,
  RequestHealthSummary,
  RequestHealthRow,
  RequestHealthDiagnosis,
} from './types';
import type {
  HierarchyLevel,
  SiteLinkRecord,
  StationingRecord,
  PolicyChange,
  StationingPolicyOverview,
  SiteGeometry,
  TerrainAssessment,
  StationingPolicyValues,
  StationingPolicyVersion,
  TerrainDatasetView,
  RestationingChecks,
  RestationingContent,
  RestationingLeg,
  GeoPolygon,
  RestationingListItem,
  RestationingRequest,
  RestationingUnit,
  TaskCandidate,
  TaskRouting,
  AccessExplain,
  ApprovalVerification,
  SigningJob,
  AccessPolicyVersion,
  ApiErrorBody,
  AuthzStatus,
  GrantScopeInput,
  GrantView,
  PolicyImpact,
  ApprovalDocument,
  Attachment,
  AuditEvent,
  AuthStatus,
  AvailabilityCheck,
  AvailabilityGrid,
  BoundaryVersion,
  Delegation,
  DecisionInput,
  DraftInput,
  ExecutionTask,
  ExportJob,
  FormSchema,
  FormVersion,
  GeoJsonGeometry,
  GeometryCheck,
  HrCanonical,
  HrEntity,
  HrField,
  HrMappingVersion,
  HrRule,
  HrRun,
  HrSource,
  HrSourceInput,
  HrStatus,
  HrTestResult,
  IdentityIssue,
  ImportJob,
  Integration,
  Kpis,
  MapContext,
  MapFeatures,
  MapPackage,
  Me,
  MyExecutionTask,
  Notification,
  OrgBranch,
  OrgDetail,
  OrgImportPreview,
  OrgNode,
  Page,
  Person,
  PolicyDraft,
  PolicyVersion,
  RequestBoundaries,
  RequestDetail,
  RequestListItem,
  Responsibility,
  RequestStatus,
  RequestType,
  Resource,
  ReservationItem,
  RoleDef,
  Settings,
  SimulationResult,
  Site,
  SiteDetail,
  SiteNode,
  SiteRequestActions,
  Communication,
  CommunicationChannel,
  RevisionComparison,
  Relocation,
  PlacementAction,
  PlacementCheck,
  PlacementRule,
  PlacementUnit,
  StationLevel,
  UnitSymbolLookup,
  UnitSymbol,
  StudioItem,
  SystemInfo,
  SystemManagement,
  SystemState,
  HrUnitsPreview,
  TaskItem,
  ValidationResult,
  WorkflowDefinition,
  WorkflowVersion,
  Permission,
  Scope,
  RoutingLevelValue,
 IntegrationView, IntegrationStatus, DirectoryTestResult, OidcTestResult } from './types';

export const API_BASE = '/api/v1';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly traceId?: string;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.code = body.code;
    this.status = status;
    this.details = body.details;
    this.traceId = body.traceId;
  }
}

const FALLBACK_MESSAGES: Record<number, string> = {
  400: 'تعذر قبول البيانات المرسلة.',
  401: 'انتهت الجلسة. سجّل الدخول مرة أخرى.',
  403: 'الإجراء غير مسموح ضمن صلاحياتك.',
  404: 'العنصر غير موجود أو خارج نطاقك.',
  409: 'تعارض مع حالة أحدث للسجل.',
  413: 'حجم الملف يتجاوز الحد المسموح.',
  503: 'الخدمة المطلوبة غير متاحة حالياً.',
};

/** Parses an error response into an ApiError; tolerant of non-JSON bodies from proxies. */
export function parseApiError(status: number, text: string): ApiError {
  try {
    const body = JSON.parse(text) as Partial<ApiErrorBody>;
    if (body && typeof body.code === 'string') {
      return new ApiError(status, {
        code: body.code,
        message: typeof body.message === 'string' && body.message ? body.message : FALLBACK_MESSAGES[status] ?? 'حدث خطأ غير متوقع.',
        details: body.details,
        traceId: body.traceId,
      });
    }
  } catch {
    /* not JSON */
  }
  const code = status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'RESOURCE_NOT_FOUND' : 'HTTP_' + status;
  return new ApiError(status, { code, message: FALLBACK_MESSAGES[status] ?? 'تعذر الاتصال بالخادم (' + status + ').' });
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
export function onUnauthorized(fn: Listener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

type RequestOptions = { body?: unknown; idempotencyKey?: string; form?: FormData; silent401?: boolean; signal?: AbortSignal };

export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'k-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  });
  const s = q.toString();
  return s ? '?' + s : '';
}

async function call<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-Requested-With'] = 'mover';
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(API_BASE + path, { method, headers, body, credentials: 'same-origin', signal: opts.signal });
  } catch (e) {
    // A superseded request (newer viewport or period) is cancelled on purpose; callers ignore it.
    if (opts.signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) throw e;
    throw new ApiError(0, { code: 'NETWORK', message: 'تعذر الوصول إلى الخادم. تحقق من الشبكة الداخلية.' });
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) {
    const err = parseApiError(res.status, text);
    if (res.status === 401 && !opts.silent401) unauthorizedListeners.forEach((fn) => fn());
    throw err;
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

const get = <T>(path: string, opts?: RequestOptions) => call<T>('GET', path, opts);

/**
 * Conditional GET for ETag-enabled endpoints (ADR-094 Gate 2.5 §A, §26-§29).
 * Returns `{ status: 304 }` when the server's current revision matches the client's `If-None-Match` — the
 * caller must keep its last response in memory and reuse it. Returns `{ status: 200, body, etag }` on a miss.
 */
export type ConditionalResult<T> = { status: 304; etag: string | null } | { status: 200; body: T; etag: string | null };
async function conditionalGet<T>(path: string, ifNoneMatch: string | null, signal?: AbortSignal): Promise<ConditionalResult<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;
  let res: Response;
  try {
    res = await fetch(API_BASE + path, { method: 'GET', headers, credentials: 'same-origin', signal });
  } catch (e) {
    if (signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) throw e;
    throw new ApiError(0, { code: 'NETWORK', message: 'تعذر الوصول إلى الخادم. تحقق من الشبكة الداخلية.' });
  }
  const etag = res.headers.get('ETag');
  if (res.status === 304) return { status: 304, etag };
  const text = await res.text();
  if (!res.ok) {
    const err = parseApiError(res.status, text);
    if (res.status === 401) unauthorizedListeners.forEach((fn) => fn());
    throw err;
  }
  const body = (text ? JSON.parse(text) : undefined) as T;
  return { status: 200, body, etag };
}
const post = <T>(path: string, body?: unknown, idempotencyKey?: string) => call<T>('POST', path, { body: body ?? {}, idempotencyKey });
const put = <T>(path: string, body: unknown) => call<T>('PUT', path, { body });
const patch = <T>(path: string, body: unknown) => call<T>('PATCH', path, { body });
const del = <T>(path: string) => call<T>('DELETE', path);

/** URL helpers for direct downloads (browser navigation keeps the session cookie). */
export const urls = {
  attachment: (id: string) => `${API_BASE}/attachments/${id}/content`,
  exportContent: (id: string) => `${API_BASE}/exports/${id}/content`,
  bpmn: (id: string) => `${API_BASE}/workflow-versions/${id}/bpmn`,
  mapContent: (pkg: MapPackage) => (pkg.contentUrl.startsWith('/') ? pkg.contentUrl : `${API_BASE}/map/packages/${pkg.id}/content`),
  boundariesExport: () => `${API_BASE}/map/boundaries/export`,
};

/** Query of the map layers: viewport, period (half-open; open = no end), selected resources and organisation. */
export type FeatureQuery = {
  bbox?: string;
  from?: string;
  to?: string | null;
  open?: boolean;
  time?: string;
  resourceIds?: string;
  orgId?: string;
  includeSubOrgs?: boolean;
  packageId?: string;
  zoom?: number;
  siteIds?: string;
};

export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

type RoleName = { code: string; name: string };
/**
 * Who the person is, from the one employment context (ADR-068): Oracle while it is in force, the directory before.
 * `unitConfigured` false: the source names a Unit ID TMRKZ does not hold; `statedUnitId`/`statedUnitName` are then as received.
 */
export type AccessIdentity = {
  name: string;
  employeeNo: string | null;
  userId: string | null;
  rank: string | null;
  position: string | null;
  unit: string | null;
  mainUnit: string | null;
  /** the person's own unit in TMRKZ (null when not configured), highlighted in the scope tree (ADR-094) */
  unitId?: string | null;
  source: string;
  sourceCode?: 'LDAP' | 'ORACLE';
  unitConfigured?: boolean;
  unitOrigin?: 'SOURCE' | 'EARLIER_HR' | 'ADDED' | 'NONE';
  statedUnitId?: string | null;
  statedUnitName?: string | null;
  observedAt?: string | null;
};
export type AccessMine = {
  unit: string | null;
  available: boolean;
  /** what may be asked for, as the system administrator describes it (owner, 16 Nov 2026) */
  requestable: OfferedRole[];
  scopeUnits?: { id: string; name: string; depth: number }[];
  scopeSites?: { id: string; name: string }[];
  held: string[];
  /** who the person is, for the zero-access page (owner, 16 Nov 2026) */
  identity?: AccessIdentity;
  /** one line for the whole page: NONE | PENDING | RETURNED | PARTLY_APPROVED | APPROVED | REJECTED */
  overall?: { code: string; text: string };
  requests: { statusLabel?: string; scope?: AccessScope | null; id: string; number: string; status: string; note: string | null; submittedAt: string; reason: string; unit: string; requested: RoleName[]; granted: RoleName[]; waiting: string | null }[];
};
export type AccessInboxItem = {
  /** recorded when the review step was passed because the unit has no access manager (owner, 16 Nov 2026) */
  reviewSkipped?: string | null;
  taskId: string;
  requestId: string;
  number: string;
  stage: string;
  final: boolean;
  person: string;
  employeeNo: string;
  unit: string;
  movedTo: string | null;
  reason: string;
  submittedAt: string;
  requested: RoleName[];
  recommended: RoleName[] | null;
  reviewedBy: string | null;
  offered: RoleName[];
  extras: RoleName[];
  recommendReject: boolean;
  reviewNote: string | null;
  personActive: boolean;
  scope: AccessScope | null;
  proposedScope: AccessScope | null;
  scopeNames: string[];
  scopeUnits: { id: string; name: string; depth: number }[];
  scopeSites: { id: string; name: string }[];
};
/** Where a permission reaches; the whole system is never asked for (ADR-045). */
export type AccessScope = { mode: 'UNIT' | 'UNIT_TREE' | 'UNITS' | 'SITES' | 'ALL'; ids: string[] };
export type HubAction = { action: string; allowed: boolean; reason: string | null; openRequest: string | null };
export type HubUnit = { id: string; code: string; name: string; parentId: string | null; depth: number; state: string; site: { id: string; name: string; lat: number | null; lng: number | null; geometry: { type: string; coordinates: unknown } | null } | null; actions: HubAction[] };
export type RequestHub = { actions: HubAction[]; units: HubUnit[]; unitsTotal: number };
/** «موقع جديد» of the setup administrator (ADR-067): the site, its initial stationing and each unit's two areas, in one save. */
/** «صلاحيات تهيئة المواقع» (ADR-089): who may set up sites besides the system administrator. */
export type SiteSetupAccessRule = {
  saved: boolean;
  roles: string[];
  persons: { id: string; name: string }[];
  units: { id: string; name: string; includeDescendants: boolean }[];
  levels: number[];
  reason?: string;
  updatedAt?: string;
  updatedBy?: string;
};
export type SiteDeletionRequest = { id: string; siteId: string; siteCode: string; siteName: string; requester: string; reason: string; requestedAt: string; state: string; decisionReason: string | null };
export type SiteDeletionImpact = {
  site: { id: string; code: string; name: string };
  inside: { id: string; code: string; name: string }[];
  stationed: { unit: string; site: string }[];
  blockers: string[];
  canDelete: boolean;
  canRequest: boolean;
  pending: SiteDeletionRequest | null;
};
export type SiteSetupBody = {
  site: { code: string; name: string; kind: string; parentId?: string | null; responsibleOrgId: string | null; capacity?: number | null; location: { lat: number; lng: number }; notes?: string | null; reason?: string; symbol?: string | null };
  boundary: { geometry: SiteGeometry; crs: string; expectedVersion: number; reason: string; method: string } | null;
  units: { organizationId: string; primary: GeoPolygon | null; alternative: GeoPolygon | null }[];
  reason: string;
  reference?: string | null;
  effectiveFrom?: string | null;
};
/** The same checks as the save, nothing written: each unit's legs in the shape of a request's checks. */
export type SiteSetupCheck = {
  ok: boolean;
  problems: string[];
  policyVersion: number | null;
  deploymentRequirement: 'REQUIRED' | 'OPTIONAL' | null;
  units: { organizationId: string; name: string; ok: boolean; problems: string[]; legs: RestationingLeg[] }[];
};
export type SiteSetupResult = { site: Site; units: { organizationId: string; name: string; stationingId: string; areas: { PRIMARY: string | null; ALTERNATIVE: string | null } }[]; policyVersion: number | null; effectiveFrom: string | null };
export type OverviewItem = { id: string; number: string; type: string; state: string; stateLabel?: string; updatedAt?: string; requestingUnit?: { name: string }; person?: string; mine?: boolean; myTurn?: boolean; currentStage?: string; currentStageKind?: string; fyi?: boolean; fyiPending?: boolean; activatable?: boolean; exceedsPolicy?: boolean };
export type StationingRouteVersion = { id: string; version: number; routing: { startAt: 'SELF' | 'PARENT'; levels: RoutingLevelValue[] }; stages: { unitOperations: boolean; finalByPermission: boolean; fyiBeforeActivation: boolean }; reason: string | null; publishedAt: string | null; publishedBy: string | null };
export type StationingRouteRow = { purpose: string; published: StationingRouteVersion | null; draft: StationingRouteVersion | null };
export type StationingRouteTry = { stages: { key: string; kind: string; label: string; unit: string | null; holders: number; inheritedFrom?: string | null; skipped?: boolean }[]; complete: boolean; problems: string[]; activators?: number; fyiHolders?: number };
export type HomeCard = { key: string; label: string; value: number; href: string };
export type PostureUnit = { id: string; code: string; name: string; parentId: string | null; depth: number; state: string; site?: { id: string; name: string; geometry: { type: string; coordinates: unknown } | null } | null; kind?: string; plannedEnd?: string | null; primary?: unknown; alternative?: unknown; otherUnitsAtSite?: number; request?: { purpose: string; state: string } | null };

/**
 * One proposal visible to the operator on «الموقف العملياتي» (ADR-078 scope, owner 21 Nov 2026 brief §10–§14): a
 * single projection per (request × scope-unit), the server filters by the same `visible(ctx,r)` rule that the request
 * list uses — the right VIEW_OPERATIONAL_POSTURE alone does NOT reveal every proposal.
 */
export type PosturePending = {
  requestId: string;
  requestNumber: string;
  purpose: 'RESTATIONING' | 'DEPLOYMENT_AREAS' | string;
  state: string;
  currentStage: string | null;
  unitId: string;
  unitCode: string | null;
  unitName: string | null;
  currentSiteId: string | null;
  proposedSite: { type: string; coordinates: unknown } | null;
  proposedPrimary: { type: string; coordinates: unknown } | null;
  proposedSub: { type: string; coordinates: unknown } | null;
};
export type SiteOccupants = { stationed: { orgId: string; orgName: string }[]; linked: { id: string; orgId: string; orgName: string; reason: string }[]; otherStationed: number };

/**
 * Site-Hub overview response (ADR-094 Gate 2 §C). Compact aggregates per site; no per-unit records, no geometry.
 * Drill into {@link PostureSiteDetail} on site click, {@link PostureUnitDetail} on unit click,
 * {@link PostureRequestGeometry} on request click.
 */
export type PostureSiteHub = {
  siteId: string;
  siteCode: string;
  siteName: string;
  anchor: { lat: number | null; lng: number | null };
  unitsTotal: number;
  completeCount: number;
  incompleteCount: number;
  temporaryCount: number;
  expiringCount: number;
  pendingCount: number;
};
export type PostureSummary = { complete: number; incomplete: number; noStationing: number; temporary: number; expiring: number; pending: number };
export type PostureOverview = {
  dataRevision: string;
  unitsTotal: number;
  sitesTotal: number;
  summary: PostureSummary;
  siteHubs: PostureSiteHub[];
  noStationingSummary: { count: number };
};
export type PostureSiteDetail = {
  site: { id: string; code: string; name: string; lat: number | null; lng: number | null; geometry: unknown };
  units: Array<{ id: string; code: string | null; name: string | null; state: string; kind?: string | null; plannedEnd?: string | null; request?: { purpose: string; state: string; number: string } | null }>;
  pending: Array<{ requestId: string; requestNumber: string; purpose: string; state: string; currentStage: string | null; scopeUnitCount: number }>;
};
export type PostureUnitDetail = {
  id: string;
  code: string | null;
  name: string | null;
  state: string;
  kind?: string | null;
  plannedEnd?: string | null;
  site?: { id: string; code: string; name: string; lat: number | null; lng: number | null; geometry: unknown } | null;
  primary?: unknown;
  alternative?: unknown;
  request?: { purpose: string; state: string; number: string } | null;
};
export type PostureRequestGeometry = {
  requestId: string;
  requestNumber: string;
  purpose: string;
  state: string;
  scope: string[];
  proposedSite: { type: string; coordinates: unknown } | null;
  proposedPrimary: { type: string; coordinates: unknown } | null;
  proposedSub: { type: string; coordinates: unknown } | null;
};

export type AccessOfferRow = { code: string; name: string; audience: string | null; description?: string | null; scopeModes?: ScopeMode[] | null; defaultScope?: ScopeMode | null };
export type ScopeMode = 'UNIT' | 'UNIT_TREE' | 'UNITS' | 'SITES';
/** A role on the page to ask: its description and the scopes it may be asked with, set in «الصلاحيات المتاحة للطلب». */
export type OfferedRole = { code: string; name: string; description?: string | null; scopeModes?: ScopeMode[] | null; defaultScope?: ScopeMode | null };

export type UnitOpsRoute = { id: string; name: string; from: string; to: string; days: number[]; active: boolean; targets: { id: string; name: string }[] };
/** A request's approval stamps (ADR-055): who approved each stamped stage, in which capacity and unit, when. */
export type RestationingStamp = { name: string; position: string | null; role: string | null; unit: string | null; at: string; onBehalf: boolean };
export type RestationingStamps = {
  number: string;
  state: string;
  requestingUnit: string | null;
  mainUnit: string | null;
  unitOperations: RestationingStamp | null;
  final: RestationingStamp | null;
};
/** «مركز الدعم» (ADR-053). */
export type SupportCategory = 'SIGN_IN' | 'PERMISSIONS' | 'REQUESTS' | 'MAP' | 'STATIONING' | 'DATA' | 'NOTIFICATIONS' | 'PERFORMANCE' | 'OTHER';
export type SupportPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
export type SupportStatus = 'OPEN' | 'IN_PROGRESS' | 'WAITING_USER' | 'RESOLVED' | 'CLOSED';
export type SupportCaseRow = {
  id: string;
  number: string;
  title: string;
  category: SupportCategory;
  priority: SupportPriority;
  status: SupportStatus;
  screen: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  requesterName?: string | null;
  createdAt: string;
  updatedAt: string;
  responseDue: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
};
export type SupportMessage = { id: string; author: string; fromSupport: boolean; internal: boolean; body: string; createdAt: string };
export type SupportCase = SupportCaseRow & {
  requesterId: string;
  requesterNo?: string;
  clientInfo?: Record<string, string> | null;
  messages: SupportMessage[];
  events?: { kind: string; actor: string | null; at: string; detail: Record<string, unknown> | null }[];
  staff: boolean;
};
export type SupportSeat = { id: string; personId: string; displayName: string; employeeNo: string; role: 'AGENT' | 'SUPERVISOR'; grantedAt: string; openCases: number };
/** «المساعد الذكي» (ADR-056): the model's answer from the cited guides, or the guides alone (GUIDE) when it is off or away. */
export type AssistantAnswer = {
  mode: 'MODEL' | 'GUIDE';
  answer: string | null;
  model: string | null;
  degraded: 'OFF' | 'BUSY' | 'UNREACHABLE' | null;
  sources: { resource: string; title: string; screen: string | null; snippet: string }[];
};
/** «دليل تمركز» (ADR-054): a verified knowledge document, cited by its resource. */
export type HelpHit = { resource: string; title: string; type: string; screen: string | null; snippet?: string; score?: number };
export type HelpDoc = HelpHit & { verified: string; origin: string; body: string };
/** One answer of the desktop notification feed (ADR-050). */
export type DesktopFeedItem = { seq: number; kind: string; title: string; body: string; url: string; requireInteraction: boolean; createdAt: string };
export type DesktopFeed = { personId: string; latestSeq: number; items: DesktopFeedItem[] };
/** The HR card shown by «إضافة مستخدم» before saving (ADR-049). */
export type UnitMemberCard = {
  /** null: found live in HR, not yet in TMRKZ; saving imports that one person (ADR-065, importOnSave) */
  personId: string | null;
  importOnSave?: boolean;
  employeeNo: string;
  displayName: string;
  userId: string | null;
  positionTitle: string | null;
  jobTitle: string | null;
  hrStatus: string | null;
  unitName: string | null;
  inUnit: boolean;
  acting: boolean;
};

export type WorkspaceSummary = { units: number; people: number; active: number; pageSize: number; global: boolean };
export type WorkspaceNode = { id: string; name: string; code: string | null; main: boolean; childCount: number; peopleCount: number };
export type WorkspaceHit = { id: string; name?: string; code?: string | null; displayName?: string; employeeNo?: string; active?: boolean; unit?: { id: string; name: string }; path: string };
export type WorkspaceUnit = {
  id: string;
  name: string;
  code: string | null;
  level: number | null;
  main: boolean;
  parent: { id: string; name: string } | null;
  managers: string[];
  people: number;
  active: number;
  children: number;
  path: string;
  /** The unit's ancestors, the top first, without the unit: the tree opens them to show it. */
  trail?: string[];
  inherited: { code: string; name: string; scope: string; since: string; grantedBy: string | null }[];
  unitRoles: { code: string; name: string; on: boolean; lock: string | null }[];
  providers: string[];
  myRights: string[];
};
export type AccessRightDef = { key: string; label: string; byDefault: boolean };
export type Administrator = { personId: string; displayName: string; username: string; employeeNumber: string | null; grantedAt: string; grantedBy: string };
export type DutyPermit = {
  id: string;
  person: { id: string; displayName: string; employeeNo: string };
  organization: { id: string; name: string };
  role: { code: string; name: string };
  validFrom: string;
  validTo: string;
  reason: string;
  issuedBy: string | null;
  issuedAt: string;
  activatedAt: string | null;
  endReason: string | null;
  state: 'ISSUED' | 'ACTIVATED' | 'ACTIVE' | 'ENDED' | 'EXPIRED';
};
export type AccountCard = {
  id: string;
  displayName: string;
  employeeNo: string;
  username: string | null;
  source: 'HR' | 'LOCAL';
  hrStatus: string;
  accessDisabled: boolean;
  accessDisabledReason: string | null;
  hrUnavailable: string | null;
  linked: boolean;
  system: boolean;
  createdAt: string;
  units: { id: string; name: string; how: 'HR' | 'ADDED' | 'ACTING' }[];
  grants: { id: string; role: { code: string; name: string }; system: boolean; organization: string; validTo: string | null; delegated: boolean; rights: string[] | null }[];
  permits: DutyPermit[];
  history: { at: string; action: string; by: string | null; reason: string | null }[];
  systemRoles: { code: string; name: string }[];
  canEdit: boolean;
  canRetire: boolean;
  canEditProfile: boolean;
};
export type ProvidingDepartment = { code: string; name: string; providers: number };
/** {@code seat}: a responsibility of the unit (its holder decides a stage of others' requests), not a personal permission */
export type WorkspaceColumn = { code: string; name: string; mode: 'CHECK' | 'ASSIGN' | 'ADMIN' | 'AVAIL'; finalOnly: boolean; lock: string | null; seat?: boolean };
export type WorkspaceCell = {
  direct: { id: string; scopeText: string; validTo: string; all: boolean; units: number } | null;
  inherited: 'UNIT' | 'SEAT' | null;
  temporary: boolean;
};
export type WorkspacePerson = {
  id: string;
  displayName: string;
  employeeNo: string;
  active: boolean;
  added: boolean;
  acting: boolean;
  withoutHr: boolean;
  lock: string | null;
  hrUnavailable?: string | null;
  accessDisabled?: boolean;
  /** From the person's current HR record (MOVER's «الرتبة العسكرية» and «المنصب»), and the sign-in ID («رقم الـU»). */
  rank?: string | null;
  position?: string | null;
  username?: string | null;
  cells: Record<string, WorkspaceCell>;
  effective: number;
  grants: GrantView[];
};
export type WorkspaceMatrix = { total: number; page: number; pageSize: number; columns: WorkspaceColumn[]; people: WorkspacePerson[]; providers: string[] };
export type StagedOp = { personId: string; roleCode: string; action: 'GRANT' | 'REVOKE' };
export type BatchPreview = {
  fingerprint: string;
  grants: number;
  revokes: number;
  people: number;
  ok: boolean;
  wholeUnit: boolean;
  lines: { personId: string; person: string; roleCode: string; role: string; action: 'GRANT' | 'REVOKE'; problem: string | null }[];
};
export type WorkspaceHistoryRow = {
  id: number;
  at: string;
  action: string;
  by: string | null;
  person: string | null;
  employeeNo: string | null;
  role: string | null;
  reference: string | null;
  reason: string | null;
  grants: string | null;
  revokes: string | null;
};

export type GrantBody = {
  personId: string;
  organizationId: string;
  roleCode: string;
  positionTitle?: string;
  validFrom: string;
  validTo?: string | null;
  scope: GrantScopeInput;
  /** for a role that manages access: its separate rights (ADR-059) */
  rights?: string[];
};

export const api = {
  // session
  authStatus: () => call<AuthStatus>('GET', '/auth/status', { silent401: true }),
  logout: () => post<{ redirect: string }>('/auth/logout'),
  reauth: (returnTo: string) => post<{ redirect: string }>('/auth/reauth', { returnTo }),
  directoryLogin: (username: string, password: string) => call<Me>('POST', '/auth/directory/login', { body: { username, password }, silent401: true }),
  directoryReauth: (password: string) => post<void>('/auth/directory/reauth', { password }),
  me: () => call<Me>('GET', '/me', { silent401: true }),

  // organizations
  orgTree: () => get<OrgNode[]>('/organizations/tree'),
  orgRoots: () => get<OrgBranch[]>('/organizations/roots'),
  orgChildren: (id: string) => get<OrgBranch[]>(`/organizations/${id}/children`),
  orgSearch: (q: string, signal?: AbortSignal) => get<OrgBranch[]>('/organizations/search' + query({ q }), { signal }),
  org: (id: string) => get<OrgDetail>(`/organizations/${id}`),
  people: (q: string) => get<Page<Person>>('/people' + query({ q, size: 50 })),
  identityIssues: () => get<IdentityIssue[]>('/identity-issues'),
  resolveIdentityIssue: (id: string, personId: string | null, reason: string) => post<void>(`/identity-issues/${id}/resolve`, { personId, reason }),
  taskRoutings: () => get<TaskRouting[]>('/task-reassignments'),
  taskRoutingCandidates: (id: string, q: string, page = 0) =>
    get<{ items: TaskCandidate[]; page: number; hasMore: boolean }>(`/task-reassignments/${id}/candidates` + query({ q, page })),
  assignRoutedTask: (id: string, personId: string, reason: string) => post<void>(`/task-reassignments/${id}/assign`, { personId, reason }),
  createMembership: (body: { personId: string; organizationId: string; roleCode: string; positionTitle?: string; siteScopeId?: string | null; validFrom: string; validTo?: string | null }) =>
    post<unknown>('/memberships', body),
  endMembership: (id: string, reason: string, endAt?: string) => post<unknown>(`/memberships/${id}/end`, { reason, endAt }),
  delegations: () => get<Delegation[]>('/delegations'),
  createDelegation: (body: { delegateId: string; membershipId: string; validFrom: string; validTo: string; reason: string }) => post<Delegation>('/delegations', body),
  revokeDelegation: (id: string, reason: string) => post<Delegation>(`/delegations/${id}/revoke`, { reason }),
  roles: () => get<RoleDef[]>('/roles'),
  // admin: employee number
  setEmployeeNo: (personId: string, employeeNo: string) => call<{ id: string; employeeNo: string }>('PUT', `/people/${personId}/employee-no`, { body: { employeeNo } }),
  // admin: unit management
  createUnit: (body: { code: string; name: string; parentId?: string }) => post<{ id: string; code: string; name: string }>('/organizations', body),
  updateUnit: (id: string, body: { name: string; parentId?: string | null }) => call<{ id: string; code: string; name: string }>('PUT', `/organizations/${id}`, { body }),
  retireUnit: (id: string, reason: string) => post<void>(`/organizations/${id}/retire`, { reason }),
  // admin: level management
  levels: () => get<{ level: number; name: string; unitCount: number }[]>('/levels'),
  setLevel: (level: number, name: string) => call<{ level: number; name: string; unitCount: number }>('PUT', `/levels/${level}`, { body: { name } }),
  deleteLevel: (level: number) => del<void>(`/levels/${level}`),
  setUnitLevel: (orgId: string, level: number | null) => call<void>('PUT', `/organizations/${orgId}/level`, { body: { level } }),
  // admin: administrator lifecycle
  listAdministrators: () => get<Administrator[]>('/administrators'),
  addAdministrator: (username: string) => post<Administrator>('/administrators', { username }),
  removeAdministrator: (personId: string) => del<void>(`/administrators/${personId}`),

  // permissions studio (policy versions, scoped grants, explanations, OpenFGA sync)
  authzStatus: () => get<AuthzStatus>('/access/status'),
  authzRebuild: () => post<AuthzStatus>('/access/rebuild'),
  policyVersions: () => get<AccessPolicyVersion[]>('/access/policy/versions'),
  policyVersion: (id: string) => get<AccessPolicyVersion>(`/access/policy/versions/${id}`),
  policyDraft: (note?: string) => post<AccessPolicyVersion>('/access/policy/draft', { note }),
  policySaveRole: (body: { code: string; name: string; permissions: Permission[]; scope: Scope; summaryOnly: boolean; grantableRoles: string[] }) =>
    put<AccessPolicyVersion>('/access/policy/draft/roles', body),
  policyImpact: () => get<PolicyImpact>('/access/policy/draft/impact'),
  policyPublish: (note: string) => post<AccessPolicyVersion>('/access/policy/draft/publish', { note }),
  policyDiscard: (note: string) => post<void>('/access/policy/draft/discard', { note }),
  policyRestore: (id: string, note: string) => post<AccessPolicyVersion>(`/access/policy/versions/${id}/restore`, { note }),
  accessGrants: (organizationId: string, includeEnded = false) =>
    get<GrantView[]>('/access/grants' + query({ organizationId, includeEnded: includeEnded || undefined })),
  createGrant: (body: GrantBody) => post<{ id: string; scopeText: string }>('/memberships', body),
  accessMine: () => get<AccessMine>('/access-requests/mine'),
  submitAccessRequest: (body: { roles: string[]; reason: string; scope?: AccessScope }) => post<{ id: string; number: string }>('/access-requests', body),
  resubmitAccessRequest: (id: string, body: { roles: string[]; reason: string; scope?: AccessScope }) => post<{ id: string; number: string }>(`/access-requests/${id}/resubmit`, body),
  accessInbox: () => get<AccessInboxItem[]>('/access-requests/inbox'),
  accessOffer: () => get<AccessOfferRow[]>('/access-requests/offer'),
  saveAccessOffer: (offer: Record<string, { audience: string; description?: string | null; scopeModes?: ScopeMode[] | null; defaultScope?: ScopeMode | null }>) =>
    put<AccessOfferRow[]>('/access-requests/offer', offer),
  decideAccessRequest: (id: string, body: { taskId: string; decision: string; roles: string[]; note?: string; scope?: AccessScope; recommendReject?: boolean }) =>
    post<{ status: string }>(`/access-requests/${id}/decision`, body),
  scopePreview: (organizationId: string, descendants: boolean, levels?: number[]) =>
    get<{ units: number }>('/access/scope-preview' + query({ organizationId, descendants, levels: levels?.length ? levels.join(',') : undefined })),
  grantRoots: () => get<OrgBranch[]>('/access/grant-roots'),
  unitMatrix: (organizationId: string, q?: string, page?: number) =>
    get<{ total: number; people: { id: string; displayName: string; employeeNo: string; added?: boolean; acting?: boolean; withoutHr?: boolean; grants: GrantView[] }[] }>(
      '/access/unit-matrix' + query({ organizationId, q, page }),
    ),
  /** «إضافة مستخدم» (ADR-049): the HR card of one person, by employee number or User ID, inside the manager's reach. */
  unitMemberLookup: (organizationId: string, key: string) => get<UnitMemberCard>('/access/unit-members/lookup' + query({ organizationId, key })),
  addUnitMember: (body: { organizationId: string; personId?: string | null; employeeNo?: string | null; userId?: string | null; displayName?: string | null }) =>
    post<{ personId: string; created: boolean; already: boolean }>('/access/unit-members', body),
  endUnitMember: (personId: string, organizationId: string, reason: string) => post<void>(`/access/unit-members/${personId}/end`, { organizationId, reason }),
  replaceGrant: (id: string, grant: GrantBody, reason?: string) =>
    post<{ id: string; scopeText: string }>(`/access/grants/${id}/replace`, { grant, reason }),
  unitOpsRoutes: (commandId: string) => get<UnitOpsRoute[]>('/access/unit-ops-routes' + query({ commandId })),
  saveUnitOpsRoutes: (commandId: string, routes: { name: string; from: string; to: string; days: number[]; active: boolean; targets: string[] }[]) =>
    put<UnitOpsRoute[]>('/access/unit-ops-routes' + query({ commandId }), routes),
  fyiMains: () => get<{ id: string; name: string }[]>('/access/fyi-mains'),
  addFyiMain: (id: string) => put<void>(`/access/fyi-mains/${id}`, {}),
  removeFyiMain: (id: string) => del<void>(`/access/fyi-mains/${id}`),
  explainAccess: (q: { personId: string; organizationId?: string; siteId?: string; resourceId?: string }) =>
    get<AccessExplain>('/access/explain' + query(q)),

  // «إدارة الصلاحيات والوحدات», TNQL's access workspace (ADR-058)
  workspaceSummary: () => get<WorkspaceSummary>('/access/workspace/summary'),
  workspaceTree: (parent?: string) => get<WorkspaceNode[]>('/access/workspace/tree' + query({ parent })),
  workspaceSearch: (q: string, kind: 'UNITS' | 'PEOPLE') => get<WorkspaceHit[]>('/access/workspace/search' + query({ q, kind })),
  workspaceUnit: (id: string) => get<WorkspaceUnit>(`/access/workspace/units/${id}`),
  workspaceUnitGrant: (id: string, roleCode: string, on: boolean, reason?: string) =>
    put<WorkspaceUnit>(`/access/workspace/units/${id}/inherited`, { roleCode, on, reason }),
  workspaceMatrix: (id: string, q?: string, page?: number, role?: string) =>
    get<WorkspaceMatrix>(`/access/workspace/units/${id}/matrix` + query({ q, page, role })),
  workspacePreview: (id: string, ops: StagedOp[]) => post<BatchPreview>(`/access/workspace/units/${id}/preview`, { ops }),
  workspaceApply: (id: string, ops: StagedOp[], fingerprint: string, wholeUnit = false) =>
    post<{ reference: string; applied: number; affected: number }>(`/access/workspace/units/${id}/apply`, { ops, fingerprint, wholeUnit }),
  // ADR-059: rights of an access manager, duty permits, the account card, providing departments
  rightsCatalogue: () => get<AccessRightDef[]>('/access/rights-catalogue'),
  unitPermits: (id: string) => get<DutyPermit[]>(`/access/workspace/units/${id}/permits`),
  issuePermit: (body: { personId: string; organizationId: string; roleCode: string; validFrom?: string; validTo: string; reason: string }) =>
    post<DutyPermit>('/access/permits', body),
  endPermit: (id: string, reason?: string) => post<DutyPermit>(`/access/permits/${id}/end`, { reason }),
  myPermits: () => get<DutyPermit[]>('/me/permits'),
  activatePermit: (id: string) => post<DutyPermit>(`/me/permits/${id}/activate`, {}),
  endMyPermit: (id: string) => post<DutyPermit>(`/me/permits/${id}/end`, {}),
  accountCard: (id: string) => get<AccountCard>(`/access/workspace/people/${id}`),
  setAccountActive: (id: string, active: boolean, reason?: string) => put<AccountCard>(`/access/workspace/people/${id}/active`, { active, reason }),
  setAccountProfile: (id: string, displayName: string) => put<AccountCard>(`/access/workspace/people/${id}/profile`, { displayName }),
  retireAccount: (id: string, reason: string) => post<AccountCard>(`/access/workspace/people/${id}/retire`, { reason }),
  departments: () => get<ProvidingDepartment[]>('/access/workspace/departments'),
  addDepartment: (code: string, name: string) => post<ProvidingDepartment[]>('/access/workspace/departments', { code, name }),
  setProvider: (id: string, roleCode: string, on: boolean) => put<string[]>(`/access/workspace/units/${id}/providers`, { roleCode, on }),
  workspaceHistory: (id: string, page?: number) => get<{ total: number; page: number; rows: WorkspaceHistoryRow[] }>(`/access/workspace/units/${id}/history` + query({ page })),

  // facilities & map
  sites: () => get<Site[]>('/sites'),
  site: (id: string) => get<SiteDetail>(`/sites/${id}`),
  unitSymbolCatalog: () =>
    get<{ code: string; sidc: string; name: string; standard: string; edition: string; description?: string; active: boolean }[]>('/unit-symbols/catalog'),
  assignUnitSymbol: (orgId: string, body: { catalogCode?: string; sidc?: string; description?: string; expectedVersion: number; reason: string }) =>
    put<UnitSymbol>(`/organizations/${orgId}/unit-symbol`, body),
  removeUnitSymbol: (orgId: string, body: { expectedVersion: number; reason: string }) => post<void>(`/organizations/${orgId}/unit-symbol/remove`, body),
  unitSymbols: (orgIds: string[]) => get<UnitSymbolLookup>('/unit-symbols' + query({ orgIds: orgIds.join(',') })),
  siteRequestActions: (id: string, signal?: AbortSignal) => get<SiteRequestActions>(`/sites/${id}/request-actions`, { signal }),
  createSite: (body: {
    code: string;
    name: string;
    kind: string;
    parentId?: string | null;
    responsibleOrgId: string | null;
    capacity?: number | null;
    location: { lat: number; lng: number };
    notes?: string | null;
    reason?: string;
    symbol?: string | null;
  }) => post<Site>('/sites', body),
  updateSite: (id: string, body: { code: string; name: string; kind: string; parentId: string | null; responsibleOrgId?: string | null; capacity: number | null; location: { lat: number; lng: number } | null; notes?: string | null; reason: string }) => put<Site>(`/sites/${id}`, body),
  createSiteWithBoundary: (body: { site: { code: string; name: string; kind: string; parentId?: string | null; responsibleOrgId: string | null; capacity?: number | null; location: { lat: number; lng: number }; notes?: string | null; reason?: string; symbol?: string | null }; boundary: { geometry: SiteGeometry; crs: string; expectedVersion: number; reason: string; method: string } }) => post<Site>('/sites/with-boundary', body),
  /** «إرشادات صفحة الدخول» (ADR-083): today's notes before sign-in; the whole board in the settings. */
  signInNotices: () => get<{ saved: boolean; heading?: string; subheading?: string; footer?: string; notes?: { id: string; kind: 'GUIDE' | 'NOTICE'; meta: string; title: string; text: string }[] }>('/auth/notices'),
  signInBoard: () => get<{ saved: boolean; board?: SignInBoard }>('/settings/sign-in-notes'),
  // «صلاحيات تهيئة المواقع» (phase 7; ADR-089)
  siteSetupAccess: () => get<{ admin: boolean; may: boolean }>('/site-setup/access'),
  siteSetupAccessRule: () => get<SiteSetupAccessRule>('/settings/site-setup-access'),
  saveSiteSetupAccessRule: (body: { roles: string[]; persons: string[]; units: { id: string; includeDescendants: boolean }[]; levels: number[]; reason: string }) =>
    put<SiteSetupAccessRule>('/settings/site-setup-access', body),
  saveSignInBoard: (board: SignInBoard) => put<SignInBoard>('/settings/sign-in-notes', board),
  /** Deleting a site (ADR-086): its impact and blockers, the administrator's delete, a request, and the decision on one. */
  siteDeletion: (id: string) => get<SiteDeletionImpact>(`/sites/${id}/deletion`),
  deleteSite: (id: string, reason: string) => post<{ deleted: string[]; unitsStationedNowhere: string[] }>(`/sites/${id}/deletion`, { reason }),
  requestSiteDeletion: (id: string, reason: string) => post<SiteDeletionRequest>(`/sites/${id}/deletion-requests`, { reason }),
  siteDeletionRequests: () => get<SiteDeletionRequest[]>('/site-deletion-requests'),
  decideSiteDeletion: (id: string, decision: 'APPROVE' | 'REFUSE', reason: string) => post<unknown>(`/site-deletion-requests/${id}/decision`, { decision, reason }),
  setSiteSymbol: (id: string, body: { symbol: string | null; reason: string }) => put<{ sidc?: string; standard?: string }>(`/sites/${id}/symbol`, body),
  saveSiteGeometry: (id: string, body: { geometry: SiteGeometry; crs: string; expectedVersion: number; reason: string; method: string }) => post<unknown>(`/sites/${id}/geometry`, body),
  siteOccupants: (id: string) => get<SiteOccupants>(`/sites/${id}/occupants`),
  createSiteLink: (body: { siteId: string; organizationId: string; reason: string }) => post<unknown>('/site-links', body),
  endSiteLink: (id: string, reason: string) => post<unknown>(`/site-links/${id}/end`, { reason }),
  correctStationing: (body: { organizationId: string; siteId: string; reason: string }) => post<unknown>('/stationing/corrections', body),
  /** «موقع جديد» of the setup administrator (ADR-067): one atomic, audited save; the key makes a resend harmless. */
  siteSetup: (body: SiteSetupBody, idempotencyKey?: string) => post<SiteSetupResult>('/site-setup', body, idempotencyKey),
  siteSetupCheck: (body: SiteSetupBody) => post<SiteSetupCheck>('/site-setup/check', body),
  stationingRoutes: () => get<{ routes: StationingRouteRow[]; policyInForce: boolean }>('/stationing/routes'),
  saveStationingRoute: (purpose: string, route: { routing: unknown; stages: unknown }) => put<StationingRouteVersion>(`/stationing/routes/${purpose}/draft`, route),
  publishStationingRoute: (purpose: string, reason: string) => post<StationingRouteVersion>(`/stationing/routes/${purpose}/publish`, { reason }),
  tryStationingRoute: (purpose: string, body: { routing: unknown; stages: unknown; orgId: string }) => post<StationingRouteTry>(`/stationing/routes/${purpose}/simulate`, body),
  requestHub: () => get<RequestHub>('/request-hub'),
  hubUnit: (id: string) => get<HubUnit>(`/request-hub/units/${id}`),
  requestOverview: (filter: string) => get<OverviewItem[]>('/request-hub/overview' + query({ filter })),
  homeCards: () => get<HomeCard[]>('/request-hub/home-cards'),
  // Legacy per-unit shape, kept available only as an escape hatch for tests; PosturePage no longer calls this
  // path (ADR-094 Gate 2.5 — the posture UI is migrated to the Site-Hub summary + lazy detail endpoints below).
  operationalPosture: (signal?: AbortSignal) => get<{ units: PostureUnit[]; unitsTotal: number; pending: PosturePending[]; dataRevision?: string }>('/operational-posture?view=UNITS', { signal }),
  // Site-Hub summary — compact aggregates per site, no per-unit payload. Served with `Cache-Control: private,
  // no-cache, must-revalidate` + a weak ETag; `postureOverviewConditional` sends `If-None-Match` so the server
  // can answer 304 without touching the read model (brief §A).
  postureOverview: (signal?: AbortSignal) => get<PostureOverview>('/operational-posture', { signal }),
  postureOverviewConditional: (ifNoneMatch: string | null, signal?: AbortSignal) =>
    conditionalGet<PostureOverview>('/operational-posture', ifNoneMatch, signal),
  postureSite: (siteId: string, signal?: AbortSignal) => get<PostureSiteDetail>(`/operational-posture/sites/${siteId}`, { signal }),
  postureUnit: (unitId: string, signal?: AbortSignal) => get<PostureUnitDetail>(`/operational-posture/units/${unitId}`, { signal }),
  postureRequest: (requestId: string, signal?: AbortSignal) => get<PostureRequestGeometry>(`/operational-posture/requests/${requestId}`, { signal }),
  fyiOptions: (id: string) => get<RestationingUnit[]>(`/restationing-requests/${id}/fyi-options`),
  endFyi: (id: string, unit: string, reason: string) => post<RestationingRequest>(`/restationing-requests/${id}/fyi/${unit}/end`, { reason }),
  distributeFyi: (id: string, units: string[], note?: string) => post<RestationingRequest>(`/restationing-requests/${id}/fyi`, { units, note }),
  moveSiteMarker: (id: string, body: { location: { lat: number; lng: number }; reason: string }) => post<Site>(`/sites/${id}/location`, body),
  createResource: (body: {
    siteId: string;
    code: string;
    name: string;
    kind: string;
    policy: 'EXCLUSIVE' | 'SHARED';
    parentResourceId: string | null;
    handoverMinutes: number;
    childBlocking: boolean;
    sharedLimit: number | null;
  }) => post<Resource>('/resources', body),
  updateResource: (id: string, body: { name: string; kind: string; handoverMinutes: number; childBlocking: boolean; sharedLimit?: number }) =>
    put<Resource>(`/resources/${id}`, body),
  siteTree: (parentId?: string | null) => get<SiteNode[]>('/sites/tree' + query({ parentId: parentId ?? undefined })),
  siteSearch: (q: string, signal?: AbortSignal) => get<SiteNode[]>('/sites/search' + query({ q }), { signal }),
  mapContext: () => get<MapContext>('/map/context'),
  mapPackages: (all = false) => get<MapPackage[]>('/map/packages' + query({ all: all || undefined })),
  mapFeatures: (q: FeatureQuery, signal?: AbortSignal) =>
    get<MapFeatures>('/map/features' + query({ ...q, to: q.to ?? undefined, open: q.open || undefined }), { signal }),
  uploadMapPackage: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return call<{ code: string; version: string; status: string; packages: MapPackage[]; checks: string[] }>('POST', '/map/packages', { form });
  },
  setPackageStatus: (code: string, version: string, status: 'ACTIVE' | 'DISABLED' | 'REJECTED', reason: string) =>
    post<MapPackage[]>(`/map/packages/${encodeURIComponent(code)}/${encodeURIComponent(version)}/status`, { status, reason }),
  geometryVersions: (siteId: string) => get<BoundaryVersion[]>(`/sites/${siteId}/geometry/versions`),
  geometryVersion: (siteId: string, version: number) => get<BoundaryVersion>(`/sites/${siteId}/geometry/versions/${version}`),
  validateGeometry: (siteId: string, geometry: GeoJsonGeometry, crs: string) =>
    post<GeometryCheck>(`/sites/${siteId}/geometry/validate`, { geometry, crs }),
  saveGeometry: (siteId: string, body: { geometry: GeoJsonGeometry; crs: string; expectedVersion: number; reason: string; method: 'DRAWN' | 'COORDINATES' }) =>
    post<BoundaryVersion>(`/sites/${siteId}/geometry`, body),
  importBoundaries: (file: File, crs?: string, targetSiteId?: string) => {
    const form = new FormData();
    form.append('file', file);
    if (crs) form.append('crs', crs);
    if (targetSiteId) form.append('targetSiteId', targetSiteId);
    return call<ImportJob>('POST', '/map/imports', { form });
  },
  importJob: (id: string) => get<ImportJob>(`/map/imports/${id}`),
  publishImport: (id: string, reason: string) => post<ImportJob>(`/map/imports/${id}/publish`, { reason }),
  cancelImport: (id: string) => post<ImportJob>(`/map/imports/${id}/cancel`),
  requestBoundaries: (id: string, revision?: number) => get<RequestBoundaries>(`/requests/${id}/boundaries` + query({ revision })),
  availabilityGrid: (from: string, days = 7) => get<AvailabilityGrid>('/availability/grid' + query({ from, days })),
  availabilityCheck: (body: { resourceIds: string[]; start: string; end: string | null; excludeReservationId?: string | null }) =>
    post<AvailabilityCheck>('/availability/check', body),

  // requests
  requestTypes: () => get<RequestType[]>('/request-types'),
  createRequestType: (body: { name: string; kind: string }) => post<{ code: string; name: string }>('/request-types', body),
  removeRequestType: (code: string) => del<void>(`/request-types/${code}`),
  requests: (p: { status?: string; q?: string; page?: number; size?: number; excludeDrafts?: boolean; mine?: boolean; type?: string; from?: string; to?: string; sort?: string; dir?: string } = {}, opts?: { silent401?: boolean }) =>
    get<Page<RequestListItem>>('/requests' + query({ size: 100, ...p }), opts),
  requestCounts: (p: { q?: string; mine?: boolean; type?: string; from?: string; to?: string } = {}) => get<Partial<Record<RequestStatus, number>>>('/requests/counts' + query(p)),
  request: (id: string) => get<RequestDetail>(`/requests/${id}`),
  createRequest: (body: DraftInput) => post<RequestDetail>('/requests', body),
  updateDraft: (id: string, body: DraftInput & { expectedVersion: number }) => patch<RequestDetail>(`/requests/${id}/draft`, body),
  submit: (id: string, expectedVersion: number, resubmissionReason: string | undefined, key: string) =>
    post<RequestDetail>(`/requests/${id}/submit`, { expectedVersion, resubmissionReason }, key),
  closeRequest: (id: string, body: { statement: string; reference?: string; note?: string }, key: string) =>
    post<RequestDetail>(`/requests/${id}/close`, body, key),
  communications: (id: string) => get<Communication[]>(`/requests/${id}/communications`),
  communicate: (
    id: string,
    body: { recipientKind: Communication['recipientKind']; recipientOrgId?: string; recipientText?: string; channel: CommunicationChannel; reference?: string; communicatedAt?: string; note?: string },
    key: string,
  ) => post<Communication[]>(`/requests/${id}/communications`, body, key),
  relocation: (id: string) => get<Relocation | null>(`/requests/${id}/relocation`),
  saveRelocation: (
    id: string,
    body: {
      organizationId: string;
      includeDescendants: boolean;
      fromSiteId: string;
      proposedName: string;
      geometry: GeoJsonGeometry;
      action?: PlacementAction;
      stationLevel?: StationLevel;
      temporary?: boolean;
      temporaryEnd?: string | null;
      targetSiteId?: string | null;
      includedOrgIds?: string[];
    },
  ) => put<Relocation>(`/requests/${id}/relocation`, body),
  // stationing proposal on the map (ADR-025): rules, interactive check, organisations covered by a move
  placementRules: () => get<PlacementRule[]>('/placement/rules'),
  savePlacementRule: (id: string | null, body: Omit<PlacementRule, 'id' | 'organization' | 'version' | 'updatedAt'> & { organizationId?: string | null; expectedVersion?: number; reason: string }) =>
    id ? put<PlacementRule>(`/placement/rules/${id}`, body) : post<PlacementRule>('/placement/rules', body),
  placementCheck: (
    body: {
      action: PlacementAction;
      organizationId?: string;
      fromSiteId: string;
      stationLevel?: StationLevel;
      geometry: GeoJsonGeometry;
      targetSiteId?: string | null;
      start?: string;
      end?: string | null;
      excludeRequestId?: string;
      includedOrgIds?: string[];
    },
    signal?: AbortSignal,
  ) => call<PlacementCheck>('POST', '/placement/check', { body, signal }),
  placementUnits: (orgId: string, siteId: string) => get<PlacementUnit[]>('/placement/units' + query({ orgId, siteId })),
  changes: (id: string, revision?: number) => get<RevisionComparison>(`/requests/${id}/changes` + query({ revision })),
  uploadAttachment: (id: string, fieldId: string, file: File) => {
    const form = new FormData();
    form.append('fieldId', fieldId);
    form.append('file', file);
    return call<Attachment>('POST', `/requests/${id}/attachments`, { form });
  },
  changeRequest: (reservationId: string, typeCode: string) => post<RequestDetail>(`/reservations/${reservationId}/change-requests`, { typeCode }),

  // tasks
  tasks: (opts?: { silent401?: boolean }) => get<TaskItem[]>('/tasks', opts),
  approvalDocument: (taskId: string) => get<ApprovalDocument>(`/tasks/${taskId}/approval-document`),
  decide: (taskId: string, body: DecisionInput, key: string) => post<RequestDetail>(`/tasks/${taskId}/decision`, body, key),
  signTask: (taskId: string, expectedRevision: number) => post<SigningJob>(`/tasks/${taskId}/signing`, { expectedRevision }),
  verifyApprovalDocument: (requestId: string) => get<ApprovalVerification>(`/requests/${requestId}/approval-document/verification`),

  // reservations & execution
  reservations: (p: { from?: string; to?: string; resourceId?: string; status?: string } = {}) => get<ReservationItem[]>('/reservations' + query(p)),
  executionTasks: () => get<MyExecutionTask[]>('/execution-tasks'),
  completeExecution: (id: string, note: string, key: string, evidenceAttachmentId?: string) =>
    post<ExecutionTask>(`/execution-tasks/${id}/complete`, { note, evidenceAttachmentId }, key),

  // studios
  forms: () => get<StudioItem[]>('/forms'),
  formVersion: (id: string) => get<FormVersion>(`/form-versions/${id}`),
  saveFormDraft: (formId: string, schema: FormSchema) => post<FormVersion>(`/forms/${formId}/drafts`, { schema }),
  validateForm: (versionId: string) => post<ValidationResult>(`/form-versions/${versionId}/validate`),
  evaluateForm: (schema: FormSchema, values: Record<string, unknown>, facts: Record<string, unknown>) =>
    post<{ valid: boolean; errors: { path: string; message: string }[]; fields: { id: string; label: string; visible: boolean; required: boolean }[] }>(
      '/forms/evaluate',
      { schema, values, facts },
    ),
  publishForm: (versionId: string) => post<FormVersion>(`/form-versions/${versionId}/publish`),
  workflows: () => get<StudioItem[]>('/workflows'),
  workflowVersion: (id: string) => get<WorkflowVersion>(`/workflow-versions/${id}`),
  saveWorkflowDraft: (workflowId: string, definition: WorkflowDefinition) => post<WorkflowVersion>(`/workflows/${workflowId}/drafts`, { definition }),
  simulateWorkflow: (versionId: string, facts?: Record<string, unknown>) => post<SimulationResult>(`/workflow-versions/${versionId}/simulate`, { facts }),
  responsibilities: () => get<Responsibility[]>('/responsibilities'),
  addResponsibility: (name: string) => post<Responsibility[]>('/responsibilities', { name }),
  setResponsibilityRule: (code: string, scope: string, responsibleOrgId: string) => put<Responsibility[]>(`/responsibilities/${code}/rules/${scope}`, { responsibleOrgId }),
  removeResponsibilityRule: (code: string, scope: string) => del<Responsibility[]>(`/responsibilities/${code}/rules/${scope}`),
  publishWorkflow: (versionId: string) => post<WorkflowVersion>(`/workflow-versions/${versionId}/publish`),

  // policies, integrations, system
  policy: () => get<PolicyVersion>('/policies/current'),
  policyHistory: () => get<PolicyVersion[]>('/policies/history'),
  draftPolicy: (settings: Settings) => post<PolicyDraft>('/policies/drafts', { settings }),
  publishPolicy: (id: string) => post<PolicyVersion>(`/policy-versions/${id}/publish`),
  integrations: () => get<Integration[]>('/integrations'),
  previewOrgImport: (rows: { code: string; name: string; parentCode: string | null }[]) => post<OrgImportPreview>('/integrations/org-structure/preview', { rows }),
  commitOrgImport: (runId: string) => post<unknown>(`/integrations/org-structure/runs/${runId}/commit`),
  systemInfo: () => get<SystemInfo>('/system/info'),
  systemManagement: () => get<SystemManagement>('/system/management'),
  getEmbedding: () => get<{ allowedOrigins: string[] }>('/system/embedding'),
  setEmbedding: (origins: string[]) => call<{ allowedOrigins: string[] }>('PUT', '/system/embedding', { body: { allowedOrigins: origins } }),
  /** ADR-094: the installation's state — empty screens show nothing in the middle (no map, no zeros) */
  systemState: () => get<SystemState>('/system/state'),
  /** ADR-094: the person asks HR for their own record now */
  myHrRefresh: () => post<{ refreshed: boolean }>('/me/hr-refresh'),
  /** ADR «صحة الطلبات» (20 Nov 2026): read-only diagnostic of open re-stationing requests for the system administrator. */
  requestHealthSummary: () => get<RequestHealthSummary>('/system/request-health/summary'),
  requestHealthSearch: (p: { q?: string; health?: string; state?: string }) => get<RequestHealthRow[]>('/system/request-health' + query(p)),
  requestHealthDiagnose: (identifier: string) => get<RequestHealthDiagnosis>('/system/request-health/' + encodeURIComponent(identifier)),

  // HR source
  hrStatus: () => get<HrStatus>('/hr/status'),
  hrRuns: (size = 10) => get<HrRun[]>('/hr/runs' + query({ size })),
  hrSync: (overrideReason?: string) => post<{ runId: string }>('/hr/sync', overrideReason ? { overrideReason } : {}),
  // «إعدادات التكامل» (ADR-092): the directory and Keycloak sections, tested with the values on the screen, saved, cleared
  integrationStatus: () => get<IntegrationStatus>('/settings/integration/status'),
  integrationDirectory: () => get<IntegrationView>('/settings/integration/directory'),
  saveIntegrationDirectory: (form: DirectoryForm) => put<IntegrationView>('/settings/integration/directory', form),
  clearIntegrationDirectory: () => del<IntegrationView>('/settings/integration/directory'),
  testIntegrationDirectory: (form: DirectoryForm, testLogin?: string, testPassword?: string) =>
    post<DirectoryTestResult>('/settings/integration/directory/test', { settings: form, testLogin, testPassword }),
  integrationOidc: () => get<IntegrationView>('/settings/integration/oidc'),
  saveIntegrationOidc: (form: OidcForm) => put<IntegrationView>('/settings/integration/oidc', form),
  clearIntegrationOidc: () => del<IntegrationView>('/settings/integration/oidc'),
  testIntegrationOidc: (form: OidcForm) => post<OidcTestResult>('/settings/integration/oidc/test', form),
  integrationAssistant: () => get<AssistantView>('/settings/integration/assistant'),
  saveIntegrationAssistant: (form: AssistantForm) => put<AssistantView>('/settings/integration/assistant', form),
  clearIntegrationAssistant: () => del<AssistantView>('/settings/integration/assistant'),
  testIntegrationAssistant: (form: AssistantForm) => post<AssistantTestResult>('/settings/integration/assistant/test', form),
  hrSource: () => get<HrSource>('/hr/source'),
  saveHrSource: (input: HrSourceInput) => put<HrSource>('/hr/source', input),
  testHrSource: () => post<HrTestResult>('/hr/source/test'),
  /** «معاينة الوحدات»: read-only; nothing is written to the units */
  previewHrUnits: () => post<HrUnitsPreview>('/hr/units/preview'),
  hrContract: () => get<HrCanonical[]>('/hr/contract'),
  hrMappings: () => get<HrMappingVersion[]>('/hr/mappings'),
  saveHrDraft: (fields?: HrField[], activeRules?: Partial<Record<HrEntity, HrRule>>) =>
    post<HrMappingVersion>('/hr/mappings/draft', fields ? { fields, activeRules } : {}),
  discoverHrMapping: (id: string) => post<HrMappingVersion>(`/hr/mappings/${id}/discover`),
  publishHrMapping: (id: string) => post<HrMappingVersion>(`/hr/mappings/${id}/publish`),

  // audit, reports, exports, notifications
  auditEvents: (page: number, size = 50) => get<Page<AuditEvent>>('/audit-events' + query({ page, size })),
  kpis: (from: string, to: string) => get<Kpis>('/reports/kpis' + query({ from, to })),
  createExport: (status: string | undefined, key: string) => post<ExportJob>('/exports', { kind: 'REQUESTS_CSV', filter: status ? { status } : {} }, key),
  notifications: () => get<Notification[]>('/notifications'),
  // «مركز الدعم» and «لوحة الدعم» (ADR-053)
  supportOpen: (body: { title: string; category: SupportCategory; priority: SupportPriority; body: string; screen?: string | null; clientInfo?: Record<string, string> }) =>
    post<{ id: string; number: string }>('/support/cases', body),
  supportMine: () => get<SupportCaseRow[]>('/support/cases'),
  supportCase: (id: string) => get<SupportCase>(`/support/cases/${id}`),
  supportReply: (id: string, body: string) => post<void>(`/support/cases/${id}/messages`, { body }),
  supportConfirm: (id: string, solved: boolean, note?: string) => post<void>(`/support/cases/${id}/confirm`, { solved, note }),
  supportQueue: (filter: string) => get<SupportCaseRow[]>('/support/console/cases' + query({ filter })),
  supportCounts: () => get<Record<string, number>>('/support/console/counts'),
  supportAct: (id: string, body: { action: string; assigneeId?: string; priority?: SupportPriority; body?: string; internal?: boolean }) =>
    post<void>(`/support/console/cases/${id}/act`, body),
  supportSeats: () => get<SupportSeat[]>('/support/seats'),
  supportGrantSeat: (personId: string, role: 'AGENT' | 'SUPERVISOR') => post<{ id: string }>('/support/seats', { personId, role }),
  supportEndSeat: (id: string, reason: string) => post<void>(`/support/seats/${id}/end`, { reason }),
  // «المساعد الذكي» (ADR-056)
  assistantStatus: () => get<{ enabled: boolean; model: string | null; reachable: boolean }>('/assistant/status'),
  assistantAsk: (question: string, screen?: string | null, history?: { question: string; answer: string | null }[]) =>
    post<AssistantAnswer>('/assistant/ask', { question, screen, history: history?.filter((t) => t.answer).map((t) => ({ question: t.question, answer: t.answer })) }),
  // «دليل تمركز» (ADR-054)
  helpSearch: (q: string) => get<HelpHit[]>('/help/search' + query({ q })),
  helpIndex: () => get<HelpHit[]>('/help/index'),
  helpDoc: (resource: string) => get<HelpDoc>('/help/doc' + query({ resource })),
  /** Desktop notifications (ADR-050): unread items after the cursor, with lock-screen-safe text; no cursor = the current number. */
  desktopFeed: (since?: number) => get<DesktopFeed>('/notifications/desktop-feed' + query({ since })),
  markRead: (id: string) => post<void>(`/notifications/${id}/read`),

  // Stationing V3 re-stationing requests (ADR-033)
  restationingRequests: (state?: string) => get<RestationingListItem[]>('/restationing-requests' + query({ state })),
  restationingRequest: (id: string) => get<RestationingRequest>(`/restationing-requests/${id}`),
  restationingUnits: () => get<RestationingUnit[]>('/restationing-requests/units'),
  askRestationingCancellation: (id: string, reason: string) => post<RestationingRequest>(`/restationing-requests/${id}/cancellation`, { reason }),
  askStartCancellation: (id: string, reason: string) => post<RestationingRequest>(`/restationing-requests/${id}/start-cancellation`, { reason }),
  askEarlyReturn: (id: string, reason: string) => post<RestationingRequest>(`/restationing-requests/${id}/early-return`, { reason }),
  decideRestationingAction: (id: string, action: string, decision: 'APPROVE' | 'REJECT', reason: string) =>
    post<RestationingRequest>(`/restationing-requests/${id}/actions/${action}/decision`, { decision, reason: reason || undefined }),
  createRestationingExtension: (id: string, end: string, reason: string) =>
    post<RestationingRequest>(`/restationing-requests/${id}/extensions`, { end, reason }),
  createRestationing: (requestingUnitId: string, content: RestationingContent, purpose?: string) =>
    post<RestationingRequest>('/restationing-requests', { requestingUnitId, content, purpose }),
  editRestationing: (id: string, content: RestationingContent) => put<RestationingRequest>(`/restationing-requests/${id}/content`, content),
  restationingChecks: (id: string) => get<RestationingChecks>(`/restationing-requests/${id}/checks`),
  /** «ختم عمليات الوحدة» and «ختم الاعتماد النهائي» (ADR-055): drawn from the recorded approvals; visual only. */
  restationingStamps: (id: string) => get<RestationingStamps>(`/restationing-requests/${id}/stamps`),
  submitRestationing: (id: string, reason?: string) => post<RestationingRequest>(`/restationing-requests/${id}/submit`, { reason }),
  decideRestationing: (id: string, decision: 'APPROVE' | 'RETURN' | 'REJECT' | 'PARTS', reason?: string, parts?: Record<string, 'APPROVE' | 'CHANGES'>, partNotes?: Record<string, string>) =>
    post<RestationingRequest>(`/restationing-requests/${id}/decision`, { decision, reason, parts, partNotes }),
  activateRestationing: (id: string, reason?: string) => post<RestationingRequest>(`/restationing-requests/${id}/activate`, { reason }),

  // Stationing V3 policy studio (System Administrator)
  stationingPolicy: () => get<StationingPolicyOverview>('/stationing/policy'),
  /** The server's terrain analysis of one polygon under the policy in force (read only; nothing is saved). */
  terrainAssess: (geometry: SiteGeometry, policyVersion?: number | null) =>
    post<TerrainAssessment>('/stationing/terrain/assess', policyVersion == null ? { geometry } : { geometry, policyVersion }),
  stationingPolicyVersions: () => get<{ version: StationingPolicyVersion; changes: PolicyChange[] }[]>('/stationing/policy/versions'),
  validateStationingPolicy: (values: StationingPolicyValues) => post<{ ok: boolean; problems: string[] }>('/stationing/policy/validate', { values }),
  publishStationingPolicy: (values: StationingPolicyValues, effectiveFrom: string | null, reason: string, reference: string) =>
    post<{ version: StationingPolicyVersion; changes: PolicyChange[] }>('/stationing/policy/versions', { values, effectiveFrom, reason, reference }),
  hierarchyLevels: () => get<HierarchyLevel[]>('/stationing/hierarchy-levels'),
  // Stationing register read contract (ADR-031): the server returns only the units this person may read
  stationingCurrent: (orgId?: string, siteId?: string) => get<StationingRecord[]>('/stationing/current' + query({ orgId, siteId })),
  siteLinks: (orgId?: string, siteId?: string) => get<SiteLinkRecord[]>('/site-links' + query({ orgId, siteId })),
  terrainDatasets: () => get<TerrainDatasetView[]>('/terrain/datasets'),

  // «مركز ترحيل قاعدة البيانات» (ADR-094): an older TMRKZ database brought into the current one; CONFIGURE only
  dbMigrations: () => get<DbMigrationListItem[]>('/settings/db-migration'),
  dbMigration: (id: string) => get<DbMigration>(`/settings/db-migration/${id}`),
  dbMigrationBackupStatus: () => get<DbMigrationBackup>('/settings/db-migration/backup-status'),
  dbMigrationInbox: () => get<DbMigrationInbox>('/settings/db-migration/inbox'),
  uploadDbMigrationDump: (file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return call<DbMigrationDumpInfo>('POST', '/settings/db-migration/inbox', { form });
  },
  connectDbMigration: (input: DbMigrationConnectInput) => post<DbMigration>('/settings/db-migration/connect', input),
  selectDbMigrationTables: (id: string, selection: DbMigrationSelectionInput) => put<DbMigration>(`/settings/db-migration/${id}/selection`, selection),
  runDbMigration: (id: string, backupVerified: boolean) => post<DbMigration>(`/settings/db-migration/${id}/migrate`, { backupVerified }),
  abandonDbMigration: (id: string) => del<DbMigration>(`/settings/db-migration/${id}`),
};
