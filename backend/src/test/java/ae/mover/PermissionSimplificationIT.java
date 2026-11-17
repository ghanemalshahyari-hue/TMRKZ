package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.Statement;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import javax.sql.DataSource;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.datasource.DataSourceUtils;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.access.Permission;
import ae.mover.common.Db;

/**
 * ADR-078 (owner, 17 Nov 2026) on an installation that already holds the roles: V49 runs before Bootstrap, so on the test
 * database it found nothing to change. Here the migration's own SQL runs again, in one transaction that is rolled back, on data
 * shaped like :8088 at V48 — the stationing roles as published from ops/policy, MOVER's facilities roles with their grants, an
 * open policy draft, a role of the administrator's own with the removed actions, an old request waiting at a distance-exception
 * stage — and then once more, to show it changes nothing the second time. Also: a policy version from before the decision is
 * brought back with today's actions only.
 */
class PermissionSimplificationIT extends IntegrationTest {

    private static final List<String> RETIRED = List.of("CREATE_INITIAL_STATIONING", "CREATE_DEPLOYMENT_REQUEST",
            "APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION", "DECIDE_PRE_ACTIVATION_CANCELLATION", "ACTIVATE_TEMPORARY_EXTENSION",
            "DECIDE_EARLY_RETURN", "DECIDE_BEFORE_START_CANCELLATION");

    @Autowired
    DataSource dataSource;

    private void upsertRole(String code, String name, String scope, List<String> perms, List<String> grantable) {
        jdbc.sql("""
                insert into role_def(code, name, permissions, scope, summary_only, system, sort_order, grantable_roles)
                values (:c, :n, string_to_array(:p, ','), :s, false, false, 50, case when :g = '' then '{}'::text[] else string_to_array(:g, ',') end)
                on conflict (code) do update set name = excluded.name, permissions = excluded.permissions, scope = excluded.scope,
                  grantable_roles = excluded.grantable_roles""")
                .param("c", code).param("n", name).param("p", String.join(",", perms)).param("s", scope).param("g", String.join(",", grantable))
                .update();
    }

    private void runV49() throws Exception {
        String sql = new String(new ClassPathResource("db/migration/V49__stationing_permissions_simplified.sql").getInputStream().readAllBytes(),
                StandardCharsets.UTF_8);
        Connection c = DataSourceUtils.getConnection(dataSource);
        try (Statement st = c.createStatement()) {
            st.execute(sql);
        } finally {
            DataSourceUtils.releaseConnection(c, dataSource);
        }
    }

    private List<String> perms(String code) {
        return jdbc.sql("select array_to_string(permissions, ',') from role_def where code = :c").param("c", code).query(String.class).optional()
                .map(t -> t.isEmpty() ? List.<String>of() : List.of(t.split(","))).orElseThrow();
    }

    private String name(String code) {
        return jdbc.sql("select name from role_def where code = :c").param("c", code).query(String.class).single();
    }

    private long count(String sql, Object... params) {
        var q = jdbc.sql(sql);
        for (int i = 0; i < params.length; i++) {
            q = q.param("p" + i, params[i]);
        }
        return q.query(Long.class).single();
    }

