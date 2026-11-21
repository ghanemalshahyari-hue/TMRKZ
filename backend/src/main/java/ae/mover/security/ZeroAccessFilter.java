package ae.mover.security;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

import org.springframework.http.MediaType;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import ae.mover.access.AccessService;
import ae.mover.common.ErrorCode;
import ae.mover.common.ErrorResponse;
import ae.mover.common.Json;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

/**
 * Zero access is enforced by the server, not only by the screen (owner, 16 Nov 2026: «request page and support only»). A person
 * who is signed in but holds no permission at all — no grant of their own, no delegation, nothing — reaches only: signing in and
 * out, who they are, the access-request page (their requests, the roles offered to ask for, submit, resubmit, their own duty
 * permits to activate), «مركز الدعم» with its guides, and their notifications. Everything else is refused with {@code NO_EFFECTIVE_ACCESS} — a request sent to
 * them «للعلم» and the assistant included (both were open to them before, decisions of 7 and 11 Nov, now withdrawn).
 * Runs after Spring's request-context filter (order -105), so the access context computed here is the one the endpoint reuses.
 */
@Component
@Order(-100)
public class ZeroAccessFilter extends OncePerRequestFilter {

    static final String MESSAGE = "لا توجد لديك صلاحيات بعد — قدّم طلب صلاحية من صفحة «طلب صلاحية».";
    private static final List<String> OPEN_PREFIXES = List.of("/api/v1/auth/", "/api/v1/support/", "/api/v1/help/");
    private static final List<String> OPEN = List.of(
            "GET /api/v1/me",
            // a duty permit is in force only once its holder activates it: until then they hold nothing and must reach it (ADR-059)
            "GET /api/v1/me/permits",
            "GET /api/v1/access-requests/mine",
            "GET /api/v1/access-requests/offer",
            "POST /api/v1/access-requests",
            "GET /api/v1/notifications",
            "GET /api/v1/notifications/desktop-feed",
            "GET /api/v1/system/health",
            "GET /api/v1/system/state",
            "POST /api/v1/me/hr-refresh",
            "GET /api/v1/openapi.json");
    private static final Pattern OPEN_PATTERNS = Pattern.compile(
            "POST /api/v1/access-requests/[0-9a-fA-F-]{36}/resubmit|POST /api/v1/notifications/[0-9a-fA-F-]{36}/read"
            + "|POST /api/v1/me/permits/[0-9a-fA-F-]{36}/activate");

    private final AccessService access;
    private final Json json;

    public ZeroAccessFilter(AccessService access, Json json) {
        this.access = access;
        this.json = json;
    }

    static boolean open(String method, String path) {
        String call = method + " " + path;
        return OPEN_PREFIXES.stream().anyMatch(path::startsWith) || OPEN.contains(call) || OPEN_PATTERNS.matcher(call).matches();
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String path = request.getRequestURI();
        if (path.startsWith("/api/") && request.getAttribute(SessionFilter.ACTOR_ATTRIBUTE) instanceof Actor actor
                && !open(request.getMethod(), path) && access.context(actor).permissions().isEmpty()) {
            response.setStatus(ErrorCode.NO_EFFECTIVE_ACCESS.status());
            response.setContentType(MediaType.APPLICATION_JSON_VALUE);
            response.setCharacterEncoding("UTF-8");
            response.getWriter().write(json.write(new ErrorResponse(ErrorCode.NO_EFFECTIVE_ACCESS.name(), MESSAGE, Map.of(),
                    response.getHeader("X-Trace-Id"))));
            return;
        }
        chain.doFilter(request, response);
    }
}
