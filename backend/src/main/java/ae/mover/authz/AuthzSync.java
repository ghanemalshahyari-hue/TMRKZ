package ae.mover.authz;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import ae.mover.access.GrantSource;
import ae.mover.access.GrantTarget;
import ae.mover.access.RawGrant;
import ae.mover.common.Db;
import ae.mover.common.Json;

/**
 * Applies the authorisation outbox to OpenFGA. Changes are recorded by database triggers in the same transaction as
 * the business change ({@code authz_change}); this worker computes the tuples the database implies, compares them with
 * the mirror of what OpenFGA holds ({@code authz_tuple}) and writes only the difference. Runs every few seconds, on
 * demand before a sensitive action of a person with pending changes, and as a full reconciliation every few minutes.
 */
@Component
@EnableConfigurationProperties(AuthzProperties.class)
public class AuthzSync {

    private static final Logger log = LoggerFactory.getLogger(AuthzSync.class);
    private static final long LOCK_KEY = 0x544d524b5a46L; // "TMRKZF"
    private static final int BATCH = 100;

    /** Store and pinned model in use. */
    public record Ready(String storeId, String modelId) {
    }

    public record Result(long appliedSeq, int written, int deleted, long millis) {
    }

    private final JdbcClient jdbc;
    private final TransactionTemplate tx;
    private final FgaClient fga;
    private final AuthzProperties props;
    private final GrantSource grants;
    private final Json json;
    private final Clock clock;
    private volatile Ready ready;

    public AuthzSync(JdbcClient jdbc, PlatformTransactionManager txManager, FgaClient fga, AuthzProperties props,
                     GrantSource grants, Json json, Clock clock) {
        this.jdbc = jdbc;
        // Own transactions: the sync and the pending check see committed changes only, never a caller's open work.
        this.tx = new TransactionTemplate(txManager);
        this.tx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        this.fga = fga;
        this.props = props;
        this.grants = grants;
        this.json = json;
        this.clock = clock;
    }

    /** Store and authorisation model, created or written once and recorded in the database. */
    public Ready ready() {
        Ready r = ready;
        if (r != null) {
            return r;
        }
        synchronized (this) {
            if (ready != null) {
                return ready;
            }
            Map<String, Object> st = tx.execute(x -> jdbc.sql("select store_id, model_id, model_hash from authz_sync_state where id = 1")
                    .query().singleRow());
            String store = props.storeId() != null && !props.storeId().isBlank() ? props.storeId() : (String) st.get("store_id");
            if (store == null || !fga.storeExists(store)) {
                store = fga.findOrCreateStore(props.storeName());
            }
            String model = (String) st.get("model_id");
            String hash = AuthzModel.hash();
            boolean sameStore = store.equals(st.get("store_id"));
            if (!sameStore || !hash.equals(st.get("model_hash")) || model == null || !fga.modelExists(store, model)) {
                model = fga.writeModel(store, AuthzModel.json());
            }
            String s = store;
            String m = model;
            tx.executeWithoutResult(x -> {
                if (!sameStore) {
                    // a new or replaced store holds no tuples: forget the mirror and rebuild everything
                    jdbc.sql("delete from authz_tuple").update();
                    jdbc.sql("insert into authz_change(person_id, source) values (null, 'store:grants')").update();
                    jdbc.sql("insert into authz_change(person_id, source) values (null, 'store:structure')").update();
                }
                jdbc.sql("update authz_sync_state set store_id = :s, model_id = :m, model_hash = :h where id = 1")
                        .param("s", s).param("m", m).param("h", hash).update();
            });
            log.info("OpenFGA store {} with model {}", s, m);
            ready = new Ready(s, m);
            return ready;
        }
    }

    /** True if a change concerning this person, or a shared change, is not yet in OpenFGA. */
    public boolean pending(UUID personId) {
        return Boolean.TRUE.equals(tx.execute(x -> jdbc.sql("""
                select exists (select 1 from authz_change c, authz_sync_state s
                  where s.id = 1 and c.seq > s.applied_seq and (c.person_id is null or c.person_id = :p))""")
                .param("p", personId).query(Boolean.class).single()));
    }

