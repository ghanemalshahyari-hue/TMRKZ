// Labels the ui-rebuild draft RS-2026-0002 as fictional development data (its reason was empty). Content otherwise unchanged.
import { signIn } from './api.mjs';
const rq = await signIn('t.requester');
const id = '2683e5c7-fc7d-4db3-9bea-9e77a96bc241';
const v = (await rq.get('/restationing-requests/' + id)).body;
const before = JSON.stringify({ ...v.content, reason: undefined });
const content = { ...v.content, reason: 'مسودة اختبار انحدار (ui-rebuild) — بيانات تطوير وهمية، ليست طلب عمل (DEV-REGRESSION)' };
const r = await rq.put(`/restationing-requests/${id}/content`, content);
const after = (await rq.get('/restationing-requests/' + id)).body;
console.log(r.status, after.number, after.state, after.content.reason, 'other fields unchanged:', JSON.stringify({ ...after.content, reason: undefined }) === before);
