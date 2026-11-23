// FULL END-TO-END ACCEPTANCE (16 Nov 2026) — ACCEPTANCE ONLY. Ends every grant and unit membership that the lead's first
// provisioning (full26-users.mjs, its own numbering) gave the fictional accounts full26.u01…u14, so the permissions can be
// distributed again through «إدارة الصلاحيات والوحدات» in the owner's numbering (spec §20/§21). Nothing is deleted: grants and
// unit entries are ended with a reason, as the screen ends them, by the administrator (session borrowed read-only via CDP).
//   node tests/acceptance/full26-renumber.mjs <repo root>
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [root] = process.argv.slice(2);
const { adminSession } = await import(pathToFileURL(`${root}/tests/acceptance/lib/full26-admin.mjs`).href);
const a = await adminSession(root);
const REASON = 'ACCEPTANCE ONLY — renumbered to the owner\'s specification';
const sql = (q) => execFileSync('docker', ['exec', 'tmrkz-db-1', 'sh', '-c', `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "${q}"`], { encoding: 'utf8' }).trim();
const grants = sql(`select m.id || '|' || p.username || '|' || m.role_code from membership m join person p on p.id = m.person_id where p.username like 'full26.%' and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()) order by 1`).split('\n').filter(Boolean);
for (const line of grants) {
  const [id, who, role] = line.split('|');
  const r = await a.api('POST', `/memberships/${id}/end`, { reason: REASON });
  console.log('grant', who, role, r.status, r.status === 200 || r.status === 204 ? '' : JSON.stringify(r.body).slice(0, 200));
}
const members = sql(`select u.person_id || '|' || u.organization_id || '|' || p.username from unit_member u join person p on p.id = u.person_id where p.username like 'full26.%' and u.ended_at is null order by p.username`).split('\n').filter(Boolean);
for (const line of members) {
  const [person, org, who] = line.split('|');
  const r = await a.api('POST', `/access/unit-members/${person}/end`, { organizationId: org, reason: REASON });
  console.log('member', who, r.status, r.status === 200 || r.status === 204 ? '' : JSON.stringify(r.body).slice(0, 200));
}
console.log('left:', sql(`select count(*) from membership m join person p on p.id = m.person_id where p.username like 'full26.%' and (m.valid_to is null or m.valid_to > now())`),
  'grants,', sql(`select count(*) from unit_member u join person p on p.id = u.person_id where p.username like 'full26.%' and u.ended_at is null`), 'unit entries');
process.exit(0);