    @Test
    @DisplayName("V49 on :8088-shaped data: roles redefined and emptied, grants ended with a reason, offers moved, a version recorded, the draft carried, an old exception stage handed to the final approver, audited; a second run changes nothing")
    void migrationOnExistingRoles() {
        tx.executeWithoutResult(status -> {
            status.setRollbackOnly();
            try {
                migrate();
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        });
        assertThat(perms("REQUESTER")).as("rolled back: the test database keeps MOVER's facilities roles for the other tests").isNotEmpty();
    }

    private void migrate() throws Exception {
        UUID org = org("V49", null);
        // the stationing roles as published on :8088 (ops/policy, ADR-063), and an access manager able to give them
        upsertRole("STATIONING_REQUESTER", "إنشاء طلبات التمركز", "ORGANIZATION",
                List.of("VIEW", "CREATE_INITIAL_STATIONING", "CREATE_DEPLOYMENT_REQUEST", "CREATE_RESTATIONING", "REQUEST_SITE_REGISTRATION"), List.of());
        upsertRole("DEPLOYMENT_REQUESTER", "إنشاء طلب منطقة انتشار", "ORGANIZATION", List.of("VIEW", "CREATE_DEPLOYMENT_REQUEST"), List.of());
        upsertRole("SITE_REGISTRATION_REQUESTER", "طلب اعتماد موقع", "ORGANIZATION", List.of("VIEW", "REQUEST_SITE_REGISTRATION"), List.of());
        upsertRole("SITE_LINK_MANAGER", "ربط الوحدات بالمواقع", "ORGANIZATION", List.of("VIEW", "MANAGE_SITE_LINKS"), List.of());
        upsertRole("SITE_SETUP_ADMIN", "تهيئة المواقع والتمركز", "ALL", List.of("VIEW", "MANAGE_FACILITIES", "MANAGE_SITE_LINKS", "CORRECT_STATIONING"), List.of());
        upsertRole("UNIT_OPERATIONS_APPROVER", "معتمد عمليات الوحدة", "ORGANIZATION", List.of("VIEW", "REVIEW", "DECIDE_UNIT_OPERATIONS"), List.of());
        upsertRole("UNIT_ACCESS_MANAGER", "مدير صلاحيات الوحدة", "ORGANIZATION", List.of("MANAGE_ACCESS", "REVIEW"),
                List.of("REQUESTER", "CHAIN_APPROVER", "UNIT_OPERATIONS_APPROVER", "FYI_RECEIVER", "STATIONING_REQUESTER", "DEPLOYMENT_REQUESTER",
                        "SITE_REGISTRATION_REQUESTER", "POSTURE_VIEWER"));
        String custom = "T_V49_" + sfx.toUpperCase();
        upsertRole(custom, "دور خاص بالإدارة", "ORGANIZATION",
                List.of("VIEW", "CREATE_DEPLOYMENT_REQUEST", "DECIDE_EARLY_RETURN", "APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION"), List.of("REQUESTER"));
        // the request offer as V29 left it, MOVER's facilities requester to everyone
        jdbc.sql("insert into access_request_offer(role_code, audience) values ('REQUESTER', 'EVERYONE') on conflict (role_code) do update set audience = 'EVERYONE'").update();
        jdbc.sql("delete from access_request_offer where role_code = 'STATIONING_REQUESTER'").update();

        // grants of the facilities roles: a membership with a delegation, a unit grant, a seat
        UUID holder = person("v49holder", "REQUESTER", org);
        UUID delegate = person("v49delegate", custom, org);
        UUID membership = jdbc.sql("select id from membership where person_id = :p and role_code = 'REQUESTER'").param("p", holder).query(UUID.class).single();
        UUID delegation = UUID.randomUUID();
        jdbc.sql("""
                insert into delegation(id, delegator_id, delegate_id, membership_id, valid_from, valid_to, reason)
                values (:id, :a, :b, :m, now() - interval '1 hour', now() + interval '1 day', 'تفويض للاختبار')""")
                .param("id", delegation).param("a", holder).param("b", delegate).param("m", membership).update();
        UUID unitGrant = UUID.randomUUID();
        jdbc.sql("insert into unit_grant(id, organization_id, role_code, valid_from, granted_by) values (:id, :o, 'REQUESTER', now() - interval '1 day', :by)")
                .param("id", unitGrant).param("o", org).param("by", holder).update();
        UUID seat = UUID.randomUUID();
        jdbc.sql("insert into position_seat(id, organization_id, position_id, name, role_code) values (:id, :o, 'P-V49', 'منصب للاختبار', 'APPROVER')")
                .param("id", seat).param("o", org).update();
        UUID kept = person("v49kept", "AUDITOR", org);

        // the policy: the live roles published, and an open draft that still names a removed action
        UUID published = jdbc.sql("select id from access_policy_version where status = 'PUBLISHED'").query(UUID.class).single();
        int publishedVersion = jdbc.sql("select version from access_policy_version where id = :id").param("id", published).query(Integer.class).single();
        UUID draft = jdbc.sql("select id from access_policy_version where status = 'DRAFT'").query(UUID.class).optional().orElse(null);
        if (draft == null) {
            draft = UUID.randomUUID();
            jdbc.sql("""
                    insert into access_policy_version(id, version, status, roles, note, based_on)
                    values (:id, (select max(version) + 1 from access_policy_version), 'DRAFT',
                            (select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'permissions', to_jsonb(permissions), 'scope', scope,
                                     'summaryOnly', summary_only, 'system', system, 'grantableRoles', to_jsonb(grantable_roles), 'sortOrder', sort_order))
                               from role_def), 'مسودة مفتوحة', :b)""").param("id", draft).param("b", published).update();
        }
        int draftVersion = jdbc.sql("select version from access_policy_version where id = :id").param("id", draft).query(Integer.class).single();

        // an old request waiting at its distance-exception stage, and an older one whose exception was decided
        UUID waiting = oldRequest("W", org, holder);
        UUID waitingStage = exceptionStage(waiting, null);
        UUID decided = oldRequest("D", org, holder);
        UUID decidedStage = exceptionStage(decided, kept);

        runV49();

        // 1. roles
        assertThat(name("STATIONING_REQUESTER")).isEqualTo("مقدم الطلب");
        assertThat(perms("STATIONING_REQUESTER")).containsExactly("VIEW", "CREATE_RESTATIONING", "REQUEST_SITE_REGISTRATION");
        assertThat(perms("UNIT_OPERATIONS_APPROVER")).containsExactly("VIEW", "REVIEW", "DECIDE_UNIT_OPERATIONS", "MANAGE_FACILITIES", "MANAGE_SITE_LINKS");
        assertThat(perms("SITE_SETUP_ADMIN")).containsExactly("VIEW", "MANAGE_FACILITIES", "MANAGE_SITE_LINKS", "CORRECT_STATIONING");
        assertThat(perms("SYSTEM_ADMIN")).contains("REPLAY_STATIONING_EVENTS", "CREATE_RESTATIONING", "CORRECT_STATIONING");
        assertThat(perms(custom)).as("a role of the administrator's own: the deployment right becomes the merged one, the rest go")
                .containsExactly("VIEW", "CREATE_RESTATIONING");
        for (String code : List.of("REQUESTER", "FACILITIES_REVIEWER", "ORG_MANAGER", "APPROVER", "LIMITED_VIEWER", "DEPLOYMENT_REQUESTER",
                "SITE_REGISTRATION_REQUESTER", "SITE_LINK_MANAGER")) {
            assertThat(perms(code)).as(code).isEmpty();
            assertThat(name(code)).as(code).contains("غير مستخدم");
        }
        assertThat(name("REQUESTER")).isEqualTo("مقدم الطلب (مرافق — غير مستخدم)");
        assertThat(perms("AUDITOR")).as("kept").containsExactly("VIEW", "AUDIT");
        assertThat(count("select count(*) from role_def where permissions && string_to_array(:p0, ',')", String.join(",", RETIRED)))
                .as("no role names a removed action").isZero();
        assertThat(jdbc.sql("select array_to_string(grantable_roles, ',') from role_def where code = 'UNIT_ACCESS_MANAGER'").query(String.class).single())
                .isEqualTo("STATIONING_REQUESTER,CHAIN_APPROVER,UNIT_OPERATIONS_APPROVER,FYI_RECEIVER,POSTURE_VIEWER");
        assertThat(jdbc.sql("select array_to_string(grantable_roles, ',') from role_def where code = :c").param("c", custom).query(String.class).single())
                .as("«مقدم الطلب» takes the facilities requester's place").isEqualTo("STATIONING_REQUESTER");

        // 2. grants of the emptied roles ended, with the reason
        Map<String, Object> m = jdbc.sql("select valid_to, ended_reason from membership where id = :id").param("id", membership).query().singleRow();
        assertThat(m.get("valid_to")).isNotNull();
        assertThat((String) m.get("ended_reason")).contains("ADR-078");
        assertThat(jdbc.sql("select revoke_reason from delegation where id = :id and revoked_at is not null").param("id", delegation).query(String.class).single())
                .contains("ADR-078");
        assertThat(jdbc.sql("select ended_reason from unit_grant where id = :id and valid_to is not null").param("id", unitGrant).query(String.class).single())
                .contains("ADR-078");
        assertThat(jdbc.sql("select active from position_seat where id = :id").param("id", seat).query(Boolean.class).single()).isFalse();
        assertThat(count("select count(*) from membership where person_id = :p0 and valid_to is null", kept)).as("other grants stay").isEqualTo(1);
        assertThat(count("select count(*) from membership where person_id = :p0 and valid_to is null", delegate)).isEqualTo(1);

        // 3. offers
        assertThat(count("select count(*) from access_request_offer where role_code = 'REQUESTER'")).isZero();
        assertThat(jdbc.sql("select audience from access_request_offer where role_code = 'STATIONING_REQUESTER'").query(String.class).single()).isEqualTo("EVERYONE");

        // 4. the policy history: a version saying what is in force, the draft after it and carried
        Map<String, Object> now = jdbc.sql("select id, version, note, based_on, roles::text as roles from access_policy_version where status = 'PUBLISHED'")
                .query().singleRow();
        assertThat(now.get("id")).isNotEqualTo(published);
        assertThat(((Number) now.get("version")).intValue()).as("the draft's place").isEqualTo(draftVersion);
        assertThat((String) now.get("note")).contains("ADR-078");
        assertThat(now.get("based_on")).isEqualTo(published);
        assertThat(jdbc.sql("select status from access_policy_version where id = :id").param("id", published).query(String.class).single()).isEqualTo("SUPERSEDED");
        assertThat(jdbc.sql("select version from access_policy_version where id = :id").param("id", published).query(Integer.class).single()).isEqualTo(publishedVersion);
        JsonNode recorded = JSON.readTree((String) now.get("roles"));
        for (JsonNode r : recorded) {
            List<String> live = perms(r.path("code").asText());
            List<String> inVersion = new java.util.ArrayList<>();
            r.path("permissions").forEach(p -> inVersion.add(p.asText()));
            assertThat(inVersion).as(r.path("code").asText()).isEqualTo(live);
        }
        assertThat(count("select count(*) from role_def where policy_version is distinct from :p0", now.get("version"))).isZero();
        Map<String, Object> d = jdbc.sql("select version, based_on, roles::text as roles from access_policy_version where id = :id").param("id", draft).query().singleRow();
        assertThat(((Number) d.get("version")).intValue()).as("the draft comes after the recorded version").isGreaterThan(((Number) now.get("version")).intValue());
        assertThat(d.get("based_on")).isEqualTo(now.get("id"));
        for (String retired : RETIRED) {
            assertThat((String) d.get("roles")).as("the draft names no removed action").doesNotContain("\"" + retired + "\"");
        }
        assertThat((String) d.get("roles")).contains("مقدم الطلب (مرافق — غير مستخدم)").contains("REPLAY_STATIONING_EVENTS");

        // 5. the old exception stage: the waiting one is handed to the final stage, the decided one stays as history
        assertThat(count("select count(*) from restationing_stage where id = :p0", waitingStage)).isZero();
        assertThat(count("select count(*) from restationing_stage where id = :p0", decidedStage)).isEqualTo(1);

        // 6. one audit event with everything ended
        String audited = jdbc.sql("select detail::text from audit_event where action = 'ACCESS_ROLES_SIMPLIFIED' order by id desc limit 1").query(String.class).single();
        assertThat(audited).contains(membership.toString()).contains(unitGrant.toString()).contains(delegation.toString()).contains(seat.toString())
                .contains(waiting.toString());

        // a second run changes nothing
        long versions = count("select count(*) from access_policy_version");
        long audits = count("select count(*) from audit_event where action = 'ACCESS_ROLES_SIMPLIFIED'");
        jdbc.sql("drop table if exists adr078_before, adr078_retired, adr078_ended, adr078_version, adr078_stages").update();
        runV49();
        assertThat(count("select count(*) from access_policy_version")).isEqualTo(versions);
        assertThat(count("select count(*) from audit_event where action = 'ACCESS_ROLES_SIMPLIFIED'")).isEqualTo(audits);
        assertThat(perms("STATIONING_REQUESTER")).containsExactly("VIEW", "CREATE_RESTATIONING", "REQUEST_SITE_REGISTRATION");
    }

    /** A request of before ADR-078 on its first route (kept a draft here so it needs no stationing policy in the test database). */
    private UUID oldRequest(String tag, UUID org, UUID requester) {
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into restationing_request(id, number, requester_id, requesting_unit_id, state, kind, start_at, reason, content, route_no,
                                                 created_at, updated_at, purpose)
                values (:id, :n, :by, :o, 'DRAFT', 'PERMANENT', now(), 'طلب قديم', cast(:c as jsonb), 1, now(), now(), 'DEPLOYMENT_AREAS')""")
                .param("id", id).param("n", "RS-V49-" + tag + "-" + sfx).param("by", requester).param("o", org)
                .param("c", write(Map.of("kind", "PERMANENT", "scope", List.of(org.toString()), "reason", "طلب قديم")))
                .update();
        return id;
    }

    private UUID exceptionStage(UUID request, UUID decidedBy) {
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into restationing_stage(id, request_id, route_no, position, stage_key, kind, unit_id, permission, label, satisfies, depends_on,
                                               final_stage, mark, decided_by, decided_at)
                values (:id, :r, 1, 0, 'X:distance', 'EXCEPTION', null, 'APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION', 'اعتماد استثناء مسافة الانتشار',
                        '[]'::jsonb, '{DEPLOYMENT}', false, :mark, :by, :at)""")
                .param("id", id).param("r", request).param("mark", decidedBy == null ? null : "APPROVED").param("by", decidedBy)
                .param("at", decidedBy == null ? null : Db.ts(java.time.Instant.now())).update();
        return id;
    }

