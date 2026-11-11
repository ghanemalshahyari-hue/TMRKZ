package ae.mover.access;

import java.util.Collection;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import ae.mover.common.ApiException;
import ae.mover.common.Db;

/**
 * The separate rights of «مسؤول إدارة الوصول والصلاحيات», as TNQL's access administration (owner, 11 Nov 2026; ADR-059).
 * They are kept on a grant of a role that manages access ({@code membership.access_rights}); a grant without a list — every
 * grant made before V37, a position seat, a role given to a unit, a global manager's — has them all. A right is held at a
 * unit when one grant that manages access there carries it; rights from different grants are never combined to widen one.
 */
@Component
public class AccessRights {

    public enum Right {
        LOOKUP("البحث عن الموظفين", false),
        REVIEW("مراجعة طلبات الصلاحية", false),
        GRANT("منح الصلاحيات", false),
        ANNEXED("إدارة الملحقين", false),
        DELEGATE("تفويض إدارة الصلاحيات", false),
        FINALIZE("اعتماد نهائي لطلبات الصلاحيات", false),
        DUTY("إدارة صلاحية المناوبة", true),
        ROUTING("توجيه المهام بانتظار الإسناد", true),
        UNIT_OPERATIONS("إدارة اعتماد عمليات الوحدة حسب الوقت", false),
        ATTACH("إلحاق الوحدات وتعيين مهام التوفير", false);

        public final String label;
        public final boolean byDefault;

        Right(String label, boolean byDefault) {
            this.label = label;
            this.byDefault = byDefault;
        }
    }

    public static final Set<Right> ALL = EnumSet.allOf(Right.class);

    private final JdbcClient jdbc;

    public AccessRights(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** The catalogue for the page: key, label, whether a new grant starts with it. */
    public static List<Map<String, Object>> catalogue() {
        return java.util.Arrays.stream(Right.values()).map(r -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("key", r.name());
            m.put("label", r.label);
            m.put("byDefault", r.byDefault);
            return m;
        }).toList();
    }

    /** Parses a list from the page; null or empty-null means every right. Unknown keys are refused. */
    public static Set<Right> parse(Collection<String> keys) {
        if (keys == null) {
            return null;
        }
        Set<Right> out = EnumSet.noneOf(Right.class);
        for (String k : keys) {
            try {
                out.add(Right.valueOf(k));
            } catch (IllegalArgumentException e) {
                throw ApiException.validation("حق غير معروف: " + k);
            }
        }
        return out;
    }

    /** The rights stored on each of these memberships; a membership with no list (or none at all) has every right. */
    public Map<UUID, Set<Right>> of(Collection<UUID> memberships) {
        Map<UUID, Set<Right>> out = new HashMap<>();
        List<UUID> ids = memberships.stream().filter(Objects::nonNull).distinct().toList();
        if (ids.isEmpty()) {
            return out;
        }
        jdbc.sql("select id, array_to_string(access_rights, ',') as r from membership where id = any(string_to_array(:ids, ',')::uuid[])")
                .param("ids", Db.ids(ids))
                .query((rs, n) -> {
                    String r = rs.getString("r");
                    out.put(Db.uuid(rs, "id"), r == null ? ALL : r.isEmpty() ? EnumSet.noneOf(Right.class)
                            : parse(List.of(r.split(","))));
                    return null;
                }).list();
        return out;
    }

    /** The rights of one grant: those on its membership, or all of them for a seat or a role given to a unit. */
    public Set<Right> of(Grant g, Map<UUID, Set<Right>> known) {
        return g.membershipId() == null ? ALL : known.getOrDefault(g.membershipId(), ALL);
    }

    /** Whether one grant managing access at this unit (any unit when {@code org} is null) carries the right. */
    public boolean can(AccessContext ctx, Right right, UUID org) {
        List<Grant> managing = ctx.grants().stream()
                .filter(g -> g.has(Permission.MANAGE_ACCESS) && (org == null || g.actsFor(org))).toList();
        if (managing.isEmpty()) {
            return false;
        }
        Map<UUID, Set<Right>> known = of(managing.stream().map(Grant::membershipId).toList());
        boolean held = managing.stream().anyMatch(g -> of(g, known).contains(right));
        return held && (org == null || ctx.canFor(Permission.MANAGE_ACCESS, org));
    }

    public void require(AccessContext ctx, Right right, UUID org) {
        ctx.require(Permission.MANAGE_ACCESS);
        if (!can(ctx, right, org)) {
            throw ApiException.forbidden("لا تملك حق «" + right.label + "» في هذا النطاق؛ يمنحه لك من فوّضك أو مدير الصلاحيات العام.");
        }
    }
}
