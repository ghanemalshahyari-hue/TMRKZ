package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * «ACCESS-SCOPE-PARITY-WITH-MOVER» (owner brief, 20 Nov 2026): the acceptance matrix a scoped MANAGE_ACCESS holder must
 * never breach. The scope is a subtree the manager was granted; everything outside it must look as if it does not exist,
 * for every path: list, search, lookup by number, lookup by username, the add-user Oracle lookup, counts, and any read
 * endpoint that returns a person. Any UX consolidation that regresses this suite is considered broken.
 *
 * <pre>
 *   ROOT
 *   ├── MAIN-A
 *   │   ├── A1 ← manager M1 holds MANAGE_ACCESS here (subtree)
 *   │   │   └── A1-1
 *   │   └── A2
 *   └── MAIN-B
 *       └── B1
 *
 *   P1 posted at A1, user of A1          — visible to M1
 *   P2 posted at A1-1, user of A1-1      — visible to M1
 *   P3 posted at A2, user of A2          — hidden
 *   P4 posted at MAIN-A, user of MAIN-A  — hidden
 *   P5 posted at B1, user of B1          — hidden
 *   P6 HR at B1 but added to A1          — visible to M1 (attachment inside reach)
 *   P7 HR at B1 attached then ended      — hidden
 * </pre>
 *
 * <p>Since ADR-061 (owner, 16 Nov 2026) a unit's users are those added («إضافة مستخدم», an approved access request or a
 * direct grant); an HR posting alone lists no one in the counts, the tree, the people search or the unit file. P1–P5 are
 * therefore users of the unit they are posted at, added by the administrator, so the hidden ones are real users that a
 * global manager sees (checked) and that M1 must not.
 */
class AccessScopeParityIT extends IntegrationTest {

    UUID root, mainA, a1, a11, a2, mainB, b1, admin, m1;
    UUID p1, p2, p3, p4, p5, p6, p7;
    String mgrRole;
    Api m1Api;

    @BeforeEach
    void fixtures() {
        root = org("ROOT-" + sfx, null);
        mainA = org("MAIN-A-" + sfx, root);
        a1 = org("A1-" + sfx, mainA);
        a11 = org("A1-1-" + sfx, a1);
        a2 = org("A2-" + sfx, mainA);
        mainB = org("MAIN-B-" + sfx, root);
        b1 = org("B1-" + sfx, mainB);
        mgrRole = role("SCOPE_MGR_" + sfx, "ORGANIZATION", "MANAGE_ACCESS", "VIEW");
        admin = person("scope_admin_" + sfx, "SYSTEM_ADMIN", root);
        m1 = person("m1_" + sfx, mgrRole, a1);
        p1 = hrPersonAt(a1, "p1");
        p2 = hrPersonAt(a11, "p2");
        p3 = hrPersonAt(a2, "p3");
        p4 = hrPersonAt(mainA, "p4");
        p5 = hrPersonAt(b1, "p5");
        // users of the units they are posted at (ADR-061: a posting alone makes no one a user)
        attach(p1, a1);
        attach(p2, a11);
        attach(p3, a2);
        attach(p4, mainA);
        attach(p5, b1);
        // P6: posted at B1, local attachment ACTIVE at A1 — visible to M1
        p6 = hrPersonAt(b1, "p6");
        attach(p6, a1);
        // P7: posted at B1, attachment to A1 ENDED — not visible to M1
        p7 = hrPersonAt(b1, "p7");
        attach(p7, a1);
        // Ended exactly as UnitMemberService ends an entry: V33 requires ended_by with ended_at (unit_member_check1) and
        // ended_at >= added_at (unit_member_check).
        jdbc.sql("""
                update unit_member set ended_at = greatest(now(), added_at), ended_by = :by, ended_reason = 'اختبار: انتهى الإلحاق'
                where person_id = :p and ended_at is null""").param("p", p7).param("by", admin).update();
        // M1 is also in the unit_member directory of A1 (so search sees them)
        attach(m1, a1);
        m1Api = login("m1_" + sfx);
    }

    private UUID hrPersonAt(UUID org, String tag) {
        UUID id = UUID.randomUUID();
        String emp = "EMP-" + tag + "-" + sfx;
        String login = tag + "-" + sfx;
        jdbc.sql("insert into person(id, employee_no, display_name, username, source, source_external_id) values (:id, :e, :n, :u, 'HR', :x)")
                .param("id", id).param("e", emp).param("n", "الموظف " + tag).param("u", login).param("x", "X-" + tag + "-" + sfx).update();
        jdbc.sql("insert into affiliation(id, person_id, organization_id, position_title, valid_from) values (:id, :p, :o, 'وظيفة', '2026-01-01T00:00:00Z')")
                .param("id", UUID.randomUUID()).param("p", id).param("o", org).update();
        return id;
    }

    private void attach(UUID person, UUID org) {
        jdbc.sql("insert into unit_member(id, person_id, organization_id, acting, added_by, added_at) values (:id, :p, :o, false, :by, now())")
                .param("id", UUID.randomUUID()).param("p", person).param("o", org).param("by", admin).update();
    }

    private String empOf(UUID id) {
        return jdbc.sql("select employee_no from person where id = :id").param("id", id).query(String.class).single();
    }
    private String userOf(UUID id) {
        return jdbc.sql("select username from person where id = :id").param("id", id).query(String.class).single();
    }

