package ae.mover.security;

import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import ae.mover.audit.AuditService;
import ae.mover.common.Db;

/**
 * One employment context for a person (ADR-068; LDAP first-login specification §2-5, 25, 26): who they are and where they work,
 * from ONE source at a time. The rule lives here and nowhere else.
 *
 * <ul>
 *   <li><b>Oracle</b> (Mode B) while an HR source is enabled and has a published snapshot: rank, position and the unit come from
 *       the published HR record and the HR posting (affiliation). The directory still proves who signs in; where it disagrees
 *       on the Unit ID, Oracle wins and the disagreement is audited once per change ({@code IDENTITY_ORG_SOURCE_MISMATCH}).
 *       A temporarily unreachable or stale Oracle never hands the decision back to the directory: the sign-in rules of
 *       ADR-065 refuse instead (fail closed).</li>
 *   <li><b>The directory</b> (Mode A) otherwise: what the directory stated at the latest sign-in ({@code person_directory_profile}).
 *       Its Unit ID is joined to the ONE active TMRKZ unit whose {@code source_external_id} equals it — never by name, and no
 *       unit is ever created. A Unit ID TMRKZ does not hold leaves the person signed in with no unit and the page says
 *       «تم التحقق من هويتك، لكن وحدتك التنظيمية غير مهيأة في النظام» (an access request is refused until the unit exists).</li>
 * </ul>
 * With either source, a person with no unit from it keeps the unit an access manager added them to («إضافة مستخدم», ADR-061);
 * with the directory and no Unit ID stated at all (attribute not configured), a posting kept from an earlier Oracle period
 * counts before that, as before this decision. A unit is structure, never a permission: nothing here grants anything.
 */
@Service
public class EmploymentContextResolver {

    /** The organisational source in force. */
    public enum Source { LDAP, ORACLE }

    /** Where the unit of a context comes from. */
    public enum UnitOrigin {
        /** the source in force: Oracle's posting, or the directory's Unit ID matched to an active TMRKZ unit */
        SOURCE,
        /** the directory states no Unit ID: an open posting kept from an earlier Oracle period */
        EARLIER_HR,
        /** the unit an access manager added the person to (ADR-061) */
        ADDED,
        NONE
    }

    /**
     * The normalised context. {@code unitExternalId}/{@code statedUnitName}: the Unit ID (and name) exactly as the source in
     * force states it; {@code unitOrgId}/{@code unitName}: the TMRKZ unit the person asks and is routed for, or null;
     * {@code unitConfigured} false: the source names a Unit ID that no active TMRKZ unit holds. {@code observedAt}: when the
     * source said it (the published snapshot, or the latest directory sign-in).
     */
    public record Context(UUID personId, String username, String employeeNo, String displayName, String rank, String position,
                          String unitExternalId, String statedUnitName, UUID unitOrgId, String unitName, boolean unitConfigured,
                          UnitOrigin unitOrigin, String mainUnitExternalId, String mainUnitName, Source source, Instant observedAt) {
    }

    /** Placeholder employee number of a directory person whose directory entry carries none (person.employee_no is required). */
    public static final String DIRECTORY_NUMBER_PREFIX = "DIR-";

    private final JdbcClient jdbc;
    private final Clock clock;
    private final AuditService audit;

