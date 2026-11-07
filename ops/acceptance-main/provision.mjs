// Loads the temporary acceptance data into the one application on :8088 (owner decision of 7 Nov 2026). Records what it creates in
// a git-ignored manifest; ops/acceptance-main/cleanup.mjs removes exactly that. Refuses to load over a run still loaded, and stops
// unless ops/verify-backup.sh passes on the backup named as the first argument.
//   sh ops/acceptance-main/provision.sh backups/<dir>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CURRENT, DB, GEN, LDAP, ROOT, USERS, dockerRun, fingerprintAll, ldapAdmin, loaded, manifestFile, password, psql, tupleCounts, waitAuthzDrained, writeJson } from './lib.mjs';

const backup = process.argv[2];
if (!backup) throw new Error('name the backup taken just before this run');
if (loaded()) throw new Error('acceptance data is already loaded: run ' + loaded().id + '. Clean it first.');
// the proof runs here, every time: a file left by an earlier attempt proves nothing
console.log('[acceptance] verifying the backup', backup);
execFileSync('sh', ['ops/verify-backup.sh', backup], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
console.log('[acceptance] backup verified');

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const id = stamp;
const ns = 'acc' + stamp;
const prefix = 'ACC-20261107-' + stamp.slice(-6) + '-';

console.log('[acceptance] run', id, '— baseline of every table');
waitAuthzDrained();
const before = fingerprintAll();
const tuples = tupleCounts();
const auditFrom = Number(psql('select coalesce(max(id), 0) from audit_event'));
const saved = {
  hrSource: JSON.parse(psql(`select json_agg(json_build_object('id', id, 'enabled', enabled, 'updated_at', updated_at)) from hr_source`)),
  accessDraft: JSON.parse(psql(`select coalesce(json_agg(row_to_json(v)), '[]') from workflow_version v join workflow_definition w on w.id = v.workflow_id join request_type t on t.code = w.request_type_code where t.kind = 'ACCESS'`)),
  offers: JSON.parse(psql(`select coalesce(json_agg(row_to_json(o)), '[]') from access_request_offer o`)),
};
const manifest = { id, ns, prefix, backup, loadedAt: new Date().toISOString(), auditFrom, saved, before, tuples, marker: 'ACCEPTANCE / FICTIONAL' };
writeJson(manifestFile(id), manifest);
writeJson(CURRENT, { id, ns, prefix });

console.log('[acceptance] pausing the HR sync: it would retire these fictional units within the hour');
psql(`update hr_source set enabled = false where enabled`);

const employee = (u) => 'P' + u.slice(1, 3);
const ldif = USERS.map((u) => `dn: uid=${u},ou=people,dc=tmrkz,dc=local
objectClass: inetOrgPerson
uid: ${u}
cn: ${u} اختبار قبول وهمي
sn: ACCEPTANCE
employeeNumber: ${prefix}${employee(u)}
userPassword: ${password()}
`).join('\n');
dockerRun(['exec', '-i', LDAP, 'ldapadd', '-c', '-x', '-H', 'ldap://localhost', '-D', 'cn=admin,dc=tmrkz,dc=local', '-w', ldapAdmin()], ldif);

console.log('[acceptance] organisations, people, sites and test holders');
const seed = readFileSync(new URL('./seed.sql', import.meta.url), 'utf8').replaceAll('__NS__', ns).replaceAll('__PFX__', prefix);
psql(seed);
waitAuthzDrained();

manifest.roots = {
  organization: psql(`select id from organization where code like '${prefix}%'`).split('\n'),
  person: psql(`select id from person where employee_no like '${prefix}%'`).split('\n'),
  site: psql(`select id from site where code like '${prefix}%'`).split('\n'),
  hrUnits: psql(`select external_id from hr_unit where external_id like '${prefix}%'`).split('\n'),
  hrPeople: psql(`select external_id from hr_person where external_id like '${prefix}%'`).split('\n'),
  snapshot: psql(`select id from hr_snapshot where status = 'PUBLISHED'`),
  offersAdded: ['POSTURE_VIEWER', 'STATIONING_UNIT_APPROVER', 'SITE_LINK_MANAGER'],
  ldap: USERS.map((u) => `uid=${u},ou=people,dc=tmrkz,dc=local`),
  usernames: USERS,
};
psql(`insert into audit_event(action, entity_type, entity_id, entity_label, detail, reason) values ('ACCEPTANCE_RUN_LOADED', 'ACCEPTANCE_RUN', '${id}', 'ACCEPTANCE / FICTIONAL', '${JSON.stringify({ marker: 'ACCEPTANCE / FICTIONAL', run: id, prefix, firstAuditId: auditFrom + 1, people: manifest.roots.person })}'::jsonb, 'بيانات اختبار قبول وهمية داخل التطبيق')`);
writeJson(manifestFile(id), manifest);
if (manifest.roots.person.length !== USERS.length) throw new Error('expected ' + USERS.length + ' people, got ' + manifest.roots.person.length);
console.log(`[acceptance] loaded: ${manifest.roots.organization.length} units, ${manifest.roots.person.length} people, ${manifest.roots.site.length} sites`);
console.log(`ACC_NS=${ns} ACC_PREFIX=${prefix}`);