    /** Applies pending changes now (other callers wait for the run in progress). */
    public synchronized Result run(boolean full) {
        long started = System.nanoTime();
        Ready r = ready();
        try {
            Result res = tx.execute(x -> apply(r, full, started));
            return res;
        } catch (RuntimeException e) {
            String message = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            tx.executeWithoutResult(x -> jdbc.sql("update authz_sync_state set last_error = :e, last_error_at = :t where id = 1")
                    .param("e", message.substring(0, Math.min(500, message.length()))).param("t", Db.ts(clock.instant())).update());
            if (e instanceof FgaClient.FgaException) {
                ready = null; // re-check store and model on the next attempt
            }
            throw e;
        }
    }

    private Result apply(Ready r, boolean full, long started) {
        jdbc.sql("select pg_advisory_xact_lock(:k)").param("k", LOCK_KEY).query().listOfRows();
        long applied = jdbc.sql("select applied_seq from authz_sync_state where id = 1 for update").query(Long.class).single();
        long target = jdbc.sql("select coalesce(max(seq), 0) from authz_change").query(Long.class).single();
        if (target <= applied && !full) {
            return new Result(applied, 0, 0, 0);
        }
        boolean structure = full;
        boolean everyone = full;
        Set<UUID> persons = new HashSet<>();
        for (Map<String, Object> c : jdbc.sql("select person_id, source from authz_change where seq > :a and seq <= :t")
                .param("a", applied).param("t", target).query().listOfRows()) {
            String source = (String) c.get("source");
            if (c.get("person_id") != null) {
                persons.add((UUID) c.get("person_id"));
            } else if (source.endsWith(":structure")) {
                structure = true;
            } else {
                everyone = true;
            }
        }
        List<Op> ops = new ArrayList<>();
        if (structure) {
            ops.addAll(structureDiff());
        }
        if (everyone) {
            ops.addAll(grantDiff(null));
        } else if (!persons.isEmpty()) {
            ops.addAll(grantDiff(persons));
        }
        List<Op> deletes = ops.stream().filter(o -> o.delete).toList();
        List<Op> writes = ops.stream().filter(o -> !o.delete).toList();
        send(r, deletes, true);
        send(r, writes, false);
        for (Op d : deletes) {
            jdbc.sql("delete from authz_tuple where object = :o and relation = :r and subject = :s")
                    .param("o", d.tuple.object()).param("r", d.tuple.relation()).param("s", d.tuple.subject()).update();
        }
        for (Op w : writes) {
            jdbc.sql("""
                    insert into authz_tuple(object, relation, subject, condition, person_id, kind)
                    values (:o, :r, :s, cast(:c as jsonb), :p, :k)
                    on conflict (object, relation, subject) do update set condition = excluded.condition,
                      person_id = excluded.person_id, kind = excluded.kind""")
                    .param("o", w.tuple.object()).param("r", w.tuple.relation()).param("s", w.tuple.subject())
                    .param("c", w.tuple.condition() == null ? null : json.write(w.tuple.condition()))
                    .param("p", w.person).param("k", w.person == null && w.structure ? "STRUCTURE" : "GRANT").update();
        }
        long ms = (System.nanoTime() - started) / 1_000_000;
        jdbc.sql("""
                update authz_sync_state set applied_seq = :t, last_success_at = :now, last_duration_ms = :ms,
                  tuples = (select count(*) from authz_tuple), last_error = null, last_error_at = null where id = 1""")
                .param("t", target).param("now", Db.ts(clock.instant())).param("ms", (int) ms).update();
        if (!ops.isEmpty()) {
            log.info("Authorisation sync to seq {}: {} written, {} deleted in {} ms", target, writes.size(), deletes.size(), ms);
        }
        return new Result(target, writes.size(), deletes.size(), ms);
    }

    private record Op(boolean delete, FgaClient.Tuple tuple, UUID person, boolean structure) {
    }