    public EmploymentContextResolver(JdbcClient jdbc, Clock clock, AuditService audit) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.audit = audit;
    }

    /** ORACLE while an enabled HR source has a published snapshot; the directory before (and while HR is switched off). */
    public Source mode() {
        Boolean oracle = jdbc.sql("""
                select exists (select 1 from hr_source where enabled)
                   and exists (select 1 from hr_snapshot where status = 'PUBLISHED')""").query(Boolean.class).single();
        return Boolean.TRUE.equals(oracle) ? Source.ORACLE : Source.LDAP;
    }

    /** The ONE active TMRKZ unit holding this Unit ID, or null (none, or more than one): never by name, never created. */
    public UUID unitById(String unitId) {
        if (unitId == null || unitId.isBlank()) {
            return null;
        }
        List<UUID> ids = jdbc.sql("select id from organization where status = 'ACTIVE' and source_external_id = :x limit 2")
                .param("x", unitId.trim()).query(UUID.class).list();
        return ids.size() == 1 ? ids.get(0) : null;
    }

    /** The unit the person asks for and is routed by (access requests), or null. */
    public UUID unitOf(UUID person) {
        Source mode = mode();
        return placement(person, mode, mode == Source.LDAP ? profile(person) : null, mode == Source.ORACLE ? hrRow(person) : null).org();
    }

    /** The whole context of a person, for the identity card and the access-request page. */
    public Context of(UUID person) {
        Map<String, Object> p = jdbc.sql("select display_name, employee_no, username from person where id = :p")
                .param("p", person).query().singleRow();
        Source mode = mode();
        Map<String, Object> d = profile(person);
        Map<String, Object> h = hrRow(person);
        Placement pl = placement(person, mode, mode == Source.LDAP ? d : null, mode == Source.ORACLE ? h : null);
        String rank;
        String position;
        Instant observed;
        String mainId = null;
        String mainName = null;
        if (mode == Source.ORACLE) {
            rank = text(h, "rank_name");
            position = text(h, "position_title");
            observed = jdbc.sql("select published_at from hr_snapshot where status = 'PUBLISHED'").query().listOfRows().stream()
                    .findFirst().map(r -> Db.toInstant(r.get("published_at"))).orElse(null);
        } else {
            // the directory in force; what it does not state (attribute not configured) is read from an earlier Oracle record
            rank = first(text(d, "rank"), text(h, "rank_name"));
            position = first(text(d, "position"), text(h, "position_title"));
            observed = d == null ? null : Db.toInstant(d.get("observed_at"));
            mainId = text(d, "main_unit_external_id");
            if (mainId != null) {
                UUID main = unitById(mainId);
                mainName = main == null ? null : orgName(main);
            }
        }
        if (mainId == null && pl.org() != null) {
            // the nearest main unit above (MAIN_UNIT_ID = ID, ADR-064)
            Map<String, Object> main = jdbc.sql("""
                    with recursive up(id, parent_id, depth) as (
                      select id, parent_id, 0 from organization where id = :u
                      union all select o.id, o.parent_id, up.depth + 1 from organization o join up on o.id = up.parent_id where up.depth < 50)
                    select o.name, o.source_external_id from up join organization o on o.id = up.id
                    join hr_unit h on h.external_id = o.source_external_id and h.is_main
                      and h.snapshot_id = (select id from hr_snapshot where status = 'PUBLISHED')
                    order by up.depth limit 1""").param("u", pl.org()).query().listOfRows().stream().findFirst().orElse(null);
            if (main != null) {
                mainId = (String) main.get("source_external_id");
                mainName = (String) main.get("name");
            }
        }
        String number = (String) p.get("employee_no");
        if (number != null && number.startsWith(DIRECTORY_NUMBER_PREFIX)) {
            number = null; // a placeholder, never shown as a number
        }
        String username = first(text(h, "domain_account"), first((String) p.get("username"), text(d, "username")));
        return new Context(person, username, number, (String) p.get("display_name"), rank, position, pl.statedId(), pl.statedName(),
                pl.org(), pl.org() == null ? null : orgName(pl.org()), pl.configured(), pl.origin(), mainId, mainName, mode, observed);
    }

    /**
     * At every sign-in: records what the directory stated (never a password or token). A path that reads no employment
     * attribute keeps what an earlier sign-in recorded. With Oracle in force, a Unit ID that differs from Oracle's is audited
     * once per change ({@code IDENTITY_ORG_SOURCE_MISMATCH}) and changes nothing: Oracle decides the placement.
     */
    public void observe(UUID person, OidcClient.Identity id) {
        DirectoryProfile pr = id.profile();
        jdbc.sql("""
                insert into person_directory_profile(person_id, issuer, username, employee_number, display_name, rank, position,
                                                     unit_external_id, unit_name, main_unit_external_id, observed_at)
                values (:p, :i, :u, :e, :n, :r, :pos, :unit, :uname, :main, :now)
                on conflict (person_id) do update set issuer = excluded.issuer, username = excluded.username,
                  employee_number = coalesce(excluded.employee_number, person_directory_profile.employee_number),
                  display_name = excluded.display_name, observed_at = excluded.observed_at""")
                .param("p", person).param("i", id.issuer()).param("u", ae.mover.authz.UnitMemberService.normalLogin(id.username()))
                .param("e", pr.employeeNumber()).param("n", DirectoryProfile.clean(id.displayName())).param("r", pr.rank())
                .param("pos", pr.position()).param("unit", pr.unitId()).param("uname", pr.unitName()).param("main", pr.mainUnitId())
                .param("now", Db.ts(clock.instant())).update();
        if (pr.employment()) {
            jdbc.sql("""
                    update person_directory_profile set rank = :r, position = :pos, unit_external_id = :unit, unit_name = :uname,
                           main_unit_external_id = :main where person_id = :p""")
                    .param("r", pr.rank()).param("pos", pr.position()).param("unit", pr.unitId()).param("uname", pr.unitName())
                    .param("main", pr.mainUnitId()).param("p", person).update();
        }
        if (mode() == Source.ORACLE) {
            checkAgreement(person);
        }
    }

    /** Oracle in force: the directory's Unit ID against Oracle's, audited once per change of the pair. */
    private void checkAgreement(UUID person) {
        Map<String, Object> d = profile(person);
        String directoryUnit = text(d, "unit_external_id");
        String oracleUnit = text(hrRow(person), "unit_external_id");
        if (directoryUnit == null || oracleUnit == null) {
            return;
        }
        String pair = directoryUnit.equals(oracleUnit) ? null : directoryUnit + " -> " + oracleUnit;
        if (Objects.equals(pair, text(d, "org_mismatch"))) {
            return;
        }
        jdbc.sql("update person_directory_profile set org_mismatch = :m where person_id = :p").param("m", pair).param("p", person).update();
        if (pair != null) {
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("directoryUnitId", directoryUnit);
            detail.put("oracleUnitId", oracleUnit);
            detail.put("decidedBy", "ORACLE");
            audit.system("IDENTITY_ORG_SOURCE_MISMATCH", "PERSON", person.toString(), null, detail);
        }
    }

    // ---- reading -------------------------------------------------------------------------------------------------

    private record Placement(UUID org, UnitOrigin origin, String statedId, String statedName, boolean configured) {
    }

    /** The unit by the rule of the source in force (class comment). */
    private Placement placement(UUID person, Source mode, Map<String, Object> directory, Map<String, Object> oracle) {
        if (mode == Source.ORACLE) {
            String stated = text(oracle, "unit_external_id");
            UUID posted = affiliation(person);
            if (posted != null) {
                return new Placement(posted, UnitOrigin.SOURCE, stated, null, true);
            }
            return added(person, stated, null, stated == null);
        }
        String stated = text(directory, "unit_external_id");
        String statedName = text(directory, "unit_name");
        if (stated != null) {
            UUID unit = unitById(stated);
            return unit != null ? new Placement(unit, UnitOrigin.SOURCE, stated, statedName, true) : added(person, stated, statedName, false);
        }
        UUID earlier = affiliation(person);
        if (earlier != null) {
            return new Placement(earlier, UnitOrigin.EARLIER_HR, null, null, true);
        }
        return added(person, null, null, true);
    }

    private Placement added(UUID person, String stated, String statedName, boolean configured) {
        UUID unit = jdbc.sql("""
                select u.organization_id from unit_member u join organization o on o.id = u.organization_id and o.status = 'ACTIVE'
                where u.person_id = :p and u.ended_at is null order by u.added_at desc limit 1""")
                .param("p", person).query(UUID.class).optional().orElse(null);
        return new Placement(unit, unit == null ? UnitOrigin.NONE : UnitOrigin.ADDED, stated, statedName, configured);
    }

    private UUID affiliation(UUID person) {
        return jdbc.sql("""
                select a.organization_id from affiliation a join organization o on o.id = a.organization_id and o.status = 'ACTIVE'
                where a.person_id = :p and a.valid_to is null order by a.valid_from desc limit 1""")
                .param("p", person).query(UUID.class).optional().orElse(null);
    }

    private Map<String, Object> profile(UUID person) {
        return jdbc.sql("select * from person_directory_profile where person_id = :p").param("p", person).query().listOfRows()
                .stream().findFirst().orElse(null);
    }

    /** The published HR record of an HR person, or null. */
    private Map<String, Object> hrRow(UUID person) {
        return jdbc.sql("""
                select h.unit_external_id, h.rank_name, h.position_title, h.domain_account
                from person p join hr_person h on h.external_id = p.source_external_id
                  and h.snapshot_id = (select id from hr_snapshot where status = 'PUBLISHED')
                where p.id = :p and p.source = 'HR'""").param("p", person).query().listOfRows().stream().findFirst().orElse(null);
    }

    private String orgName(UUID id) {
        return jdbc.sql("select name from organization where id = :id").param("id", id).query(String.class).optional().orElse(null);
    }

    private static String text(Map<String, Object> row, String column) {
        Object v = row == null ? null : row.get(column);
        return v == null || v.toString().isBlank() ? null : v.toString();
    }

    private static String first(String a, String b) {
        return a != null ? a : b;
    }
}
