package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.Stream;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.simple.JdbcClient;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.audit.AuditService;
import ae.mover.hr.HrProjection;
import ae.mover.hr.HrSyncService;
import ae.mover.hr.OracleUnitImportService;
import ae.mover.hr.SeatRelease;
import ae.mover.hr.TaskRealignment;
import ae.mover.org.OrganizationService;
import ae.mover.security.Actor;
import ae.mover.security.IdentityService;
import ae.mover.security.OidcClient;

/**
 * V47 Oracle-unit import against the real HTTP/service/projection path and the existing disposable PostgreSQL/OpenFGA
 * fixtures. Every source identifier is generated or explicitly synthetic. Files live below the test storage root: the
 * live staged dataset is never read, and no Oracle connection or live unit import is configured or attempted.
 */
@Import(OracleUnitImportIT.ProjectionFaults.class)
class OracleUnitImportIT extends IntegrationTest {

    private static final String REASON = "استبدال جهات اختبارية موثق بالكامل";
    private static final AtomicBoolean FAIL_AFTER_PROJECTION = new AtomicBoolean();

    /** Fault injection happens after the real organization projection, so rollback must undo actual writes. */
    @TestConfiguration(proxyBeanMethods = false)
    static class ProjectionFaults {
        @Bean
        @Primary
        HrProjection faultInjectingHrProjection(JdbcClient jdbc, Clock clock, AccessService access,
                                                  TaskRealignment realignment, AuditService audit, SeatRelease seats) {
            return new HrProjection(jdbc, clock, access, realignment, audit, seats) {
                @Override
                public OrganizationResult applyOrganizations(UUID snapshot, Set<String> cycleUnits,
                                                              boolean retireUnmatchedLocal) {
                    OrganizationResult result = super.applyOrganizations(snapshot, cycleUnits, retireUnmatchedLocal);
                    if (FAIL_AFTER_PROJECTION.get()) {
                        throw new InjectedProjectionFailure("injected failure after organization projection");
                    }
                    return result;
                }
            };
        }
    }

    static final class InjectedProjectionFailure extends RuntimeException {
        InjectedProjectionFailure(String message) {
            super(message);
        }
    }

    @Autowired
    OracleUnitImportService imports;
    @Autowired
    HrSyncService sync;
    @Autowired
    HrProjection projection;
    @Autowired
    AccessService access;
    @Autowired
    OrganizationService organizations;
    @Autowired
    IdentityService identities;

    @Value("${mover.storage.root}")
    String storageRoot;

    final List<Path> files = new ArrayList<>();
    String rootExternal;
    UUID root;
    UUID previousSnapshot;
    UUID sourceId;
    UUID mappingId;
    UUID adminId;
    String adminRole;
    String readerRole;
    Api admin;
    Api reader;

    @BeforeEach
    void fixtures() {
        FAIL_AFTER_PROJECTION.set(false);
        // Mirror lineage is shared test infrastructure. Clear only the throw-away mirror, never any named application DB.
        jdbc.sql("delete from oracle_unit_import_run").update();
        jdbc.sql("delete from hr_sync_issue").update();
        jdbc.sql("delete from hr_unit").update();
        jdbc.sql("delete from hr_person").update();
        jdbc.sql("delete from hr_snapshot_scope").update();
        jdbc.sql("delete from hr_snapshot").update();
        jdbc.sql("delete from hr_sync_run").update();
        jdbc.sql("delete from hr_mapping_version").update();
        jdbc.sql("delete from hr_source").update();
        // A publication is intentionally installation-wide. Retire leftovers from earlier shared-DB tests as fixture setup;
        // scenarios below create every active unit they use, and non-effect assertions still fingerprint all business rows.
        tx.executeWithoutResult(s -> {
            jdbc.sql("select set_config('tmrkz.hr_projection', 'on', true)").query().singleRow();
            jdbc.sql("update organization set status = 'RETIRED' where status = 'ACTIVE'").update();
        });

        rootExternal = uid("root");
        root = unitOrg(rootExternal, "Synthetic root " + sfx, null, "LOCAL", "ACTIVE");
        adminRole = role("OUI_ADMIN", "ALL", "CONFIGURE", "VIEW", "AUDIT", "MANAGE_ACCESS");
        readerRole = role("OUI_READER", "ORGANIZATION", "VIEW", "AUDIT");
        adminId = person("oui-admin", adminRole, root);
        person("oui-reader", readerRole, root);
        admin = login("oui-admin");
        reader = login("oui-reader");
        publishedBaseMirror();
    }

    @AfterEach
    void cleanFilesAndSource() throws IOException {
        FAIL_AFTER_PROJECTION.set(false);
        // Defence in depth if a fixture is changed later: a disabled source can never be read by a scheduled/sign-in path.
        jdbc.sql("update hr_source set enabled = false").update();
        // Import runs reference hr_snapshot; other suites on the shared throw-away DB reset the HR mirror with
        // "delete from hr_snapshot", which these provenance rows would otherwise block.
        jdbc.sql("delete from oracle_unit_import_run").update();
        for (Path file : files) {
            Files.deleteIfExists(file);
        }
        files.clear();
    }

    // ---- synthetic files and mirror fixtures ----------------------------------------------------------

    private static String path(String... ids) {
        return "\\" + String.join("\\", ids);
    }

