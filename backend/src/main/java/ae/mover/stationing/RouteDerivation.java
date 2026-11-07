package ae.mover.stationing;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

import ae.mover.stationing.StationingPolicy.CrossAuthority;
import ae.mover.stationing.StationingPolicy.CrossBranch;
import ae.mover.stationing.StationingPolicy.Routing;
import ae.mover.stationing.StationingPolicy.RoutingLevel;
import ae.mover.stationing.StationingPolicy.StartAt;

/**
 * Approval route of a re-stationing request (owner decisions O-07, O-09, O-03, O-03b): from the REQUESTING UNIT upward
 * through its Oracle ancestors; a unit whose level the configuration marks as approving gets a stage decided by that
 * unit's approver seat; the configured final level closes the route; no level number is named in code.
 *
 * <p>Including a unit of another branch adds one requirement per configured authority. By default a stage already on
 * the route for the same authority satisfies it as well and records every requirement it satisfies; when the policy
 * requires independence, a separate stage is added and must be decided by a different human
 * ({@link #mayDecide}).
 */
public final class RouteDerivation {

    private RouteDerivation() {
    }

    public enum Kind { HIERARCHY, CROSS_BRANCH, EXCEPTION, UNIT_OPERATIONS, FINAL }

    /** One approval condition a stage's decision satisfies (written to the decision record). */
    public record Requirement(String code, String label) {
    }

    /**
     * @param unit        the approver seat's unit, or null for a permission-based stage (distance exception)
     * @param independentOf the key of the stage whose human may not decide this one (independent approvals), or null
     */
    public record RouteStage(String key, UUID unit, Kind kind, String label, List<Requirement> satisfies,
                             boolean finalStage, Set<Fact> dependsOn, String independentOf) {
    }

    /** An included unit of another branch, with the units its configured authorities resolve to. */
    public record CrossBranchInclusion(UUID unit, String unitName, UUID parent, UUID siteResponsible) {

        UUID authority(CrossAuthority a) {
            return switch (a) {
                case OTHER_UNIT -> unit;
                case OTHER_UNIT_PARENT -> parent;
                case SITE_RESPONSIBLE -> siteResponsible;
            };
        }
    }

    /**
     * @param path the requesting unit and its ancestors, nearest first (current hierarchy, {@link OrgHierarchy#path})
     */
    public static List<RouteStage> derive(List<OrgUnit> path, Routing routing, CrossBranch crossBranch,
                                          List<CrossBranchInclusion> inclusions, boolean distanceExceptionRequested) {
        List<OrgUnit> walk = routing.startAt() == StartAt.PARENT && !path.isEmpty() ? path.subList(1, path.size()) : path;
        List<RouteStage> stages = new ArrayList<>();
        for (OrgUnit u : walk) {
            RoutingLevel cfg = u.level() == null ? null
                    : routing.levels().stream().filter(l -> l.level() == u.level()).findFirst().orElse(null);
            if (cfg != null && cfg.approves()) {
                stages.add(new RouteStage("H:" + u.id(), u.id(), Kind.HIERARCHY, cfg.label(),
                        new ArrayList<>(List.of(new Requirement("HIERARCHY", "اعتماد هرمي"))), cfg.finalStage(),
                        cfg.finalStage() ? EnumSet.allOf(Fact.class) : copy(cfg.dependsOn()), null));
            }
            if (cfg != null && cfg.finalStage()) {
                break;
            }
        }
        List<RouteStage> extra = new ArrayList<>();
        for (CrossBranchInclusion inc : inclusions) {
            for (CrossAuthority a : crossBranch.authorities()) {
                UUID unit = inc.authority(a);
                if (unit == null) {
                    continue;
                }
                Requirement req = new Requirement("CROSS_BRANCH:" + a + ":" + inc.unit(), what(a) + " (ضم " + inc.unitName() + ")");
                RouteStage existing = find(stages, extra, unit);
                if (existing != null && !crossBranch.independent()) {
                    existing.satisfies().add(req);
                } else {
                    extra.add(new RouteStage("C:" + a + ":" + unit + ":" + inc.unit(), unit, Kind.CROSS_BRANCH, what(a),
                            new ArrayList<>(List.of(req)), false, EnumSet.of(Fact.SCOPE, Fact.SITE),
                            existing == null ? null : existing.key()));
                }
            }
        }
        if (distanceExceptionRequested) {
            extra.add(new RouteStage("X:distance", null, Kind.EXCEPTION, "اعتماد استثناء مسافة الانتشار",
                    new ArrayList<>(List.of(new Requirement("DISTANCE_EXCEPTION", "استثناء المسافة"))), false,
                    EnumSet.of(Fact.DEPLOYMENT), null));
        }
        // additional requirements are decided before the final stage
        int at = stages.isEmpty() || !stages.get(stages.size() - 1).finalStage() ? stages.size() : stages.size() - 1;
        stages.addAll(at, extra);
        return stages;
    }