    @Test
    @DisplayName("SCOPE-01 workspace search by name returns only people inside the reach; outside-scope names do not appear")
    void searchByName() {
        Res r = m1Api.get("/access/workspace/search?kind=PEOPLE&q=" + urlEncode("الموظف"));
        assertThat(r.status()).isEqualTo(200);
        List<String> ids = idsOf(r.body());
        assertThat(ids).contains(p1.toString(), p2.toString(), p6.toString());
        assertThat(ids).doesNotContain(p3.toString(), p4.toString(), p5.toString(), p7.toString());
        // control: the hidden ones are real users, found by a manager over everything
        List<String> global = idsOf(login("scope_admin_" + sfx).get("/access/workspace/search?kind=PEOPLE&q=" + urlEncode("الموظف")).body());
        assertThat(global).contains(p1.toString(), p2.toString(), p3.toString(), p4.toString(), p5.toString(), p6.toString());
    }

    @Test
    @DisplayName("SCOPE-02 add-user lookup by exact military number: hidden people answer the same «not found» as unknowns")
    void addUserLookup() {
        // P1 (inside) answers with a card
        Res in = m1Api.get("/access/unit-members/lookup?organizationId=" + a1 + "&key=" + empOf(p1));
        assertThat(in.status()).isEqualTo(200);
        assertThat(in.body().path("displayName").asText()).contains("p1");
        // P3 (outside the reach) — identical answer to a nonsense key
        for (UUID hidden : List.of(p3, p4, p5, p7)) {
            Res out = m1Api.get("/access/unit-members/lookup?organizationId=" + a1 + "&key=" + empOf(hidden));
            Res bogus = m1Api.get("/access/unit-members/lookup?organizationId=" + a1 + "&key=BOGUS-" + sfx);
            assertThat(out.status()).as("hidden " + hidden).isEqualTo(bogus.status());
            // the whole answer is the same; only the per-request trace id differs
            assertThat(withoutTrace(out.body())).as("hidden " + hidden).isEqualTo(withoutTrace(bogus.body()));
            assertThat(out.body().path("traceId").asText()).as("each answer carries its own trace id").isNotEqualTo(bogus.body().path("traceId").asText());
        }
    }

    @Test
    @DisplayName("SCOPE-03 add-user lookup by username: no information disclosure for outside-scope people")
    void addUserLookupByUsername() {
        for (UUID hidden : List.of(p3, p4, p5, p7)) {
            Res out = m1Api.get("/access/unit-members/lookup?organizationId=" + a1 + "&key=" + userOf(hidden));
            Res bogus = m1Api.get("/access/unit-members/lookup?organizationId=" + a1 + "&key=nobody-" + sfx);
            assertThat(out.status()).as("hidden " + hidden).isEqualTo(bogus.status());
        }
    }

    @Test
    @DisplayName("SCOPE-04 the active attached person (P6) is visible, the ended one (P7) is not")
    void attachmentActive() {
        // P6 — active attachment
        Res in = m1Api.get("/access/unit-members/lookup?organizationId=" + a1 + "&key=" + empOf(p6));
        assertThat(in.status()).isEqualTo(200);
        assertThat(in.body().path("displayName").asText()).contains("p6");
        // P7 — attachment ended
        Res out = m1Api.get("/access/unit-members/lookup?organizationId=" + a1 + "&key=" + empOf(p7));
        Res bogus = m1Api.get("/access/unit-members/lookup?organizationId=" + a1 + "&key=BOGUS-7-" + sfx);
        assertThat(out.status()).isEqualTo(bogus.status());
    }

    @Test
    @DisplayName("SCOPE-05 the workspace tree starts at A1 and does not include MAIN-B")
    void treeStartsAtReach() {
        Res r = m1Api.get("/access/workspace/tree");
        assertThat(r.status()).isEqualTo(200);
        String body = r.body().toString();
        assertThat(body).contains("A1-" + sfx);
        assertThat(body).doesNotContain("MAIN-B-" + sfx);
        assertThat(body).doesNotContain("B1-" + sfx);
    }

    @Test
    @DisplayName("SCOPE-06 the counters count only reach people (P1, P2 and P6 at the subtree, and M1); not P3 / P4 / P5 / P7")
    void countsScoped() {
        // the workspace counters over the manager's reach (GET /access/workspace/summary; there is no per-unit /summary)
        Res r = m1Api.get("/access/workspace/summary");
        assertThat(r.status()).isEqualTo(200);
        assertThat(r.body().path("global").asBoolean()).isFalse();
        assertThat(r.body().path("units").asLong()).as("A1 and A1-1").isEqualTo(2);
        assertThat(r.body().path("people").asLong()).as("P1@A1 + P2@A1-1 + P6 attached + M1 themselves").isEqualTo(4);
        // the unit file of A1 counts A1's own users: P1, P6 and M1
        Res unit = m1Api.get("/access/workspace/units/" + a1);
        assertThat(unit.status()).isEqualTo(200);
        assertThat(unit.body().path("people").asLong()).as("P1 + P6 + M1").isEqualTo(3);
        // a unit outside the reach is not opened at all
        assertThat(m1Api.get("/access/workspace/units/" + b1).status()).isIn(403, 404);
    }

    // ---- helpers ----------------------------------------------------------------------------------------------------

    private static String urlEncode(String s) {
        return java.net.URLEncoder.encode(s, java.nio.charset.StandardCharsets.UTF_8);
    }

    private static JsonNode withoutTrace(JsonNode body) {
        JsonNode copy = body.deepCopy();
        if (copy instanceof com.fasterxml.jackson.databind.node.ObjectNode o) {
            o.remove("traceId");
        }
        return copy;
    }

    private static List<String> idsOf(JsonNode body) {
        java.util.List<String> out = new java.util.ArrayList<>();
        if (body.isArray()) {
            for (JsonNode n : body) {
                if (n.hasNonNull("id")) out.add(n.path("id").asText());
            }
        }
        return out;
    }
}
