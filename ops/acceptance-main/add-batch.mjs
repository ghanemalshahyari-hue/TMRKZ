// A further batch of acceptance data beside the one already loaded, with its own accounts, units and sites on free ground: the journeys
// consume what they use, so a rerun needs fresh data, and the first batch stays as it is for the owner's hands-on review. Every row is
// added to the run's manifest, so one removal covers all batches.
//   node ops/acceptance-main/add-batch.mjs b2 0.25      (a label of letters and digits, and degrees north of the first batch)
import { readFileSync } from 'node:fs';
import { CURRENT, LDAP, USERS, directoryEntries, dockerRun, ldapAdmin, loaded, manifestFile, psql, readJson, seedText, waitAuthzDrained, writeJson } from './lib.mjs';

const [label, dyText] = process.argv.slice(2);
if (!/^[a-z0-9]+$/.test(label ?? '') || !Number(dyText)) throw new Error('usage: add-batch.mjs <label> <degrees north>');
const run = loaded();
if (!run) throw new Error('no acceptance run is loaded');
const m = readJson(manifestFile(run.id));
if (m.batches?.[label]) throw new Error('batch ' + label + ' exists');
const ns = m.ns + label;
const prefix = `${m.prefix}${label.toUpperCase()}-`;
const up = `${label}.`;
const sfx = ` — اختبار قبول ${label.toUpperCase()} — وهمي`;
const dy = Number(dyText);
const auditFrom = Number(psql('select coalesce(max(id), 0) from audit_event'));
dockerRun(['exec', '-i', LDAP, 'ldapadd', '-c', '-x', '-H', 'ldap://localhost', '-D', 'cn=admin,dc=tmrkz,dc=local', '-w', ldapAdmin()], directoryEntries(prefix, up));
psql(seedText({ ns, prefix, up, sfx, dy }));
psql(seedText({ ns, prefix, up, sfx, dy, file: './areas.sql' }));
waitAuthzDrained();
const q = (sql) => psql(sql).split('\n').filter(Boolean);
const added = {
  organization: q(`select id from organization where code like '${prefix}%'`),
  person: q(`select id from person where employee_no like '${prefix}%'`),
  site: q(`select id from site where code like '${prefix}%'`),
  hrUnits: q(`select external_id from hr_unit where external_id like '${prefix}%'`),
  hrPeople: q(`select external_id from hr_person where external_id like '${prefix}%'`),
  ldap: USERS.map((u) => `uid=${up}${u},ou=people,dc=tmrkz,dc=local`),
  usernames: USERS.map((u) => up + u),
};
if (added.person.length !== USERS.length) throw new Error('expected ' + USERS.length + ' people, got ' + added.person.length);
for (const k of Object.keys(added)) m.roots[k] = [...m.roots[k], ...added[k]];
(m.batches ??= {})[label] = { ns, prefix, up, sfx, dy, addedAt: new Date().toISOString(), counts: Object.fromEntries(Object.entries(added).map(([k, v]) => [k, v.length])) };
psql(`insert into audit_event(action, entity_type, entity_id, entity_label, detail, reason) values ('ACCEPTANCE_BATCH_LOADED', 'ACCEPTANCE_RUN', '${run.id}', 'ACCEPTANCE / FICTIONAL', '${JSON.stringify({ marker: 'ACCEPTANCE / FICTIONAL', run: run.id, batch: label, prefix, firstAuditId: auditFrom + 1, people: added.person })}'::jsonb, 'دفعة بيانات اختبار قبول وهمية داخل التطبيق')`);
writeJson(manifestFile(run.id), m);
console.log(`[acceptance] batch ${label}: ${added.organization.length} units, ${added.person.length} people, ${added.site.length} sites; accounts ${up}p01.new …`);
