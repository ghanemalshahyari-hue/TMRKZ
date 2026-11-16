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
  TaskItem,
  ValidationResult,
  WorkflowDefinition,
  WorkflowVersion,
  Permission,
  Scope,
  RoutingLevelValue,
} from './types';

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
export type AccessMine = {
  unit: string | null;
  available: boolean;
  requestable: RoleName[];
  scopeUnits?: { id: string; name: string; depth: number }[];
  scopeSites?: { id: string; name: string }[];
  held: string[];
  requests: { statusLabel?: string; scope?: AccessScope | null; id: string; number: string; status: string; note: string | null; submittedAt: string; reason: string; unit: string; requested: RoleName[]; granted: RoleName[]; waiting: string | null }[];
};
export type AccessInboxItem = {
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
export type HubSite = { id: string; code: string; name: string; lat: number | null; lng: number | null; geometry: { type: string; coordinates: unknown } | null; linked: boolean };
export type OverviewItem = { id: string; number: string; type: string; state: string; stateLabel?: string; updatedAt?: string; requestingUnit?: { name: string }; person?: string; mine?: boolean; myTurn?: boolean; currentStage?: string; currentStageKind?: string; fyi?: boolean; fyiPending?: boolean; activatable?: boolean };
export type StationingRouteVersion = { id: string; version: number; routing: { startAt: 'SELF' | 'PARENT'; levels: RoutingLevelValue[] }; stages: { unitOperations: boolean; finalByPermission: boolean; fyiBeforeActivation: boolean }; reason: string | null; publishedAt: string | null; publishedBy: string | null };
export type StationingRouteRow = { purpose: string; published: StationingRouteVersion | null; draft: StationingRouteVersion | null };
export type StationingRouteTry = { stages: { key: string; kind: string; label: string; unit: string | null; holders: number }[]; complete: boolean; problems: string[]; activators?: number; fyiHolders?: number };
export type HomeCard = { key: string; label: string; value: number; href: string };
export type PostureUnit = { id: string; code: string; name: string; parentId: string | null; depth: number; state: string; site?: { id: string; name: string; geometry: { type: string; coordinates: unknown } | null } | null; kind?: string; plannedEnd?: string | null; primary?: unknown; alternative?: unknown; otherUnitsAtSite?: number; request?: { purpose: string; state: string } | null };
export type SiteOccupants = { stationed: { orgId: string; orgName: string }[]; linked: { id: string; orgId: string; orgName: string; reason: string }[]; otherStationed: number };
export type AccessOfferRow = { code: string; name: string; audience: string | null };

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
  personId: string;
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
export type WorkspaceColumn = { code: string; name: string; mode: 'CHECK' | 'ASSIGN' | 'ADMIN' | 'AVAIL'; finalOnly: boolean; lock: string | null };
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
  saveAccessOffer: (audiences: Record<string, string>) => put<AccessOfferRow[]>('/access-requests/offer', audiences),
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
  addUnitMember: (body: { organizationId: string; personId?: string | null; userId?: string | null; displayName?: string | null }) =>
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
  setSiteSymbol: (id: string, body: { symbol: string | null; reason: string }) => put<{ sidc?: string; standard?: string }>(`/sites/${id}/symbol`, body),
  saveSiteGeometry: (id: string, body: { geometry: SiteGeometry; crs: string; expectedVersion: number; reason: string; method: string }) => post<unknown>(`/sites/${id}/geometry`, body),
  siteOccupants: (id: string) => get<SiteOccupants>(`/sites/${id}/occupants`),
  createSiteLink: (body: { siteId: string; organizationId: string; reason: string }) => post<unknown>('/site-links', body),
  endSiteLink: (id: string, reason: string) => post<unknown>(`/site-links/${id}/end`, { reason }),
  correctStationing: (body: { organizationId: string; siteId: string; reason: string }) => post<unknown>('/stationing/corrections', body),
  stationingRoutes: () => get<{ routes: StationingRouteRow[]; policyInForce: boolean }>('/stationing/routes'),
  saveStationingRoute: (purpose: string, route: { routing: unknown; stages: unknown }) => put<StationingRouteVersion>(`/stationing/routes/${purpose}/draft`, route),
  publishStationingRoute: (purpose: string, reason: string) => post<StationingRouteVersion>(`/stationing/routes/${purpose}/publish`, { reason }),
  tryStationingRoute: (purpose: string, body: { routing: unknown; stages: unknown; orgId: string }) => post<StationingRouteTry>(`/stationing/routes/${purpose}/simulate`, body),
  requestHub: () => get<RequestHub>('/request-hub'),
  hubUnit: (id: string) => get<HubUnit>(`/request-hub/units/${id}`),
  hubSites: (unit: string) => get<HubSite[]>(`/request-hub/units/${unit}/sites`),
  requestOverview: (filter: string) => get<OverviewItem[]>('/request-hub/overview' + query({ filter })),
  homeCards: () => get<HomeCard[]>('/request-hub/home-cards'),
  operationalPosture: () => get<{ units: PostureUnit[]; unitsTotal: number }>('/operational-posture'),
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
  requests: (p: { status?: string; q?: string; page?: number; size?: number; excludeDrafts?: boolean; mine?: boolean; type?: string; from?: string; to?: string; sort?: string; dir?: string } = {}) =>
    get<Page<RequestListItem>>('/requests' + query({ size: 100, ...p })),
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
  tasks: () => get<TaskItem[]>('/tasks'),
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

  // HR source
  hrStatus: () => get<HrStatus>('/hr/status'),
  hrRuns: (size = 10) => get<HrRun[]>('/hr/runs' + query({ size })),
  hrSync: (overrideReason?: string) => post<{ runId: string }>('/hr/sync', overrideReason ? { overrideReason } : {}),
  hrSource: () => get<HrSource>('/hr/source'),
  saveHrSource: (input: HrSourceInput) => put<HrSource>('/hr/source', input),
  testHrSource: () => post<HrTestResult>('/hr/source/test'),
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
  assistantAsk: (question: string, screen?: string | null) => post<AssistantAnswer>('/assistant/ask', { question, screen }),
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
  decideRestationing: (id: string, decision: 'APPROVE' | 'RETURN' | 'REJECT', reason?: string) =>
    post<RestationingRequest>(`/restationing-requests/${id}/decision`, { decision, reason }),
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
};