    private List<Op> structureDiff() {
        List<Op> ops = new ArrayList<>();
        jdbc.sql("""
                with desired(object, relation, subject) as (
                  select 'organization:' || id, 'parent', 'organization:' || parent_id from organization where parent_id is not null
                  union select 'site:' || id, 'parent', 'site:' || parent_id from site where parent_id is not null
                  union select 'site:' || site_id, 'responsible', 'organization:' || organization_id
                        from site_responsibility where valid_to is null),
                mirror as (select object, relation, subject from authz_tuple where kind = 'STRUCTURE')
                select false as del, * from (select * from desired except select * from mirror) w
                union all
                select true, * from (select * from mirror except select * from desired) d""")
                .query((rs, n) -> ops.add(new Op(rs.getBoolean("del"),
                        new FgaClient.Tuple(rs.getString("object"), rs.getString("relation"), rs.getString("subject"), null),
                        null, true)))
                .list();
        return ops;
    }

    /** Difference between the tuples implied by the grants of these persons (or everyone) and the mirror. */
    private List<Op> grantDiff(Set<UUID> persons) {
        Instant now = clock.instant();
        List<RawGrant> raw = new ArrayList<>();
        if (persons == null) {
            raw.addAll(grants.unended(null, now));
        } else {
            for (UUID p : persons) {
                raw.addAll(grants.unended(p, now));
            }
        }
        Set<UUID> resourceIds = new HashSet<>();
        for (RawGrant g : raw) {
            for (GrantTarget t : g.targets()) {
                if (GrantTarget.RESOURCE.equals(t.kind())) {
                    resourceIds.add(t.id());
                }
            }
        }
        Map<UUID, UUID> resourceSites = new HashMap<>();
        if (!resourceIds.isEmpty()) {
            jdbc.sql("select id, site_id from resource where id = any(string_to_array(:ids, ',')::uuid[])")
                    .param("ids", Db.ids(resourceIds))
                    .query((rs, n) -> resourceSites.put(Db.uuid(rs, "id"), Db.uuid(rs, "site_id"))).list();
        }
        Map<String, Op> desired = new LinkedHashMap<>();
        for (RawGrant g : raw) {
            for (FgaClient.Tuple t : AuthzTuples.of(g, resourceSites)) {
                desired.putIfAbsent(key(t), new Op(false, t, g.personId(), false));
            }
        }
        Map<String, Map<String, Object>> mirror = new HashMap<>();
        Map<String, UUID> mirrorPerson = new HashMap<>();
        String filter = persons == null ? "" : " and person_id = any(string_to_array(:ids, ',')::uuid[])";
        var q = jdbc.sql("select object, relation, subject, condition::text as condition, person_id from authz_tuple where kind = 'GRANT'" + filter);
        if (persons != null) {
            q = q.param("ids", Db.ids(persons));
        }
        q.query((rs, n) -> {
            String k = rs.getString("object") + "|" + rs.getString("relation") + "|" + rs.getString("subject");
            String c = rs.getString("condition");
            mirror.put(k, c == null ? null : json.map(c));
            mirrorPerson.put(k, Db.uuid(rs, "person_id"));
            return null;
        }).list();
        List<Op> ops = new ArrayList<>();
        for (Map.Entry<String, Map<String, Object>> m : mirror.entrySet()) {
            Op want = desired.get(m.getKey());
            if (want == null || !sameCondition(m.getValue(), want.tuple.condition())) {
                String[] parts = m.getKey().split("\\|", 3);
                ops.add(new Op(true, new FgaClient.Tuple(parts[0], parts[1], parts[2], null), mirrorPerson.get(m.getKey()), false));
            }
        }
        for (Map.Entry<String, Op> d : desired.entrySet()) {
            if (!mirror.containsKey(d.getKey()) || !sameCondition(mirror.get(d.getKey()), d.getValue().tuple.condition())) {
                ops.add(d.getValue());
            }
        }
        return ops;
    }

    private boolean sameCondition(Map<String, Object> a, Map<String, Object> b) {
        if (a == null || b == null) {
            return a == null && b == null;
        }
        return json.canonical(a).equals(json.canonical(b));
    }