    /** The owner's column order (17 Nov 2026). */
    private static final List<String> ORDER = List.of("STATIONING_REQUESTER", "CHAIN_APPROVER", "UNIT_OPERATIONS_APPROVER", "FINAL_APPROVER",
            "FYI_DISTRIBUTOR", "FYI_RECEIVER", "STATIONING_ACTIVATOR", "POSTURE_VIEWER", "UNIT_ACCESS_MANAGER", "ACCESS_FINAL_APPROVER");

    @Test
    @DisplayName("The access-workspace matrix shows unit roles that give something, in the owner's order — never the system role, a whole-system role or an emptied one; an emptied role is never given nor offered")
    void matrixAndEmptyRoles() {
        UUID org = org("V49M", null);
        String empty = role("V49EMPTY", "ORGANIZATION");
        String auditAll = role("V49AUDIT", "ALL", "VIEW", "AUDIT");
        String correctAll = role("V49SETUP", "ALL", "VIEW", "MANAGE_FACILITIES", "CORRECT_STATIONING");
        String finalAll = role("V49FINAL", "ALL", "REVIEW", "APPROVE");
        String unitRole = role("V49UNIT", "ORGANIZATION", "VIEW", "CREATE_RESTATIONING");
        UUID admin = person("v49madmin", "SYSTEM_ADMIN", org);
        UUID someone = person("v49someone", unitRole, org);
        assertThat(admin).isNotNull();
        Api a = login("v49madmin");
        Res matrix = a.get("/access/workspace/units/" + org + "/matrix");
        assertThat(matrix.status()).as(matrix.toString()).isEqualTo(200);
        List<String> columns = new java.util.ArrayList<>();
        matrix.body().path("columns").forEach(c -> columns.add(c.path("code").asText()));
        assertThat(columns).as("whole-system and emptied roles are not columns")
                .doesNotContain("SYSTEM_ADMIN", "AUDITOR", "SITE_SETUP_ADMIN", empty, auditAll, correctAll);
        assertThat(columns).as("a unit role, and a decider over everything that is not an administrator").contains(unitRole, finalAll);
        // the owner's order: the named roles present come first, in that order
        List<String> named = columns.stream().filter(ORDER::contains).toList();
        assertThat(named).isEqualTo(ORDER.stream().filter(columns::contains).toList());
        assertThat(columns.subList(0, named.size())).as("before any other role").isEqualTo(named);
        JsonNode row = null;
        for (JsonNode r : matrix.body().path("people")) {
            if (r.path("id").asText().equals(someone.toString())) {
                row = r;
            }
        }
        assertThat(row).isNotNull();
        assertThat(row.path("cells").has(empty)).isFalse();

        // an emptied role is never given: grant, unit grant
        Res grant = a.post("/memberships", Map.of("personId", someone.toString(), "organizationId", org.toString(), "roleCode", empty));
        assertThat(grant.status()).as(grant.toString()).isEqualTo(400);
        assertThat(grant.body().path("message").asText()).contains("بلا صلاحيات");
        Res unitGrant = a.put("/access/workspace/units/" + org + "/inherited", Map.of("roleCode", empty, "on", true, "reason", "منح لكل الوحدة"));
        assertThat(unitGrant.status()).as(unitGrant.toString()).isEqualTo(400);
        // nor offered for request
        assertThat(a.get("/access-requests/offer").body().toString()).doesNotContain(empty).contains(unitRole);
        Res offered = a.put("/access-requests/offer", Map.of(empty, "EVERYONE", unitRole, "EVERYONE"));
        assertThat(offered.status()).as("an emptied role cannot be offered: " + offered).isEqualTo(400);
    }

