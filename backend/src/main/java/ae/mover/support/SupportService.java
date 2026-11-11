package ae.mover.support;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ae.mover.access.AccessContext;
import ae.mover.access.Permission;
import ae.mover.audit.AuditService;
import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Json;

/**
 * «مركز الدعم», as in TNQL's support centre (owner, 11 Nov 2026; ADR-053). A person reports a problem («أبلغ عن مشكلة») and
 * follows it in «بلاغاتي»; the support staff — people holding a support seat, «موظف دعم» or «مشرف دعم» — work the queue in
 * «لوحة الدعم»: take a case, assign it, set its priority, reply or leave an internal note, resolve it. The person confirms
 * the resolution or reopens the case. Each priority has a response time (critical 1 h, high 4 h, normal 24 h, low 72 h).
 *
 * <p>Visibility: the person who reported a case sees it and its public messages; a seat holder sees every case and the
 * internal notes; anyone else gets «not found». Seats are given and ended by a configuration administrator or a support
 * supervisor. A case holds the screen it came from and browser facts, never a request's contents.
 */
@Service
public class SupportService {

    static final Set<String> CATEGORIES = Set.of("SIGN_IN", "PERMISSIONS", "REQUESTS", "MAP", "STATIONING", "DATA", "NOTIFICATIONS",
            "PERFORMANCE", "OTHER");
    static final Map<String, Duration> RESPONSE = Map.of("CRITICAL", Duration.ofHours(1), "HIGH", Duration.ofHours(4),
            "NORMAL", Duration.ofHours(24), "LOW", Duration.ofHours(72));

    private final JdbcClient jdbc;
    private final Clock clock;
    private final AuditService audit;
    private final Json json;