    private static String key(FgaClient.Tuple t) {
        return t.object() + "|" + t.relation() + "|" + t.subject();
    }

    private void send(Ready r, List<Op> ops, boolean delete) {
        for (int i = 0; i < ops.size(); i += BATCH) {
            List<FgaClient.Tuple> batch = ops.subList(i, Math.min(ops.size(), i + BATCH)).stream().map(Op::tuple).toList();
            try {
                write(r, batch, delete);
            } catch (FgaClient.FgaException e) {
                if (!tolerable(e)) {
                    throw e;
                }
                // the mirror missed an earlier outcome: apply one by one, accepting tuples already in the wanted state
                for (FgaClient.Tuple t : batch) {
                    try {
                        write(r, List.of(t), delete);
                    } catch (FgaClient.FgaException one) {
                        if (!tolerable(one)) {
                            throw one;
                        }
                    }
                }
            }
        }
    }

    private void write(Ready r, List<FgaClient.Tuple> batch, boolean delete) {
        fga.write(r.storeId(), r.modelId(), delete ? List.of() : batch, delete ? batch : List.of());
    }

    private static boolean tolerable(FgaClient.FgaException e) {
        String m = e.getMessage() == null ? "" : e.getMessage();
        return m.contains("already exist") || m.contains("did not exist") || m.contains("does not exist");
    }

    /**
     * Rebuilds the authorisation data in a new store from the database alone and switches to it; the previous store is
     * then deleted. Repairs any difference between OpenFGA and the mirror (e.g. after restoring one without the other).
     * Checks keep using the previous store until the switch.
     */
    public synchronized Result rebuild() {
        if (props.storeId() != null && !props.storeId().isBlank()) {
            throw new IllegalStateException("store pinned by TMRKZ_OPENFGA_STORE_ID");
        }
        long started = System.nanoTime();
        Ready old = ready();
        String store = fga.createStore(props.storeName());
        String model = fga.writeModel(store, AuthzModel.json());
        Ready fresh = new Ready(store, model);
        long target = tx.execute(x -> jdbc.sql("select coalesce(max(seq), 0) from authz_change").query(Long.class).single());
        List<Op> ops = new ArrayList<>();
        tx.executeWithoutResult(x -> {
            jdbc.sql("""
                    select 'organization:' || id as object, 'parent' as relation, 'organization:' || parent_id as subject from organization where parent_id is not null
                    union select 'site:' || id, 'parent', 'site:' || parent_id from site where parent_id is not null
                    union select 'site:' || site_id, 'responsible', 'organization:' || organization_id from site_responsibility where valid_to is null""")
                    .query((rs, n) -> ops.add(new Op(false, new FgaClient.Tuple(rs.getString("object"), rs.getString("relation"),
                            rs.getString("subject"), null), null, true))).list();
        });
        Map<String, Op> grantOps = new LinkedHashMap<>();
        Instant now = clock.instant();
        List<RawGrant> raw = grants.unended(null, now);
        Map<UUID, UUID> resourceSites = new HashMap<>();
        jdbc.sql("select id, site_id from resource").query((rs, n) -> resourceSites.put(Db.uuid(rs, "id"), Db.uuid(rs, "site_id"))).list();
        for (RawGrant g : raw) {
            for (FgaClient.Tuple t : AuthzTuples.of(g, resourceSites)) {
                grantOps.putIfAbsent(key(t), new Op(false, t, g.personId(), false));
            }
        }
        ops.addAll(grantOps.values());
        send(fresh, ops, false);
        tx.executeWithoutResult(x -> {
            jdbc.sql("select pg_advisory_xact_lock(:k)").param("k", LOCK_KEY).query().listOfRows();
            jdbc.sql("delete from authz_tuple").update();
            for (Op w : ops) {
                jdbc.sql("""
                        insert into authz_tuple(object, relation, subject, condition, person_id, kind)
                        values (:o, :r, :s, cast(:c as jsonb), :p, :k) on conflict do nothing""")
                        .param("o", w.tuple.object()).param("r", w.tuple.relation()).param("s", w.tuple.subject())
                        .param("c", w.tuple.condition() == null ? null : json.write(w.tuple.condition()))
                        .param("p", w.person).param("k", w.structure ? "STRUCTURE" : "GRANT").update();
            }
            jdbc.sql("""
                    update authz_sync_state set store_id = :s, model_id = :m, model_hash = :h, applied_seq = :t,
                      tuples = (select count(*) from authz_tuple), last_success_at = :now, last_error = null, last_error_at = null
                    where id = 1""")
                    .param("s", store).param("m", model).param("h", AuthzModel.hash()).param("t", target)
                    .param("now", Db.ts(clock.instant())).update();
        });
        ready = fresh;
        try {
            fga.deleteStore(old.storeId());
        } catch (RuntimeException e) {
            log.warn("Previous OpenFGA store {} not deleted: {}", old.storeId(), e.getMessage());
        }
        long ms = (System.nanoTime() - started) / 1_000_000;
        log.info("Authorisation store rebuilt as {} with {} tuples in {} ms", store, ops.size(), ms);
        // changes committed during the rebuild are applied to the new store by the next run
        run(false);
        return new Result(target, ops.size(), 0, ms);
    }