    @Test
    @DisplayName("A policy version from before ADR-078 is brought back with today's actions: each removed one becomes what replaced it, or nothing; recorded")
    void restoreTranslatesRemovedActions() {
        String role = role("V49OLD", "ORGANIZATION", "VIEW");
        person("v49admin", "SYSTEM_ADMIN", org("V49ADM", null));
        Api admin = login("v49admin");
        assertThat(admin.post("/access/policy/draft", Map.of("note", "اختبار")).status()).isEqualTo(200);
        assertThat(admin.put("/access/policy/draft/roles", Map.of("code", role, "name", "دور قديم",
                "permissions", List.of("VIEW", "CREATE_DEPLOYMENT_REQUEST"), "scope", "ORGANIZATION")).status())
                .as("a draft cannot name a removed action").isEqualTo(400);
        assertThat(admin.put("/access/policy/draft/roles", Map.of("code", role, "name", "دور قديم",
                "permissions", List.of("VIEW"), "scope", "ORGANIZATION")).status()).isEqualTo(200);
        Res published = admin.post("/access/policy/draft/publish", Map.of("note", "نسخة قبل الاستعادة"));
        assertThat(published.status()).as(published.toString()).isEqualTo(200);
        // the same roles as an earlier version still naming the removed actions (as one published before ADR-078 does)
        UUID old = UUID.randomUUID();
        jdbc.sql("""
                insert into access_policy_version(id, version, status, roles, note, published_at)
                select :id, (select max(version) + 1 from access_policy_version), 'SUPERSEDED',
                       (select jsonb_agg(case when e->>'code' = :r
                                              then jsonb_set(e, '{permissions}', '["VIEW", "CREATE_DEPLOYMENT_REQUEST", "DECIDE_EARLY_RETURN"]'::jsonb)
                                              else e end order by n)
                          from jsonb_array_elements(v.roles) with ordinality as t(e, n)), 'نسخة قديمة', now()
                  from access_policy_version v where v.status = 'PUBLISHED'""").param("id", old).param("r", role).update();
        Res restored = admin.post("/access/policy/versions/" + old + "/restore", Map.of("note", "استعادة نسخة قديمة"));
        assertThat(restored.status()).as(restored.toString()).isEqualTo(200);
        assertThat(perms(role)).containsExactly("VIEW", "CREATE_RESTATIONING");
        assertThat(restored.body().toString()).doesNotContain("CREATE_DEPLOYMENT_REQUEST").doesNotContain("DECIDE_EARLY_RETURN");
        assertThat(jdbc.sql("select detail::text from audit_event where action = 'POLICY_RESTORED' and entity_id = :id")
                .param("id", restored.body().path("id").asText()).query(String.class).single()).contains("retiredPermissionsTranslated").contains(role);
        assertThat(Permission.current(List.of("VIEW", "CREATE_DEPLOYMENT_REQUEST", "CREATE_RESTATIONING", "NOT_AN_ACTION", "DECIDE_EARLY_RETURN")))
                .containsExactly("VIEW", "CREATE_RESTATIONING");
    }
}