    public SupportService(JdbcClient jdbc, Clock clock, AuditService audit, Json json) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.audit = audit;
        this.json = json;
    }

    // ---- seats ---------------------------------------------------------------------------------------------------

    /** The person's current seat: AGENT, SUPERVISOR or null. */
    public String seat(UUID person) {
        return jdbc.sql("select role from support_seat where person_id = :p and ended_at is null").param("p", person)
                .query(String.class).optional().orElse(null);
    }

    private void requireSeat(AccessContext ctx) {
        if (seat(ctx.personId()) == null) {
            throw ApiException.forbidden("لوحة الدعم لموظفي الدعم فقط.");
        }
    }

    private boolean managesSeats(AccessContext ctx) {
        return ctx.canEverywhere(Permission.CONFIGURE) || "SUPERVISOR".equals(seat(ctx.personId()));
    }

    public List<Map<String, Object>> seats(AccessContext ctx) {
        if (!managesSeats(ctx)) {
            requireSeat(ctx);
        }
        return jdbc.sql("""
                select s.id, s.person_id, s.role, s.granted_at, p.display_name, p.employee_no,
                       (select count(*) from support_case c where c.assignee_id = s.person_id and c.status in ('OPEN', 'IN_PROGRESS', 'WAITING_USER')) as open_cases
                from support_seat s join person p on p.id = s.person_id
                where s.ended_at is null order by s.role desc, p.display_name""")
                .query((rs, n) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getString("id"));
                    m.put("personId", rs.getString("person_id"));
                    m.put("displayName", rs.getString("display_name"));
                    m.put("employeeNo", rs.getString("employee_no"));
                    m.put("role", rs.getString("role"));
                    m.put("grantedAt", Db.iso(rs, "granted_at"));
                    m.put("openCases", rs.getLong("open_cases"));
                    return m;
                }).list();
    }

    public record SeatInput(String personId, String role) {
    }

    @Transactional
    public Map<String, Object> grantSeat(AccessContext ctx, SeatInput in) {
        if (!managesSeats(ctx)) {
            throw ApiException.forbidden("يعيّن مقاعد الدعم مدير التهيئة أو مشرف الدعم.");
        }
        if (in == null || in.personId() == null || !Set.of("AGENT", "SUPERVISOR").contains(in.role())) {
            throw ApiException.validation("اختر الشخص ونوع المقعد.");
        }
        UUID person = UUID.fromString(in.personId());
        boolean active = jdbc.sql("select count(*) from person where id = :p and status = 'ACTIVE'").param("p", person).query(Integer.class).single() > 0;
        if (!active) {
            throw ApiException.validation("الشخص غير موجود أو غير نشط.");
        }
        if ("SUPERVISOR".equals(in.role()) && !ctx.canEverywhere(Permission.CONFIGURE)) {
            throw ApiException.forbidden("يعيّن مشرف الدعم مدير التهيئة فقط.");
        }
        Instant now = clock.instant();
        // a new seat replaces the person's current one
        jdbc.sql("update support_seat set ended_at = :now, ended_by = :by, ended_reason = 'REPLACED' where person_id = :p and ended_at is null")
                .param("now", Db.ts(now)).param("by", ctx.personId()).param("p", person).update();
        UUID id = UUID.randomUUID();
        jdbc.sql("insert into support_seat(id, person_id, role, granted_by, granted_at) values (:id, :p, :r, :by, :now)")
                .param("id", id).param("p", person).param("r", in.role()).param("by", ctx.personId()).param("now", Db.ts(now)).update();
        audit.recordAs(ctx.actor(), "SUPPORT_SEAT_GRANTED", "PERSON", person.toString(), null, Map.of("role", in.role()), null);
        return Map.of("id", id.toString());
    }

    @Transactional
    public void endSeat(AccessContext ctx, UUID seatId, String reason) {
        if (!managesSeats(ctx)) {
            throw ApiException.forbidden("يعيّن مقاعد الدعم مدير التهيئة أو مشرف الدعم.");
        }
        Map<String, Object> s = jdbc.sql("select person_id, role from support_seat where id = :id and ended_at is null").param("id", seatId)
                .query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        if ("SUPERVISOR".equals(s.get("role")) && !ctx.canEverywhere(Permission.CONFIGURE)) {
            throw ApiException.forbidden("ينهي مقعد مشرف الدعم مدير التهيئة فقط.");
        }
        jdbc.sql("update support_seat set ended_at = :now, ended_by = :by, ended_reason = :r where id = :id")
                .param("now", Db.ts(clock.instant())).param("by", ctx.personId()).param("r", reason == null ? "" : reason.trim()).param("id", seatId).update();
        audit.recordAs(ctx.actor(), "SUPPORT_SEAT_ENDED", "PERSON", s.get("person_id").toString(), null, Map.of("role", s.get("role")), reason);
    }

    // ---- the person's side ---------------------------------------------------------------------------------------

    public record CaseInput(String title, String category, String priority, String body, String screen, Map<String, Object> clientInfo) {
    }

    @Transactional
    public Map<String, Object> open(AccessContext ctx, CaseInput in) {
        if (in == null) {
            throw ApiException.validation("صف المشكلة.");
        }
        String title = in.title() == null ? "" : in.title().trim();
        String body = in.body() == null ? "" : in.body().trim();
        if (title.length() < 3 || title.length() > 200) {
            throw ApiException.validation("اكتب عنواناً قصيراً للمشكلة (3 إلى 200 حرف).");
        }
        if (body.isEmpty() || body.length() > 4000) {
            throw ApiException.validation("صف المشكلة في 4000 حرف على الأكثر.");
        }
        String category = CATEGORIES.contains(in.category()) ? in.category() : "OTHER";
        String priority = RESPONSE.containsKey(in.priority()) ? in.priority() : "NORMAL";
        String screen = in.screen() != null && in.screen().matches("^[A-Za-z]{1,40}$") ? in.screen() : null;
        Instant now = clock.instant();
        long seq = jdbc.sql("select nextval('support_case_no')").query(Long.class).single();
        String number = "SUP-" + now.atZone(ZoneOffset.UTC).getYear() + "-" + String.format("%04d", seq);
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into support_case(id, number, requester_id, category, priority, status, title, screen, client_info,
                                         created_at, updated_at, response_due)
                values (:id, :n, :p, :c, :pr, 'OPEN', :t, :s, cast(:ci as jsonb), :now, :now, :due)""")
                .param("id", id).param("n", number).param("p", ctx.personId()).param("c", category).param("pr", priority)
                .param("t", title).param("s", screen).param("ci", clientInfo(in.clientInfo())).param("now", Db.ts(now))
                .param("due", Db.ts(now.plus(RESPONSE.get(priority)))).update();
        message(id, ctx.personId(), false, false, body, now);
        event(id, ctx.personId(), "OPENED", Map.of("priority", priority, "category", category), now);
        for (UUID agent : jdbc.sql("select person_id from support_seat where ended_at is null").query(UUID.class).list()) {
            if (!agent.equals(ctx.personId())) {
                notify(agent, "SUPPORT_NEW", "بلاغ دعم جديد " + number, title, "#supportConsole/" + id, now);
            }
        }
        audit.recordAs(ctx.actor(), "SUPPORT_CASE_OPENED", "SUPPORT_CASE", id.toString(), number, Map.of("priority", priority), null);
        return Map.of("id", id.toString(), "number", number);
    }

    /** Only the browser's own facts, each a short string: nothing a page could slip a request's contents into. */
    private String clientInfo(Map<String, Object> raw) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (raw != null) {
            for (String k : List.of("appVersion", "browser", "platform", "screen", "language", "theme")) {
                Object v = raw.get(k);
                if (v != null) {
                    String s = v.toString();
                    out.put(k, s.length() > 120 ? s.substring(0, 120) : s);
                }
            }
        }
        return json.write(out);
    }

    public List<Map<String, Object>> mine(AccessContext ctx) {
        return jdbc.sql("""
                select c.*, a.display_name as assignee_name from support_case c left join person a on a.id = c.assignee_id
                where c.requester_id = :p order by c.created_at desc limit 200""")
                .param("p", ctx.personId()).query((rs, n) -> row(rs, false)).list();
    }

    /** One case: for the person who reported it (public messages) or a seat holder (everything). */
    public Map<String, Object> get(AccessContext ctx, UUID id) {
        boolean staff = seat(ctx.personId()) != null;
        Map<String, Object> c = jdbc.sql("""
                select c.*, a.display_name as assignee_name, r.display_name as requester_name, r.employee_no as requester_no
                from support_case c left join person a on a.id = c.assignee_id join person r on r.id = c.requester_id where c.id = :id""")
                .param("id", id).query((rs, n) -> {
                    Map<String, Object> m = row(rs, true);
                    m.put("requesterId", rs.getString("requester_id"));
                    if (staff) {
                        m.put("requesterName", rs.getString("requester_name"));
                        m.put("requesterNo", rs.getString("requester_no"));
                        m.put("clientInfo", json.tree(rs.getString("client_info")));
                    }
                    return m;
                }).optional().orElseThrow(ApiException::notFound);
        if (!staff && !ctx.personId().toString().equals(c.get("requesterId"))) {
            throw ApiException.notFound();
        }
        c.put("messages", jdbc.sql("""
                select m.*, p.display_name from support_message m join person p on p.id = m.author_id
                where m.case_id = :id and (:staff or not m.internal) order by m.created_at, m.id""")
                .param("id", id).param("staff", staff).query((rs, n) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getString("id"));
                    m.put("author", rs.getString("display_name"));
                    m.put("fromSupport", rs.getBoolean("from_support"));
                    m.put("internal", rs.getBoolean("internal"));
                    m.put("body", rs.getString("body"));
                    m.put("createdAt", Db.iso(rs, "created_at"));
                    return m;
                }).list());
        if (staff) {
            c.put("events", jdbc.sql("""
                    select e.kind, e.detail::text as detail, e.created_at, p.display_name from support_event e left join person p on p.id = e.actor_id
                    where e.case_id = :id order by e.id""").param("id", id).query((rs, n) -> {
                        Map<String, Object> m = new LinkedHashMap<>();
                        m.put("kind", rs.getString("kind"));
                        m.put("actor", rs.getString("display_name"));
                        m.put("detail", rs.getString("detail") == null ? null : json.tree(rs.getString("detail")));
                        m.put("at", Db.iso(rs, "created_at"));
                        return m;
                    }).list());
        }
        c.put("staff", staff);
        return c;
    }

    private Map<String, Object> row(java.sql.ResultSet rs, boolean full) throws java.sql.SQLException {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", rs.getString("id"));
        m.put("number", rs.getString("number"));
        m.put("title", rs.getString("title"));
        m.put("category", rs.getString("category"));
        m.put("priority", rs.getString("priority"));
        m.put("status", rs.getString("status"));
        m.put("screen", rs.getString("screen"));
        m.put("assigneeName", rs.getString("assignee_name"));
        m.put("assigneeId", rs.getString("assignee_id"));
        m.put("createdAt", Db.iso(rs, "created_at"));
        m.put("updatedAt", Db.iso(rs, "updated_at"));
        m.put("responseDue", Db.iso(rs, "response_due"));
        m.put("firstResponseAt", Db.iso(rs, "first_response_at"));
        m.put("resolvedAt", Db.iso(rs, "resolved_at"));
        m.put("closedAt", Db.iso(rs, "closed_at"));
        return m;
    }

    public record MessageInput(String body, Boolean internal) {
    }

    /** The person's reply: back to the support staff (the assignee, or every seat while none). */
    @Transactional
    public void reply(AccessContext ctx, UUID id, MessageInput in) {
        Map<String, Object> c = lockOwn(ctx, id);
        if ("CLOSED".equals(c.get("status"))) {
            throw ApiException.validation("البلاغ مغلق؛ افتح بلاغاً جديداً.");
        }
        Instant now = clock.instant();
        message(id, ctx.personId(), false, false, body(in), now);
        String status = c.get("assignee_id") == null ? "OPEN" : "IN_PROGRESS";
        jdbc.sql("update support_case set status = :s, updated_at = :now, resolved_at = null where id = :id")
                .param("s", status).param("now", Db.ts(now)).param("id", id).update();
        event(id, ctx.personId(), "REQUESTER_REPLIED", null, now);
        String number = (String) c.get("number");
        List<UUID> to = c.get("assignee_id") != null ? List.of((UUID) c.get("assignee_id"))
                : jdbc.sql("select person_id from support_seat where ended_at is null").query(UUID.class).list();
        for (UUID p : to) {
            notify(p, "SUPPORT_UPDATE", "تحديث على البلاغ " + number, (String) c.get("title"), "#supportConsole/" + id, now);
        }
    }

    /** The person confirms the resolution (CLOSED) or reopens a resolved case. */
    @Transactional
    public void confirm(AccessContext ctx, UUID id, boolean solved, String note) {
        Map<String, Object> c = lockOwn(ctx, id);
        if (!"RESOLVED".equals(c.get("status"))) {
            throw ApiException.validation("لا يُؤكَّد إلا بلاغ حُلّ.");
        }
        Instant now = clock.instant();
        if (note != null && !note.isBlank()) {
            message(id, ctx.personId(), false, false, note.trim().length() > 4000 ? note.trim().substring(0, 4000) : note.trim(), now);
        }
        if (solved) {
            jdbc.sql("update support_case set status = 'CLOSED', closed_at = :now, updated_at = :now where id = :id")
                    .param("now", Db.ts(now)).param("id", id).update();
            event(id, ctx.personId(), "CLOSED_BY_REQUESTER", null, now);
        } else {
            jdbc.sql("update support_case set status = 'IN_PROGRESS', resolved_at = null, updated_at = :now where id = :id")
                    .param("now", Db.ts(now)).param("id", id).update();
            event(id, ctx.personId(), "REOPENED", null, now);
            if (c.get("assignee_id") != null) {
                notify((UUID) c.get("assignee_id"), "SUPPORT_UPDATE", "أُعيد فتح البلاغ " + c.get("number"), (String) c.get("title"),
                        "#supportConsole/" + id, now);
            }
        }
        audit.recordAs(ctx.actor(), solved ? "SUPPORT_CASE_CLOSED" : "SUPPORT_CASE_REOPENED", "SUPPORT_CASE", id.toString(), (String) c.get("number"), Map.of(), null);
    }

    private Map<String, Object> lockOwn(AccessContext ctx, UUID id) {
        Map<String, Object> c = jdbc.sql("select * from support_case where id = :id for update").param("id", id).query().listOfRows()
                .stream().findFirst().orElseThrow(ApiException::notFound);
        if (!ctx.personId().equals(c.get("requester_id"))) {
            throw ApiException.notFound();
        }
        return c;
    }

    // ---- «لوحة الدعم» ---------------------------------------------------------------------------------------------

    public List<Map<String, Object>> queue(AccessContext ctx, String filter) {
        requireSeat(ctx);
        String where = switch (filter == null ? "open" : filter) {
            case "mine" -> "c.assignee_id = :me and c.status in ('OPEN', 'IN_PROGRESS', 'WAITING_USER')";
            case "unassigned" -> "c.assignee_id is null and c.status in ('OPEN', 'IN_PROGRESS', 'WAITING_USER')";
            case "resolved" -> "c.status in ('RESOLVED', 'CLOSED')";
            default -> "c.status in ('OPEN', 'IN_PROGRESS', 'WAITING_USER')";
        };
        return jdbc.sql("""
                select c.*, a.display_name as assignee_name, r.display_name as requester_name from support_case c
                left join person a on a.id = c.assignee_id join person r on r.id = c.requester_id""" + " where " + where
                + " order by case c.priority when 'CRITICAL' then 0 when 'HIGH' then 1 when 'NORMAL' then 2 else 3 end, c.response_due limit 300")
                .param("me", ctx.personId()).query((rs, n) -> {
                    Map<String, Object> m = row(rs, false);
                    m.put("requesterName", rs.getString("requester_name"));
                    return m;
                }).list();
    }

    public record ActInput(String action, String assigneeId, String priority, String body, Boolean internal) {
    }

    /** One step of the support staff: CLAIM, ASSIGN, PRIORITY, REPLY (public or internal), RESOLVE, CLOSE. */
    @Transactional
    public void act(AccessContext ctx, UUID id, ActInput in) {
        requireSeat(ctx);
        if (in == null || in.action() == null) {
            throw ApiException.validation("اختر الإجراء.");
        }
        Map<String, Object> c = jdbc.sql("select * from support_case where id = :id for update").param("id", id).query().listOfRows()
                .stream().findFirst().orElseThrow(ApiException::notFound);
        if ("CLOSED".equals(c.get("status")) && !"REPLY".equals(in.action())) {
            throw ApiException.validation("البلاغ مغلق.");
        }
        Instant now = clock.instant();
        UUID requester = (UUID) c.get("requester_id");
        String number = (String) c.get("number");
        String title = (String) c.get("title");
        switch (in.action()) {
            case "CLAIM" -> {
                jdbc.sql("update support_case set assignee_id = :me, status = case when status = 'OPEN' then 'IN_PROGRESS' else status end, updated_at = :now where id = :id")
                        .param("me", ctx.personId()).param("now", Db.ts(now)).param("id", id).update();
                event(id, ctx.personId(), "CLAIMED", null, now);
            }
            case "ASSIGN" -> {
                if (!"SUPERVISOR".equals(seat(ctx.personId())) && !ctx.canEverywhere(Permission.CONFIGURE)) {
                    throw ApiException.forbidden("يُسند البلاغ مشرف الدعم.");
                }
                UUID to = in.assigneeId() == null ? null : UUID.fromString(in.assigneeId());
                if (to == null || seat(to) == null) {
                    throw ApiException.validation("يُسند البلاغ إلى من يملك مقعد دعم.");
                }
                jdbc.sql("update support_case set assignee_id = :to, status = case when status = 'OPEN' then 'IN_PROGRESS' else status end, updated_at = :now where id = :id")
                        .param("to", to).param("now", Db.ts(now)).param("id", id).update();
                event(id, ctx.personId(), "ASSIGNED", Map.of("to", to.toString()), now);
                if (!to.equals(ctx.personId())) {
                    notify(to, "SUPPORT_NEW", "أُسند إليك البلاغ " + number, title, "#supportConsole/" + id, now);
                }
            }
            case "PRIORITY" -> {
                if (!RESPONSE.containsKey(in.priority())) {
                    throw ApiException.validation("أولوية غير معروفة.");
                }
                Instant created = ((java.sql.Timestamp) c.get("created_at")).toInstant();
                jdbc.sql("update support_case set priority = :p, response_due = :due, updated_at = :now where id = :id")
                        .param("p", in.priority()).param("due", Db.ts(created.plus(RESPONSE.get(in.priority())))).param("now", Db.ts(now)).param("id", id).update();
                event(id, ctx.personId(), "PRIORITY", Map.of("from", c.get("priority"), "to", in.priority()), now);
            }
            case "REPLY" -> {
                boolean internal = Boolean.TRUE.equals(in.internal());
                if ("CLOSED".equals(c.get("status")) && !internal) {
                    throw ApiException.validation("البلاغ مغلق؛ تُضاف ملاحظة داخلية فقط.");
                }
                message(id, ctx.personId(), true, internal, body(new MessageInput(in.body(), internal)), now);
                if (!internal) {
                    jdbc.sql("""
                            update support_case set status = 'WAITING_USER', updated_at = :now, first_response_at = coalesce(first_response_at, :now),
                                   assignee_id = coalesce(assignee_id, :me) where id = :id""")
                            .param("now", Db.ts(now)).param("me", ctx.personId()).param("id", id).update();
                    notify(requester, "SUPPORT_REPLY", "رد الدعم على البلاغ " + number, title, "#support/" + id, now);
                }
                event(id, ctx.personId(), internal ? "NOTE" : "REPLIED", null, now);
            }
            case "RESOLVE" -> {
                String text = in.body() == null ? "" : in.body().trim();
                if (text.length() < 3) {
                    throw ApiException.validation("اكتب للمستخدم ما الذي حلّ المشكلة.");
                }
                message(id, ctx.personId(), true, false, body(new MessageInput(text, false)), now);
                jdbc.sql("""
                        update support_case set status = 'RESOLVED', resolved_at = :now, updated_at = :now,
                               first_response_at = coalesce(first_response_at, :now), assignee_id = coalesce(assignee_id, :me) where id = :id""")
                        .param("now", Db.ts(now)).param("me", ctx.personId()).param("id", id).update();
                event(id, ctx.personId(), "RESOLVED", null, now);
                notify(requester, "SUPPORT_RESOLVED", "حُلّ البلاغ " + number, title, "#support/" + id, now);
            }
            case "CLOSE" -> {
                jdbc.sql("update support_case set status = 'CLOSED', closed_at = :now, updated_at = :now where id = :id")
                        .param("now", Db.ts(now)).param("id", id).update();
                event(id, ctx.personId(), "CLOSED", null, now);
            }
            default -> throw ApiException.validation("إجراء غير معروف.");
        }
        audit.recordAs(ctx.actor(), "SUPPORT_CASE_" + in.action(), "SUPPORT_CASE", id.toString(), number, Map.of(), null);
    }

    // ---- shared --------------------------------------------------------------------------------------------------

    private static String body(MessageInput in) {
        String b = in == null || in.body() == null ? "" : in.body().trim();
        if (b.isEmpty() || b.length() > 4000) {
            throw ApiException.validation("اكتب الرسالة في 4000 حرف على الأكثر.");
        }
        return b;
    }

    private void message(UUID caseId, UUID author, boolean fromSupport, boolean internal, String body, Instant now) {
        jdbc.sql("""
                insert into support_message(id, case_id, author_id, from_support, internal, body, created_at)
                values (:id, :c, :a, :s, :i, :b, :now)""")
                .param("id", UUID.randomUUID()).param("c", caseId).param("a", author).param("s", fromSupport).param("i", internal)
                .param("b", body).param("now", Db.ts(now)).update();
    }

    private void event(UUID caseId, UUID actor, String kind, Map<String, Object> detail, Instant now) {
        jdbc.sql("insert into support_event(case_id, actor_id, kind, detail, created_at) values (:c, :a, :k, cast(:d as jsonb), :now)")
                .param("c", caseId).param("a", actor).param("k", kind).param("d", detail == null ? null : json.write(detail))
                .param("now", Db.ts(now)).update();
    }

    /** In the bell and, through the desktop feed (ADR-050), as a toast with fixed text; the link opens the case. */
    private void notify(UUID person, String kind, String title, String body, String link, Instant now) {
        jdbc.sql("""
                insert into notification(id, person_id, kind, title, body, link, created_at)
                values (:id, :p, :k, :t, :b, :l, :now)""")
                .param("id", UUID.randomUUID()).param("p", person).param("k", kind).param("t", title).param("b", body)
                .param("l", link).param("now", Db.ts(now)).update();
    }

    /** For the tests and the console's summary: counts per status. */
    public Map<String, Long> counts(AccessContext ctx) {
        requireSeat(ctx);
        Map<String, Long> out = new LinkedHashMap<>();
        for (String s : List.of("OPEN", "IN_PROGRESS", "WAITING_USER", "RESOLVED", "CLOSED")) {
            out.put(s, 0L);
        }
        jdbc.sql("select status, count(*) as n from support_case group by status").query((rs, n) -> out.put(rs.getString("status"), rs.getLong("n"))).list();
        out.put("OVERDUE", jdbc.sql("""
                select count(*) from support_case where status in ('OPEN', 'IN_PROGRESS') and first_response_at is null and response_due < :now""")
                .param("now", Db.ts(clock.instant())).query(Long.class).single());
        return out;
    }
}
