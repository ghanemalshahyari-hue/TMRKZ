// Removes the acceptance data of the run loaded on :8088, by exact ids only, and proves real rows are as they were.
//   node ops/acceptance-main/cleanup.mjs [--dry-run]
// How it finds what to remove: the manifest's fictional units, people and sites, then every row that references them through a
// foreign key, followed to the end, written to the manifest before anything is deleted. It refuses if that reaches a table that only
// real configuration may hold. The guards that forbid deleting ordinary rows are lifted for this one transaction; the audit log
// keeps its guard: audit rows are never deleted, and stay as evidence, marked by the run's two audit entries and by the people's names.
import { CURRENT, LDAP, NOT_COMPARED, dockerRun, fingerprintAll, keycloak, ldapAdmin, loaded, manifestFile, psql, readJson, tupleCounts, waitAuthzDrained, writeJson } from './lib.mjs';
import { rmSync } from 'node:fs';

const dry = process.argv.includes('--dry-run');
const run = loaded();
if (!run) throw new Error('no acceptance run is loaded');
const m = readJson(manifestFile(run.id));
const FORBIDDEN = ['audit_event', 'role_def', 'access_policy_version', 'hr_source', 'hr_snapshot', 'hr_sync_run', 'hr_mapping_version', 'request_type', 'workflow_definition', 'form_definition', 'map_package', 'terrain_dataset'];
const lit = (v) => `'${String(v).replaceAll("'", "''")}'`;
const list = (a) => (a ?? []).filter(Boolean).map(lit).join(',') || 'null';
const keepVersions = m.saved.accessDraft.map((v) => v.id);

const closureSql = `
create temp table c(tbl text not null, pk jsonb not null, primary key (tbl, pk));
insert into c select 'organization', jsonb_build_object('id', id) from organization where id::text in (${list(m.roots.organization)});
insert into c select 'person', jsonb_build_object('id', id) from person where id::text in (${list(m.roots.person)});
insert into c select 'site', jsonb_build_object('id', id) from site where id::text in (${list(m.roots.site)});
do $f$
declare fk record; n bigint; before bigint; pkx text; pkp text;
begin
  loop
    select count(*) into before from c;
    for fk in
      select k.conrelid::regclass::text as child, k.confrelid::regclass::text as parent,
             (select array_agg(a.attname order by o.ord) from unnest(k.conkey) with ordinality o(att, ord) join pg_attribute a on a.attrelid = k.conrelid and a.attnum = o.att) as fcols,
             (select array_agg(a.attname order by o.ord) from unnest(k.confkey) with ordinality o(att, ord) join pg_attribute a on a.attrelid = k.confrelid and a.attnum = o.att) as pcols
        from pg_constraint k join pg_class t on t.oid = k.conrelid join pg_namespace s on s.oid = t.relnamespace
       where k.contype = 'f' and s.nspname = 'public' and t.relname not like 'act\\_%' and k.confrelid::regclass::text in (select distinct tbl from c)
    loop
      select string_agg(format('%L, x.%I', a.attname, a.attname), ', ') into pkx from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey) where i.indrelid = fk.child::regclass and i.indisprimary;
      select string_agg(format('%L, y.%I', a.attname, a.attname), ', ') into pkp from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey) where i.indrelid = fk.parent::regclass and i.indisprimary;
      execute format('insert into c select %L, jsonb_build_object(%s) from %s x join %s y on (%s) where jsonb_build_object(%s) in (select pk from c where tbl = %L) on conflict do nothing',
        fk.child, pkx, fk.child, fk.parent,
        (select string_agg(format('x.%I = y.%I', f, p), ' and ') from unnest(fk.fcols, fk.pcols) u(f, p)), pkp, fk.parent);
    end loop;
    select count(*) into n from c;
    exit when n = before;
  end loop;
end $f$;
-- the access path's existing draft is restored, not removed
delete from c where tbl = 'workflow_version' and pk->>'id' in (${list(keepVersions)});
`;
const rows = psql(closureSql + `select tbl || E'\\t' || pk::text from c order by 1;`).split('\n').filter(Boolean).map((l) => {
  const [tbl, pk] = l.split('\t');
  return { tbl, pk: JSON.parse(pk) };
});
const byTable = {};
for (const r of rows) (byTable[r.tbl] ??= []).push(r.pk);
const summary = Object.fromEntries(Object.entries(byTable).map(([k, v]) => [k, v.length]));
console.log('[cleanup] rows to remove by exact id:', JSON.stringify(summary));
const bad = FORBIDDEN.filter((t) => byTable[t]?.length);
if (bad.length) throw new Error('refused: the removal reaches real configuration tables: ' + bad.join(', '));
const notOurs = [['organization', m.roots.organization], ['person', m.roots.person]].flatMap(([t, ids]) => (byTable[t] ?? []).filter((r) => !ids.includes(r.id)).map((r) => `${t} ${r.id}`));
if (notOurs.length) throw new Error('refused: a row outside the manifest would be removed: ' + notOurs.join(', '));