    private static Map<String, Object> unit(String id, String name, String sortOrder, String status, String main) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("external_unit_id", id);
        row.put("name", name);
        row.put("sort_order", sortOrder);
        row.put("status", status);
        row.put("main_unit_id", main);
        return row;
    }

    private static Map<String, String> contract() {
        Map<String, String> out = new LinkedHashMap<>();
        out.put("external_unit_id", "ID");
        out.put("name", "NAME");
        out.put("sort_order", "SORT_ORDER");
        out.put("status", "STATUS");
        out.put("main_unit_id", "MAIN_UNIT_ID");
        return out;
    }

    private static Map<String, Object> document(List<Map<String, Object>> rows, String source) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("schemaVersion", "tmrkz-oracle-unit-mirror-v1");
        out.put("source", source);
        out.put("sourceSyncedAt", "1767225600");
        out.put("sourceSyncedAtUtc", "2026-01-01T00:00:00Z");
        out.put("sourceColumnContract", contract());
        out.put("units", rows);
        return out;
    }

    private Map<String, Object> payload(List<Map<String, Object>> rows) {
        return document(rows, "synthetic-unit-file-" + sfx);
    }

    private String writePayload(String label, Map<String, Object> document) {
        String key = "unit-import/synthetic-" + sfx + "-" + label + ".json";
        Path file = Path.of(storageRoot).resolve(key).normalize();
        try {
            Files.createDirectories(file.getParent());
            Files.writeString(file, write(document));
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        files.add(file);
        return key;
    }

    private String simplePayload(String label) {
        return writePayload(label, payload(List.of(
                unit(rootExternal, "Synthetic root " + sfx, path(rootExternal), "1", rootExternal),
                unit(uid("child"), "Synthetic child " + sfx, path(rootExternal, uid("child")), "1", null))));
    }

    private String uid(String value) {
        return "U" + sfx + "-" + value;
    }

    private UUID unitOrg(String externalId, String name, UUID parent, String source, String status) {
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into organization(id, code, name, parent_id, status, valid_from, source, source_external_id)
                values (:id, :code, :name, :parent, :status, '2026-01-01T00:00:00Z', :source, :external)""")
                .param("id", id).param("code", "HR-" + externalId).param("name", name).param("parent", parent)
                .param("status", status).param("source", source).param("external", externalId).update();
        return id;
    }

    private void publishedBaseMirror() {
        sourceId = UUID.randomUUID();
        mappingId = UUID.randomUUID();
        UUID run = UUID.randomUUID();
        previousSnapshot = UUID.randomUUID();
        jdbc.sql("""
                insert into hr_source(id, name, enabled, last_success_at)
                values (:id, :name, false, now() - interval '1 hour')""").param("id", sourceId)
                .param("name", "disabled synthetic unit source " + sfx).update();
        jdbc.sql("""
                insert into hr_mapping_version(id, source_id, version, status, fields, active_rules)
                values (:id, :source, 1, 'PUBLISHED', '[]'::jsonb, '{}'::jsonb)""")
                .param("id", mappingId).param("source", sourceId).update();
        jdbc.sql("""
                insert into hr_sync_run(id, source_id, mapping_version_id, trigger, status, started_at, finished_at, snapshot_id)
                values (:id, :source, :mapping, 'MANUAL', 'SUCCEEDED', now() - interval '1 hour', now() - interval '1 hour', :snapshot)""")
                .param("id", run).param("source", sourceId).param("mapping", mappingId).param("snapshot", previousSnapshot).update();
        jdbc.sql("""
                insert into hr_snapshot(id, origin, run_id, mapping_version_id, status, unit_count, active_unit_count, published_at)
                values (:id, 'ORACLE_SYNC', :run, :mapping, 'PUBLISHED', 1, 1, now() - interval '1 hour')""")
                .param("id", previousSnapshot).param("run", run).param("mapping", mappingId).update();
        addPreviousUnit(rootExternal, "Synthetic root " + sfx, null, "1", rootExternal);
    }

    private void addPreviousUnit(String externalId, String name, String parent, String rawStatus, String main) {
        jdbc.sql("""
                insert into hr_unit(snapshot_id, external_id, code, name, parent_external_id, status_raw, active, level,
                                    is_main, main_external_id)
                values (:snapshot, :external, :code, :name, :parent, :raw, :active, :level, :mainFlag, :main)""")
                .param("snapshot", previousSnapshot).param("external", externalId).param("code", "HR-" + externalId)
                .param("name", name).param("parent", parent).param("raw", rawStatus)
                .param("active", "1".equals(rawStatus)).param("level", parent == null ? 1 : 2)
                .param("mainFlag", externalId.equals(main)).param("main", main).update();
        jdbc.sql("""
                update hr_snapshot set unit_count = (select count(*) from hr_unit where snapshot_id = :snapshot),
                       active_unit_count = (select count(*) from hr_unit where snapshot_id = :snapshot and active)
                where id = :snapshot""").param("snapshot", previousSnapshot).update();
    }

    private UUID mirrorSnapshot(String runStatus, String snapshotStatus) {
        UUID run = UUID.randomUUID();
        UUID snapshot = UUID.randomUUID();
        jdbc.sql("""
                insert into hr_sync_run(id, source_id, mapping_version_id, trigger, status, started_at, snapshot_id)
                values (:id, :source, :mapping, 'SCHEDULED', :status, now() - interval '2 hours', :snapshot)""")
                .param("id", run).param("source", sourceId).param("mapping", mappingId)
                .param("status", runStatus).param("snapshot", snapshot).update();
        jdbc.sql("""
                insert into hr_snapshot(id, origin, run_id, mapping_version_id, status)
                values (:id, 'ORACLE_SYNC', :run, :mapping, :status)""")
                .param("id", snapshot).param("run", run).param("mapping", mappingId).param("status", snapshotStatus).update();
        return snapshot;
    }

    /** One linked HR person with every current mirror field, a stable affiliation and a stable identity-link UUID. */
    private UUID hraperson(String key, UUID org) {
        UUID person = UUID.randomUUID();
        UUID identity = UUID.randomUUID();
        String external = "P" + sfx + "-" + key;
        jdbc.sql("""
                insert into person(id, employee_no, display_name, username, source, source_external_id, hr_unavailable)
                values (:id, :employee, :name, :username, 'HR', :external, 'Synthetic leave')""")
                .param("id", person).param("employee", "N" + sfx + "-" + key).param("name", "Synthetic person " + key)
                .param("username", "hr-" + key + "-" + sfx).param("external", external).update();
        jdbc.sql("""
                insert into affiliation(id, person_id, organization_id, position_id, position_title, valid_from)
                values (:id, :person, :org, :position, 'Synthetic position', '2026-01-01T00:00:00Z')""")
                .param("id", UUID.randomUUID()).param("person", person).param("org", org).param("position", "POS-" + key).update();
        jdbc.sql("""
                insert into identity_link(id, person_id, issuer, subject, method)
                values (:id, :person, :issuer, :subject, 'ENTERPRISE_KEY')""")
                .param("id", identity).param("person", person).param("issuer", "https://identity.test/" + sfx)
                .param("subject", "subject-" + key + "-" + sfx).update();
        jdbc.sql("""
                insert into hr_person(snapshot_id, external_id, employee_number, legacy_employee_number, domain_account,
                                      full_name, unit_external_id, position_id, position_title, job_title, status_text, active,
                                      leave_status, rank_name)
                select :snapshot, :external, :employee, :legacy, :account, :fullName, o.source_external_id,
                       :position, 'Synthetic position', 'Synthetic job', 'Synthetic serving', true, 'Synthetic leave',
                       'Synthetic rank'
                from organization o where o.id = :org""")
                .param("snapshot", previousSnapshot).param("external", external).param("employee", "N" + sfx + "-" + key)
                .param("legacy", "L" + sfx + "-" + key).param("account", ("acct-" + key + "-" + sfx).toUpperCase())
                .param("fullName", "Synthetic person " + key).param("org", org).param("position", "POS-" + key).update();
        jdbc.sql("insert into hr_snapshot_scope(snapshot_id, external_id) values (:snapshot, :external)")
                .param("snapshot", previousSnapshot).param("external", external).update();
        recomputePeopleCounts(previousSnapshot);
        return person;
    }

    private void recomputePeopleCounts(UUID snapshot) {
        jdbc.sql("""
                update hr_snapshot set person_count = (select count(*) from hr_person where snapshot_id = :snapshot),
                       active_person_count = (select count(*) from hr_person where snapshot_id = :snapshot and active)
                where id = :snapshot""").param("snapshot", snapshot).update();
    }

    // ---- endpoint and state assertions ----------------------------------------------------------------

    private Res preview(String key) {
        return admin.post("/hr/unit-imports/preview", Map.of("storageKey", key, "reason", REASON));
    }

    private JsonNode goodPreview(String key) {
        Res response = preview(key);
        assertThat(response.status()).as(response.toString()).isEqualTo(200);
        assertThat(response.body().path("status").asText()).as(response.toString()).isEqualTo("PREVIEWED");
        assertThat(response.body().path("liveOracleRead").asBoolean()).isFalse();
        return response.body();
    }

    private Res publish(JsonNode preview) {
        return admin.post("/hr/unit-imports/" + preview.path("runId").asText() + "/publish", Map.of());
    }

    private static long effect(JsonNode result, String name) {
        return result.path("effects").path(name).asLong();
    }

    private static String reason(Res response) {
        return response.body().path("details").path("reason").asText();
    }

    private UUID snapshot(JsonNode result) {
        return UUID.fromString(result.path("snapshotId").asText());
    }

    private UUID run(JsonNode result) {
        return UUID.fromString(result.path("runId").asText());
    }

    private UUID orgOf(String externalId) {
        return jdbc.sql("select id from organization where source = 'HR' and source_external_id = :external")
                .param("external", externalId).query(UUID.class).single();
    }

    private List<String> published() {
        return jdbc.sql("select id::text from hr_snapshot where status = 'PUBLISHED' order by id")
                .query(String.class).list();
    }

    private String tableDigest(String table) {
        // Table names are fixed internal test inputs, not request/source data.
        return jdbc.sql("select md5(coalesce(string_agg(q::text, E'\\n' order by q::text), '')) from (select * from "
                + table + ") q").query(String.class).single();
    }

    private Map<String, String> businessState() {
        Map<String, String> out = new LinkedHashMap<>();
        for (String table : List.of("organization", "person", "affiliation", "identity_link", "unit_member", "membership",
                "site_responsibility", "hr_person", "hr_snapshot_scope")) {
            out.put(table, tableDigest(table));
        }
        return out;
    }

    private String sourceState() {
        return tableDigest("hr_source");
    }

    private void assertRunStillPreviewed(JsonNode preview) {
        assertThat(jdbc.sql("select status from oracle_unit_import_run where id = :id").param("id", run(preview))
                .query(String.class).single()).isEqualTo("PREVIEWED");
        assertThat(jdbc.sql("select status from hr_snapshot where id = :id").param("id", snapshot(preview))
                .query(String.class).single()).isEqualTo("PREVIEWED");
    }

    private void assertSourceDisabledAndUnchanged(String before) {
        assertThat(sourceState()).isEqualTo(before);
        Map<String, Object> source = jdbc.sql("select enabled, last_success_at from hr_source where id = :id")
                .param("id", sourceId).query().singleRow();
        assertThat(source.get("enabled")).isEqualTo(false);
        assertThat(source.get("last_success_at")).isNotNull();
    }

    private void assertNoSourceIdentifiers(JsonNode previewResult, List<String> externalIds) {
        assertThat(previewResult.has("storageKey")).isFalse();
        assertThat(previewResult.has("source")).isFalse();
        assertThat(previewResult.has("units")).isFalse();
        assertThat(previewResult.path("effects").path("peopleImported").asLong()).isZero();
        String body = previewResult.toString();
        for (String externalId : externalIds) {
            assertThat(body).doesNotContain(externalId);
        }
    }

    // ---- authorisation, staging and validation --------------------------------------------------------

    @Test
    @DisplayName("OUI-01: CONFIGURE and reason gate real endpoints; aggregate preview survives disabled-source STAGING cleanup")
    void authorizationStagingCleanupAndMainReferences() {
        String satellite = uid("satellite");
        String child = uid("child-main-null");
        String key = writePayload("authorised", payload(List.of(
                unit(rootExternal, "Synthetic root " + sfx, path(rootExternal), "1", rootExternal),
                unit(satellite, "Synthetic satellite " + sfx, path(satellite), "1", rootExternal),
                unit(child, "Synthetic child " + sfx, path(rootExternal, child), "1", null))));
        Map<String, String> before = businessState();
        List<String> publishedBefore = published();

        assertThat(reader.post("/hr/unit-imports/preview", Map.of("storageKey", key, "reason", REASON)).status())
                .as("CONFIGURE is required even though the reader has VIEW and AUDIT").isEqualTo(403);
        Res shortReason = admin.post("/hr/unit-imports/preview", Map.of("storageKey", key, "reason", "قصير"));
        assertThat(shortReason.status()).isEqualTo(400);
        assertThat(reason(shortReason)).isEqualTo("UNIT_IMPORT_REASON");
        assertThat(jdbc.sql("select count(*) from oracle_unit_import_run").query(Long.class).single()).isZero();
        assertThat(businessState()).isEqualTo(before);

        JsonNode preview = goodPreview(key);
        assertNoSourceIdentifiers(preview, List.of(rootExternal, satellite, child));
        assertThat(effect(preview, "units")).isEqualTo(3);
        assertThat(effect(preview, "created")).isEqualTo(2);
        assertThat(effect(preview, "adopted")).isEqualTo(1);
        assertThat(effect(preview, "updated")).isEqualTo(1);
        assertThat(businessState()).as("preview writes no business or person projection").isEqualTo(before);

        Map<String, Object> staged = jdbc.sql("""
                select s.origin, s.status, h.code, h.name, h.name_en, h.parent_external_id, h.status_raw, h.active,
                       h.level, h.is_main, h.main_external_id
                from hr_snapshot s join hr_unit h on h.snapshot_id = s.id
                where s.id = :snapshot and h.external_id = :external""")
                .param("snapshot", snapshot(preview)).param("external", satellite).query().singleRow();
        assertThat(staged).containsEntry("origin", "ORACLE_UNIT_IMPORT").containsEntry("status", "PREVIEWED")
                .containsEntry("code", "HR-" + satellite).containsEntry("name", "Synthetic satellite " + sfx)
                .containsEntry("name_en", null).containsEntry("parent_external_id", null).containsEntry("status_raw", "1")
                .containsEntry("active", true).containsEntry("level", 1).containsEntry("is_main", false)
                .containsEntry("main_external_id", rootExternal);
        assertThat(jdbc.sql("select parent_external_id is null as is_root, is_main from hr_unit where snapshot_id = :s and external_id = :e")
                .param("s", snapshot(preview)).param("e", rootExternal).query().singleRow())
                .containsEntry("is_root", true).containsEntry("is_main", true);
        assertThat(jdbc.sql("select parent_external_id, is_main, main_external_id from hr_unit where snapshot_id = :s and external_id = :e")
                .param("s", snapshot(preview)).param("e", child).query().singleRow())
                .containsEntry("parent_external_id", rootExternal).containsEntry("is_main", false)
                .containsEntry("main_external_id", null);

        assertThat(reader.post("/hr/unit-imports/" + preview.path("runId").asText() + "/publish", Map.of()).status())
                .as("CONFIGURE is independently required at publication").isEqualTo(403);
        assertRunStillPreviewed(preview);

        UUID staging = mirrorSnapshot("RUNNING", "STAGING");
        jdbc.sql("insert into hr_unit(snapshot_id, external_id, name, active) values (:s, :id, 'stale synthetic', true)")
                .param("s", staging).param("id", uid("stale-staging")).update();
        String sourceBefore = sourceState();
        UUID cleanupRun = sync.run("SCHEDULED", null, null); // source is disabled: recovery only, no adapter/live read
        assertThat(jdbc.sql("select status from hr_sync_run where id = :id").param("id", cleanupRun)
                .query(String.class).single()).isEqualTo("FAILED");
        assertThat(jdbc.sql("select status from hr_snapshot where id = :id").param("id", staging)
                .query(String.class).single()).isEqualTo("DISCARDED");
        assertThat(jdbc.sql("select count(*) from hr_unit where snapshot_id = :id").param("id", staging)
                .query(Long.class).single()).isZero();
        assertRunStillPreviewed(preview);
        assertThat(jdbc.sql("select count(*) from hr_unit where snapshot_id = :id").param("id", snapshot(preview))
                .query(Long.class).single()).isEqualTo(3);
        assertSourceDisabledAndUnchanged(sourceBefore);

        Res committed = publish(preview);
        assertThat(committed.status()).as(committed.toString()).isEqualTo(200);
        assertThat(committed.body().path("status").asText()).isEqualTo("PUBLISHED");
        assertThat(published()).containsExactly(preview.path("snapshotId").asText()).isNotEqualTo(publishedBefore);
        assertThat(jdbc.sql("select parent_id from organization where id = :id").param("id", orgOf(satellite))
                .query().singleRow().get("parent_id")).as("MAIN_UNIT_ID never supplies a parent").isNull();
        assertThat(jdbc.sql("select parent_id from organization where id = :id").param("id", orgOf(child))
                .query(UUID.class).single()).isEqualTo(orgOf(rootExternal));
        assertSourceDisabledAndUnchanged(sourceBefore);
    }

    private static List<Map<String, Object>> ordinaryRows() {
        List<Map<String, Object>> ordinary = new ArrayList<>();
        ordinary.add(unit("SYNTHETIC-ROOT", "Synthetic root", path("SYNTHETIC-ROOT"), "1", "SYNTHETIC-ROOT"));
        ordinary.add(unit("SYNTHETIC-CHILD", "Synthetic child", path("SYNTHETIC-ROOT", "SYNTHETIC-CHILD"), "1", null));
        return ordinary;
    }

    static Stream<Arguments> invalidDocuments() {
        Map<String, Object> extraTop = document(ordinaryRows(), "synthetic-invalid");
        extraTop.put("people", List.of());
        Map<String, Object> personShaped = document(ordinaryRows(), "synthetic-invalid");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> personRows = (List<Map<String, Object>>) personShaped.get("units");
        personRows.get(0).put("external_person_id", "NOT-A-REAL-PERSON");
        Map<String, Object> duplicate = document(ordinaryRows(), "synthetic-invalid");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> duplicateRows = (List<Map<String, Object>>) duplicate.get("units");
        duplicateRows.add(unit("SYNTHETIC-ROOT", "Duplicate synthetic root", path("SYNTHETIC-ROOT"), "1", null));
        Map<String, Object> badPath = document(ordinaryRows(), "synthetic-invalid");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> pathRows = (List<Map<String, Object>>) badPath.get("units");
        pathRows.get(1).put("sort_order", path("SYNTHETIC-ROOT", "NOT-THE-CHILD"));
        Map<String, Object> wrongContract = document(ordinaryRows(), "synthetic-invalid");
        @SuppressWarnings("unchecked")
        Map<String, String> columns = (Map<String, String>) wrongContract.get("sourceColumnContract");
        columns.put("name", "TITLE");

        List<Map<String, Object>> cycleRows = new ArrayList<>();
        cycleRows.add(unit("SYNTHETIC-R0", "Synthetic root", path("SYNTHETIC-R0"), "1", null));
        cycleRows.add(unit("SYNTHETIC-A", "Synthetic A", path("SYNTHETIC-B", "SYNTHETIC-A"), "1", null));
        cycleRows.add(unit("SYNTHETIC-B", "Synthetic B", path("SYNTHETIC-A", "SYNTHETIC-B"), "1", null));
        Map<String, Object> cycle = document(cycleRows, "synthetic-invalid");

        return Stream.of(Arguments.of("undeclared top field", extraTop, "UNIT_FILE_FIELDS"),
                Arguments.of("person-shaped unit row", personShaped, "UNIT_FILE_ROW_FIELDS"),
                Arguments.of("duplicate ID", duplicate, "UNIT_DUPLICATE_ID"),
                Arguments.of("bad hierarchy path", badPath, "UNIT_FILE_PATH"),
                Arguments.of("tree cycle with another valid root", cycle, "UNIT_CYCLE"),
                Arguments.of("wrong source column contract", wrongContract, "UNIT_FILE_CONTRACT"));
    }

    @ParameterizedTest(name = "OUI-02: {0} is refused atomically")
    @MethodSource("invalidDocuments")
    void invalidPayloadsHaveNoEffects(String label, Map<String, Object> document, String expectedReason) {
        String key = writePayload(label.replace(' ', '-'), document);
        Map<String, String> before = businessState();
        List<String> publishedBefore = published();
        long snapshots = jdbc.sql("select count(*) from hr_snapshot").query(Long.class).single();
        Res refused = preview(key);
        assertThat(refused.status()).as(refused.toString()).isEqualTo(400);
        assertThat(reason(refused)).isEqualTo(expectedReason);
        assertThat(businessState()).isEqualTo(before);
        assertThat(published()).isEqualTo(publishedBefore);
        assertThat(jdbc.sql("select count(*) from hr_snapshot").query(Long.class).single()).isEqualTo(snapshots);
        assertThat(jdbc.sql("select count(*) from oracle_unit_import_run").query(Long.class).single()).isZero();
    }

    // ---- preview/publish evidence gates ----------------------------------------------------------------

    @Test
    @DisplayName("OUI-03: changed file hash and source metadata refuse commit without replacing the public snapshot")
    void payloadChangedAfterPreview() {
        String key = simplePayload("changed-metadata");
        JsonNode preview = goodPreview(key);
        Map<String, String> before = businessState();
        List<String> publishedBefore = published();
        String sourceBefore = sourceState();
        Map<String, Object> changed = payload(List.of(
                unit(rootExternal, "Synthetic root " + sfx, path(rootExternal), "1", rootExternal),
                unit(uid("child"), "Synthetic child " + sfx, path(rootExternal, uid("child")), "1", null)));
        changed.put("sourceSyncedAt", "1767229200");
        changed.put("sourceSyncedAtUtc", "2026-01-01T01:00:00Z");
        writePayload("changed-metadata", changed);

        Res refused = publish(preview);
        assertThat(refused.status()).isEqualTo(400);
        assertThat(reason(refused)).isEqualTo("UNIT_IMPORT_PAYLOAD_CHANGED");
        assertRunStillPreviewed(preview);
        assertThat(businessState()).isEqualTo(before);
        assertThat(published()).isEqualTo(publishedBefore);
        assertSourceDisabledAndUnchanged(sourceBefore);
    }

    @Test
    @DisplayName("OUI-04: a newer organization change makes the preview stale and is not overwritten by commit")
    void staleStructureAfterPreview() {
        JsonNode preview = goodPreview(simplePayload("stale-structure"));
        UUID newer = org("NEWER-AFTER-PREVIEW", null);
        String newerName = jdbc.sql("select name from organization where id = :id").param("id", newer)
                .query(String.class).single();
        Map<String, String> afterNewerChange = businessState();
        List<String> publicBefore = published();

        Res refused = publish(preview);
        assertThat(refused.status()).isEqualTo(400);
        assertThat(reason(refused)).isEqualTo("UNIT_IMPORT_STALE");
        assertRunStillPreviewed(preview);
        assertThat(businessState()).isEqualTo(afterNewerChange);
        assertThat(jdbc.sql("select name || '|' || status from organization where id = :id").param("id", newer)
                .query(String.class).single()).isEqualTo(newerName + "|ACTIVE");
        assertThat(published()).isEqualTo(publicBefore);
    }

    @Test
    @DisplayName("OUI-05: a changed staged row refuses impact verification; INVALID collision previews cannot publish")
    void stagedRowAndUnsafePreviewGates() {
        JsonNode preview = goodPreview(simplePayload("tampered-row"));
        jdbc.sql("update hr_unit set name = 'tampered staged synthetic name' where snapshot_id = :s and external_id = :e")
                .param("s", snapshot(preview)).param("e", rootExternal).update();
        Map<String, String> before = businessState();
        List<String> publicBefore = published();
        Res refused = publish(preview);
        assertThat(refused.status()).isEqualTo(400);
        assertThat(reason(refused)).isEqualTo("UNIT_IMPORT_STAGING_CHANGED");
        assertRunStillPreviewed(preview);
        assertThat(businessState()).isEqualTo(before);
        assertThat(published()).isEqualTo(publicBefore);

        UUID colliding = org("LOCAL-COLLISION", null);
        String incoming = uid("collision-code");
        jdbc.sql("update organization set code = :code where id = :id")
                .param("code", "HR-" + incoming).param("id", colliding).update();
        String key = writePayload("unsafe-collision", payload(List.of(
                unit(incoming, "Synthetic collision " + sfx, path(incoming), "1", null))));
        Map<String, String> beforeInvalidCommit = businessState();
        Res invalid = preview(key);
        assertThat(invalid.status()).isEqualTo(200);
        assertThat(invalid.body().path("status").asText()).isEqualTo("INVALID");
        assertThat(effect(invalid.body(), "sourceCodeCollisions")).isPositive();
        assertNoSourceIdentifiers(invalid.body(), List.of(incoming));
        Res unsafe = publish(invalid.body());
        assertThat(unsafe.status()).isEqualTo(400);
        assertThat(reason(unsafe)).isEqualTo("UNIT_IMPORT_NOT_PREVIEWED");
        assertThat(businessState()).isEqualTo(beforeInvalidCommit);
        assertThat(published()).isEqualTo(publicBefore);
    }

    // ---- exact organization projection, idempotency and generated scale --------------------------------

    @Test
    @DisplayName("OUI-06: create/update/reparent counts match projection, UUIDs survive, one row snapshot publishes, repeat is inert")
    void projectionCountsAndRepeatCommit() {
        String rename = uid("rename");
        String move = uid("move");
        String newParent = uid("new-parent");
        String created = uid("created");
        UUID renameOrg = unitOrg(rename, "Old synthetic name " + sfx, root, "HR", "ACTIVE");
        UUID moveOrg = unitOrg(move, "Movable synthetic unit " + sfx, root, "HR", "ACTIVE");
        addPreviousUnit(rename, "Old synthetic name " + sfx, rootExternal, "1", null);
        addPreviousUnit(move, "Movable synthetic unit " + sfx, rootExternal, "1", null);
        String key = writePayload("projection-counts", payload(List.of(
                unit(rootExternal, "Synthetic root " + sfx, path(rootExternal), "1", rootExternal),
                unit(rename, "Renamed synthetic unit " + sfx, path(rootExternal, rename), "1", null),
                unit(newParent, "New synthetic parent " + sfx, path(rootExternal, newParent), "1", null),
                unit(move, "Movable synthetic unit " + sfx, path(rootExternal, newParent, move), "1", null),
                unit(created, "Created synthetic child " + sfx, path(rootExternal, newParent, created), "1", null))));
        JsonNode preview = goodPreview(key);
        assertThat(effect(preview, "units")).isEqualTo(5);
        assertThat(effect(preview, "created")).isEqualTo(2);
        assertThat(effect(preview, "adopted")).isEqualTo(1);
        assertThat(effect(preview, "updated")).isEqualTo(2);
        assertThat(effect(preview, "reparented")).isEqualTo(1);
        assertThat(effect(preview, "retired")).isZero();
        String sourceBefore = sourceState();

        Res committed = publish(preview);
        assertThat(committed.status()).as(committed.toString()).isEqualTo(200);
        assertThat(effect(committed.body(), "organizationsCreated")).isEqualTo(effect(preview, "created"));
        assertThat(effect(committed.body(), "organizationsUpdated")).isEqualTo(effect(preview, "updated"));
        assertThat(effect(committed.body(), "organizationsRetired")).isEqualTo(effect(preview, "retired"));
        assertThat(effect(committed.body(), "membershipsEnded")).isZero();
        assertThat(effect(committed.body(), "responsibilitiesClosed")).isZero();
        assertThat(orgOf(rename)).isEqualTo(renameOrg);
        assertThat(orgOf(move)).isEqualTo(moveOrg);
        assertThat(jdbc.sql("select name from organization where id = :id").param("id", renameOrg)
                .query(String.class).single()).isEqualTo("Renamed synthetic unit " + sfx);
        assertThat(jdbc.sql("select parent_id from organization where id = :id").param("id", moveOrg)
                .query(UUID.class).single()).isEqualTo(orgOf(newParent));
        assertThat(orgOf(created)).isNotNull();
        assertThat(orgOf(rootExternal)).isEqualTo(root);
        assertThat(published()).containsExactly(preview.path("snapshotId").asText());
        assertThat(jdbc.sql("select status from hr_snapshot where id = :id").param("id", previousSnapshot)
                .query(String.class).single()).isEqualTo("SUPERSEDED");
        assertSourceDisabledAndUnchanged(sourceBefore);

        Map<String, String> afterFirst = businessState();
        String auditCount = jdbc.sql("select count(*) from audit_event where action = 'ORACLE_UNIT_IMPORT_PUBLISHED'")
                .query(String.class).single();
        Res repeated = publish(preview);
        assertThat(repeated.status()).as(repeated.toString()).isEqualTo(200);
        assertThat(repeated.body().path("runId").asText()).isEqualTo(committed.body().path("runId").asText());
        assertThat(repeated.body().path("snapshotId").asText()).isEqualTo(committed.body().path("snapshotId").asText());
        assertThat(repeated.body().path("payloadSha256").asText()).isEqualTo(committed.body().path("payloadSha256").asText());
        assertThat(businessState()).isEqualTo(afterFirst);
        assertThat(published()).hasSize(1);
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'ORACLE_UNIT_IMPORT_PUBLISHED'")
                .query(String.class).single()).isEqualTo(auditCount);
        assertSourceDisabledAndUnchanged(sourceBefore);
        assertThat(repeated.body()).as("an idempotent replay returns the same committed result").isEqualTo(committed.body());
    }

    @Test
    @DisplayName("OUI-07: generated 20,257-unit file stages and publishes through real batches without exposing source IDs")
    void generatedLargeUnitFile() {
        final int children = 20_256;
        List<Map<String, Object>> rows = new ArrayList<>(children + 1);
        rows.add(unit(rootExternal, "Synthetic root " + sfx, path(rootExternal), "1", rootExternal));
        int inactive = 0;
        for (int i = 1; i <= children; i++) {
            String id = uid(String.format("L%05d", i));
            String rawStatus = i % 97 == 0 ? "2" : "1";
            if (!"1".equals(rawStatus)) {
                inactive++;
            }
            rows.add(unit(id, "Generated synthetic unit " + i + " " + sfx,
                    path(rootExternal, id), rawStatus, null));
        }
        String key = writePayload("generated-" + (children + 1), payload(rows));
        JsonNode preview = goodPreview(key);
        assertNoSourceIdentifiers(preview, List.of(rootExternal, uid("L00001"), uid("L20256")));
        assertThat(effect(preview, "units")).isEqualTo(children + 1L);
        assertThat(effect(preview, "activeUnits")).isEqualTo(children + 1L - inactive);
        assertThat(effect(preview, "created")).isEqualTo(children);
        assertThat(effect(preview, "adopted")).isEqualTo(1);
        assertThat(effect(preview, "updated")).isEqualTo(1);
        assertThat(effect(preview, "retired")).isZero();
        Map<String, Object> staged = jdbc.sql("""
                select count(*) as total, count(*) filter (where active) as active,
                       count(*) filter (where is_main) as mains,
                       count(*) filter (where main_external_id is null) as null_mains,
                       count(*) filter (where parent_external_id = :parent) as direct_children
                from hr_unit where snapshot_id = :snapshot""")
                .param("parent", rootExternal).param("snapshot", snapshot(preview)).query().singleRow();
        assertThat(((Number) staged.get("total")).longValue()).isEqualTo(children + 1L);
        assertThat(((Number) staged.get("active")).longValue()).isEqualTo(children + 1L - inactive);
        assertThat(((Number) staged.get("mains")).longValue()).isEqualTo(1);
        assertThat(((Number) staged.get("null_mains")).longValue()).isEqualTo(children);
        assertThat(((Number) staged.get("direct_children")).longValue()).isEqualTo(children);

        Res committed = publish(preview);
        assertThat(committed.status()).as(committed.toString()).isEqualTo(200);
        assertThat(effect(committed.body(), "organizationsCreated")).isEqualTo(children);
        assertThat(effect(committed.body(), "organizationsUpdated")).isEqualTo(1);
        assertThat(effect(committed.body(), "organizationsRetired")).isZero();
        assertThat(published()).containsExactly(preview.path("snapshotId").asText());
        Map<String, Object> snapshotRow = jdbc.sql("""
                select unit_count, active_unit_count, person_count, active_person_count from hr_snapshot where id = :id""")
                .param("id", snapshot(preview)).query().singleRow();
        assertThat(((Number) snapshotRow.get("unit_count")).longValue()).isEqualTo(children + 1L);
        assertThat(((Number) snapshotRow.get("active_unit_count")).longValue()).isEqualTo(children + 1L - inactive);
        assertThat(((Number) snapshotRow.get("person_count")).longValue()).isZero();
        assertThat(((Number) snapshotRow.get("active_person_count")).longValue()).isZero();
        assertThat(jdbc.sql("select count(*) from organization where source_external_id like :prefix")
                .param("prefix", "U" + sfx + "-%").query(Long.class).single()).isEqualTo(children + 1L);
    }

    // ---- people are carried, never projected -------------------------------------------------------------

    @Test
    @DisplayName("OUI-08: people, scopes, affiliations and identity/FK UUIDs are preserved verbatim; source metadata is untouched")
    void preservesPeopleAndNoPersonProjection() {
        String home = uid("person-home");
        UUID homeOrg = unitOrg(home, "Synthetic person home " + sfx, root, "HR", "ACTIVE");
        addPreviousUnit(home, "Synthetic person home " + sfx, rootExternal, "1", null);
        UUID person = hraperson("preserved", homeOrg);
        UUID affiliation = jdbc.sql("select id from affiliation where person_id = :p and valid_to is null")
                .param("p", person).query(UUID.class).single();
        UUID identity = jdbc.sql("select id from identity_link where person_id = :p").param("p", person)
                .query(UUID.class).single();
        String key = writePayload("person-preservation", payload(List.of(
                unit(rootExternal, "Synthetic root " + sfx, path(rootExternal), "1", rootExternal),
                unit(home, "Synthetic person home " + sfx, path(rootExternal, home), "1", null))));
        String sourceBefore = sourceState();
        Map<String, String> beforePreview = businessState();
        JsonNode preview = goodPreview(key);
        assertThat(businessState()).isEqualTo(beforePreview);
        assertThat(jdbc.sql("select count(*) from hr_person where snapshot_id = :s").param("s", snapshot(preview))
                .query(Long.class).single()).as("a preview does not copy or manufacture people").isZero();
        assertThat(jdbc.sql("select count(*) from hr_snapshot_scope where snapshot_id = :s").param("s", snapshot(preview))
                .query(Long.class).single()).isZero();
        String peopleBefore = tableDigest("person");
        String affiliationsBefore = tableDigest("affiliation");
        String identitiesBefore = tableDigest("identity_link");
        String membershipsBefore = tableDigest("membership");
        List<String> publicBefore = published();

        Res committed = publish(preview);
        assertThat(committed.status()).as(committed.toString()).isEqualTo(200);
        assertThat(effect(committed.body(), "peopleImported")).isZero();
        assertThat(tableDigest("person")).isEqualTo(peopleBefore);
        assertThat(tableDigest("affiliation")).isEqualTo(affiliationsBefore);
        assertThat(tableDigest("identity_link")).isEqualTo(identitiesBefore);
        assertThat(tableDigest("membership")).isEqualTo(membershipsBefore);
        assertThat(jdbc.sql("select id from person where id = :id").param("id", person).query(UUID.class).single())
                .isEqualTo(person);
        assertThat(jdbc.sql("select id from affiliation where id = :id").param("id", affiliation).query(UUID.class).single())
                .isEqualTo(affiliation);
        assertThat(jdbc.sql("select organization_id from affiliation where id = :id").param("id", affiliation)
                .query(UUID.class).single()).isEqualTo(homeOrg);
        assertThat(jdbc.sql("select id from identity_link where id = :id").param("id", identity).query(UUID.class).single())
                .isEqualTo(identity);

        List<Map<String, Object>> previousPeople = jdbc.sql("""
                select external_id, employee_number, legacy_employee_number, domain_account, full_name, unit_external_id,
                       position_id, position_title, job_title, status_text, active, leave_status, rank_name
                from hr_person where snapshot_id = :s order by external_id""")
                .param("s", previousSnapshot).query().listOfRows();
        List<Map<String, Object>> carriedPeople = jdbc.sql("""
                select external_id, employee_number, legacy_employee_number, domain_account, full_name, unit_external_id,
                       position_id, position_title, job_title, status_text, active, leave_status, rank_name
                from hr_person where snapshot_id = :s order by external_id""")
                .param("s", snapshot(preview)).query().listOfRows();
        assertThat(carriedPeople).isEqualTo(previousPeople).hasSize(1);
        assertThat(jdbc.sql("select external_id from hr_snapshot_scope where snapshot_id = :s")
                .param("s", previousSnapshot).query(String.class).list())
                .isEqualTo(jdbc.sql("select external_id from hr_snapshot_scope where snapshot_id = :s")
                        .param("s", snapshot(preview)).query(String.class).list());
        assertThat(jdbc.sql("select carried_person_snapshot_id from oracle_unit_import_run where id = :id")
                .param("id", run(preview)).query(UUID.class).single()).isEqualTo(previousSnapshot);
        assertThat(jdbc.sql("select status from hr_snapshot where id = :id").param("id", previousSnapshot)
                .query(String.class).single()).isEqualTo("SUPERSEDED");
        assertThat(published()).containsExactly(preview.path("snapshotId").asText()).isNotEqualTo(publicBefore);
        assertSourceDisabledAndUnchanged(sourceBefore);
    }

    // ---- explicit retirement versus ordinary HR projection ----------------------------------------------

    @Test
    @DisplayName("OUI-09: only unit-file cutover retires unmatched HR and LOCAL; ordinary HrProjection.apply leaves unrelated LOCAL alone")
    void explicitRetirementIsOperationScoped() {
        String unmatchedHr = uid("unmatched-hr");
        String unmatchedLocal = uid("unmatched-local");
        UUID hr = unitOrg(unmatchedHr, "Unmatched synthetic HR " + sfx, root, "HR", "ACTIVE");
        UUID local = unitOrg(unmatchedLocal, "Unmatched synthetic LOCAL " + sfx, root, "LOCAL", "ACTIVE");
        addPreviousUnit(unmatchedHr, "Unmatched synthetic HR " + sfx, rootExternal, "1", null);
        String key = writePayload("explicit-retirement", payload(List.of(
                unit(rootExternal, "Synthetic root " + sfx, path(rootExternal), "1", rootExternal))));
        JsonNode preview = goodPreview(key);
        assertThat(effect(preview, "retired")).isEqualTo(2);
        assertThat(effect(preview, "localRetired")).isEqualTo(1);
        Res committed = publish(preview);
        assertThat(committed.status()).as(committed.toString()).isEqualTo(200);
        assertThat(effect(committed.body(), "organizationsRetired")).isEqualTo(effect(preview, "retired"));
        assertThat(jdbc.sql("select status from organization where id = :id").param("id", hr)
                .query(String.class).single()).isEqualTo("RETIRED");
        assertThat(jdbc.sql("select status from organization where id = :id").param("id", local)
                .query(String.class).single()).isEqualTo("RETIRED");
        assertThat(orgOf(rootExternal)).isEqualTo(root);

        // A separate ordinary sync projection has no scope person changes and never opts into LOCAL retirement.
        String unrelated = uid("ordinary-unrelated-local");
        UUID ordinaryLocal = unitOrg(unrelated, "Ordinary unrelated LOCAL " + sfx, root, "LOCAL", "ACTIVE");
        Map<String, Object> before = jdbc.sql("select id, source, source_external_id, status, parent_id from organization where id = :id")
                .param("id", ordinaryLocal).query().singleRow();
        UUID ordinarySnapshot = mirrorSnapshot("SUCCEEDED", "STAGING");
        jdbc.sql("""
                insert into hr_unit(snapshot_id, external_id, code, name, active, level, is_main)
                values (:s, :external, :code, 'Synthetic root ordinary projection', true, 1, true)""")
                .param("s", ordinarySnapshot).param("external", rootExternal).param("code", "HR-" + rootExternal).update();
        String peopleBefore = tableDigest("person");
        tx.executeWithoutResult(s -> projection.apply(ordinarySnapshot, Set.of()));
        assertThat(jdbc.sql("select id, source, source_external_id, status, parent_id from organization where id = :id")
                .param("id", ordinaryLocal).query().singleRow()).isEqualTo(before);
        assertThat(tableDigest("person")).isEqualTo(peopleBefore);
    }

    @Test
    @DisplayName("OUI-10: retirement ends grants and site duty with history while bootstrap identity and recovery eligibility survive")
    void retirementEndsMembershipsAndResponsibilitiesWithoutIdentityLoss() {
        String retired = uid("retired-grant-unit");
        UUID retiredOrg = unitOrg(retired, "Retiring grant synthetic unit " + sfx, root, "HR", "ACTIVE");
        addPreviousUnit(retired, "Retiring grant synthetic unit " + sfx, rootExternal, "1", null);
        // Make this scenario's bootstrap grant the only active SYSTEM_ADMIN grant in the shared throw-away fixture.
        jdbc.sql("""
                update membership set valid_to = greatest(now(), valid_from + interval '1 second'),
                       ended_reason = 'SYNTHETIC_BOOTSTRAP_FIXTURE'
                where role_code = 'SYSTEM_ADMIN' and valid_from <= now() and (valid_to is null or valid_to > now())""").update();
        UUID bootstrapPerson = UUID.randomUUID();
        String login = "existing-bootstrap-" + sfx;
        jdbc.sql("""
                insert into person(id, employee_no, display_name, username, source, bootstrap)
                values (:id, :employee, 'Existing synthetic bootstrap', :username, 'LOCAL', true)""")
                .param("id", bootstrapPerson).param("employee", "BOOT-" + sfx).param("username", login).update();
        jdbc.sql("""
                insert into bootstrap_admin(login, expires_at, used_at, person_id)
                values (:login, now() + interval '24 hours', now() - interval '1 hour', :person)""")
                .param("login", login).param("person", bootstrapPerson).update();
        OidcClient.Identity existingIdentity = new OidcClient.Identity("https://identity.test/bootstrap-" + sfx,
                "existing-subject-" + sfx, "unmirrored-key-" + sfx, "Existing synthetic bootstrap", login,
                Instant.now(), null, "LOGIN", "/", null, false);
        jdbc.sql("""
                insert into identity_link(id, person_id, issuer, subject, method, linked_at)
                values (:id, :person, :issuer, :subject, 'BOOTSTRAP', now() - interval '1 hour')""")
                .param("id", UUID.randomUUID()).param("person", bootstrapPerson).param("issuer", existingIdentity.issuer())
                .param("subject", existingIdentity.subject()).update();
        UUID currentMembership = UUID.randomUUID();
        jdbc.sql("""
                insert into membership(id, person_id, organization_id, role_code, valid_from, valid_to, follows_affiliation)
                values (:id, :person, :org, 'SYSTEM_ADMIN', now() - interval '1 hour', now() + interval '71 hours', false)""")
                .param("id", currentMembership).param("person", bootstrapPerson).param("org", retiredOrg).update();
        UUID futureMembership = membership(bootstrapPerson, readerRole, retiredOrg, null);
        jdbc.sql("update membership set valid_from = now() + interval '1 day' where id = :id")
                .param("id", futureMembership).update();
        UUID affiliation = UUID.randomUUID();
        jdbc.sql("insert into affiliation(id, person_id, organization_id, valid_from) values (:id, :p, :o, now() - interval '1 hour')")
                .param("id", affiliation).param("p", bootstrapPerson).param("o", retiredOrg).update();
        UUID site = site("OUI-RETIRED-SITE", null, retiredOrg);
        UUID responsibility = jdbc.sql("select id from site_responsibility where site_id = :s and valid_to is null")
                .param("s", site).query(UUID.class).single();
        String key = writePayload("retirement-consequences", payload(List.of(
                unit(rootExternal, "Synthetic root " + sfx, path(rootExternal), "1", rootExternal))));
        JsonNode preview = goodPreview(key);
        assertThat(effect(preview, "retired")).isEqualTo(1);
        assertThat(effect(preview, "membershipsEnding")).isEqualTo(1);
        assertThat(effect(preview, "configurePeopleAffected")).isEqualTo(1);
        assertThat(effect(preview, "responsibilitiesClosing")).isEqualTo(1);
        assertThat(effect(preview, "affiliationsPreservedWithRetiredUnits")).isEqualTo(1);
        String peopleBefore = tableDigest("person");
        String affiliationsBefore = tableDigest("affiliation");
        String identitiesBefore = tableDigest("identity_link");

        Res committed = publish(preview);
        assertThat(committed.status()).as(committed.toString()).isEqualTo(200);
        assertThat(effect(committed.body(), "membershipsEnded")).isEqualTo(1);
        assertThat(effect(committed.body(), "responsibilitiesClosed")).isEqualTo(1);
        Map<String, Object> ended = jdbc.sql("select valid_to, ended_reason from membership where id = :id")
                .param("id", currentMembership).query().singleRow();
        assertThat(ended.get("valid_to")).isNotNull();
        assertThat(ended.get("ended_reason")).isEqualTo("ORACLE_UNIT_REPLACED");
        assertThat(jdbc.sql("select valid_to is null from membership where id = :id").param("id", futureMembership)
                .query(Boolean.class).single()).as("a future grant is not back-ended").isTrue();
        Map<String, Object> history = jdbc.sql("select valid_from, valid_to from site_responsibility where id = :id")
                .param("id", responsibility).query().singleRow();
        assertThat(history.get("valid_from")).isNotNull();
        assertThat(history.get("valid_to")).as("the existing history row closes in place").isNotNull();
        assertThat(jdbc.sql("select count(*) from site_responsibility where site_id = :s").param("s", site)
                .query(Long.class).single()).isEqualTo(1);
        assertThat(tableDigest("person")).isEqualTo(peopleBefore);
        assertThat(tableDigest("affiliation")).isEqualTo(affiliationsBefore);
        assertThat(tableDigest("identity_link")).isEqualTo(identitiesBefore);
        assertThat(jdbc.sql("select person_id from affiliation where id = :id").param("id", affiliation)
                .query(UUID.class).single()).isEqualTo(bootstrapPerson);
        assertThat(identities.resolve(existingIdentity)).as("the existing bootstrap identity still resolves to the same UUID")
                .isEqualTo(bootstrapPerson);

        String recoveryLogin = "recovery-bootstrap-" + sfx;
        jdbc.sql("insert into bootstrap_admin(login, expires_at) values (:login, now() + interval '24 hours')")
                .param("login", recoveryLogin).update();
        OidcClient.Identity recovery = new OidcClient.Identity("https://identity.test/recovery-" + sfx,
                "recovery-subject-" + sfx, "unmirrored-recovery-" + sfx, "Synthetic recovery administrator", recoveryLogin,
                Instant.now(), null, "LOGIN", "/", null, false);
        UUID recovered = identities.resolve(recovery);
        assertThat(recovered).isNotEqualTo(bootstrapPerson);
        assertThat(jdbc.sql("select bootstrap from person where id = :id").param("id", recovered)
                .query(Boolean.class).single()).isTrue();
        assertThat(jdbc.sql("select count(*) from membership where person_id = :p and role_code = 'SYSTEM_ADMIN' and valid_to > now()")
                .param("p", recovered).query(Long.class).single())
                .as("once the retired grant ends, the registered 24-hour recovery path remains eligible").isEqualTo(1);
        assertThat(jdbc.sql("select person_id from bootstrap_admin where login = :login").param("login", recoveryLogin)
                .query(UUID.class).single()).isEqualTo(recovered);
    }

    @Test
    @DisplayName("OUI-11: active child of retired parent keeps parentId but remains a scoped navigation root; retired history needs AUDIT")
    void activeChildOfRetiredParentAndScopedTrees() {
        String parent = uid("retired-parent");
        String child = uid("active-child");
        String outside = uid("outside-scope");
        UUID parentOrg = unitOrg(parent, "Retiring synthetic parent " + sfx, root, "HR", "ACTIVE");
        UUID childOrg = unitOrg(child, "Active synthetic child " + sfx, parentOrg, "HR", "ACTIVE");
        addPreviousUnit(parent, "Retiring synthetic parent " + sfx, rootExternal, "1", null);
        addPreviousUnit(child, "Active synthetic child " + sfx, parent, "1", null);
        String noAuditRole = role("OUI_NO_AUDIT", "ORGANIZATION", "VIEW");
        person("child-auditor", readerRole, childOrg);
        person("child-viewer", noAuditRole, childOrg);
        String key = writePayload("retired-parent-active-child", payload(List.of(
                unit(rootExternal, "Synthetic root " + sfx, path(rootExternal), "1", rootExternal),
                unit(parent, "Retiring synthetic parent " + sfx, path(rootExternal, parent), "2", null),
                unit(child, "Active synthetic child " + sfx, path(rootExternal, parent, child), "1", null),
                unit(outside, "Outside synthetic scope " + sfx, path(rootExternal, outside), "1", null))));
        Res committed = publish(goodPreview(key));
        assertThat(committed.status()).as(committed.toString()).isEqualTo(200);
        assertThat(jdbc.sql("select status from organization where id = :id").param("id", parentOrg)
                .query(String.class).single()).isEqualTo("RETIRED");
        assertThat(jdbc.sql("select status from organization where id = :id").param("id", childOrg)
                .query(String.class).single()).isEqualTo("ACTIVE");
        assertThat(jdbc.sql("select parent_id from organization where id = :id").param("id", childOrg)
                .query(UUID.class).single()).as("navigation fallback never rewrites lineage").isEqualTo(parentOrg);

        Api auditor = login("child-auditor");
        Api viewer = login("child-viewer");
        JsonNode ordinaryTree = auditor.get("/organizations/tree").body();
        assertThat(ordinaryTree.toString()).contains(childOrg.toString()).doesNotContain(parentOrg.toString())
                .doesNotContain(outside);
        assertThat(jdbc.sql("select parent_id from organization where id = :id").param("id", childOrg)
                .query(UUID.class).single()).isEqualTo(parentOrg);
        JsonNode roots = auditor.get("/organizations/roots").body();
        JsonNode childRoot = null;
        for (JsonNode branch : roots) {
            if (branch.path("id").asText().equals(childOrg.toString())) {
                childRoot = branch;
            }
        }
        assertThat(childRoot).as(roots.toString()).isNotNull();
        assertThat(childRoot.path("parentId").asText()).isEqualTo(parentOrg.toString());
        assertThat(viewer.get("/organizations/tree?includeRetired=true").status()).isEqualTo(403);
        JsonNode history = auditor.get("/organizations/tree?includeRetired=true").body();
        assertThat(history.toString()).contains(parentOrg.toString(), childOrg.toString()).doesNotContain(outside);

        AccessContext scoped = access.load(new Actor(jdbc.sql("select id from person where username = :u")
                .param("u", "child-auditor-" + sfx).query(UUID.class).single(), null, null, null), Instant.now());
        List<OrganizationService.OrgBranch> serviceRoots = organizations.roots(scoped);
        assertThat(serviceRoots).anySatisfy(branch -> {
            assertThat(branch.id()).isEqualTo(childOrg.toString());
            assertThat(branch.parentId()).isEqualTo(parentOrg.toString());
        });
        assertThat(serviceRoots).noneMatch(branch -> branch.code().equals("HR-" + outside));
    }

    // ---- rollback ----------------------------------------------------------------------------------------

    @Test
    @DisplayName("OUI-12: injected failure after real projection rolls back organizations, carried people, run and snapshot atomically")
    void commitFailureRollsBackEverything() {
        String home = uid("rollback-home");
        UUID homeOrg = unitOrg(home, "Rollback synthetic home " + sfx, root, "HR", "ACTIVE");
        addPreviousUnit(home, "Rollback synthetic home " + sfx, rootExternal, "1", null);
        hraperson("rollback", homeOrg);
        String created = uid("rollback-created");
        String key = writePayload("projection-fault", payload(List.of(
                unit(rootExternal, "Synthetic root " + sfx, path(rootExternal), "1", rootExternal),
                unit(home, "Rollback synthetic home " + sfx, path(rootExternal, home), "1", null),
                unit(created, "Rollback created synthetic " + sfx, path(rootExternal, created), "1", null))));
        JsonNode preview = goodPreview(key);
        Map<String, String> before = businessState();
        List<String> publicBefore = published();
        String sourceBefore = sourceState();
        AccessContext ctx = access.load(new Actor(adminId, null, null, null), Instant.now());
        FAIL_AFTER_PROJECTION.set(true);
        try {
            assertThatThrownBy(() -> imports.commit(ctx, run(preview))).isInstanceOf(InjectedProjectionFailure.class)
                    .hasMessageContaining("after organization projection");
        } finally {
            FAIL_AFTER_PROJECTION.set(false);
        }

        assertThat(businessState()).as("even writes made before injection are rolled back").isEqualTo(before);
        assertThat(published()).isEqualTo(publicBefore).hasSize(1);
        assertRunStillPreviewed(preview);
        assertThat(jdbc.sql("select committed_by, committed_at, carried_person_snapshot_id from oracle_unit_import_run where id = :id")
                .param("id", run(preview)).query().singleRow())
                .containsEntry("committed_by", null).containsEntry("committed_at", null)
                .containsEntry("carried_person_snapshot_id", null);
        assertThat(jdbc.sql("select count(*) from hr_person where snapshot_id = :s").param("s", snapshot(preview))
                .query(Long.class).single()).isZero();
        assertThat(jdbc.sql("select count(*) from hr_snapshot_scope where snapshot_id = :s").param("s", snapshot(preview))
                .query(Long.class).single()).isZero();
        assertThat(jdbc.sql("select count(*) from organization where source_external_id = :e").param("e", created)
                .query(Long.class).single()).isZero();
        assertSourceDisabledAndUnchanged(sourceBefore);

        // The failed attempt releases its advisory lock and leaves a valid preview reusable, with no duplicate business rows.
        Res recovered = publish(preview);
        assertThat(recovered.status()).as(recovered.toString()).isEqualTo(200);
        assertThat(published()).containsExactly(preview.path("snapshotId").asText());
        assertThat(jdbc.sql("select count(*) from organization where source_external_id = :e").param("e", created)
                .query(Long.class).single()).isEqualTo(1);
    }
}
