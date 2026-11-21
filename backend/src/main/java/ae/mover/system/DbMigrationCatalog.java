package ae.mover.system;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * What the migration center knows about TMRKZ's tables (ADR-094): which category each business table belongs to, as the
 * owner names them — organisations, sites, people/accounts, grants/roles, stationing, deployment areas, requests, approval
 * history, attachments, support, other — and what it never reads or writes: sessions, sign-in state, outboxes, the Flowable
 * runtime, Flyway's history, the HR staging tables, the integration and HR secrets, this centre's own rows, the OpenFGA
 * mirror and store state. A column that holds a password hash, a secret, a token, a ciphertext or a key id is stripped even
 * from a table that is migrated.
 */
final class DbMigrationCatalog {

    /** A category of the owner's list, with its Arabic label. */
    record Category(String code, String label) {
    }

    static final List<Category> CATEGORIES = List.of(
            new Category("ORGANISATIONS", "الجهات"),
            new Category("SITES", "المواقع"),
            new Category("PEOPLE", "الأشخاص والحسابات"),
            new Category("GRANTS", "الصلاحيات والأدوار"),
            new Category("STATIONING", "التمركز"),
            new Category("DEPLOYMENT_AREAS", "مناطق الانتشار"),
            new Category("REQUESTS", "الطلبات"),
            new Category("APPROVALS", "سجل الاعتماد"),
            new Category("ATTACHMENTS", "المرفقات"),
            new Category("SUPPORT", "الدعم"),
            new Category("OTHER", "أخرى"),
            new Category("UNSUPPORTED", "لا تُرحَّل"));

    /** Never read, never written: infrastructure of each installation, secrets and the engines' own state. */
    static final Set<String> EXCLUDED_TABLES = Set.of("flyway_schema_history", "user_session", "oidc_login", "login_throttle",
            "outbox_event", "stationing_outbox", "db_migration", "integration_setting", "sign_in_board", "idempotency_record",
            "bootstrap_admin", "authz_change", "authz_sync_state", "authz_tuple", "spatial_ref_sys", "local_metadata");
    static final List<String> EXCLUDED_PREFIXES = List.of("act_", "hr_");
    /** A column by this name is stripped from the comparison and the transfer. */
    static final Pattern SECRET_COLUMN = Pattern.compile(
            "(^|_)(password|password_hash|secret|token|ciphertext|private_key|credential|credentials|api_key|key_id|id_token|refresh_token)($|_)");

    private static final Map<String, String> TABLES = new LinkedHashMap<>();

    static {
        put("ORGANISATIONS", "organization", "affiliation", "org_responsibility", "org_responsibility_rule", "org_unit_symbol",
                "unit_symbol_catalog", "provider_unit", "fyi_main_command", "position_seat");
        put("SITES", "site", "site_responsibility", "site_geometry_version", "site_link", "site_symbol", "site_deletion_request",
                "site_setup_access", "resource", "map_package", "map_import_job", "validation_report", "terrain_dataset", "terrain_slope");
        put("PEOPLE", "person", "person_directory_profile", "identity_link", "identity_link_issue", "unit_member");
        put("GRANTS", "role_def", "membership", "membership_scope_target", "delegation", "unit_grant", "duty_permit",
                "access_policy_version", "access_request", "access_request_offer");
        put("STATIONING", "org_stationing", "stationing_policy_version", "stationing_route_version", "placement_rule",
                "restationing_request", "restationing_revision", "restationing_stage", "restationing_action", "restationing_fyi",
                "restationing_route_skip", "unit_ops_route", "unit_ops_route_target");
        put("DEPLOYMENT_AREAS", "deployment_area");
        put("REQUESTS", "request", "request_revision", "request_resource", "request_participant", "request_relocation", "request_fyi",
                "request_flow_end", "request_route_skip", "request_type", "form_definition", "form_version", "workflow_definition",
                "workflow_version", "policy_version", "reservation", "reservation_change", "reservation_lock", "execution_task",
                "task_assignment", "task_reassignment", "notification");
        put("APPROVALS", "decision", "decision_communication", "approval_document", "signature_evidence", "signing_job", "audit_event");
        put("ATTACHMENTS", "attachment", "export_job");
        put("SUPPORT", "support_case", "support_event", "support_message", "support_seat");
        put("OTHER", "integration_run", "oracle_unit_import_run");
    }

    private DbMigrationCatalog() {
    }

    private static void put(String category, String... tables) {
        for (String t : tables) {
            TABLES.put(t, category);
        }
    }

    /** The reason a table is never migrated, or null for a business table. */
    static String unsupportedReason(String table) {
        if (EXCLUDED_TABLES.contains(table)) {
            return switch (table) {
                case "user_session", "oidc_login", "login_throttle", "bootstrap_admin" -> "جلسات وحالة الدخول";
                case "integration_setting", "sign_in_board" -> "إعدادات هذه النسخة وأسرار التكامل";
                case "outbox_event", "stationing_outbox", "idempotency_record" -> "صندوق صادر وحالة تشغيل";
                case "authz_change", "authz_sync_state", "authz_tuple" -> "حالة مخزن الصلاحيات (OpenFGA)";
                case "db_migration" -> "سجل مركز الترحيل نفسه";
                case "flyway_schema_history" -> "سجل إصدارات المخطط";
                default -> "جدول تشغيلي خاص بكل نسخة";
            };
        }
        if (table.startsWith("act_")) {
            return "محرك سير العمل (Flowable)";
        }
        if (table.startsWith("hr_")) {
            return "جداول مؤقتة لمزامنة الموارد البشرية وأسرار مصدرها";
        }
        return null;
    }

    static String category(String table) {
        if (unsupportedReason(table) != null) {
            return "UNSUPPORTED";
        }
        String c = TABLES.get(table);
        if (c != null) {
            return c;
        }
        if (table.startsWith("restationing_") || table.startsWith("stationing_")) {
            return "STATIONING";
        }
        if (table.startsWith("request_")) {
            return "REQUESTS";
        }
        if (table.startsWith("site_")) {
            return "SITES";
        }
        if (table.startsWith("org_")) {
            return "ORGANISATIONS";
        }
        if (table.startsWith("support_")) {
            return "SUPPORT";
        }
        return "OTHER";
    }

    static boolean secretColumn(String column) {
        return SECRET_COLUMN.matcher(column).find();
    }

    static String label(String code) {
        for (Category c : CATEGORIES) {
            if (c.code().equals(code)) {
                return c.label();
            }
        }
        return code;
    }
}