m.removal = { computedAt: new Date().toISOString(), rows: byTable };
const procs = (byTable.request?.length ? psql(`select coalesce(string_agg(process_instance_id, ','), '') from request where id::text in (${list(byTable.request.map((r) => r.id))})`) : '').split(',').filter(Boolean);
const deployments = [...new Set([...m.saved.accessDraft.map((v) => v.deployment_id), ...psql(`select coalesce(string_agg(v.deployment_id, ','), '') from workflow_version v where v.id::text in (${list([...keepVersions, ...(byTable.workflow_version ?? []).map((r) => r.id)])})`).split(',')].filter(Boolean))].filter((d) => !m.saved.accessDraft.some((v) => v.deployment_id === d));
m.removal.flowable = { processes: procs, deployments };
writeJson(manifestFile(run.id), m);
if (dry) {
  console.log('[cleanup] dry run: nothing removed');
  process.exit(0);
}

const restoreDraft = m.saved.accessDraft.map((v) => `update workflow_version set status = ${lit(v.status)}, definition = ${lit(JSON.stringify(v.definition))}::jsonb, bpmn_xml = ${v.bpmn_xml ? lit(v.bpmn_xml) : 'null'}, deployment_id = ${v.deployment_id ? lit(v.deployment_id) : 'null'}, process_definition_id = ${v.process_definition_id ? lit(v.process_definition_id) : 'null'}, created_by = ${v.created_by ? lit(v.created_by) : 'null'}, created_at = ${lit(v.created_at)}, published_by = ${v.published_by ? lit(v.published_by) : 'null'}, published_at = ${v.published_at ? lit(v.published_at) : 'null'} where id = ${lit(v.id)};`).join('\n');
const flowable = `
create temp table act_p(id text); insert into act_p select unnest(array[${list(procs)}]::text[]);
create temp table act_d(id text); insert into act_d select unnest(array[${list(deployments)}]::text[]);
create temp table act_b(id text);
insert into act_b select bytearray_id_ from act_ru_variable where proc_inst_id_ in (select id from act_p) and bytearray_id_ is not null;
insert into act_b select bytearray_id_ from act_hi_varinst where proc_inst_id_ in (select id from act_p) and bytearray_id_ is not null;
do $a$
declare r record; left_ int; moved boolean;
begin
  create temp table act_t as
    select c.table_name, c.column_name, 'p' as kind from information_schema.columns c join pg_tables pt on pt.schemaname = 'public' and pt.tablename = c.table_name where c.table_schema = 'public' and c.table_name like 'act\\_%' and c.column_name in ('proc_inst_id_', 'process_instance_id_')
    union all select c.table_name, c.column_name, 'd' from information_schema.columns c join pg_tables pt on pt.schemaname = 'public' and pt.tablename = c.table_name where c.table_schema = 'public' and c.table_name like 'act\\_%' and c.column_name = 'deployment_id_'
    union all select 'act_re_deployment', 'id_', 'd' union all select 'act_ge_bytearray', 'id_', 'b';
  loop
    moved := false;
    for r in select * from act_t loop
      begin
        execute format('delete from %I where %I in (select id from %s)', r.table_name, r.column_name, case r.kind when 'p' then 'act_p' when 'd' then 'act_d' else 'act_b' end);
        delete from act_t where table_name = r.table_name and column_name = r.column_name;
        moved := true;
      exception when foreign_key_violation then null;
      end;
    end loop;
    select count(*) into left_ from act_t;
    exit when left_ = 0;
    if not moved then raise exception 'Flowable rows could not be removed: %', (select string_agg(table_name, ',') from act_t); end if;
  end loop;
end $a$;
`;
const removal = closureSql + `
begin;
${restoreDraftGuard()}
${flowable}
do $d$
declare t record; g record; progress boolean; expr text; left_ int;
begin
  for g in select tg.tgrelid::regclass::text as tbl, tg.tgname from pg_trigger tg
            where not tg.tgisinternal and tg.tgname ~ '(no_delete|append_only|immutable|frozen|no_update|hr_read_only)$'
              and tg.tgrelid::regclass::text in (select distinct tbl from c union select 'workflow_version') and tg.tgrelid <> 'audit_event'::regclass loop
    execute format('alter table %s disable trigger %I', g.tbl, g.tgname);
  end loop;
  loop
    progress := false;
    for t in select distinct tbl from c loop
      select string_agg(format('%L, x.%I', a.attname, a.attname), ', ') into expr from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey) where i.indrelid = t.tbl::regclass and i.indisprimary;
      begin
        execute format('delete from %s x where jsonb_build_object(%s) in (select pk from c where tbl = %L)', t.tbl, expr, t.tbl);
        delete from c where tbl = t.tbl;
        progress := true;
      exception when foreign_key_violation then null;
      end;
    end loop;
    select count(*) into left_ from c;
    exit when left_ = 0;
    if not progress then raise exception 'rows could not be removed: %', (select string_agg(distinct tbl, ',') from c); end if;
  end loop;
end $d$;
${restoreDraft}
do $d$
declare g record;
begin
  for g in select tg.tgrelid::regclass::text as tbl, tg.tgname from pg_trigger tg where not tg.tgisinternal and tg.tgenabled = 'D' and tg.tgname ~ '(no_delete|append_only|immutable|frozen|no_update|hr_read_only)$' loop
    execute format('alter table %s enable trigger %I', g.tbl, g.tgname);
  end loop;
end $d$;
delete from hr_person where snapshot_id = ${lit(m.roots.snapshot)} and external_id in (${list(m.roots.hrPeople)});
delete from hr_unit where snapshot_id = ${lit(m.roots.snapshot)} and external_id in (${list(m.roots.hrUnits)});
delete from access_request_offer where role_code in (${list(m.roots.offersAdded)}) and audience = 'MANAGER';
${m.saved.hrSource.map((s) => `update hr_source set enabled = ${s.enabled}, updated_at = ${lit(s.updated_at)} where id = ${lit(s.id)};`).join('\n')}
insert into audit_event(action, entity_type, entity_id, entity_label, detail, reason) values ('ACCEPTANCE_RUN_CLEANED', 'ACCEPTANCE_RUN', ${lit(run.id)}, 'ACCEPTANCE / FICTIONAL', ${lit(JSON.stringify({ marker: 'ACCEPTANCE / FICTIONAL', run: run.id, removed: summary }))}::jsonb, 'أزيلت بيانات اختبار القبول الوهمية بالمعرفات الدقيقة، وبقي سجل التدقيق');
commit;
`;
function restoreDraftGuard() {
  return '';
}
psql(removal);
console.log('[cleanup] database rows removed');
for (const dn of m.roots.ldap) {
  try {
    dockerRun(['exec', LDAP, 'ldapdelete', '-x', '-H', 'ldap://localhost', '-D', 'cn=admin,dc=tmrkz,dc=local', '-w', ldapAdmin(), dn]);
  } catch {
    console.log('[cleanup] directory entry already gone:', dn);
  }
}
const kc = keycloak('delete', m.roots.usernames);
console.log('[cleanup] directory entries removed; Keycloak users removed:', kc.length);
waitAuthzDrained();