    // ---- schedules ------------------------------------------------------------------------------------------------

    @Scheduled(fixedDelayString = "${tmrkz.authz.poll-ms:2000}", initialDelay = 3000)
    public void poll() {
        if (!props.configured() || !props.syncEnabled()) {
            return;
        }
        try {
            boolean any = Boolean.TRUE.equals(jdbc.sql("""
                    select exists (select 1 from authz_change c, authz_sync_state s where s.id = 1 and c.seq > s.applied_seq)""")
                    .query(Boolean.class).single());
            if (any || ready == null) {
                run(false);
            }
        } catch (RuntimeException e) {
            log.warn("Authorisation sync failed: {}", e.getMessage());
        }
    }

    @Scheduled(fixedDelayString = "${tmrkz.authz.reconcile-ms:300000}", initialDelay = 60000)
    public void reconcile() {
        if (!props.configured() || !props.syncEnabled()) {
            return;
        }
        try {
            run(true);
            jdbc.sql("""
                    delete from authz_change where seq <= (select applied_seq from authz_sync_state where id = 1)
                      and created_at < now() - interval '1 day'""").update();
        } catch (RuntimeException e) {
            log.warn("Authorisation reconciliation failed: {}", e.getMessage());
        }
    }

    // ---- status ---------------------------------------------------------------------------------------------------

    public Map<String, Object> status() {
        Map<String, Object> st = jdbc.sql("""
                select s.*, (select count(*) from authz_change c where c.seq > s.applied_seq) as pending,
                       (select coalesce(max(seq), 0) from authz_change) as latest
                from authz_sync_state s where s.id = 1""").query().singleRow();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("configured", props.configured());
        boolean reachable = false;
        String error = null;
        if (props.configured()) {
            try {
                Ready r = ready();
                reachable = fga.storeExists(r.storeId());
            } catch (RuntimeException e) {
                error = e.getMessage();
            }
        }
        out.put("reachable", reachable);
        out.put("storeId", st.get("store_id"));
        out.put("modelId", st.get("model_id"));
        out.put("modelHash", st.get("model_hash"));
        out.put("appliedSeq", st.get("applied_seq"));
        out.put("latestSeq", st.get("latest"));
        out.put("pendingChanges", st.get("pending"));
        out.put("tuples", st.get("tuples"));
        out.put("lastSuccessAt", st.get("last_success_at") == null ? null : Db.toInstant(st.get("last_success_at")).toString());
        out.put("lastDurationMs", st.get("last_duration_ms"));
        out.put("lastError", error != null ? error : st.get("last_error"));
        out.put("lastErrorAt", st.get("last_error_at") == null ? null : Db.toInstant(st.get("last_error_at")).toString());
        return out;
    }
}