    /**
     * The stages the policy adds after the hierarchy (ADR-045): «اعتماد عمليات الوحدة», then «الاعتماد النهائي», each decided
     * through its own permission for the requesting unit. Who holds them is configuration, never named here. A route the
     * hierarchy did not complete stays incomplete, so the request cannot be submitted.
     */
    public static List<RouteStage> withConfiguredStages(List<RouteStage> route, StationingPolicy.ApprovalStages a) {
        if (a == null || !complete(route)) {
            return route;
        }
        List<RouteStage> out = new ArrayList<>(route);
        if (a.finalByPermission()) {
            RouteStage last = out.remove(out.size() - 1);
            out.add(new RouteStage(last.key(), last.unit(), last.kind(), last.label(), last.satisfies(), false, last.dependsOn(), last.independentOf()));
            out.add(new RouteStage("F:final", null, Kind.FINAL, "الاعتماد النهائي",
                    new ArrayList<>(List.of(new Requirement("FINAL", "الاعتماد النهائي"))), true, EnumSet.allOf(Fact.class), null));
        }
        if (a.unitOperations()) {
            out.add(out.size() - 1, new RouteStage("O:operations", null, Kind.UNIT_OPERATIONS, "اعتماد عمليات الوحدة",
                    new ArrayList<>(List.of(new Requirement("UNIT_OPERATIONS", "اعتماد عمليات الوحدة"))), false, EnumSet.allOf(Fact.class), null));
        }
        return out;
    }

    /** True when the route ends with the configured final stage (otherwise the request cannot be submitted). */
    public static boolean complete(List<RouteStage> stages) {
        return !stages.isEmpty() && stages.get(stages.size() - 1).finalStage();
    }

    /**
     * Independence (O-03b): the human who decided a stage may not decide a stage declared independent of it, and the
     * reverse. {@code decidedBy} maps stage keys to the stable human identity that decided them.
     */
    public static boolean mayDecide(RouteStage stage, String human, List<RouteStage> route, Map<String, String> decidedBy) {
        if (stage.independentOf() != null && human.equals(decidedBy.get(stage.independentOf()))) {
            return false;
        }
        return route.stream().filter(s -> stage.key().equals(s.independentOf()))
                .noneMatch(s -> human.equals(decidedBy.get(s.key())));
    }

    private static RouteStage find(List<RouteStage> a, List<RouteStage> b, UUID unit) {
        for (List<RouteStage> l : List.of(a, b)) {
            for (RouteStage s : l) {
                if (Objects.equals(s.unit(), unit)) {
                    return s;
                }
            }
        }
        return null;
    }

    private static String what(CrossAuthority a) {
        return switch (a) {
            case OTHER_UNIT -> "موافقة الوحدة المضافة";
            case OTHER_UNIT_PARENT -> "موافقة الجهة الأعلى للوحدة المضافة";
            case SITE_RESPONSIBLE -> "موافقة المسؤول عن موقع الوحدة المضافة";
        };
    }

    private static Set<Fact> copy(Set<Fact> facts) {
        return facts.isEmpty() ? EnumSet.noneOf(Fact.class) : EnumSet.copyOf(facts);
    }
}
