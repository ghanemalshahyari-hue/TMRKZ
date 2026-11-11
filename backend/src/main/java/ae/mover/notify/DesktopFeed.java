package ae.mover.notify;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import ae.mover.common.Db;

/**
 * The desktop notification feed, as in TNQL (owner, 11 Nov 2026; ADR-050). The browser polls it every 30 seconds with the
 * highest number it already showed and draws each new unread notification as a Windows toast through its service worker; no
 * push service is involved, so it works on an isolated network.
 *
 * <p>Like TNQL, the toast never carries the notification's own text: a lock screen or a shared desk must not show a request
 * number, a unit or a name. Its body is a fixed line per kind and a click opens the platform, where the details are shown to
 * the signed-in person only. A first call (no cursor) returns only the current number, so older items are not replayed.
 */
@Service
public class DesktopFeed {

    /** At most this many toasts per poll, the oldest first (TNQL's DESKTOP_FEED_MAX). */
    static final int MAX = 5;
    static final String TITLE = "تمركز — إشعار جديد";
    /** Kinds that ask the person to act: the toast stays until dismissed (TNQL's action_required). */
    static final Set<String> ACTION = Set.of("REQUEST_RETURNED", "TASK_OVERDUE", "TASK_ASSIGNED", "TASK_REALIGNED", "TASK_ROUTED",
            "SUPPORT_NEW", "SUPPORT_RESOLVED", "DUTY_PERMIT");
    private static final Pattern RESTATIONING = Pattern.compile("^#restationing/([0-9a-f-]{36})");

    private final JdbcClient jdbc;

    public DesktopFeed(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** The lock-screen-safe line for a kind. */
    static String body(String kind) {
        return switch (kind) {
            case "REQUEST_RETURNED" -> "تمركز — أعيد إليك طلب للتعديل. افتح المنصة لعرض التفاصيل.";
            case "REQUEST_APPROVED" -> "تمركز — صدر قرار باعتماد طلبك. افتح المنصة لعرض التفاصيل.";
            case "REQUEST_REJECTED" -> "تمركز — صدر قرار بشأن طلبك. افتح المنصة لعرض التفاصيل.";
            case "TASK_OVERDUE" -> "تمركز — لديك مراجعة متأخرة. افتح المنصة لعرض التفاصيل.";
            case "TASK_ASSIGNED", "TASK_REALIGNED", "TASK_ROUTED" -> "تمركز — لديك إجراء مطلوب. افتح المنصة لعرض التفاصيل.";
            case "INFO_COPY" -> "تمركز — وصلك طلب للعلم. افتح المنصة لعرض التفاصيل.";
            case "SUPPORT_NEW" -> "تمركز — بلاغ دعم بانتظار الاستلام. افتح لوحة الدعم.";
            case "SUPPORT_UPDATE" -> "تمركز — تحديث على بلاغ دعم. افتح لوحة الدعم.";
            case "SUPPORT_REPLY" -> "تمركز — وصلك رد من الدعم الفني. افتح المنصة لعرض التفاصيل.";
            case "SUPPORT_RESOLVED" -> "تمركز — حُلّ بلاغك. أكّد الإغلاق أو أعد فتحه.";
            case "DUTY_PERMIT" -> "تمركز — صدر لك تصريح مناوبة. فعّله عند بدء المناوبة.";
            default -> "تمركز — لديك إشعار جديد. افتح المنصة لعرض التفاصيل.";
        };
    }

    /** Where a click goes: the request list for a request, the re-stationing request for its information copy, else home. */
    static String url(String requestId, String body, String link) {
        if (link != null && link.matches("^#[A-Za-z]{1,40}(/[0-9a-f-]{36})?$")) {
            return "/" + link;
        }
        if (requestId != null) {
            return "/#requests";
        }
        Matcher m = RESTATIONING.matcher(body == null ? "" : body);
        return m.find() ? "/#restationing/" + m.group(1) : "/";
    }

    public Map<String, Object> feed(UUID person, Long since) {
        long latest = jdbc.sql("select coalesce(max(seq), 0) from notification where person_id = :p").param("p", person)
                .query(Long.class).single();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("personId", person.toString());
        List<Map<String, Object>> items = new ArrayList<>();
        if (since != null) {
            jdbc.sql("""
                    select seq, kind, body, request_id, link, created_at from notification
                    where person_id = :p and seq > :s and read_at is null order by seq limit :l""")
                    .param("p", person).param("s", since).param("l", MAX)
                    .query((rs, n) -> {
                        String kind = rs.getString("kind");
                        Map<String, Object> m = new LinkedHashMap<>();
                        m.put("seq", rs.getLong("seq"));
                        m.put("kind", kind);
                        m.put("title", TITLE);
                        m.put("body", body(kind));
                        m.put("url", url(rs.getString("request_id"), rs.getString("body"), rs.getString("link")));
                        m.put("requireInteraction", ACTION.contains(kind));
                        m.put("createdAt", Db.iso(rs, "created_at"));
                        return items.add(m);
                    }).list();
            // a full page: the cursor stops at its last item and the rest comes next time; otherwise it moves to the newest
            // number, skipping read items, and never behind an item just returned
            long last = items.isEmpty() ? 0 : (long) items.get(items.size() - 1).get("seq");
            latest = items.size() == MAX ? last : Math.max(latest, last);
        }
        out.put("latestSeq", latest);
        out.put("items", items);
        return out;
    }
}