const after = fingerprintAll();
// a change made on purpose while the data was loaded and recorded in the manifest (the HR settings key rotation re-encrypted hr_source)
const expected = m.expectedChanges ?? {};
const changed = Object.keys({ ...m.before, ...after }).filter((t) => m.before[t] !== after[t] && !(t in expected));
const tuples = tupleCounts();
m.verification = { at: new Date().toISOString(), changedTables: changed.map((t) => ({ t, before: m.before[t], after: after[t] })), tuplesBefore: m.tuples, tuplesAfter: tuples, notCompared: NOT_COMPARED, leftoverPeople: psql(`select count(*) from person where id::text in (${list(m.roots.person)})`), auditRetained: psql(`select count(*) from audit_event where id > ${m.auditFrom}`) };
m.cleanedAt = new Date().toISOString();
writeJson(manifestFile(run.id), m);
rmSync(CURRENT);
console.log('[cleanup] tables that differ from before the run:', changed.length ? JSON.stringify(m.verification.changedTables) : 'none');
console.log('[cleanup] tuples before', JSON.stringify(m.tuples), 'after', JSON.stringify(tuples));
console.log('[cleanup] audit rows retained as evidence:', m.verification.auditRetained);
if (changed.length || tuples.authzTuple !== m.tuples.authzTuple || tuples.openfgaTuple !== m.tuples.openfgaTuple) process.exit(1);
