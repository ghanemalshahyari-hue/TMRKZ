// ACCEPTANCE ONLY — LDAP first login, zero access, unit-owned requests and unit-owned seats (owner, 16 Nov 2026; ADR-069).
// Fictional people for the one installation on :8088: each exists in the demo Oracle HR (PRS_ID 980001…980099, a range nothing
// else uses; the demo's own people are 1…200,000 and its added levels 990001+) and in the stand-in directory (uid = the HR domain
// account, as TMRKZ_OIDC_LINK_KEY=DOMAIN_ACCOUNT), and in NOTHING of TMRKZ: they become TMRKZ people only by signing in.
// Their names say «وهمي»; no real name or number is used. Secrets are read from the git-ignored files and fed on stdin, never
// printed or passed as arguments.
//   node ops/acceptance-main/acc69.mjs add                 add the people (Oracle + directory); idempotent
//   node ops/acceptance-main/acc69.mjs move <login> <unit> move one in Oracle (an HR transfer; TMRKZ sees it at its next sync)
//   node ops/acceptance-main/acc69.mjs remove              take them out of Oracle and the directory (TMRKZ keeps its history)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url);
const env = Object.fromEntries(readFileSync(new URL('ops/hr-demo/.generated/oracle_hr.env', ROOT), 'utf8').split('\n')
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const PASSWORD = readFileSync(new URL('ops/acceptance-main/.generated/full26-password', ROOT), 'utf8').trim();
const LDAP_ADMIN = readFileSync(new URL('ops/local/.generated/ldap-admin-password', ROOT), 'utf8').trim();

/**
 * A batch: ACC69_RUN='' (acc69.*, PRS_ID 980001…), 'b' (acc69b.*, 980011…), 'c' … — a re-run needs people TMRKZ has never seen
 * (AUTH-01), so it takes the next batch rather than deleting anyone from TMRKZ.
 */
export const RUN = process.env.ACC69_RUN ?? '';
const OFF = RUN ? (RUN.charCodeAt(0) - 97) * 10 : 0;
const tag = RUN ? ` (${RUN})` : '';
/** login, PRS_ID, name, unit (demo reference structure, ADR-057) — every one fictional. */
export const PEOPLE = [
  ['new1', 1, 'موظف قبول أول — وهمي', 'قسم صحة 1-أ'],
  ['uam', 2, 'مسؤول صلاحيات قبول — وهمي', 'مركز صحة واحد'],
  ['final', 3, 'معتمد طلبات صلاحية قبول — وهمي', 'قيادة إدارة الصحة'],
  ['new2', 4, 'موظف قبول ثانٍ — وهمي', 'قسم صحة 2-أ'],
  ['req1b', 5, 'مقدم طلبات قبول — وهمي', 'قسم صحة 1-ب'],
  ['req1b2', 6, 'مقدم طلبات قبول ثانٍ — وهمي', 'قسم صحة 1-ب'],
  ['opsb', 7, 'معتمد عمليات قبول ب — وهمي', 'عمليات إدارة الصحة'],
].map(([who, n, name, unit]) => [`acc69${RUN}.${who}`, 980000 + OFF + n, name.replace(' — وهمي', tag + ' — وهمي'), unit]);

const q = (s) => "'" + String(s).replaceAll("'", "''") + "'";

/** One SQL*Plus run as the demo's data owner; the connect line travels on stdin. */
function sqlplus(sql) {
  const script = `connect ${env.ORACLE_HR_SCHEMA}/"${env.ORACLE_HR_SCHEMA_PASSWORD}"@//localhost:1521/${env.ORACLE_HR_SERVICE}
whenever sqlerror exit failure rollback
set heading off feedback off pagesize 0 linesize 400 trimspool on
${sql}
commit;
exit
`;
  return execFileSync('docker', ['exec', '-i', '-e', 'NLS_LANG=AMERICAN_AMERICA.AL32UTF8', 'tmrkz-hr-demo-oracle', 'sqlplus', '-s', '/nolog'],
    { input: script, encoding: 'utf8' }).trim();
}

/**
 * One script inside the directory container. stdin: the directory admin password, the accounts' password, then the body. The
 * secrets go to files only the script sees (removed at its end); the accounts' password is stored hashed (slappasswd).
 */
function ldap(script, body = '') {
  return execFileSync('docker', ['exec', '-i', 'tmrkz-openldap-1', 'sh', '-c', `set -u
IFS= read -r ADM; IFS= read -r UPW; cat > /tmp/acc69.in
umask 077; printf %s "$ADM" > /tmp/acc69.p; printf %s "$UPW" > /tmp/acc69.u
L="-x -ZZ -H ldap://localhost -D cn=admin,dc=tmrkz,dc=local -y /tmp/acc69.p"
${script}
rc=$?; rm -f /tmp/acc69.p /tmp/acc69.u /tmp/acc69.in; exit $rc`], { input: `${LDAP_ADMIN}\n${PASSWORD}\n${body}`, encoding: 'utf8' });
}

function add() {
  const rows = PEOPLE.map(([login, id, name, unit]) => `
insert into HR_EMPLOYEES_T (PRS_ID, MIL_NUMBER, NEW_MIL_NO, PERSON_USER_ID, FIRST_NAME, FULL_NAME, FULL_NAME_E, GRD_ID, GRADE_NAME,
  FULL_GRADE_NAME, MAIN_GRADE_TYPE, POSITION_ID, EMP_POSITION_DESC, JOB_ID, JOB_NAME, ORG_UNIT_ID, ORG_UNIT_NAME, ORG_UNIT_FULL_PATH,
  MAIN_ORG_UNT_ID, MAIN_ORG_UNIT_NAME, EMP_STATUS, EMP_STATUS_DESC, EMP_WORK_STATUS_DESC, EMP_UNIT_STATUS_DESC, GENDER, GENDER_DESC,
  BIRTH_DATE, ENLISTMENT_DATE, MOBILE, NATIONALITY_DESC, EMPLOYEE_CLASS_DESC)
select ${id}, '${4000000 + id}', null, ${q(login)}, 'موظف', ${q(name)}, ${q('Acceptance ' + login)}, t.GRD_ID, t.GRADE_NAME,
  t.FULL_GRADE_NAME, t.MAIN_GRADE_TYPE, ${98000000 + id}, 'وظيفة قبول — وهمية', t.JOB_ID, t.JOB_NAME, u.ID, u.NAME, u.NAME,
  u.MAIN_UNIT_ID, m.NAME, 1, 'في الخدمة', 'على رأس العمل', 'ضمن الوحدة', 1, 'ذكر', t.BIRTH_DATE, t.ENLISTMENT_DATE,
  '05${String(id).padStart(8, '0')}', 'الإمارات', 'عسكري'
from (select * from HR_EMPLOYEES_T where PRS_ID = (select min(PRS_ID) from HR_EMPLOYEES_T)) t, HR_UNITS_T u, HR_UNITS_T m
where u.NAME = ${q(unit)} and m.ID = u.MAIN_UNIT_ID and not exists (select 1 from HR_EMPLOYEES_T x where x.PRS_ID = ${id});`).join('\n');
  sqlplus(rows);
  const ldif = PEOPLE.map(([login, , name]) => `dn: uid=${login},ou=people,dc=tmrkz,dc=local
objectClass: inetOrgPerson
uid: ${login}
cn: ${name}
sn: قبول
displayName: ${name}
description: ACCEPTANCE ONLY — fictional account (ADR-069, 16 Nov 2026)
userPassword: __HASH__
`).join('\n');
  // -c: entries already there are reported and skipped
  ldap(`H="$(slappasswd -T /tmp/acc69.u)"; sed -i "s|__HASH__|$H|" /tmp/acc69.in; ldapadd -c $L -f /tmp/acc69.in >/dev/null 2>&1; true`, ldif);
  const present = ldap(`ldapsearch $L -b ou=people,dc=tmrkz,dc=local '(uid=acc69*)' uid | grep -c '^uid:' || true`).trim();
  const n = sqlplus(`select count(*) from HR_EMPLOYEES_T where PRS_ID between 980001 and 980099;`);
  console.log(`[acc69] ${n.trim()} fictional people in the demo Oracle; ${present} directory entries (password: the git-ignored full26-password)`);
}

function move(login, unit) {
  const out = sqlplus(`
update HR_EMPLOYEES_T e set (ORG_UNIT_ID, ORG_UNIT_NAME, ORG_UNIT_FULL_PATH, MAIN_ORG_UNT_ID, MAIN_ORG_UNIT_NAME) =
  (select u.ID, u.NAME, u.NAME, u.MAIN_UNIT_ID, m.NAME from HR_UNITS_T u join HR_UNITS_T m on m.ID = u.MAIN_UNIT_ID where u.NAME = ${q(unit)})
where e.PERSON_USER_ID = ${q(login)} and e.PRS_ID between 980001 and 980099;
select ORG_UNIT_NAME from HR_EMPLOYEES_T where PERSON_USER_ID = ${q(login)};`);
  console.log(`[acc69] ${login} now in «${out.trim()}» in the demo Oracle (TMRKZ follows at its next HR sync)`);
}

function remove() {
  sqlplus(`delete from HR_EMPLOYEES_T where PRS_ID between 980001 and 980099;`);
  const all = [];
  for (const r of ['', ...'bcdefgh']) for (const who of ['new1', 'uam', 'final', 'new2', 'req1b', 'req1b2', 'opsb']) all.push(`acc69${r}.${who}`);
  ldap(`for u in ${all.join(' ')}; do ldapdelete $L "uid=$u,ou=people,dc=tmrkz,dc=local" >/dev/null 2>&1; done; true`);
  console.log('[acc69] fictional people removed from the demo Oracle and the directory');
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'add') add();
else if (cmd === 'move' && a && b) move(a, b);
else if (cmd === 'remove') remove();
else if (cmd) {
  console.error('usage: add | move <login> <unit name> | remove');
  process.exit(2);
}
