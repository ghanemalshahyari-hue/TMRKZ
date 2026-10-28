package ae.mover.security;

import java.time.Clock;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.access.Grant;
import ae.mover.common.Ref;
import ae.mover.policy.PolicyService;
import jakarta.servlet.http.HttpServletRequest;

@RestController
@RequestMapping("/api/v1")
public class AuthController {

    private final AuthService auth;
    private final AccessService access;
    private final JdbcClient jdbc;
    private final SecurityProperties props;
    private final DemoProperties demo;
    private final PolicyService policies;
    private final Clock clock;

    public AuthController(AuthService auth, AccessService access, JdbcClient jdbc, SecurityProperties props,
                          DemoProperties demo, PolicyService policies, Clock clock) {
        this.auth = auth;
        this.access = access;
        this.jdbc = jdbc;
        this.props = props;
        this.demo = demo;
        this.policies = policies;
        this.clock = clock;
    }

    public record LoginInput(String username, String password) {
    }

    public record DemoSwitchInput(String username) {
    }

    @PostMapping("/auth/login")
    public ResponseEntity<Map<String, Object>> login(@RequestBody LoginInput in, HttpServletRequest request) {
        AuthService.LoginResult r = auth.login(in.username(), in.password(), request.getRemoteAddr(), request.getHeader("User-Agent"));
        return withCookie(r);
    }

    @PostMapping("/auth/demo-switch")
    public ResponseEntity<Map<String, Object>> demoSwitch(@RequestBody DemoSwitchInput in, HttpServletRequest request) {
        AuthService.LoginResult r = auth.demoSwitch(in.username(), request.getRemoteAddr(), request.getHeader("User-Agent"));
        return withCookie(r);
    }

    private ResponseEntity<Map<String, Object>> withCookie(AuthService.LoginResult r) {
        ResponseCookie cookie = ResponseCookie.from(SessionFilter.COOKIE, r.token()).httpOnly(true)
                .secure(props.secureCookie()).sameSite("Strict").path("/").maxAge(auth.sessionLifetime()).build();
        return ResponseEntity.ok().header(HttpHeaders.SET_COOKIE, cookie.toString()).body(me(r.actor()));
    }

    @PostMapping("/auth/logout")
    public ResponseEntity<Void> logout(Actor actor) {
        auth.logout(actor);
        ResponseCookie cookie = ResponseCookie.from(SessionFilter.COOKIE, "").httpOnly(true).secure(props.secureCookie())
                .sameSite("Strict").path("/").maxAge(0).build();
        return ResponseEntity.noContent().header(HttpHeaders.SET_COOKIE, cookie.toString()).build();
    }

    @GetMapping("/auth/demo-users")
    public Map<String, Object> demoUsers() {
        if (!demo.mode()) {
            return Map.of("enabled", false, "users", List.of());
        }
        List<Map<String, Object>> users = jdbc.sql("""
                select distinct on (p.username) p.username, p.display_name, r.name as role_name, o.name as org_name, r.sort_order
                from person p join membership m on m.person_id = p.id and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
                join role_def r on r.code = m.role_code join organization o on o.id = m.organization_id
                where p.username is not null and p.status = 'ACTIVE' order by p.username, r.sort_order""")
                .query((rs, n) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("username", rs.getString("username"));
                    m.put("displayName", rs.getString("display_name"));
                    m.put("roleName", rs.getString("role_name"));
                    m.put("orgName", rs.getString("org_name"));
                    m.put("order", rs.getInt("sort_order"));
                    return m;
                }).list();
        List<Map<String, Object>> sorted = new ArrayList<>(users);
        sorted.sort((a, b) -> Integer.compare((Integer) a.get("order"), (Integer) b.get("order")));
        sorted.forEach(m -> m.remove("order"));
        return Map.of("enabled", true, "users", sorted);
    }

    @GetMapping("/me")
    public Map<String, Object> me(Actor actor) {
        AccessContext ctx = access.context(actor);
        Map<String, Object> me = new LinkedHashMap<>();
        Map<String, Object> person = jdbc.sql("select employee_no from person where id = :id").param("id", actor.personId())
                .query().singleRow();
        me.put("id", actor.personId().toString());
        me.put("username", actor.username());
        me.put("displayName", actor.displayName());
        me.put("employeeNo", person.get("employee_no"));
        me.put("initials", initials(actor.displayName()));
        Grant primary = ctx.primaryGrant().orElse(null);
        me.put("primaryRole", primary == null ? null : Map.of("code", primary.roleCode(), "name", primary.roleName()));
        me.put("primaryOrg", primary == null ? null : Ref.of(primary.orgId(), primary.orgName()));
        me.put("permissions", ctx.permissions());
        me.put("summaryOnly", ctx.summaryOnly());
        me.put("grants", grants(ctx));
        me.put("demoMode", demo.mode());
        me.put("serverTime", clock.instant().toString());
        me.put("timezone", policies.settings().timezone());
        return me;
    }

    @GetMapping("/me/capabilities")
    public Map<String, Object> capabilities(Actor actor) {
        AccessContext ctx = access.context(actor);
        return Map.of("permissions", ctx.permissions(), "grants", grants(ctx));
    }

    private static List<Map<String, Object>> grants(AccessContext ctx) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Grant g : ctx.grants()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("roleCode", g.roleCode());
            m.put("roleName", g.roleName());
            m.put("permissions", g.permissions());
            m.put("scope", g.scope());
            m.put("summaryOnly", g.summaryOnly());
            m.put("organization", Ref.of(g.orgId(), g.orgName()));
            m.put("site", Ref.of(g.siteId(), g.siteName()));
            m.put("validTo", g.validTo() == null ? null : g.validTo().toString());
            m.put("viaDelegation", g.delegationId() == null ? null : Map.of("id", g.delegationId().toString(),
                    "delegatorName", g.delegatorName(), "validTo", String.valueOf(g.validTo())));
            out.add(m);
        }
        return out;
    }

    static String initials(String name) {
        if (name == null || name.isBlank()) {
            return "؟";
        }
        String[] parts = name.trim().split("\\s+");
        return parts.length == 1 ? parts[0].substring(0, 1) : parts[0].substring(0, 1) + " " + parts[1].substring(0, 1);
    }
}
