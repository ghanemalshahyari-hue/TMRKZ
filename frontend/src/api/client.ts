import type {
  ApiErrorBody,
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
  RequestType,
  ReservationItem,
  RoleDef,
  Settings,
  SimulationResult,
  Site,
  SiteDetail,
  SiteNode,
  StudioItem,
  SystemInfo,
  TaskItem,
  ValidationResult,
  WorkflowDefinition,
  WorkflowVersion,
  Permission,
  Scope,
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
  createMembership: (body: { personId: string; organizationId: string; roleCode: string; positionTitle?: string; siteScopeId?: string | null; validFrom: string; validTo?: string | null }) =>
    post<unknown>('/memberships', body),
  endMembership: (id: string, reason: string, endAt?: string) => post<unknown>(`/memberships/${id}/end`, { reason, endAt }),
  delegations: () => get<Delegation[]>('/delegations'),
  createDelegation: (body: { delegateId: string; membershipId: string; validFrom: string; validTo: string; reason: string }) => post<Delegation>('/delegations', body),
  revokeDelegation: (id: string, reason: string) => post<Delegation>(`/delegations/${id}/revoke`, { reason }),
  roles: () => get<RoleDef[]>('/roles'),
  updateRole: (code: string, body: { permissions: Permission[]; scope: Scope; summaryOnly: boolean }) => put<RoleDef>(`/roles/${code}`, body),

  // facilities & map
  sites: () => get<Site[]>('/sites'),
  site: (id: string) => get<SiteDetail>(`/sites/${id}`),
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
  requests: (p: { status?: string; q?: string; page?: number; size?: number; excludeDrafts?: boolean } = {}) =>
    get<Page<RequestListItem>>('/requests' + query({ size: 100, ...p })),
  request: (id: string) => get<RequestDetail>(`/requests/${id}`),
  createRequest: (body: DraftInput) => post<RequestDetail>('/requests', body),
  updateDraft: (id: string, body: DraftInput & { expectedVersion: number }) => patch<RequestDetail>(`/requests/${id}/draft`, body),
  submit: (id: string, expectedVersion: number, resubmissionReason: string | undefined, key: string) =>
    post<RequestDetail>(`/requests/${id}/submit`, { expectedVersion, resubmissionReason }, key),
  closeRequest: (id: string, note: string | undefined, key: string) => post<RequestDetail>(`/requests/${id}/close`, { note }, key),
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
  publishForm: (versionId: string) => post<FormVersion>(`/form-versions/${versionId}/publish`),
  workflows: () => get<StudioItem[]>('/workflows'),
  workflowVersion: (id: string) => get<WorkflowVersion>(`/workflow-versions/${id}`),
  saveWorkflowDraft: (workflowId: string, definition: WorkflowDefinition) => post<WorkflowVersion>(`/workflows/${workflowId}/drafts`, { definition }),
  simulateWorkflow: (versionId: string, facts?: Record<string, unknown>) => post<SimulationResult>(`/workflow-versions/${versionId}/simulate`, { facts }),
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
  markRead: (id: string) => post<void>(`/notifications/${id}/read`),
};
