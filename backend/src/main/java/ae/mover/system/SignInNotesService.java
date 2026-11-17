package ae.mover.system;

import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

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
 * «إرشادات صفحة الدخول» (owner, 17 Nov 2026; ADR-083): the board beside the sign-in form — a heading, the line under it,
 * up to eight notes (guidance or an important notice, optional dates, hidden or shown) and a last line — kept by whoever
 * configures the system. The sign-in page reads it before anyone signs in, so only the notes shown today leave the server
 * there; the board holds no personal or sensitive information. No saved board: the page shows its own notes.
 */
@Service
public class SignInNotesService {

    static final int MAX_NOTES = 8;

    public record Note(String id, String kind, String meta, String title, String text, Boolean hidden, String from, String to) {
    }

    public record Board(String heading, String subheading, String footer, List<Note> notes) {
    }

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final AuditService audit;
    private final ZoneId zone;

    public SignInNotesService(JdbcClient jdbc, Json json, Clock clock, AuditService audit) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.audit = audit;
        this.zone = ZoneId.of("Asia/Dubai");
    }

    private Board stored() {
        return jdbc.sql("select board::text from sign_in_board where id = 1").query(String.class).optional()
                .map(s -> json.read(s, Board.class)).orElse(null);
    }

    /** The whole board for the settings (hidden and dated notes too); null when none was saved. */
    public Board forSettings(AccessContext ctx) {
        ctx.require(Permission.CONFIGURE);
        return stored();
    }

    /** What the sign-in page shows today: the notes not hidden and inside their dates, the important notices first. */
    public Map<String, Object> forSignIn() {
        Board b = stored();
        if (b == null) {
            return Map.of("saved", false);
        }
        String today = LocalDate.now(clock.withZone(zone)).toString();
        List<Note> shown = new ArrayList<>();
        for (Note n : b.notes() == null ? List.<Note>of() : b.notes()) {
            boolean in = !Boolean.TRUE.equals(n.hidden()) && (n.from() == null || n.from().compareTo(today) <= 0) && (n.to() == null || today.compareTo(n.to()) <= 0);
            if (in && "NOTICE".equals(n.kind())) shown.add(n);
        }
        for (Note n : b.notes() == null ? List.<Note>of() : b.notes()) {
            boolean in = !Boolean.TRUE.equals(n.hidden()) && (n.from() == null || n.from().compareTo(today) <= 0) && (n.to() == null || today.compareTo(n.to()) <= 0);
            if (in && !"NOTICE".equals(n.kind())) shown.add(n);
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("saved", true);
        m.put("heading", b.heading());
        m.put("subheading", b.subheading());
        m.put("footer", b.footer());
        m.put("notes", shown.stream().map(n -> Map.of("id", n.id(), "kind", n.kind(), "meta", nz(n.meta()), "title", n.title(), "text", n.text())).toList());
        return m;
    }

    @Transactional
    public Board save(AccessContext ctx, Board in) {
        ctx.require(Permission.CONFIGURE);
        String problem = problem(in);
        if (!problem.isEmpty()) {
            throw ApiException.validation(problem);
        }
        jdbc.sql("""
                insert into sign_in_board(id, board, updated_by, updated_at) values (1, cast(:b as jsonb), :by, :now)
                on conflict (id) do update set board = excluded.board, updated_by = excluded.updated_by, updated_at = excluded.updated_at""")
                .param("b", json.write(in)).param("by", ctx.personId()).param("now", Db.ts(clock.instant())).update();
        audit.recordAs(ctx.actor(), "SIGN_IN_NOTES_SAVED", "SETTINGS", "sign-in-board", "إرشادات صفحة الدخول",
                Map.of("notes", in.notes().size()), "تحديث إرشادات صفحة الدخول");
        return stored();
    }

    /** The first reason a board cannot be saved (the same limits as the settings screen), or empty. */
    static String problem(Board b) {
        if (b == null || b.heading() == null || b.heading().isBlank()) return "اكتب عنوان اللوحة.";
        if (b.heading().length() > 60 || nz(b.subheading()).length() > 90 || nz(b.footer()).length() > 90) return "العنوان أو السطر تحته أو الأخير أطول من المسموح.";
        List<Note> notes = b.notes() == null ? List.of() : b.notes();
        if (notes.size() > MAX_NOTES) return MAX_NOTES + " إرشادات على الأكثر.";
        for (int i = 0; i < notes.size(); i++) {
            Note n = notes.get(i);
            String at = "الإرشاد " + (i + 1);
            if (n.id() == null || n.id().isBlank() || n.id().length() > 40) return at + ": معرف غير صالح.";
            if (!"GUIDE".equals(n.kind()) && !"NOTICE".equals(n.kind())) return at + ": النوع إرشاد أو تنبيه مهم.";
            if (n.title() == null || n.title().isBlank() || n.text() == null || n.text().isBlank()) return at + ": اكتب عنوانه ونصه.";
            if (n.title().length() > 70 || n.text().length() > 400 || nz(n.meta()).length() > 40) return at + ": أطول من المسموح.";
            if (!date(n.from()) || !date(n.to())) return at + ": التاريخ بصيغة سنة-شهر-يوم.";
            if (n.from() != null && n.to() != null && n.to().compareTo(n.from()) < 0) return at + ": تاريخ النهاية قبل البداية.";
        }
        return "";
    }

    private static boolean date(String d) {
        if (d == null) return true;
        try {
            LocalDate.parse(d);
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }
}
