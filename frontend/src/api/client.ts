import type {
  ApiErrorBody,
  ApprovalDocument,
  Attachment,
  AuditEvent,
  AvailabilityCheck,
  AvailabilityGrid,
  Delegation,
  DecisionInput,
  DemoUsers,
  DraftInput,
  ExecutionTask,
  ExportJob,
  FormSchema,
  FormVersion,
  Integration,
  Kpis,
  MapFeatures,
  MapPackage,
  Me,
  MyExecutionTask,
  Notification,
  OrgDetail,
  OrgImportPreview,
  OrgNode,
  Page,
  Person,
  PolicyDraft,
  PolicyVersion,
  RequestDetail,
  RequestListItem,
  RequestType,
  ReservationItem,
  RoleDef,
  Settings,
  SimulationResult,
  Site,
  SiteDetail,
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

type RequestOptions = { body?: unknown; idempotencyKey?: string; form?: FormData; silent401?: boolean };

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
    res = await fetch(API_BASE + path, { method, headers, body, credentials: 'same-origin' });
  } catch {
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
};

export const api = {
  // session
  login: (username: string, password: string) => call<Me>('POST', '/auth/login', { body: { username, password }, silent401: true }),
  logout: () => post<void>('/auth/logout'),
  demoUsers: () => call<DemoUsers>('GET', '/auth/demo-users', { silent401: true }),
  demoSwitch: (username: string) => post<Me>('/auth/demo-switch', { username }),
  me: () => call<Me>('GET', '/me', { silent401: true }),

  // organizations
  orgTree: () => get<OrgNode[]>('/organizations/tree'),
  org: (id: string) => get<OrgDetail>(`/organizations/${id}`),
  people: (q: string) => get<Page<Person>>('/people' + query({ q, size: 50 })),
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
  mapPackages: () => get<MapPackage[]>('/map/packages'),
  mapFeatures: (time: string, bbox?: string) => get<MapFeatures>('/map/features' + query({ time, bbox })),
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

  // audit, reports, exports, notifications
  auditEvents: (page: number, size = 50) => get<Page<AuditEvent>>('/audit-events' + query({ page, size })),
  kpis: (from: string, to: string) => get<Kpis>('/reports/kpis' + query({ from, to })),
  createExport: (status: string | undefined, key: string) => post<ExportJob>('/exports', { kind: 'REQUESTS_CSV', filter: status ? { status } : {} }, key),
  notifications: () => get<Notification[]>('/notifications'),
  markRead: (id: string) => post<void>(`/notifications/${id}/read`),
};
