package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.DisplayName;

/**
 * «إرشادات صفحة الدخول» kept in the settings (owner, 17 Nov 2026; ADR-083): whoever configures the system saves the board;
 * the sign-in page reads, before anyone signs in, only the notes shown today (an important notice first, a hidden or
 * out-of-date note never leaves the server there); nobody else may save it.
 */
class SignInNotesIT extends IntegrationTest {

    private static Map<String, Object> note(String id, String kind, String title, boolean hidden, String from, String to) {
        Map<String, Object> n = new LinkedHashMap<>();
        n.put("id", id);
        n.put("kind", kind);
        n.put("meta", "تصنيف");
        n.put("title", title);
        n.put("text", "نص " + title);
        n.put("hidden", hidden);
        n.put("from", from);
        n.put("to", to);
        return n;
    }

    @Test
    @DisplayName("NOTES-01 the board is saved by whoever configures the system; the sign-in page sees only today's notes, a notice first; others are refused")
    void savedAndShown() {
        java.util.UUID top = org("NT", null);
        person("cfg", role("NTCFG", "ALL", "VIEW", "CONFIGURE"), top);
        person("plain", role("NTVIEW", "ALL", "VIEW"), top);
        Map<String, Object> board = new LinkedHashMap<>();
        board.put("heading", "إرشادات الدخول");
        board.put("subheading", "نظام المواقع");
        board.put("footer", "داخل الشبكة فقط");
        board.put("notes", List.of(
                note("a", "GUIDE", "الدخول الآلي", false, null, null),
                note("b", "GUIDE", "مخفي", true, null, null),
                note("c", "NOTICE", "صيانة", false, "2000-01-01", "2999-12-31"),
                note("d", "NOTICE", "انتهت", false, "2000-01-01", "2000-01-02")));
        assertThat(login("plain").put("/settings/sign-in-notes", board).status()).isEqualTo(403);
        Res saved = login("cfg").put("/settings/sign-in-notes", board);
        assertThat(saved.status()).as(saved.toString()).isEqualTo(200);

        Res shown = new Api().get("/auth/notices"); // before anyone signs in
        assertThat(shown.status()).as(shown.toString()).isEqualTo(200);
        assertThat(shown.body().path("saved").asBoolean()).isTrue();
        assertThat(shown.body().path("notes").findValuesAsText("title")).containsExactly("صيانة", "الدخول الآلي");

        Map<String, Object> bad = new LinkedHashMap<>(board);
        bad.put("notes", List.of(note("x", "GUIDE", "", false, null, null)));
        assertThat(login("cfg").put("/settings/sign-in-notes", bad).status()).isEqualTo(400);
        assertThat(login("cfg").get("/settings/sign-in-notes").body().path("board").path("notes")).hasSize(4);
    }
}
