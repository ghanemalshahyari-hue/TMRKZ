package ae.mover.security;

import java.io.IOException;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import ae.mover.common.ErrorCode;
import ae.mover.common.ErrorResponse;
import ae.mover.common.Json;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

/**
 * Authenticates every API call from the server-side session and applies the CSRF guard: state-changing requests
 * must carry {@code X-Requested-With: mover}, which a cross-site form cannot send without a CORS pre-flight.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class SessionFilter extends OncePerRequestFilter {

    public static final String COOKIE = "MOVER_SESSION";
    public static final String ACTOR_ATTRIBUTE = "mover.actor";
    private static final Set<String> SAFE_METHODS = Set.of("GET", "HEAD", "OPTIONS");
    private static final Set<String> PUBLIC = Set.of(
            "GET /api/v1/auth/status",
            "GET /api/v1/auth/oidc/start",
            "GET /api/v1/auth/oidc/callback",
            "GET /api/v1/system/health",
            "GET /api/v1/openapi.json");

    private final AuthService auth;
    private final Json json;

    public SessionFilter(AuthService auth, Json json) {
        this.auth = auth;
        this.json = json;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String traceId = UUID.randomUUID().toString().substring(0, 13);
        MDC.put("traceId", traceId);
        response.setHeader("X-Trace-Id", traceId);
        try {
            String path = request.getRequestURI();
            if (!path.startsWith("/api/")) {
                chain.doFilter(request, response);
                return;
            }
            response.setHeader("Cache-Control", "no-store");
            if (!SAFE_METHODS.contains(request.getMethod()) && !"mover".equals(request.getHeader("X-Requested-With"))) {
                reject(response, ErrorCode.FORBIDDEN, "الطلب يفتقد ترويسة الحماية المطلوبة.", traceId);
                return;
            }
            Optional<Actor> actor = Optional.ofNullable(token(request)).flatMap(auth::resolve);
            actor.ifPresent(a -> {
                request.setAttribute(ACTOR_ATTRIBUTE, a);
                MDC.put("actor", a.personId().toString());
            });
            if (actor.isEmpty() && !PUBLIC.contains(request.getMethod() + " " + path)) {
                reject(response, ErrorCode.UNAUTHENTICATED, "انتهت الجلسة أو لم يتم تسجيل الدخول.", traceId);
                return;
            }
            chain.doFilter(request, response);
        } finally {
            MDC.clear();
        }
    }

    private static String token(HttpServletRequest request) {
        Cookie[] cookies = request.getCookies();
        if (cookies == null) {
            return null;
        }
        for (Cookie c : cookies) {
            if (COOKIE.equals(c.getName())) {
                return c.getValue();
            }
        }
        return null;
    }

    private void reject(HttpServletResponse response, ErrorCode code, String message, String traceId) throws IOException {
        response.setStatus(code.status());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding("UTF-8");
        response.getWriter().write(json.write(new ErrorResponse(code.name(), message, java.util.Map.of(), traceId)));
    }
}
