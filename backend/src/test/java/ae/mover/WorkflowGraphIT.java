package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;

/** The studio's flow chart on the real engine (ADR-041): questions, rejected lines, parallel steps, places and notices. */
class WorkflowGraphIT extends IntegrationTest {

    @org.springframework.beans.factory.annotation.Autowired
    private ae.mover.outbox.OutboxProcessor outbox;

    @org.springframework.beans.factory.annotation.Autowired
    private ae.mover.stationing.PlaceInfo placeInfo;

    UUID root, branch, unit, other, site, res;

    @AfterEach
    void restoreOffer() {
        if (offerBefore != null) {
            // every column as it was (audience, description, scope modes, default scope)
            jdbc.sql("delete from access_request_offer").update();
            jdbc.sql("insert into access_request_offer select * from json_populate_recordset(null::access_request_offer, cast(:j as json))")
                    .param("j", offerBefore).update();
            offerBefore = null;
        }
    }

    @BeforeEach
    void fixtures() {
        root = org("ROOT", null);
        branch = org("BRANCH", root);
        unit = org("UNIT", branch);
        other = org("OTHER", root);
        site = site("SG", site("MG", null, root), unit);
        res = resource("RG", site, null, 0);
        person("req", "REQUESTER", unit);
        person("rev", "FACILITIES_REVIEWER", unit);
        person("revb", "FACILITIES_REVIEWER", branch);
        person("revo", "FACILITIES_REVIEWER", other);
        person("apr", "APPROVER", root);
        person("admin", "SYSTEM_ADMIN", root);
    }

    private static Map<String, Object> node(String id, String type, Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("type", type);
        m.put("name", "خطوة " + id);
        for (int i = 0; i < kv.length; i += 2) {
            m.put((String) kv[i], kv[i + 1]);
        }
        return m;
    }

    private static Map<String, Object> place(String role, String from, Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("role", role);
        m.put("orgFrom", from);
        for (int i = 0; i < kv.length; i += 2) {
            m.put((String) kv[i], kv[i + 1]);
        }
        return m;
    }

    @SafeVarargs
    private static Map<String, Object> approval(String id, boolean fin, Map<String, Object>... places) {
        return node(id, "approval", "mode", "ALL", "slaDays", 3, "assignees", List.of(places), "final", fin, "requiresSignature", fin);
    }

    private static Map<String, Object> line(String from, String to, String when) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("from", from);
        m.put("to", to);
        if (when != null) {
            m.put("when", when);
        }
        return m;
    }

    private static Map<String, Object> flow(List<Map<String, Object>> nodes, List<Map<String, Object>> edges) {
        Map<String, Object> def = new LinkedHashMap<>();
        def.put("name", "مخطط اختبار");
        def.put("stages", List.of());
        def.put("execution", List.of());
        def.put("graph", Map.of("nodes", nodes, "edges", edges));
        return def;
    }

    private UUID submitted(String type) {
        Api req = login("req");
        UUID id = req.draft(type, "LIST", unit, List.of(res), day("2029-03-01"), day("2029-03-03"), Map.of("reason", "مبرر اختبار كافٍ للطلب هنا"));
        assertThat(req.upload(id, "attachments", "plan.txt", "خطة".getBytes(StandardCharsets.UTF_8)).status()).isEqualTo(200);
        assertThat(req.submit(id).status()).isEqualTo(200);
        return id;
    }

    private String status(UUID id) {
        return jdbc.sql("select status from request where id = :id").param("id", id).query(String.class).single();
    }

    private long reservations(UUID id) {
        return jdbc.sql("select count(*) from reservation where source_request_id = :id").param("id", id).query(Long.class).single();
    }

    private List<String> openStages(UUID id) {
        return jdbc.sql("select stage_key from task_assignment where request_id = :id and status = 'OPEN' order by stage_key").param("id", id).query(String.class).list();
    }

    @Test
    @DisplayName("Straight through: a chart approves and reserves as a list of stages did")
    void straight() {
        String type = requestType("NEW_RESERVATION", flow(
                List.of(node("st", "start"), approval("rv", false, place("FACILITIES_REVIEWER", "REQUEST_ORG")), approval("fin", true, place("APPROVER", "ANY")), node("ok", "end_approved")),
                List.of(line("st", "rv", null), line("rv", "fin", "approved"), line("fin", "ok", "approved"))), null);
        UUID id = submitted(type);
        assertThat(openStages(id)).containsExactly("rv");
        Api rev = login("rev");
        assertThat(rev.approve(rev.taskFor(id), 1).status()).isEqualTo(200);
        assertThat(openStages(id)).containsExactly("fin");
        Api apr = login("apr");
        assertThat(apr.approve(apr.taskFor(id), 1).status()).isEqualTo(200);
        assertThat(status(id)).isEqualTo("APPROVED");
        assertThat(activeReservations(res)).isEqualTo(1);
    }

    @Test
    @DisplayName("A question sends the request down its yes or no line")
    void question() {
        Map<String, Object> ask = node("qq", "decision", "condition", Map.of("fact", "resourceCount", "op", "gte", "value", 5));
        String type = requestType("NEW_RESERVATION", flow(
                List.of(node("st", "start"), ask, approval("big", false, place("FACILITIES_REVIEWER", "REQUEST_ORG")), approval("fin", true, place("APPROVER", "ANY")), node("ok", "end_approved")),
                List.of(line("st", "qq", null), line("qq", "big", "yes"), line("qq", "fin", "no"), line("big", "fin", "approved"), line("fin", "ok", "approved"))), null);
        assertThat(openStages(submitted(type))).as("one resource: the no line skips the review").containsExactly("fin");
    }

    @Test
    @DisplayName("A rejection with its own line goes on along it; no rejection reaches «approved» without the final approval")
    void rejectedLine() {
        String type = requestType("NEW_RESERVATION", flow(
                List.of(node("st", "start"), approval("rv", false, place("FACILITIES_REVIEWER", "REQUEST_ORG")), approval("second", false, place("FACILITIES_REVIEWER", "UP", "levelsUp", 1)),
                        approval("fin", true, place("APPROVER", "ANY")), node("ok", "end_approved")),
                List.of(line("st", "rv", null), line("rv", "fin", "approved"), line("rv", "second", "rejected"), line("second", "fin", "approved"), line("fin", "ok", "approved"))), null);
        UUID id = submitted(type);
        Api rev = login("rev");
        assertThat(rev.decide(rev.taskFor(id), "REJECT", "لا يناسب هذه الجهة، يحتاج رأياً أعلى", 1).status()).isEqualTo(200);
        assertThat(status(id)).as("still running: the rejection had a line").isEqualTo("SUBMITTED");
        assertThat(openStages(id)).containsExactly("second");
        Api revb = login("revb");
        assertThat(revb.approve(revb.taskFor(id), 1).status()).isEqualTo(200);
        assertThat(openStages(id)).containsExactly("fin");
        assertThat(jdbc.sql("select count(*) from audit_event where entity_id = :id and action = 'TASK_REJECTED_ROUTED'").param("id", id.toString()).query(Long.class).single()).isEqualTo(1);
    }

    @Test
    @DisplayName("A rejection with no line ends the request as before; a rejected end closes it with nothing reserved")
    void rejectedEnds() {
        String plain = requestType("NEW_RESERVATION", flow(
                List.of(node("st", "start"), approval("rv", false, place("FACILITIES_REVIEWER", "REQUEST_ORG")), approval("fin", true, place("APPROVER", "ANY")), node("ok", "end_approved")),
                List.of(line("st", "rv", null), line("rv", "fin", "approved"), line("fin", "ok", "approved"))), null);
        UUID a = submitted(plain);
        Api rev = login("rev");
        assertThat(rev.decide(rev.taskFor(a), "REJECT", "لا يستوفي الشروط الأساسية", 1).status()).isEqualTo(200);
        assertThat(status(a)).isEqualTo("REJECTED");

        String ending = requestType("NEW_RESERVATION", flow(
                List.of(node("st", "start"), approval("rv", false, place("FACILITIES_REVIEWER", "REQUEST_ORG")), approval("fin", true, place("APPROVER", "ANY")), node("ok", "end_approved"),
                        node("tell", "notify", "recipients", List.of(Map.of("kind", "REQUESTER")), "message", "رُفض طلبك"), node("no", "end_rejected")),
                List.of(line("st", "rv", null), line("rv", "fin", "approved"), line("rv", "tell", "rejected"), line("tell", "no", null), line("fin", "ok", "approved"))), null);
        UUID b = submitted(ending);
        assertThat(rev.decide(rev.taskFor(b), "REJECT", "مرفوض مع إشعار مقدم الطلب", 1).status()).isEqualTo(200);
        assertThat(status(b)).isEqualTo("REJECTED");
        assertThat(openStages(b)).isEmpty();
        assertThat(activeReservations(res)).isZero();
        assertThat(jdbc.sql("select count(*) from notification where request_id = :id and kind = 'FLOW_NOTICE'").param("id", b).query(Long.class).single()).isEqualTo(1);
    }

    @Test
    @DisplayName("A question can reject on submission, before anyone decides")
    void rejectedAtOnce() {
        Map<String, Object> ask = node("qq", "decision", "condition", Map.of("fact", "resourceCount", "op", "gte", "value", 1));
        String type = requestType("NEW_RESERVATION", flow(
                List.of(node("st", "start"), ask, node("no", "end_rejected"), approval("fin", true, place("APPROVER", "ANY")), node("ok", "end_approved")),
                List.of(line("st", "qq", null), line("qq", "no", "yes"), line("qq", "fin", "no"), line("fin", "ok", "approved"))), null);
        UUID id = submitted(type);
        assertThat(status(id)).isEqualTo("REJECTED");
        assertThat(openStages(id)).isEmpty();
    }

    @Test
    @DisplayName("Parallel steps all open, and the flow goes on only after both")
    void parallel() {
        String type = requestType("NEW_RESERVATION", flow(
                List.of(node("st", "start"), node("par", "parallel"), approval("a1", false, place("FACILITIES_REVIEWER", "REQUEST_ORG")), approval("a2", false, place("FACILITIES_REVIEWER", "UP", "levelsUp", 1)),
                        node("mrg", "join"), approval("fin", true, place("APPROVER", "ANY")), node("ok", "end_approved")),
                List.of(line("st", "par", null), line("par", "a1", null), line("par", "a2", null), line("a1", "mrg", "approved"), line("a2", "mrg", "approved"), line("mrg", "fin", null), line("fin", "ok", "approved"))), null);
        UUID id = submitted(type);
        assertThat(openStages(id)).containsExactly("a1", "a2");
        Api rev = login("rev");
        assertThat(rev.approve(rev.taskFor(id), 1).status()).isEqualTo(200);
        assertThat(openStages(id)).containsExactly("a2");
        Api revb = login("revb");
        assertThat(revb.approve(revb.taskFor(id), 1).status()).isEqualTo(200);
        assertThat(openStages(id)).containsExactly("fin");
    }

    @Test
    @DisplayName("Places: up, fixed and a responsibility's nearest rule find the unit; a step with no unit stays open to the role")
    void places() {
        jdbc.sql("insert into org_responsibility(code, name) values ('r_fac', 'الموافقة على المرافق')").update();
        jdbc.sql("insert into org_responsibility_rule(responsibility_code, scope_org_id, responsible_org_id) values ('r_fac', :s, :o)").param("s", root).param("o", other).update();
        String type = requestType("NEW_RESERVATION", flow(
                List.of(node("st", "start"), approval("up", false, place("FACILITIES_REVIEWER", "UP", "levelsUp", 1)), approval("fx", false, place("FACILITIES_REVIEWER", "FIXED", "orgId", other.toString())),
                        approval("resp", false, place("FACILITIES_REVIEWER", "RESPONSIBLE", "responsibility", "r_fac")), approval("lvl", false, place("FACILITIES_REVIEWER", "AT_LEVEL", "level", 99)),
                        approval("fin", true, place("APPROVER", "ANY")), node("ok", "end_approved")),
                List.of(line("st", "up", null), line("up", "fx", "approved"), line("fx", "resp", "approved"), line("resp", "lvl", "approved"), line("lvl", "fin", "approved"), line("fin", "ok", "approved"))), null);
        UUID id = submitted(type);
        assertThat(target(id, "up")).isEqualTo(branch);
        // the role reaches every unit, but a step going to a unit is for those who hold the role there
        Api outsider = login("revo");
        assertThat(outsider.taskFor(id)).as("not on the list of a holder elsewhere").isNull();
        String step = jdbc.sql("select id::text from task_assignment where request_id = :id and stage_key = 'up' and status = 'OPEN'").param("id", id).query(String.class).single();
        assertThat(outsider.approve(step, 1).status()).as("and refused if tried directly").isEqualTo(403);
        Api revb = login("revb");
        assertThat(revb.approve(revb.taskFor(id), 1).status()).isEqualTo(200);
        assertThat(target(id, "fx")).isEqualTo(other);
        Api revo = login("revo");
        assertThat(revo.approve(revo.taskFor(id), 1).status()).isEqualTo(200);
        assertThat(target(id, "resp")).as("the rule on an ancestor covers every unit under it").isEqualTo(other);
        // a rule nearer the unit wins over the one above it
        jdbc.sql("insert into org_responsibility_rule(responsibility_code, scope_org_id, responsible_org_id) values ('r_fac', :s, :o)").param("s", branch).param("o", branch).update();
        UUID second = submitted(type);
        assertThat(revb.approve(revb.taskFor(second), 1).status()).isEqualTo(200);
        assertThat(revo.approve(revo.taskFor(second), 1).status()).isEqualTo(200);
        assertThat(target(second, "resp")).isEqualTo(branch);
        assertThat(revo.approve(revo.taskFor(id), 1).status()).isEqualTo(200);
        assertThat(jdbc.sql("select count(*) from task_assignment where request_id = :id and stage_key = 'lvl' and status = 'OPEN' and target_org_id is null")
                .param("id", id).query(Long.class).single()).as("no unit at that level: open to the role, never skipped").isEqualTo(1);
    }

    private UUID target(UUID id, String stage) {
        return jdbc.sql("select target_org_id from task_assignment where request_id = :id and stage_key = :s").param("id", id).param("s", stage).query(UUID.class).single();
    }

    @Test
    @DisplayName("A notice reaches the requester and the holders of a role at its place")
    void notifies() {
        Map<String, Object> tell = node("tell", "notify", "recipients", List.of(Map.of("kind", "REQUESTER"), place("FACILITIES_REVIEWER", "FIXED", "orgId", other.toString())), "message", "اعتُمد الطلب");
        String type = requestType("NEW_RESERVATION", flow(
                List.of(node("st", "start"), approval("fin", true, place("APPROVER", "ANY")), tell, node("ok", "end_approved")),
                List.of(line("st", "fin", null), line("fin", "tell", "approved"), line("tell", "ok", null))), null);
        UUID id = submitted(type);
        Api apr = login("apr");
        assertThat(apr.approve(apr.taskFor(id), 1).status()).isEqualTo(200);
        assertThat(status(id)).isEqualTo("APPROVED");
        List<String> to = jdbc.sql("select p.username from notification n join person p on p.id = n.person_id where n.request_id = :id and n.kind = 'FLOW_NOTICE' order by 1").param("id", id).query(String.class).list();
        assertThat(to).hasSize(2);
    }

    // ---- approvals climbing the hierarchy --------------------------------------------------------------------------

    private UUID snapshot() {
        UUID s = jdbc.sql("select id from hr_snapshot where status = 'PUBLISHED'").query(UUID.class).optional().orElse(null);
        if (s != null) {
            return s;
        }
        UUID source = UUID.randomUUID();
        UUID mapping = UUID.randomUUID();
        UUID run = UUID.randomUUID();
        UUID id = UUID.randomUUID();
        jdbc.sql("insert into hr_source(id, name) values (:id, 'مصدر اختبار')").param("id", source).update();
        jdbc.sql("insert into hr_mapping_version(id, source_id, version, status, fields, active_rules) values (:id, :s, 1, 'DRAFT', '{}', '{}')").param("id", mapping).param("s", source).update();
        jdbc.sql("insert into hr_sync_run(id, trigger, status, started_at) values (:id, 'MANUAL', 'SUCCEEDED', now())").param("id", run).update();
        jdbc.sql("insert into hr_snapshot(id, run_id, mapping_version_id, status, published_at) values (:id, :r, :m, 'PUBLISHED', now())").param("id", id).param("r", run).param("m", mapping).update();
        return id;
    }

    private UUID hrUnit(String code, UUID parent, int level, boolean main) {
        UUID id = UUID.randomUUID();
        String ext = code + "-" + sfx;
        jdbc.sql("""
                insert into organization(id, code, name, parent_id, valid_from, source, source_external_id)
                values (:id, :c, :n, :p, '2026-01-01T00:00:00Z', 'HR', :e)""")
                .param("id", id).param("c", "HR-" + ext).param("n", "وحدة " + code).param("p", parent).param("e", ext).update();
        jdbc.sql("insert into hr_unit(snapshot_id, external_id, name, active, level, is_main) values (:s, :e, :n, true, :l, :m)")
                .param("s", snapshot()).param("e", ext).param("n", "وحدة " + code).param("l", level).param("m", main).update();
        return id;
    }

    private static Map<String, Object> climbing(String id, String role, Object... chain) {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("from", "PARENT");
        c.put("skipEmpty", true); // these tests hold the climb itself; gapsInTheClimb holds the default
        for (int i = 0; i < chain.length; i += 2) {
            c.put((String) chain[i], chain[i + 1]);
        }
        return node(id, "approval", "mode", "ALL", "slaDays", 3, "assignees", List.of(place(role, "REQUEST_ORG")), "final", false, "requiresSignature", false, "chain", c);
    }

    /** Top (level 1) → main (level 4, flagged) → section (5) → team (6) → squad (7). The main unit's level is not assumed anywhere. */
    private UUID top, main, section, team, squad;
    private int sites;

    private void hierarchy() {
        top = hrUnit("TOPC", null, 1, false);
        main = hrUnit("MAINC", top, 4, true);
        section = hrUnit("SECC", main, 5, false);
        team = hrUnit("TEAMC", section, 6, false);
        squad = hrUnit("SQUADC", team, 7, false);
        person("mTop", "ORG_MANAGER", top);
        person("mMain", "ORG_MANAGER", main);
        person("mSec", "ORG_MANAGER", section);
        person("mTeam", "ORG_MANAGER", team);
        person("rSquad", "REQUESTER", squad);
        person("rMain", "REQUESTER", main);
        person("rTeam", "REQUESTER", team);
    }

    private String withClimb(Map<String, Object> climb) {
        return requestType("NEW_RESERVATION", flow(
                List.of(node("st", "start"), climb, approval("fin", true, place("APPROVER", "ANY")), node("ok", "end_approved")),
                List.of(line("st", (String) climb.get("id"), null), line((String) climb.get("id"), "fin", "approved"), line("fin", "ok", "approved"))), null);
    }

    private UUID submittedBy(String who, UUID org, String type) {
        int n = ++sites;
        UUID s = site("S" + who + n, site("M" + who + n, null, org), org);
        UUID r = resource("R" + who + n, s, null, 0);
        Api api = login(who);
        UUID id = api.draft(type, "LIST", org, List.of(r), day("2029-05-01"), day("2029-05-03"), Map.of("reason", "مبرر اختبار كافٍ للطلب هنا"));
        assertThat(api.upload(id, "attachments", "plan.txt", "خطة".getBytes(StandardCharsets.UTF_8)).status()).isEqualTo(200);
        assertThat(api.submit(id).status()).isEqualTo(200);
        return id;
    }

    private UUID openTarget(UUID id) {
        return jdbc.sql("select target_org_id from task_assignment where request_id = :id and status = 'OPEN'").param("id", id).query(UUID.class).single();
    }

    @Test
    @DisplayName("Climbing: one card, one unit at a time, up to the main unit whatever its level; the top is not asked")
    void climbsToTheMainUnit() {
        hierarchy();
        String type = withClimb(climbing("chain", "ORG_MANAGER", "stop", "MAIN_UNIT"));
        UUID id = submittedBy("rSquad", squad, type);
        assertThat(openTarget(id)).isEqualTo(team);
        Api mTeam = login("mTeam");
        assertThat(mTeam.approve(mTeam.taskFor(id), 1).status()).isEqualTo(200);
        assertThat(openTarget(id)).isEqualTo(section);
        Api mSec = login("mSec");
        assertThat(mSec.approve(mSec.taskFor(id), 1).status()).isEqualTo(200);
        assertThat(openStages(id)).as("the climb ends below the main unit, which is never a station").containsExactly("fin");
        assertThat(login("mMain").taskFor(id)).isNull();
        assertThat(jdbc.sql("select count(*) from task_assignment where request_id = :id and stage_key = 'chain'").param("id", id).query(Long.class).single()).isEqualTo(2);
    }

    @Test
    @DisplayName("Climbing: a level with nobody is refused before sending; the requester alone on a level is passed; skipping is the flow's choice")
    void gapsInTheClimb() {
        hierarchy();
        jdbc.sql("update membership set valid_to = now() where person_id = (select id from person where username = 'mSec-" + sfx + "')").update();
        Map<String, Object> strict = climbing("chain", "ORG_MANAGER", "stop", "MAIN_UNIT");
        ((Map<String, Object>) strict.get("chain")).put("skipEmpty", false);
        String type = withClimb(strict);
        Api req = login("rSquad");
        UUID id = req.draft(type, "LIST", squad, List.of(resource("RGP", site("SGP", site("MGP", null, squad), squad), null, 0)), day("2029-05-01"), day("2029-05-03"), Map.of("reason", "مبرر اختبار كافٍ للطلب هنا"));
        assertThat(req.upload(id, "attachments", "plan.txt", "خطة".getBytes(StandardCharsets.UTF_8)).status()).isEqualTo(200);
        Res refused = req.submit(id);
        assertThat(refused.status()).isEqualTo(400);
        assertThat(String.valueOf(refused.body())).contains("وحدة SECC");
        // the requester is also the only holder on the first level above them: that level is passed
        UUID both = jdbc.sql("select id from person where username = 'rSquad-" + sfx + "'").query(UUID.class).single();
        jdbc.sql("update membership set valid_to = now() where person_id = (select id from person where username = 'mTeam-" + sfx + "')").update();
        membership(both, "ORG_MANAGER", team, null);
        person("mSec2", "ORG_MANAGER", section);
        UUID passed = submittedBy("rSquad", squad, withClimb(climbing("chain2", "ORG_MANAGER", "stop", "MAIN_UNIT")));
        assertThat(openTarget(passed)).isEqualTo(section);
    }

    @Test
    @DisplayName("Climbing (ADR-058, as TNQL): a level with no approver of its own is signed by the nearest approver above covering it, who then signs his own; never early where a level has its own")
    void inheritedStation() {
        hierarchy();
        Map<String, Object> strict = climbing("chain", "ORG_MANAGER", "stop", "MAIN_UNIT");
        ((Map<String, Object>) strict.get("chain")).put("skipEmpty", false);
        String type = withClimb(strict);
        UUID first = submittedBy("rSquad", squad, type);
        assertThat(openTarget(first)).isEqualTo(team);
        Api mSec = login("mSec");
        assertThat(mSec.taskFor(first)).as("the team has its own approver: the section's waits for its own level").isNull();
        String step = jdbc.sql("select id::text from task_assignment where request_id = :id and status = 'OPEN'").param("id", first).query(String.class).single();
        assertThat(mSec.approve(step, 1).status()).isEqualTo(403);

        // the team's approver leaves: the request is not refused, the section's approver signs the team's level, then his own
        jdbc.sql("update membership set valid_to = now() where person_id = (select id from person where username = 'mTeam-" + sfx + "')").update();
        UUID second = submittedBy("rSquad", squad, type);
        assertThat(openTarget(second)).isEqualTo(team);
        assertThat(mSec.approve(mSec.taskFor(second), 1).status()).isEqualTo(200);
        assertThat(openTarget(second)).isEqualTo(section);
        assertThat(mSec.approve(mSec.taskFor(second), 1).status()).isEqualTo(200);
        assertThat(openStages(second)).containsExactly("fin");
    }

    @Test
    @DisplayName("Climbing: the main unit itself has nothing to climb and goes on; a level above it does not climb past its stop")
    void mainUnitGoesOn() {
        hierarchy();
        String type = withClimb(climbing("chain", "ORG_MANAGER", "stop", "MAIN_UNIT"));
        assertThat(openStages(submittedBy("rMain", main, type))).containsExactly("fin");
    }

    @Test
    @DisplayName("Climbing: nobody holding the role in a unit skips it; nobody at all skips the whole climb and the flow goes on (ADR-062), never open to the role")
    void skipsEmptyUnits() {
        hierarchy();
        jdbc.sql("update membership set valid_to = now() where person_id = (select id from person where username = 'mSec-" + sfx + "')").update();
        // a fresh sign-in reads the grants: the section has nobody now
        String type = withClimb(climbing("chain", "ORG_MANAGER", "stop", "MAIN_UNIT"));
        UUID id = submittedBy("rSquad", squad, type);
        Api mTeam = login("mTeam");
        assertThat(mTeam.approve(mTeam.taskFor(id), 1).status()).isEqualTo(200);
        assertThat(openStages(id)).as("the section is skipped, and the climb ends below the main unit").containsExactly("fin");

        String nobody = withClimb(climbing("chain", "FACILITIES_REVIEWER", "stop", "MAIN_UNIT"));
        UUID open = submittedBy("rTeam", team, nobody);
        assertThat(jdbc.sql("select count(*) from task_assignment where request_id = :id and stage_key = 'chain'").param("id", open).query(Long.class).single())
                .as("no «ROLE|*» task: the climb with nobody is skipped").isZero();
        assertThat(openStages(open)).containsExactly("fin");
        assertThat(jdbc.sql("select organization_id from request_route_skip where request_id = :id order by hierarchy_order").param("id", open).query(UUID.class).list())
                .containsExactly(section);
    }

    // ---- ADR-062 (owner, 16 Nov 2026): hierarchy units with no hierarchy approver are skipped, recorded, and the flow goes on ---

    /** The owner's health example: requester «قسم صحة أ1» → «مركز صحة 1» → «إدارة الصحة» → «إدارة الصحة الرئيسية» → main unit. */
    private UUID hMain, hIdaraMain, hIdara, hMarkaz, hQism, hOps;

    private void health() {
        UUID hTop = hrUnit("HTOP", null, 1, false);
        hMain = hrUnit("HMAIN", hTop, 4, true);
        hIdaraMain = hrUnit("HIDARAMAIN", hMain, 5, false);
        hIdara = hrUnit("HIDARA", hIdaraMain, 6, false);
        hMarkaz = hrUnit("HMARKAZ", hIdara, 7, false);
        hQism = hrUnit("HQISM", hMarkaz, 8, false);
        hOps = hrUnit("HOPS", hMain, 5, false);
        person("hReq", "REQUESTER", hQism);
    }

    /** «اعتماد مستويات الوحدة» (from the parent, below the main unit, skipping empty units) → unit operations at «عمليات الصحة» → final. */
    private String healthFlow() {
        Map<String, Object> levels = climbing("levels", "ORG_MANAGER", "stop", "MAIN_UNIT");
        return requestType("NEW_RESERVATION", flow(
                List.of(node("st", "start"), levels, approval("ops", false, place("FACILITIES_REVIEWER", "FIXED", "orgId", hOps.toString())),
                        approval("fin", true, place("APPROVER", "ANY")), node("ok", "end_approved")),
                List.of(line("st", "levels", null), line("levels", "ops", "approved"), line("ops", "fin", "approved"), line("fin", "ok", "approved"))), null);
    }

    private List<Map<String, Object>> skips(UUID id, int revision) {
        return jdbc.sql("""
                select organization_id, organization_name, organization_level, hierarchy_order, reason_code, reason_text, stage_key
                  from request_route_skip where request_id = :id and revision = :v order by hierarchy_order""")
                .param("id", id).param("v", revision).query().listOfRows();
    }

    private List<UUID> skipped(UUID id, int revision) {
        return skips(id, revision).stream().map(m -> (UUID) m.get("organization_id")).toList();
    }

    private String openTargetOf(UUID id, String stage) {
        return jdbc.sql("select coalesce(target_org_id::text, '*') from task_assignment where request_id = :id and stage_key = :s and status = 'OPEN'")
                .param("id", id).param("s", stage).query(String.class).single();
    }

    @Test
    @DisplayName("HSKIP-01/04: an empty level is skipped and recorded; a level with its own approver waits for it; the empty level above is skipped too")
    @SuppressWarnings("unchecked")
    void hskipOneEmptyLevel() {
        health();
        scoped("hIdaraOwn", "ORG_MANAGER", hIdara, unitTarget(hIdara, false)); // its own level only: it does not cover the centre
        person("hOpsA", "FACILITIES_REVIEWER", hOps);
        UUID id = submittedBy("hReq", hQism, healthFlow());
        assertThat(skipped(id, 1)).as("the centre and the main administration have nobody").containsExactly(hMarkaz, hIdaraMain);
        assertThat(openTargetOf(id, "levels")).as("HSKIP-04: the administration's own approver decides").isEqualTo(hIdara.toString());
        Api own = login("hIdaraOwn");
        assertThat(own.approve(own.taskFor(id), 1).status()).isEqualTo(200);
        assertThat(openStages(id)).containsExactly("ops");
        assertThat(openTargetOf(id, "ops")).isEqualTo(hOps.toString());
    }

    @Test
    @DisplayName("HSKIP-02/03/06: every level below the main unit empty — three skips in order, the climb completes, unit operations opens next, no «ROLE|*»; the unit-operations holder is no hierarchy approver")
    void hskipAllEmpty() {
        health();
        person("hOpsB", "FACILITIES_REVIEWER", hOps);
        person("hOpsInCentre", "FACILITIES_REVIEWER", hMarkaz); // holds unit operations only, inside the climb
        UUID id = submittedBy("hReq", hQism, healthFlow());
        List<Map<String, Object>> s = skips(id, 1);
        assertThat(s).extracting(m -> m.get("organization_id")).containsExactly(hMarkaz, hIdara, hIdaraMain);
        assertThat(s).extracting(m -> ((Number) m.get("hierarchy_order")).intValue()).containsExactly(1, 2, 3);
        assertThat(s).extracting(m -> m.get("organization_name")).containsExactly("وحدة HMARKAZ", "وحدة HIDARA", "وحدة HIDARAMAIN");
        assertThat(s).extracting(m -> m.get("organization_level")).containsExactly(7, 6, 5);
        assertThat(s).allSatisfy(m -> {
            assertThat(m.get("reason_code")).isEqualTo("NO_HIERARCHY_APPROVER");
            assertThat(m.get("reason_text")).isEqualTo("تم تجاوز هذه الجهة لعدم وجود معتمد للسلسلة الهرمية");
            assertThat(m.get("stage_key")).isEqualTo("levels");
        });
        assertThat(jdbc.sql("select count(*) from task_assignment where request_id = :id and stage_key = 'levels'").param("id", id).query(Long.class).single())
                .as("no hierarchy task at all, and no «ROLE|*»").isZero();
        assertThat(openStages(id)).as("straight to unit operations").containsExactly("ops");
        assertThat(openTargetOf(id, "ops")).isEqualTo(hOps.toString());
        assertThat(login("hOpsInCentre").taskFor(id)).as("HSKIP-06: unit operations elsewhere is not the centre's hierarchy approver").isNull();
        // one grouped audit event, written when the route was resolved
        JsonNode audit;
        try {
            audit = JSON.readTree(jdbc.sql("select detail::text from audit_event where action = 'HIERARCHY_LEVEL_SKIPPED' and entity_id = :id").param("id", id.toString()).query(String.class).single());
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new AssertionError(e);
        }
        assertThat(audit.path("units")).hasSize(3);
        assertThat(audit.path("stage").asText()).isEqualTo("levels");
        // the request page: the climb is complete with its skipped units, then unit operations
        JsonNode stages = login("hOpsB").get("/requests/" + id).body().path("stages");
        JsonNode levels = null;
        for (JsonNode st : stages) {
            if ("levels".equals(st.path("key").asText())) {
                levels = st;
            }
        }
        assertThat(levels).isNotNull();
        assertThat(levels.path("state").asText()).isEqualTo("COMPLETE");
        assertThat(levels.path("skipped")).hasSize(3);
        assertThat(levels.path("skipped").get(0).path("organizationName").asText()).isEqualTo("وحدة HMARKAZ");
        assertThat(levels.path("skipped").get(0).path("reasonCode").asText()).isEqualTo("NO_HIERARCHY_APPROVER");
        // opening the page again adds nothing
        login("hOpsB").get("/requests/" + id);
        assertThat(skipped(id, 1)).hasSize(3);
    }

    @Test
    @DisplayName("HSKIP-05: no own approver but an inherited one covering the level (ADR-058): not skipped, the inherited approver decides")
    void hskipInherited() {
        health();
        person("hIdaraAll", "ORG_MANAGER", hIdara); // role scope: the administration with every unit under it
        person("hOpsC", "FACILITIES_REVIEWER", hOps);
        UUID id = submittedBy("hReq", hQism, healthFlow());
        assertThat(skipped(id, 1)).as("only the main administration has nobody, own or inherited").containsExactly(hIdaraMain);
        assertThat(openTargetOf(id, "levels")).isEqualTo(hMarkaz.toString());
        Api inh = login("hIdaraAll");
        assertThat(inh.approve(inh.taskFor(id), 1).status()).as("signs the centre's level").isEqualTo(200);
        assertThat(openTargetOf(id, "levels")).isEqualTo(hIdara.toString());
        assertThat(inh.approve(inh.taskFor(id), 1).status()).as("then its own").isEqualTo(200);
        assertThat(openStages(id)).containsExactly("ops");
    }

    @Test
    @DisplayName("HSKIP-07/08: unit operations with no holder is not skipped by this rule; a final approval with nobody never completes the request")
    void hskipOtherStagesUnchanged() {
        health();
        UUID id = submittedBy("hReq", hQism, healthFlow());
        assertThat(skipped(id, 1)).hasSize(3);
        assertThat(openStages(id)).as("HSKIP-07: unit operations still opens, waiting for a holder").containsExactly("ops");
        assertThat(openTargetOf(id, "ops")).isEqualTo(hOps.toString());
        assertThat(status(id)).isEqualTo("SUBMITTED");

        person("hOpsD", "FACILITIES_REVIEWER", hOps);
        jdbc.sql("update membership set valid_to = now() where role_code = 'APPROVER'").update();
        UUID second = submittedBy("hReq", hQism, healthFlow());
        Api ops = login("hOpsD");
        assertThat(ops.approve(ops.taskFor(second), 1).status()).isEqualTo(200);
        assertThat(openStages(second)).as("HSKIP-08: the final approval stays open with nobody").containsExactly("fin");
        assertThat(status(second)).isEqualTo("SUBMITTED");
    }

    @Test
    @DisplayName("HSKIP-09/10: a returned and resubmitted request keeps the first revision's skips; later hierarchy changes never rewrite them")
    void hskipRevisionsAndHistory() {
        health();
        person("hOpsE", "FACILITIES_REVIEWER", hOps);
        UUID id = submittedBy("hReq", hQism, healthFlow());
        assertThat(skipped(id, 1)).hasSize(3);
        Api ops = login("hOpsE");
        assertThat(ops.decide(ops.taskFor(id), "RETURN", "أكمل البيانات من فضلك", 1).status()).isEqualTo(200);
        // the main administration gets an approver of its own before the resubmission
        scoped("hIdaraMainOwn", "ORG_MANAGER", hIdaraMain, unitTarget(hIdaraMain, false));
        Api req = login("hReq");
        int version = req.get("/requests/" + id).body().path("version").asInt();
        assertThat(req.post("/requests/" + id + "/submit", Map.of("expectedVersion", version, "resubmissionReason", "استُكملت البيانات"),
                UUID.randomUUID().toString()).status()).isEqualTo(200);
        assertThat(skipped(id, 1)).as("revision 1 keeps what happened then").containsExactly(hMarkaz, hIdara, hIdaraMain);
        List<UUID> second = skipped(id, 2);
        String levelsCarried = jdbc.sql("select coalesce(array_to_string(carried_stages, ','), '') from request_revision where request_id = :id and revision = 2")
                .param("id", id).query(String.class).single();
        if (!levelsCarried.contains("levels")) {
            assertThat(second).as("revision 2's own route: the main administration now has an approver").containsExactly(hMarkaz, hIdara);
        }
        // HSKIP-10: the hierarchy changes after the route was resolved; the record keeps the names and levels of then
        tx.executeWithoutResult(t -> {
            jdbc.sql("select set_config('tmrkz.hr_projection', 'on', true)").query().singleRow(); // as the HR sync renames a unit
            jdbc.sql("update organization set name = 'اسم جديد' where id = :o").param("o", hMarkaz).update();
        });
        assertThat(login("hOpsE").get("/requests/" + id).body().path("stages").toString()).as("the page shows the name of then").contains("وحدة HMARKAZ");
        assertThat(skips(id, 1).get(0).get("organization_name")).isEqualTo("وحدة HMARKAZ");
    }

    @Test
    @DisplayName("Climbing: it can stop at the first of several levels, after a number of approvals or at one unit, and approve only at chosen levels")
    void otherStops() {
        hierarchy();
        // the first of levels 5 or 4 on the way up, so only the team and then the section
        UUID a = submittedBy("rSquad", squad, withClimb(climbing("chain", "ORG_MANAGER", "stop", "LEVELS", "levels", List.of(5, 4))));
        assertThat(openTarget(a)).isEqualTo(team);
        Api mTeam = login("mTeam");
        assertThat(mTeam.approve(mTeam.taskFor(a), 1).status()).isEqualTo(200);
        assertThat(openTarget(a)).isEqualTo(section);
        Api mSec = login("mSec");
        assertThat(mSec.approve(mSec.taskFor(a), 1).status()).isEqualTo(200);
        assertThat(openStages(a)).containsExactly("fin");
        // a number of approvals: one is enough
        UUID b = submittedBy("rSquad", squad, withClimb(climbing("chain2", "ORG_MANAGER", "stop", "COUNT", "count", 1)));
        assertThat(mTeam.approve(mTeam.taskFor(b), 1).status()).isEqualTo(200);
        assertThat(openStages(b)).containsExactly("fin");
        // only the chosen levels on the way to the top: the main unit and the top, not the units between
        UUID c = submittedBy("rSquad", squad, withClimb(climbing("chain3", "ORG_MANAGER", "stop", "TOP", "onlyLevels", List.of(4, 1))));
        assertThat(openTarget(c)).isEqualTo(main);
        Api mMain = login("mMain");
        assertThat(mMain.approve(mMain.taskFor(c), 1).status()).isEqualTo(200);
        assertThat(openTarget(c)).isEqualTo(top);
        // the stop is not above the requesting unit: nothing to climb
        UUID d = submittedBy("rMain", main, withClimb(climbing("chain4", "ORG_MANAGER", "stop", "LEVELS", "levels", List.of(6))));
        assertThat(openStages(d)).containsExactly("fin");
    }

    @Test
    @DisplayName("Climbing: a rejection on the way follows the card's rejected line, and later units are not asked")
    void climbRejected() {
        hierarchy();
        Map<String, Object> climb = climbing("chain", "ORG_MANAGER", "stop", "MAIN_UNIT");
        String type = requestType("NEW_RESERVATION", flow(
                List.of(node("st", "start"), climb, approval("fin", true, place("APPROVER", "ANY")), node("ok", "end_approved"), node("no", "end_rejected")),
                List.of(line("st", "chain", null), line("chain", "fin", "approved"), line("chain", "no", "rejected"), line("fin", "ok", "approved"))), null);
        UUID id = submittedBy("rSquad", squad, type);
        Api mTeam = login("mTeam");
        assertThat(mTeam.decide(mTeam.taskFor(id), "REJECT", "لا يناسب، الطلب غير مكتمل المعلومات", 1).status()).isEqualTo(200);
        assertThat(status(id)).isEqualTo("REJECTED");
        assertThat(openStages(id)).isEmpty();
    }

    @Test
    @DisplayName("The if: a question asks whether the requesting unit is a main unit, its level, and whether anything is above it")
    void questionsAboutTheUnit() {
        hierarchy();
        Map<String, Object> ask = node("qq", "decision", "condition", Map.of("fact", "requesterIsMain", "op", "eq", "value", "YES"));
        String type = requestType("NEW_RESERVATION", flow(
                List.of(node("st", "start"), ask, climbing("chain", "ORG_MANAGER", "stop", "MAIN_UNIT"), approval("fin", true, place("APPROVER", "ANY")), node("ok", "end_approved")),
                List.of(line("st", "qq", null), line("qq", "fin", "yes"), line("qq", "chain", "no"), line("chain", "fin", "approved"), line("fin", "ok", "approved"))), null);
        assertThat(openStages(submittedBy("rMain", main, type))).as("main: straight to the final").containsExactly("fin");
        assertThat(openStages(submittedBy("rSquad", squad, type))).as("under it: the climb").containsExactly("chain");
        Map<String, Object> deep = node("qq", "decision", "condition", Map.of("fact", "requesterLevel", "op", "gt", "value", 6));
        String byLevel = requestType("NEW_RESERVATION", flow(
                List.of(node("st", "start"), deep, node("no", "end_rejected"), approval("fin", true, place("APPROVER", "ANY")), node("ok", "end_approved")),
                List.of(line("st", "qq", null), line("qq", "no", "yes"), line("qq", "fin", "no"), line("fin", "ok", "approved"))), null);
        assertThat(status(submittedBy("rSquad", squad, byLevel))).isEqualTo("REJECTED");
        assertThat(openStages(submittedBy("rTeam", team, byLevel))).containsExactly("fin");
    }

    @Test
    @DisplayName("Trying a climb: every unit it passes for the unit tried, with who holds the role there; nothing for a main unit")
    void simulatesTheClimb() {
        hierarchy();
        Map<String, Object> def = flow(
                List.of(node("st", "start"), climbing("chain", "ORG_MANAGER", "stop", "MAIN_UNIT"), approval("fin", true, place("APPROVER", "ANY")), node("ok", "end_approved")),
                List.of(line("st", "chain", null), line("chain", "fin", "approved"), line("fin", "ok", "approved")));
        requestType("NEW_RESERVATION", finalOnly(), null);
        Api admin = login("admin");
        String workflowId = admin.get("/workflows").body().get(0).path("id").asText();
        String version = admin.post("/workflows/" + workflowId + "/drafts", Map.of("definition", def)).body().path("id").asText();
        JsonNode sim = admin.post("/workflow-versions/" + version + "/simulate", Map.of("facts", Map.of("orgId", squad.toString()))).body();
        JsonNode step = sim.path("route").get(1);
        assertThat(step.path("chain").asBoolean()).isTrue();
        List<String> passed = new ArrayList<>();
        step.path("places").forEach(p -> passed.add(p.path("orgs").get(0).asText() + ":" + p.path("holders").asInt()));
        assertThat(passed).containsExactly("وحدة TEAMC:1", "وحدة SECC:1");
        JsonNode none = admin.post("/workflow-versions/" + version + "/simulate", Map.of("facts", Map.of("orgId", main.toString()))).body();
        assertThat(none.path("route").get(1).path("places")).isEmpty();
        assertThat(problems(flow(List.of(node("st", "start"), climbing("chain", "ORG_MANAGER", "stop", "LEVELS"), approval("fin", true, place("APPROVER", "ANY")), node("ok", "end_approved")),
                List.of(line("st", "chain", null), line("chain", "fin", "approved"), line("fin", "ok", "approved"))))).anyMatch(p -> p.contains("مستوى توقف"));
    }

    // ---- steps found by a grant's scope, independence and for-information by place (ADR-042) ----------------------------

    /** A person whose grant of the role is on chosen units, through the same API as the page. */
    private UUID scoped(String who, String role, UUID home, Map<String, Object>... targets) {
        UUID id = UUID.randomUUID();
        jdbc.sql("insert into person(id, employee_no, display_name, username) values (:id, :e, :n, :u)")
                .param("id", id).param("e", "T-" + who + "-" + sfx).param("n", "شخص " + who).param("u", who + "-" + sfx).update();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("personId", id.toString());
        body.put("organizationId", home.toString());
        body.put("roleCode", role);
        body.put("scope", Map.of("mode", "CUSTOM", "targets", List.of(targets)));
        Res r = login("admin").post("/memberships", body);
        assertThat(r.status()).as(String.valueOf(r.body())).isEqualTo(200);
        return id;
    }

    private static Map<String, Object> unitTarget(UUID id, boolean branch, Integer... levels) {
        Map<String, Object> t = new LinkedHashMap<>();
        t.put("kind", "ORGANIZATION");
        t.put("id", id.toString());
        t.put("includeDescendants", branch);
        if (levels.length > 0) {
            t.put("levels", List.of(levels));
        }
        return t;
    }

    private String byScopeFlow() {
        return requestType("NEW_RESERVATION", flow(
                List.of(node("st", "start"), approval("ops", false, place("ORG_MANAGER", "BY_SCOPE")), approval("fin", true, place("APPROVER", "ANY")), node("ok", "end_approved")),
                List.of(line("st", "ops", null), line("ops", "fin", "approved"), line("fin", "ok", "approved"))), null);
    }

    private void opsHierarchy() {
        top = hrUnit("TOPC", null, 1, false);
        main = hrUnit("MAINC", top, 4, true);
        section = hrUnit("SECC", main, 5, false);
        team = hrUnit("TEAMC", section, 6, false);
        squad = hrUnit("SQUADC", team, 7, false);
        person("rSquad", "REQUESTER", squad);
        person("rTeam", "REQUESTER", team);
        person("rMain", "REQUESTER", main);
    }

    @Test
    @DisplayName("By scope: the nearest grant reaching the unit takes the step; one above it does not see it, and is refused if it tries")
    @SuppressWarnings("unchecked")
    void nearestGrantWins() {
        opsHierarchy();
        scoped("uoMain", "ORG_MANAGER", other, unitTarget(main, true));
        scoped("uoSec", "ORG_MANAGER", other, unitTarget(section, true));
        scoped("uoTeam", "ORG_MANAGER", other, unitTarget(team, false));
        String type = byScopeFlow();

        UUID fromSquad = submittedBy("rSquad", squad, type);
        assertThat(openTarget(fromSquad)).as("the step stands on the requesting unit").isEqualTo(squad);
        assertThat(login("uoTeam").taskFor(fromSquad)).as("«the unit only» does not reach below it").isNull();
        assertThat(login("uoMain").taskFor(fromSquad)).as("a nearer grant exists").isNull();
        String step = jdbc.sql("select id::text from task_assignment where request_id = :id and stage_key = 'ops' and status = 'OPEN'").param("id", fromSquad).query(String.class).single();
        assertThat(login("uoMain").approve(step, 1).status()).as("refused if tried directly").isIn(403, 404);
        Api uoSec = login("uoSec");
        assertThat(uoSec.approve(uoSec.taskFor(fromSquad), 1).status()).isEqualTo(200);
        assertThat(openStages(fromSquad)).containsExactly("fin");

        UUID fromTeam = submittedBy("rTeam", team, type);
        Api uoTeam = login("uoTeam");
        assertThat(uoTeam.taskFor(fromTeam)).as("named on this very unit: the nearest").isNotNull();
        assertThat(login("uoSec").taskFor(fromTeam)).isNull();

        UUID fromMain = submittedBy("rMain", main, type);
        Api uoMain = login("uoMain");
        assertThat(uoMain.approve(uoMain.taskFor(fromMain), 1).status()).as("the unit itself, by the grant on it").isEqualTo(200);
    }

    @Test
    @DisplayName("By scope: a grant limited to levels reaches those levels only, and is enforced with OpenFGA in the loop")
    @SuppressWarnings("unchecked")
    void levelsOfAScope() {
        opsHierarchy();
        scoped("uoL", "ORG_MANAGER", other, unitTarget(main, true, 7));
        String type = byScopeFlow();
        UUID fromSquad = submittedBy("rSquad", squad, type);
        Api uoL = login("uoL");
        assertThat(uoL.approve(uoL.taskFor(fromSquad), 1).status()).as("level 7 is in the grant").isEqualTo(200);
        Api rTeam = login("rTeam");
        UUID fromTeam = rTeam.draft(type, "LIST", team, List.of(resource("RLV", site("SLV", site("MLV", null, team), team), null, 0)), day("2029-05-01"), day("2029-05-03"), Map.of("reason", "مبرر اختبار كافٍ للطلب هنا"));
        assertThat(rTeam.upload(fromTeam, "attachments", "plan.txt", "خطة".getBytes(StandardCharsets.UTF_8)).status()).isEqualTo(200);
        Res refused = rTeam.submit(fromTeam);
        assertThat(refused.status()).as("level 6 is not, and nobody else reaches it: refused before sending, with a clear reason").isEqualTo(400);
        assertThat(String.valueOf(refused.body())).contains("لا يوجد معتمد");
        String text = login("admin").get("/access/grants?organizationId=" + other).body().toString();
        assertThat(text).as("the scope in words").contains("المستوى 7");
        Res preview = login("admin").get("/access/scope-preview?organizationId=" + main + "&descendants=true&levels=7");
        assertThat(preview.body().path("units").asInt()).as("what the levels cover today").isEqualTo(1);
        assertThat(login("admin").get("/access/grant-roots").body().toString()).as("the dialog's tree starts at the main units").contains("وحدة MAINC").doesNotContain("وحدة TOPC");
    }

    @Test
    @DisplayName("By scope: a command with no holder of the role has no such step; and when the only final approver approved earlier, the final step waits for the access managers")
    void notRequired() {
        opsHierarchy();
        UUID id = submittedBy("rSquad", squad, requestType("NEW_RESERVATION", flow(
                List.of(node("st", "start"), approval("ops", false, place("FACILITIES_REVIEWER", "BY_SCOPE")), approval("fin", true, place("APPROVER", "ANY")), node("ok", "end_approved")),
                List.of(line("st", "ops", null), line("ops", "fin", "approved"), line("fin", "ok", "approved"))), null));
        assertThat(openStages(id)).as("everywhere-scoped reviewers reach it, so it runs").containsExactly("ops");
        String unused = "T_UNUSED_" + sfx.toUpperCase();
        jdbc.sql("insert into role_def(code, name, permissions, scope, summary_only, sort_order) values (:c, 'دور غير مستخدم', array['VIEW','REVIEW'], 'ORGANIZATION', false, 950)").param("c", unused).update();
        UUID skipped = submittedBy("rSquad", squad, requestType("NEW_RESERVATION", flow(
                List.of(node("st", "start"), approval("ops", false, place(unused, "BY_SCOPE")), approval("fin", true, place("APPROVER", "ANY")), node("ok", "end_approved")),
                List.of(line("st", "ops", null), line("ops", "fin", "approved"), line("fin", "ok", "approved"))), null));
        assertThat(openStages(skipped)).as("nobody holds it in this command: no such step").containsExactly("fin");
        // trying it says so, and never says a final approval is passed
        String unusedFinal = "UNUSED_FINAL";
        jdbc.sql("insert into role_def(code, name, permissions, scope, summary_only, sort_order) values (:c, 'نهائي غير مستخدم', array['VIEW','REVIEW','APPROVE'], 'ORGANIZATION', false, 951) on conflict do nothing").param("c", unusedFinal).update();
        Map<String, Object> tried = flow(
                List.of(node("st", "start"), approval("ops", false, place(unused, "BY_SCOPE")), approval("fin", true, place(unusedFinal, "BY_SCOPE")), node("ok", "end_approved")),
                List.of(line("st", "ops", null), line("ops", "fin", "approved"), line("fin", "ok", "approved")));
        Api adminApi = login("admin");
        String wf = adminApi.get("/workflows").body().get(0).path("id").asText();
        String version = adminApi.post("/workflows/" + wf + "/drafts", Map.of("definition", tried)).body().path("id").asText();
        JsonNode sim = adminApi.post("/workflow-versions/" + version + "/simulate", Map.of("facts", Map.of("orgId", squad.toString()))).body();
        assertThat(sim.path("errors").toString()).isEqualTo("[]");
        assertThat(sim.path("route").toString()).contains("فتُتخطى الخطوة").contains("لا يوجد من يعتمد بعد");
        assertThat(sim.path("outcome").asText()).isEqualTo("NO_FINAL_APPROVER");
        assertThat(jdbc.sql("delete from workflow_version where id = cast(:v as uuid) and status = 'DRAFT'").param("v", version).update()).isEqualTo(1);

        // the only final approver already approved: the final step goes to the access managers
        String type = byScopeFlow();
        UUID both = scoped("uoFin", "ORG_MANAGER", other, unitTarget(squad, false));
        jdbc.sql("update membership set valid_to = now() where role_code = 'APPROVER'").update();
        membership(both, "APPROVER", root, null);
        UUID sole = submittedBy("rSquad", squad, type);
        Api uoFin = login("uoFin");
        assertThat(uoFin.approve(uoFin.taskFor(sole), 1).status()).isEqualTo(200);
        assertThat(jdbc.sql("select awaiting_assignment from task_assignment where request_id = :id and stage_key = 'fin' and status = 'OPEN'").param("id", sole).query(Boolean.class).single())
                .as("nobody independent is left, so it is routed to the access managers").isTrue();
    }

    @Test
    @DisplayName("Independence: whoever approved an earlier step does not decide the final one, nor its by-scope step after the climb")
    @SuppressWarnings("unchecked")
    void earlierApproverIsNotFinal() {
        opsHierarchy();
        UUID both = scoped("both", "ORG_MANAGER", other, unitTarget(main, true));
        membership(both, "APPROVER", root, null);
        person("fin2", "APPROVER", root);
        UUID id = submittedBy("rSquad", squad, byScopeFlow());
        Api b = login("both");
        assertThat(b.approve(b.taskFor(id), 1).status()).isEqualTo(200);
        assertThat(b.taskFor(id)).as("the final step is not offered to them").isNull();
        String step = jdbc.sql("select id::text from task_assignment where request_id = :id and stage_key = 'fin' and status = 'OPEN'").param("id", id).query(String.class).single();
        Res refused = b.approve(step, 1);
        assertThat(refused.status()).as(String.valueOf(refused.body())).isIn(403, 404, 409);
        Api other2 = login("fin2");
        assertThat(other2.approve(other2.taskFor(id), 1).status()).isEqualTo(200);
        assertThat(status(id)).isEqualTo("APPROVED");
    }

    @Test
    @DisplayName("For information: after final approval only, to the main unit, the units at the place, and their main units; each told which unit and its main")
    void forInformationByPlace() {
        opsHierarchy();
        UUID elsewhereMain = hrUnit("MAINE", top, 4, true);
        UUID localUnit = hrUnit("LOCAL", elsewhereMain, 7, false);
        UUID unrelated = hrUnit("UNREL", elsewhereMain, 7, false);
        UUID commandUnit = hrUnit("CMDU", top, 4, true);
        jdbc.sql("""
                insert into role_def(code, name, permissions, scope, summary_only, sort_order) values ('FYI_RECEIVER', 'للعلم', array['VIEW_SUMMARY'], 'SITE', false, 950)
                on conflict (code) do nothing""").update();
        UUID atMain = person("fyiMain", "FYI_RECEIVER", main);
        UUID atLocal = person("fyiLocal", "FYI_RECEIVER", localUnit);
        UUID atElsewhereMain = person("fyiLocalMain", "FYI_RECEIVER", elsewhereMain);
        UUID atUnrelated = person("fyiOther", "FYI_RECEIVER", unrelated);
        UUID branchHolder = scoped("fyiBranch", "FYI_RECEIVER", other, unitTarget(section, true));
        UUID unitOnly = scoped("fyiOne", "FYI_RECEIVER", other, unitTarget(section, false));
        UUID atCommand = person("fyiCommand", "FYI_RECEIVER", commandUnit);
        person("viewerAtLocal", "REQUESTER", localUnit);
        person("apr2", "APPROVER", root);
        assertThat(login("admin").put("/access/fyi-mains/" + commandUnit, Map.of()).status()).isEqualTo(204);

        // the place: a unit of another main unit stands here beside the requesting unit
        UUID place = site("SFY", site("MFY", null, squad), squad);
        jdbc.sql("""
                insert into site_link(id, site_id, organization_id, valid_from, reason, created_by)
                values (:id, :s, :o, '2026-01-01T00:00:00Z', 'وحدة موجودة في الموقع', :by)""")
                .param("id", UUID.randomUUID()).param("s", place).param("o", localUnit).param("by", atLocal).update();
        UUID r = resource("RFY", place, null, 0);
        String type = requestType("NEW_RESERVATION", flow(
                List.of(node("st", "start"), approval("fin", true, place("APPROVER", "ANY")), node("ok", "end_approved")),
                List.of(line("st", "fin", null), line("fin", "ok", "approved"))), null);
        Api req = login("rSquad");
        UUID id = req.draft(type, "LIST", squad, List.of(r), day("2029-06-01"), day("2029-06-03"), Map.of("reason", "مبرر اختبار كافٍ للطلب هنا"));
        assertThat(req.upload(id, "attachments", "plan.txt", "خطة".getBytes(StandardCharsets.UTF_8)).status()).isEqualTo(200);
        assertThat(req.submit(id).status()).isEqualTo(200);

        for (String who : List.of("fyiLocal", "fyiBranch", "fyiCommand")) {
            assertThat(login(who).get("/requests/" + id).status()).as(who + ": not before the final approval, whatever the scope").isIn(403, 404);
        }
        Api apr = login("apr2");
        assertThat(apr.approve(apr.taskFor(id), 1).status()).isEqualTo(200);
        assertThat(status(id)).isEqualTo("APPROVED");
        assertThat(jdbc.sql("select person_id from request_fyi where request_id = :r").param("r", id).query(UUID.class).list())
                .containsExactlyInAnyOrder(atMain, atLocal, atElsewhereMain, branchHolder, atCommand);
        for (String who : List.of("fyiMain", "fyiLocal", "fyiLocalMain", "fyiBranch", "fyiCommand")) {
            Res seen = login(who).get("/requests/" + id);
            assertThat(seen.status()).as(who + " reads it after").isEqualTo(200);
            assertThat(seen.body().path("view").asText()).as(who + " the summary only").isEqualTo("SUMMARY");
        }
        assertThat(login("fyiOther").get("/requests/" + id).status()).as("a holder in an unrelated unit does not").isIn(403, 404);
        assertThat(login("fyiOne").get("/requests/" + id).status()).as("«the unit only» does not reach below it").isIn(403, 404);
        assertThat(login("viewerAtLocal").get("/requests/" + id).status()).as("others at an informed unit do not: only the role").isIn(403, 404);
        assertThat(unitOnly).isNotNull();
        assertThat(login("fyiLocal").get("/requests?size=50").body().toString()).as("on their list").contains(id.toString());
        assertThat(jdbc.sql("select count(*) from request_fyi where request_id = :r and first_read_at is not null").param("r", id).query(Long.class).single()).as("who read it is recorded").isEqualTo(5);
        assertThat(req.get("/requests/" + id).body().path("fyi").size()).as("the requester sees who was told").isEqualTo(5);
        outbox.processBatch(500);
        for (UUID person : List.of(atMain, atLocal, atElsewhereMain, branchHolder, atCommand)) {
            assertThat(jdbc.sql("select body from notification where person_id = :p and kind = 'INFO_COPY' and request_id = :r").param("p", person).param("r", id).query(String.class).list())
                    .as("told which unit and its main unit").singleElement().asString().contains("وحدة SQUADC").contains("وحدتها الرئيسية: وحدة MAINC");
        }
        assertThat(jdbc.sql("select count(*) from notification where person_id = :p and request_id = :r").param("p", atUnrelated).param("r", id).query(Long.class).single()).isZero();

        // a re-stationing activated at a place: the same parties are told who is now there
        placeInfo.noticeStationed(List.of(squad), place, "RS-1");
        assertThat(jdbc.sql("select body from notification where person_id = :p and title like '%RS-1'").param("p", atLocal).query(String.class).list())
                .singleElement().asString().contains("وحدتها الرئيسية: وحدة MAINC");
        assertThat(jdbc.sql("select count(*) from notification where person_id = :p and title like '%RS-1'").param("p", atUnrelated).query(Long.class).single()).isZero();
    }

    @Test
    @DisplayName("By time: the period decides the receiving unit, and its own people act; a time no period covers is refused; a later edit does not move a waiting request")
    void routesByTime() {
        opsHierarchy();
        jdbc.sql("""
                insert into role_def(code, name, permissions, scope, summary_only, sort_order) values ('UNIT_OPERATIONS_APPROVER', 'معتمد عمليات الوحدة', array['VIEW','REVIEW'], 'ORGANIZATION', false, 951)
                on conflict (code) do update set name = excluded.name, permissions = excluded.permissions, scope = excluded.scope,
                                                 summary_only = excluded.summary_only""").update(); // see ROLE_DEFINITIONS_NOTE
        UUID dayUnit = hrUnit("DAYU", main, 5, false);
        UUID nightUnit = hrUnit("NIGHTU", main, 5, false);
        scoped("uoDay", "UNIT_OPERATIONS_APPROVER", dayUnit, unitTarget(main, true));
        scoped("uoNight", "UNIT_OPERATIONS_APPROVER", nightUnit, unitTarget(main, true));
        scoped("uoOther", "UNIT_OPERATIONS_APPROVER", section, unitTarget(main, true));
        String type = requestType("NEW_RESERVATION", flow(
                List.of(node("st", "start"), approval("ops", false, place("UNIT_OPERATIONS_APPROVER", "BY_SCOPE")), approval("fin", true, place("APPROVER", "ANY")), node("ok", "end_approved")),
                List.of(line("st", "ops", null), line("ops", "fin", "approved"), line("fin", "ok", "approved"))), null);
        Api admin = login("admin");
        int today = java.time.ZonedDateTime.now(java.time.ZoneId.of("Asia/Dubai")).getDayOfWeek().getValue() % 7;
        List<Integer> everyDay = List.of(0, 1, 2, 3, 4, 5, 6);
        Map<String, Object> allDay = Map.of("name", "طوال الوقت", "from", "00:00", "to", "23:59:59", "days", everyDay, "targets", List.of(dayUnit.toString()));
        Res saved = admin.put("/access/unit-ops-routes?commandId=" + main, List.of(allDay));
        assertThat(saved.status()).as(String.valueOf(saved.body())).isEqualTo(200);
        assertThat(saved.body().get(0).path("targets").get(0).path("name").asText()).isEqualTo("وحدة DAYU");

        UUID id = submittedBy("rSquad", squad, type);
        assertThat(login("uoNight").taskFor(id)).as("another unit's people wait for their period").isNull();
        assertThat(login("uoOther").taskFor(id)).as("a grant over the whole unit is not enough outside the routed unit").isNull();
        assertThat(login("uoDay").taskFor(id)).as("the routed unit's own people act").isNotNull();

        // the periods change: the request already at the step stays with the units pinned on it
        Map<String, Object> night = Map.of("name", "بعد الدوام", "from", "00:00", "to", "23:59:59", "days", everyDay, "targets", List.of(nightUnit.toString()));
        assertThat(admin.put("/access/unit-ops-routes?commandId=" + main, List.of(night)).status()).isEqualTo(200);
        Api uoDay = login("uoDay");
        assertThat(uoDay.approve(uoDay.taskFor(id), 1).status()).as("pinned").isEqualTo(200);
        assertThat(login("uoNight").taskFor(submittedBy("rSquad", squad, type))).as("a new request follows the new period").isNotNull();

        // a schedule exists and no period covers now: refused before sending
        List<Integer> notToday = everyDay.stream().filter(d -> d != today).toList();
        assertThat(admin.put("/access/unit-ops-routes?commandId=" + main, List.of(Map.of("name", "ليس اليوم", "from", "00:00", "to", "23:59:59", "days", notToday, "targets", List.of(dayUnit.toString())))).status()).isEqualTo(200);
        Api req = login("rSquad");
        UUID draft = req.draft(type, "LIST", squad, List.of(resource("RTM", site("STM", site("MTM", null, squad), squad), null, 0)), day("2029-05-01"), day("2029-05-03"), Map.of("reason", "مبرر اختبار كافٍ للطلب هنا"));
        assertThat(req.upload(draft, "attachments", "plan.txt", "خطة".getBytes(StandardCharsets.UTF_8)).status()).isEqualTo(200);
        Res refused = req.submit(draft);
        assertThat(refused.status()).isEqualTo(400);
        assertThat(String.valueOf(refused.body())).contains("لا توجد فترة");

        assertThat(admin.put("/access/unit-ops-routes?commandId=" + main, List.of(Map.of("name", "خارجها", "from", "08:00", "to", "15:00", "days", everyDay, "targets", List.of(other.toString())))).status())
                .as("a receiving unit outside the command is refused").isEqualTo(400);
        assertThat(admin.get("/access/unit-ops-routes?commandId=" + main).body().get(0).path("name").asText()).as("and nothing changed").isEqualTo("ليس اليوم");
        assertThat(admin.put("/access/unit-ops-routes?commandId=" + main, List.of()).status()).isEqualTo(200);
    }

    @Test
    @DisplayName("Request types: added with a name and what it does; removed from every list, and refused while a request of it is open")
    void requestTypes() {
        Api admin = login("admin");
        Res made = admin.post("/request-types", Map.of("name", "طلب تجربة " + sfx, "kind", "NEW_RESERVATION"));
        assertThat(made.status()).as(String.valueOf(made.body())).isEqualTo(200);
        String code = made.body().path("code").asText();
        assertThat(admin.get("/request-types").body().toString()).contains(code);
        assertThat(admin.get("/workflows").body().toString()).as("its path can be drawn").contains(code);
        assertThat(admin.post("/request-types", Map.of("name", "طلب تجربة " + sfx, "kind", "NEW_RESERVATION")).status()).as("the same name twice").isEqualTo(400);
        assertThat(admin.post("/request-types", Map.of("name", "طلب بلا عمل", "kind", "SOMETHING")).status()).isEqualTo(400);
        assertThat(login("req").post("/request-types", Map.of("name", "طلب من غير مخول", "kind", "NEW_RESERVATION")).status()).as("configuration only").isEqualTo(403);

        String type = requestType("NEW_RESERVATION", flow(
                List.of(node("st", "start"), approval("fin", true, place("APPROVER", "ANY")), node("ok", "end_approved")),
                List.of(line("st", "fin", null), line("fin", "ok", "approved"))), null);
        UUID open = submitted(type);
        assertThat(admin.delete("/request-types/" + type).status()).as("a request of it is open").isEqualTo(400);
        Api apr = login("apr");
        assertThat(apr.approve(apr.taskFor(open), 1).status()).isEqualTo(200);
        assertThat(admin.delete("/request-types/" + type).status()).isEqualTo(204);
        assertThat(admin.get("/request-types").body().toString()).doesNotContain(type);
        assertThat(admin.get("/workflows").body().toString()).doesNotContain(type);
        assertThat(admin.get("/forms").body().toString()).doesNotContain(type);
        assertThat(login("req").get("/requests/" + open).status()).as("its past request stays").isEqualTo(200);
    }

    private UUID zeroAccess(String who, UUID unit) {
        UUID id = UUID.randomUUID();
        jdbc.sql("insert into person(id, employee_no, display_name, username) values (:id, :e, :n, :u)")
                .param("id", id).param("e", "T-" + who + "-" + sfx).param("n", "شخص " + who).param("u", who + "-" + sfx).update();
        jdbc.sql("insert into affiliation(id, person_id, organization_id, valid_from) values (:i, :p, :o, '2026-01-01T00:00:00Z')")
                .param("i", UUID.randomUUID()).param("p", id).param("o", unit).update();
        return id;
    }

    private static JsonNode inboxItem(JsonNode box, UUID request) {
        for (JsonNode n : box) {
            if (n.path("requestId").asText().equals(request.toString())) {
                return n;
            }
        }
        throw new AssertionError("not in the inbox: " + request);
    }

    /*
     * ROLE_DEFINITIONS_NOTE. The suite shares one database: other classes (MatrixColumnsIT, the authz scope ITs, SiteSetupIT …)
     * seed the same canonical role codes with their own names and permissions, and with "on conflict do nothing" whichever
     * class ran first decided what these journeys saw (MatrixColumnsIT, which runs earlier, names each role by its code and
     * gives UNIT_OPERATIONS_APPROVER no REVIEW, so the facilities step assigned to it could not be published). The journeys
     * here set the definitions they are written for, as on a fresh database. WorkflowGraphIT runs last in the suite.
     */
    private String offerBefore;

    private void accessRoles() {
        jdbc.sql("""
                insert into role_def(code, name, permissions, scope, summary_only, sort_order) values
                  ('CHAIN_APPROVER', 'معتمد السلسلة الهرمية', array['VIEW','REVIEW'], 'ORGANIZATION', false, 951),
                  ('UNIT_OPERATIONS_APPROVER', 'معتمد عمليات الوحدة', array['VIEW','REVIEW'], 'ORGANIZATION', false, 952),
                  ('FYI_RECEIVER', 'للعلم', array['VIEW_SUMMARY'], 'SITE', false, 953),
                  ('UNIT_ACCESS_MANAGER', 'مدير صلاحيات الوحدة', array['MANAGE_ACCESS','REVIEW'], 'ORGANIZATION', false, 954),
                  ('ACCESS_FINAL_APPROVER', 'معتمد طلبات الصلاحية', array['REVIEW','APPROVE'], 'ALL', false, 955)
                on conflict (code) do update set name = excluded.name, permissions = excluded.permissions, scope = excluded.scope,
                                                 summary_only = excluded.summary_only""").update();
        // What a person may ask for is the system administrator's setting (ADR-044, V29). V64 (ADR-095 Q3) removed MOVER's
        // facility roles from that list on every installation — and V49 (ADR-078) had already put «مقدم الطلب» in REQUESTER's
        // place — while the test environment still keeps REQUESTER for the facilities engine (legacy-facility-roles=true).
        // These journeys ask for REQUESTER, so the administrator offers it to everyone here, through the same endpoint, beside
        // the three roles V29 offers; the list is restored after the test.
        if (offerBefore == null) {
            offerBefore = jdbc.sql("select coalesce(json_agg(o), '[]'::json)::text from access_request_offer o").query(String.class).single();
        }
        Res offered = login("admin").put("/access-requests/offer", Map.of("REQUESTER", "EVERYONE", "CHAIN_APPROVER", "EVERYONE",
                "UNIT_OPERATIONS_APPROVER", "EVERYONE", "FYI_RECEIVER", "EVERYONE"));
        assertThat(offered.status()).as(String.valueOf(offered.body())).isEqualTo(200);
        jdbc.sql("update request_type set active = false where kind = 'ACCESS'").update();
        requestType("ACCESS", flow(
                List.of(node("st", "start"), approval("rev", false, place("UNIT_ACCESS_MANAGER", "BY_SCOPE")),
                        node("fin", "approval", "mode", "ANY", "slaDays", 3, "assignees", List.of(place("ACCESS_FINAL_APPROVER", "BY_SCOPE")), "final", true, "requiresSignature", true),
                        node("ok", "end_approved")),
                List.of(line("st", "rev", null), line("rev", "fin", "approved"), line("fin", "ok", "approved"))), null);
    }

    @Test
    @DisplayName("Asking for permissions: no permission, one open request; the reviewer advises; only the final approval grants, and what was asked, advised and granted stay apart")
    void askingForPermissions() {
        opsHierarchy();
        accessRoles();
        UUID asker = zeroAccess("asker", squad);
        person("mgrSec", "UNIT_ACCESS_MANAGER", section);
        person("accFin", "ACCESS_FINAL_APPROVER", root);
        Api me = login("asker");
        assertThat(me.get("/requests").body().path("total").asInt(0)).as("signing in shows nothing").isZero();
        JsonNode mine = me.get("/access-requests/mine").body();
        assertThat(mine.path("available").asBoolean()).isTrue();
        assertThat(mine.toString()).contains("معتمد عمليات الوحدة").doesNotContain("ACCESS_FINAL_APPROVER");
        assertThat(me.post("/access-requests", Map.of("roles", List.of("APPROVER"), "reason", "أريد صلاحية لا تُطلب")).status()).as("not on the list").isEqualTo(400);
        Res sent = me.post("/access-requests", Map.of("roles", List.of("REQUESTER", "FYI_RECEIVER"), "reason", "أحتاجها لعملي في الوحدة"));
        assertThat(sent.status()).as(String.valueOf(sent.body())).isEqualTo(200);
        UUID id = UUID.fromString(sent.body().path("id").asText());
        assertThat(me.post("/access-requests", Map.of("roles", List.of("REQUESTER"), "reason", "طلب ثان أثناء الأول")).status()).as("one open request").isEqualTo(400);
        assertThat(jdbc.sql("select count(*) from membership where person_id = :p").param("p", asker).query(Long.class).single()).as("a request is not a grant").isZero();

        Api mgr = login("mgrSec");
        JsonNode box = mgr.get("/access-requests/inbox").body();
        assertThat(box.toString()).contains("شخص asker").contains("أحتاجها لعملي");
        JsonNode item = inboxItem(box, id);
        assertThat(item.path("final").asBoolean()).isFalse();
        assertThat(mgr.get("/tasks").body().toString()).as("not among other requests").doesNotContain(id.toString());
        Res advised = mgr.post("/access-requests/" + id + "/decision", Map.of("taskId", item.path("taskId").asText(), "decision", "APPROVE", "roles", List.of("REQUESTER")));
        assertThat(advised.status()).as(String.valueOf(advised.body())).isEqualTo(200);
        assertThat(jdbc.sql("select count(*) from membership where person_id = :p").param("p", asker).query(Long.class).single()).as("advice grants nothing").isZero();

        Api fin = login("accFin");
        JsonNode finalBox = inboxItem(fin.get("/access-requests/inbox").body(), id);
        assertThat(finalBox.path("final").asBoolean()).isTrue();
        assertThat(finalBox.path("recommended").toString()).contains("REQUESTER").doesNotContain("FYI_RECEIVER");
        assertThat(finalBox.path("reviewedBy").asText()).isEqualTo("شخص mgrSec");
        Res done = fin.post("/access-requests/" + id + "/decision", Map.of("taskId", finalBox.path("taskId").asText(), "decision", "APPROVE", "roles", List.of("REQUESTER", "CHAIN_APPROVER")));
        assertThat(done.status()).as(String.valueOf(done.body())).isEqualTo(200);
        assertThat(done.body().path("status").asText()).isEqualTo("APPROVED");
        assertThat(jdbc.sql("select role_code from membership where person_id = :p and organization_id = :o").param("p", asker).param("o", squad).query(String.class).list())
                .as("what the final approver granted").containsExactlyInAnyOrder("REQUESTER", "CHAIN_APPROVER");
        // the approved request makes the person one of the unit's users (owner, 16 Nov 2026, as TNQL)
        assertThat(jdbc.sql("select count(*) from unit_member where person_id = :p and organization_id = :o and ended_at is null and not acting")
                .param("p", asker).param("o", squad).query(Long.class).single()).isEqualTo(1);
        assertThat(jdbc.sql("select count(*) from audit_event where action = 'UNIT_MEMBER_ADDED' and entity_id = :p").param("p", asker.toString())
                .query(Long.class).single()).isEqualTo(1);
        assertThat(login("asker").get("/me").body().path("permissions").toString()).contains("CREATE");
        assertThat(jdbc.sql("select array_to_string(requested, ',') || '|' || array_to_string(recommended, ',') || '|' || array_to_string(granted, ',') from access_request where request_id = :r").param("r", id).query(String.class).single())
                .as("three sets apart").isEqualTo("REQUESTER,FYI_RECEIVER|REQUESTER|REQUESTER,CHAIN_APPROVER");
        assertThat(login("req").get("/requests/" + id).status()).as("others do not read it").isIn(403, 404);
    }

    @Test
    @DisplayName("Asking for permissions: the administrator decides what is shown; the unit's manager adds what is kept for them; nothing ends or is reported late by a deadline")
    void whatCanBeAsked() {
        opsHierarchy();
        accessRoles();
        List<Map<String, Object>> before = jdbc.sql("select role_code, audience from access_request_offer").query().listOfRows();
        try {
            UUID asker = zeroAccess("offerAsker", squad);
            person("offerMgr", "UNIT_ACCESS_MANAGER", section);
            person("offerFin", "ACCESS_FINAL_APPROVER", root);
            Api me = login("offerAsker");
            Api admin = login("admin");
            assertThat(me.get("/access-requests/offer").status()).as("the list is the administrator's").isEqualTo(403);
            assertThat(me.put("/access-requests/offer", Map.of("REQUESTER", "EVERYONE")).status()).isEqualTo(403);
            String offer = admin.get("/access-requests/offer").body().toString();
            assertThat(offer).as("a request never makes an administrator or a final approver of requests")
                    .contains("REQUESTER").doesNotContain("SYSTEM_ADMIN").doesNotContain("UNIT_ACCESS_MANAGER").doesNotContain("ACCESS_FINAL_APPROVER").doesNotContain("AUDITOR");
            assertThat(admin.put("/access-requests/offer", Map.of("UNIT_ACCESS_MANAGER", "EVERYONE")).status()).as("not offerable").isEqualTo(400);
            assertThat(admin.put("/access-requests/offer", Map.of("REQUESTER", "MANAGER")).status()).as("somebody must be able to ask").isEqualTo(400);
            assertThat(admin.put("/access-requests/offer", Map.of("REQUESTER", "EVERYONE", "FYI_RECEIVER", "MANAGER")).status()).isEqualTo(200);

            // «الصلاحيات المتاحة للطلب» (owner, 16 Nov 2026): the description and the scopes are the administrator's, not the page's
            assertThat(admin.put("/access-requests/offer", Map.of("REQUESTER", Map.of("audience", "EVERYONE", "description", "يقدّم طلبات وحدته فقط",
                    "scopeModes", List.of("UNIT", "UNIT_TREE"), "defaultScope", "SITES"), "FYI_RECEIVER", "MANAGER")).status()).as("a default outside its scopes").isEqualTo(400);
            assertThat(admin.put("/access-requests/offer", Map.of("REQUESTER", Map.of("audience", "EVERYONE", "description", "يقدّم طلبات وحدته فقط",
                    "scopeModes", List.of("UNIT", "UNIT_TREE"), "defaultScope", "UNIT_TREE"), "FYI_RECEIVER", "MANAGER")).status()).isEqualTo(200);
            JsonNode mine = me.get("/access-requests/mine").body();
            assertThat(mine.path("requestable").toString()).contains("REQUESTER").doesNotContain("FYI_RECEIVER").doesNotContain("CHAIN_APPROVER");
            JsonNode offered = mine.path("requestable").get(0);
            assertThat(offered.path("description").asText()).isEqualTo("يقدّم طلبات وحدته فقط");
            assertThat(offered.path("scopeModes").toString()).isEqualTo("[\"UNIT\",\"UNIT_TREE\"]");
            assertThat(offered.path("defaultScope").asText()).isEqualTo("UNIT_TREE");
            Res outside = me.post("/access-requests", Map.of("roles", List.of("REQUESTER"), "reason", "أحتاجها لعملي في الوحدة", "scope", Map.of("mode", "UNITS", "ids", List.of(squad.toString()))));
            assertThat(outside.status()).as("a scope the role does not allow").isEqualTo(400);
            assertThat(String.valueOf(outside.body())).contains("هذا النطاق غير متاح");
            assertThat(me.post("/access-requests", Map.of("roles", List.of("FYI_RECEIVER"), "reason", "أحتاجها لعملي في الوحدة")).status()).as("kept for the manager").isEqualTo(400);
            assertThat(me.post("/access-requests", Map.of("roles", List.of("CHAIN_APPROVER"), "reason", "أحتاجها لعملي في الوحدة")).status()).as("no longer shown").isEqualTo(400);
            UUID id = UUID.fromString(me.post("/access-requests", Map.of("roles", List.of("REQUESTER"), "reason", "أحتاجها لعملي في الوحدة")).body().path("id").asText());

            // a deadline passes: no notice, no count, and the request still waits for its decision
            jdbc.sql("update task_assignment set due_at = now() - interval '30 days' where request_id = :r").param("r", id).update();
            outbox.scanOverdue();
            assertThat(jdbc.sql("select count(*) from task_assignment where request_id = :r and overdue_notified").param("r", id).query(Long.class).single()).as("nothing is late").isZero();
            assertThat(jdbc.sql("select status from request where id = :r").param("r", id).query(String.class).single()).as("a deadline decides nothing").isEqualTo("SUBMITTED");

            Api mgr = login("offerMgr");
            JsonNode item = inboxItem(mgr.get("/access-requests/inbox").body(), id);
            assertThat(item.path("extras").toString()).as("the manager's own list").contains("FYI_RECEIVER");
            assertThat(item.path("offered").toString()).doesNotContain("FYI_RECEIVER");
            assertThat(mgr.post("/access-requests/" + id + "/decision", Map.of("taskId", item.path("taskId").asText(), "decision", "APPROVE", "roles", List.of("REQUESTER", "APPROVER"))).status())
                    .as("not on any list").isEqualTo(400);
            assertThat(mgr.post("/access-requests/" + id + "/decision", Map.of("taskId", item.path("taskId").asText(), "decision", "APPROVE", "roles", List.of("REQUESTER", "FYI_RECEIVER"))).status()).isEqualTo(200);
            assertThat(jdbc.sql("select count(*) from membership where person_id = :p").param("p", asker).query(Long.class).single()).as("adding is advice too").isZero();

            Api fin = login("offerFin");
            JsonNode last = inboxItem(fin.get("/access-requests/inbox").body(), id);
            assertThat(last.path("offered").toString()).as("what was added reaches the final approver").contains("FYI_RECEIVER");
            assertThat(fin.post("/access-requests/" + id + "/decision", Map.of("taskId", last.path("taskId").asText(), "decision", "APPROVE", "roles", List.of("REQUESTER", "FYI_RECEIVER"))).status()).isEqualTo(200);
            assertThat(jdbc.sql("select role_code from membership where person_id = :p").param("p", asker).query(String.class).list()).containsExactlyInAnyOrder("REQUESTER", "FYI_RECEIVER");
        } finally {
            jdbc.sql("delete from access_request_offer").update();
            before.forEach(r -> jdbc.sql("insert into access_request_offer(role_code, audience) values (:c, :a)").param("c", r.get("role_code")).param("a", r.get("audience")).update());
        }
    }

    @Test
    @DisplayName("Asking for permissions: the scope asked, advised and granted; advice to reject; a return is the same request; the whole system is never asked for")
    void askingWithScope() {
        opsHierarchy();
        accessRoles();
        UUID asker = zeroAccess("scoped", squad);
        person("mgrScope", "UNIT_ACCESS_MANAGER", section);
        person("finScope", "ACCESS_FINAL_APPROVER", root);
        Api me = login("scoped");
        // the role is on the person's list, so the refusal below can only be the scope rule's
        assertThat(me.get("/access-requests/mine").body().path("requestable").toString()).contains("\"code\":\"REQUESTER\"");
        Res whole = me.post("/access-requests", Map.of("roles", List.of("REQUESTER"), "reason", "أحتاجها لعملي في الوحدة", "scope", Map.of("mode", "ALL")));
        assertThat(whole.status()).as("the whole system is never asked for").isEqualTo(403);
        assertThat(whole.body().path("message").asText()).isEqualTo("النطاق الشامل يمنحه مدير صلاحيات عام عند الاعتماد النهائي فقط.");
        assertThat(jdbc.sql("select count(*) from access_request where person_id = :p").param("p", asker).query(Long.class).single())
                .as("nothing is recorded for a refused scope").isZero();
        assertThat(me.post("/access-requests", Map.of("roles", List.of("REQUESTER"), "reason", "أحتاجها لعملي في الوحدة", "scope", Map.of("mode", "UNITS", "ids", List.of(root.toString())))).status())
                .as("units of the person's own branch").isEqualTo(400);
        Res sent = me.post("/access-requests", Map.of("roles", List.of("REQUESTER"), "reason", "أحتاجها لعملي في الوحدة", "scope", Map.of("mode", "UNIT_TREE")));
        assertThat(sent.status()).as(sent.toString()).isEqualTo(200);
        UUID id = UUID.fromString(sent.body().path("id").asText());
        assertThat(me.get("/access-requests/mine").body().path("requests").get(0).path("statusLabel").asText()).isEqualTo("بانتظار التوصية");

        Api mgr = login("mgrScope");
        JsonNode item = inboxItem(mgr.get("/access-requests/inbox").body(), id);
        assertThat(item.path("scope").path("mode").asText()).isEqualTo("UNIT_TREE");
        assertThat(mgr.post("/access-requests/" + id + "/decision", Map.of("taskId", item.path("taskId").asText(), "decision", "RETURN")).status()).as("a return says why").isEqualTo(400);
        Res ret = mgr.post("/access-requests/" + id + "/decision", Map.of("taskId", item.path("taskId").asText(), "decision", "RETURN", "note", "حدد النطاق بوحدتك فقط"));
        assertThat(ret.status()).as(ret.toString()).isEqualTo(200);
        assertThat(me.get("/access-requests/mine").body().path("requests").get(0).path("statusLabel").asText()).isEqualTo("أعيد للتعديل");
        assertThat(me.post("/access-requests", Map.of("roles", List.of("REQUESTER"), "reason", "طلب ثان أثناء الإرجاع")).status()).as("the same request, not a second").isEqualTo(400);
        assertThat(login("mgrScope").post("/access-requests/" + id + "/resubmit", Map.of("roles", List.of("REQUESTER"), "reason", "ليس طلبي")).status()).as("only its owner").isEqualTo(404);
        Res again = me.post("/access-requests/" + id + "/resubmit", Map.of("roles", List.of("REQUESTER"), "reason", "حددت النطاق بوحدتي", "scope", Map.of("mode", "UNIT")));
        assertThat(again.status()).as(again.toString()).isEqualTo(200);
        assertThat(jdbc.sql("select count(*) from request where id = :r").param("r", id).query(Long.class).single()).isEqualTo(1);

        JsonNode second = inboxItem(mgr.get("/access-requests/inbox").body(), id);
        assertThat(mgr.post("/access-requests/" + id + "/decision", Map.of("taskId", second.path("taskId").asText(), "decision", "APPROVE", "roles", List.of(), "recommendReject", true, "note", "لا يحتاجها في عمله الحالي")).status()).isEqualTo(200);
        assertThat(me.get("/access-requests/mine").body().path("requests").get(0).path("statusLabel").asText()).startsWith("موصى بالرفض");
        assertThat(jdbc.sql("select count(*) from membership where person_id = :p").param("p", asker).query(Long.class).single()).as("advice grants nothing").isZero();
        assertThat(jdbc.sql("select recommended_scope is not null and granted_scope is null from access_request where request_id = :r").param("r", id).query(Boolean.class).single())
                .as("the advised scope is kept apart from the granted one (V43)").isTrue();

        Api fin = login("finScope");
        JsonNode last = inboxItem(fin.get("/access-requests/inbox").body(), id);
        assertThat(last.path("final").asBoolean()).isTrue();
        assertThat(last.path("recommendReject").asBoolean()).isTrue();
        assertThat(mgr.post("/access-requests/" + id + "/decision", Map.of("taskId", last.path("taskId").asText(), "decision", "APPROVE", "roles", List.of("REQUESTER"))).status()).as("the reviewer has no final button").isIn(403, 404, 409);
        assertThat(fin.post("/access-requests/" + id + "/decision", Map.of("taskId", last.path("taskId").asText(), "decision", "APPROVE", "roles", List.of("REQUESTER"), "scope", Map.of("mode", "ALL"))).status())
                .as("only a global access manager gives the whole system").isEqualTo(403);
        Res done = fin.post("/access-requests/" + id + "/decision", Map.of("taskId", last.path("taskId").asText(), "decision", "APPROVE", "roles", List.of("REQUESTER")));
        assertThat(done.status()).as(done.toString()).isEqualTo(200);
        Map<String, Object> grant = jdbc.sql("select id, scope_mode, scope_all from membership where person_id = :p").param("p", asker).query().singleRow();
        assertThat(grant.get("scope_mode")).isEqualTo("CUSTOM");
        assertThat(grant.get("scope_all")).isEqualTo(false);
        assertThat(jdbc.sql("select count(*) from membership_scope_target where membership_id = :m and kind = 'ORGANIZATION' and target_id = :o and not include_descendants")
                .param("m", grant.get("id")).param("o", squad).query(Long.class).single()).as("the unit alone").isEqualTo(1);
        assertThat(login("scoped").get("/me").body().path("permissions").toString()).contains("CREATE");
        assertThat(jdbc.sql("select count(*) from audit_event where entity_id = :r and action in ('ACCESS_REQUEST_RECOMMENDED', 'ACCESS_REQUEST_FINAL_APPROVED', 'ACCESS_REQUEST_RESUBMITTED')").param("r", id.toString()).query(Long.class).single()).isEqualTo(3);
    }

    @Test
    @DisplayName("ACCESS-04: with no reviewer it goes to the final approval, recorded in the owner's words; refusal grants nothing and opens the way for a new request; a move reroutes it")
    void askingWithoutReviewer() {
        opsHierarchy();
        accessRoles();
        UUID asker = zeroAccess("asker2", team);
        person("accFin2", "ACCESS_FINAL_APPROVER", root);
        Api me = login("asker2");
        UUID id = UUID.fromString(me.post("/access-requests", Map.of("roles", List.of("REQUESTER"), "reason", "أحتاجها لعملي في الوحدة")).body().path("id").asText());
        Api fin = login("accFin2");
        JsonNode box = inboxItem(fin.get("/access-requests/inbox").body(), id);
        assertThat(box.path("final").asBoolean()).as("nobody reviews this unit, so it comes straight here").isTrue();
        assertThat(box.path("reviewedBy").isNull() || box.path("reviewedBy").isMissingNode()).isTrue();
        // recorded, not inferred (owner, 16 Nov 2026): the step passed for want of an access manager, with the reason, audited once
        assertThat(box.path("reviewSkipped").asText()).isEqualTo("تم التجاوز — لا يوجد مسؤول صلاحيات يغطي الوحدة");
        assertThat(jdbc.sql("select count(*) from request_route_skip where request_id = :r and reason_code = 'NO_ACCESS_MANAGER'").param("r", id).query(Long.class).single()).isEqualTo(1);
        assertThat(jdbc.sql("select count(*) from audit_event where entity_id = :r and action = 'ACCESS_REVIEW_SKIPPED'").param("r", id.toString()).query(Long.class).single()).isEqualTo(1);
        Res refused = fin.post("/access-requests/" + id + "/decision", Map.of("taskId", box.path("taskId").asText(), "decision", "REJECT", "note", "لا يحتاج هذه الصلاحية في عمله الحالي"));
        assertThat(refused.status()).as(String.valueOf(refused.body())).isEqualTo(200);
        assertThat(jdbc.sql("select count(*) from membership where person_id = :p").param("p", asker).query(Long.class).single()).isZero();
        Res again = me.post("/access-requests", Map.of("roles", List.of("REQUESTER"), "reason", "طلب جديد بعد الرفض"));
        assertThat(again.status()).as("a new request after a decision").isEqualTo(200);
        UUID second = UUID.fromString(again.body().path("id").asText());
        // moved in HR while it waits: nothing is granted for the old unit; the same request starts over at the new one (§24)
        jdbc.sql("update affiliation set valid_to = now() where person_id = :p").param("p", asker).update();
        jdbc.sql("insert into affiliation(id, person_id, organization_id, valid_from) values (:i, :p, :o, now())").param("i", UUID.randomUUID()).param("p", asker).param("o", section).update();
        JsonNode moved = inboxItem(fin.get("/access-requests/inbox").body(), second);
        assertThat(moved.path("movedTo").asText()).isEqualTo("وحدة SECC");
        Res rerouted = fin.post("/access-requests/" + second + "/decision", Map.of("taskId", moved.path("taskId").asText(), "decision", "APPROVE", "roles", List.of("REQUESTER")));
        assertThat(rerouted.status()).as(rerouted.toString()).isEqualTo(200);
        assertThat(rerouted.body().path("rerouted").asBoolean()).isTrue();
        assertThat(rerouted.body().path("message").asText()).contains("نُقل مقدم الطلب");
        assertThat(jdbc.sql("select count(*) from membership where person_id = :p").param("p", asker).query(Long.class).single()).as("nothing granted").isZero();
        assertThat(jdbc.sql("select unit_org_id from access_request where request_id = :r").param("r", second).query(UUID.class).single()).isEqualTo(section);
        assertThat(jdbc.sql("select count(*) from audit_event where entity_id = :r and action = 'ACCESS_REQUEST_UNIT_CHANGED' and reason = 'الوحدة تغيرت أثناء طلب الصلاحية'")
                .param("r", second.toString()).query(Long.class).single()).as("audited").isEqualTo(1);
        JsonNode again2 = inboxItem(fin.get("/access-requests/inbox").body(), second);
        assertThat(again2.path("unit").asText()).isEqualTo("وحدة SECC");
        assertThat(again2.path("movedTo").isNull() || again2.path("movedTo").isMissingNode()).as("the request now stands at the current unit").isTrue();
    }

    @Test
    @DisplayName("ACCESS-01/02/03/05/06: asked 4, advised 3, granted 2 role by role; unit operations by levels under an anchor; the preview is exactly what is written")
    void finalApproverSetsEachRole() {
        opsHierarchy();
        accessRoles();
        UUID asker = zeroAccess("perRole", squad);
        person("mgrPerRole", "UNIT_ACCESS_MANAGER", section);
        person("finPerRole", "ACCESS_FINAL_APPROVER", root);
        Api me = login("perRole");
        // ACCESS-01: several roles at once, of every kind offered
        Res sent = me.post("/access-requests", Map.of("roles", List.of("REQUESTER", "CHAIN_APPROVER", "UNIT_OPERATIONS_APPROVER", "FYI_RECEIVER"),
                "reason", "أحتاجها لعملي في الوحدة"));
        assertThat(sent.status()).as(sent.toString()).isEqualTo(200);
        UUID id = UUID.fromString(sent.body().path("id").asText());
        assertThat(me.get("/access-requests/mine").body().path("overall").path("text").asText()).isEqualTo("طلبك بانتظار مراجعة مسؤول الصلاحيات");

        // ACCESS-02: the access manager advises a subset; nothing becomes effective
        Api mgr = login("mgrPerRole");
        JsonNode item = inboxItem(mgr.get("/access-requests/inbox").body(), id);
        assertThat(item.path("seats").toString()).as("unit responsibilities are told apart").contains("UNIT_OPERATIONS_APPROVER").doesNotContain("REQUESTER\"");
        assertThat(mgr.post("/access-requests/" + id + "/preview", Map.of("taskId", item.path("taskId").asText(), "grants", List.of(Map.of("role", "REQUESTER")))).status())
                .as("the reviewer has no preview of activation").isEqualTo(400);
        assertThat(mgr.post("/access-requests/" + id + "/decision", Map.of("taskId", item.path("taskId").asText(), "decision", "APPROVE",
                "roles", List.of("REQUESTER", "UNIT_OPERATIONS_APPROVER", "FYI_RECEIVER"))).status()).isEqualTo(200);
        assertThat(jdbc.sql("select count(*) from membership where person_id = :p").param("p", asker).query(Long.class).single()).isZero();
        assertThat(me.get("/access-requests/mine").body().path("overall").path("text").asText()).as("the owner's words").isEqualTo("بانتظار الاعتماد النهائي");

        // ACCESS-03/05: the final approver grants a different subset, each role with its own scope
        Api fin = login("finPerRole");
        JsonNode last = inboxItem(fin.get("/access-requests/inbox").body(), id);
        String task = last.path("taskId").asText();
        assertThat(fin.get("/access-requests/" + id + "/scope-tree").status()).isEqualTo(200);
        assertThat(fin.get("/access-requests/" + id + "/scope-tree").body().path("rootId").asText()).as("the branch of the main unit").isEqualTo(main.toString());
        assertThat(login("rSquad").get("/access-requests/" + id + "/scope-tree").status()).as("only whoever holds a step").isEqualTo(404);
        String validTo = java.time.Instant.now().plus(java.time.Duration.ofDays(365)).truncatedTo(java.time.temporal.ChronoUnit.SECONDS).toString();
        List<Map<String, Object>> grants = List.of(
                Map.of("role", "REQUESTER", "scope", Map.of("mode", "CUSTOM", "targets", List.of(Map.of("kind", "ORGANIZATION", "id", squad.toString(), "includeDescendants", false)))),
                Map.of("role", "UNIT_OPERATIONS_APPROVER", "validTo", validTo, "scope", Map.of("mode", "CUSTOM",
                        "targets", List.of(Map.of("kind", "ORGANIZATION", "id", section.toString(), "includeDescendants", true, "levels", List.of(6, 7))))));
        JsonNode preview = fin.post("/access-requests/" + id + "/preview", Map.of("taskId", task, "grants", grants)).body();
        assertThat(preview.path("problems").size()).as(preview.toString()).isZero();
        JsonNode ops = preview.path("lines").get(1);
        assertThat(ops.path("roleName").asText()).isEqualTo("معتمد عمليات الوحدة");
        assertThat(ops.path("seat").asBoolean()).isTrue();
        assertThat(ops.path("kind").asText()).isEqualTo("مسؤولية/مقعد الوحدة");
        assertThat(ops.path("scopeText").asText()).isEqualTo("الجهة «وحدة SECC»: المستوى 6 و7");
        assertThat(ops.path("units").asInt()).as("team and squad").isEqualTo(2);
        assertThat(ops.path("anchors").get(0).path("levels").toString()).isEqualTo("[6,7]");
        assertThat(ops.path("validTo").asText()).isEqualTo(validTo);
        assertThat(preview.path("lines").get(0).path("kind").asText()).isEqualTo("صلاحية شخصية");
        assertThat(preview.path("lines").get(0).path("scopeText").asText()).isEqualTo("الجهة «وحدة SQUADC» وحدها");
        String fingerprint = preview.path("fingerprint").asText();
        assertThat(jdbc.sql("select count(*) from membership where person_id = :p").param("p", asker).query(Long.class).single()).as("a preview writes nothing").isZero();

        // what blocks: the whole system, levels with no unit (listed, never written)
        JsonNode blocked = fin.post("/access-requests/" + id + "/preview", Map.of("taskId", task, "grants", List.of(
                Map.of("role", "REQUESTER", "scope", Map.of("mode", "CUSTOM", "all", true)),
                Map.of("role", "UNIT_OPERATIONS_APPROVER", "scope", Map.of("mode", "CUSTOM",
                        "targets", List.of(Map.of("kind", "ORGANIZATION", "id", section.toString(), "includeDescendants", true, "levels", List.of(2)))))))).body();
        assertThat(blocked.path("problems").toString()).contains("النطاق الشامل").contains("لا توجد وحدات في المستوى 2");
        assertThat(fin.post("/access-requests/" + id + "/preview", Map.of("taskId", task, "grants", List.of(Map.of("role", "AUDITOR")))).status())
                .as("never a role outside the lists").isEqualTo(400);

        // §15: only what was previewed is approved
        Map<String, Object> approve = new LinkedHashMap<>();
        approve.put("taskId", task);
        approve.put("decision", "APPROVE");
        approve.put("grants", grants);
        assertThat(fin.post("/access-requests/" + id + "/decision", approve).status()).as("no preview, no approval").isEqualTo(409);
        approve.put("fingerprint", fingerprint);
        approve.put("grants", List.of(grants.get(0)));
        assertThat(fin.post("/access-requests/" + id + "/decision", approve).status()).as("changed after the preview").isEqualTo(409);
        approve.put("grants", grants);
        Res done = fin.post("/access-requests/" + id + "/decision", approve);
        assertThat(done.status()).as(done.toString()).isEqualTo(200);
        assertThat(done.body().path("status").asText()).isEqualTo("APPROVED");

        // ACCESS-06: the result is the preview, word for word
        assertThat(jdbc.sql("select array_to_string(requested, ',') || '|' || array_to_string(recommended, ',') || '|' || array_to_string(granted, ',') from access_request where request_id = :r")
                .param("r", id).query(String.class).single())
                .as("three sets apart").isEqualTo("REQUESTER,CHAIN_APPROVER,UNIT_OPERATIONS_APPROVER,FYI_RECEIVER|REQUESTER,UNIT_OPERATIONS_APPROVER,FYI_RECEIVER|REQUESTER,UNIT_OPERATIONS_APPROVER");
        JsonNode held = login("admin").get("/access/grants?personId=" + asker).body();
        Map<String, String> written = new LinkedHashMap<>();
        held.forEach(g -> written.put(g.path("role").path("code").asText(), g.path("scopeText").asText()));
        assertThat(written).containsOnly(Map.entry("REQUESTER", preview.path("lines").get(0).path("scopeText").asText()),
                Map.entry("UNIT_OPERATIONS_APPROVER", ops.path("scopeText").asText()));
        assertThat(jdbc.sql("""
                select array_to_string(t.levels, ',') || '|' || t.include_descendants || '|' || (m.valid_to = cast(:to as timestamptz))
                from membership m join membership_scope_target t on t.membership_id = m.id
                where m.person_id = :p and m.role_code = 'UNIT_OPERATIONS_APPROVER'""").param("p", asker).param("to", validTo).query(String.class).single())
                .isEqualTo("6,7|true|true");
        assertThat(jdbc.sql("select count(*) from audit_event where entity_id = :r and action = 'ACCESS_REQUEST_FINAL_APPROVED' and detail::text like '%المستوى 6 و7%'")
                .param("r", id.toString()).query(Long.class).single()).as("the approval records what was previewed").isEqualTo(1);
    }

    @Test
    @DisplayName("ACCESS-07: the person moves before the final approval; the same request is rerouted through the current unit; never the old unit's scope")
    void movedBeforeFinalIsRerouted() {
        opsHierarchy();
        accessRoles();
        UUID asker = zeroAccess("mover7", squad);
        person("mgrMove7", "UNIT_ACCESS_MANAGER", section);
        person("finMove7", "ACCESS_FINAL_APPROVER", root);
        Api me = login("mover7");
        UUID id = UUID.fromString(me.post("/access-requests", Map.of("roles", List.of("REQUESTER"), "reason", "أحتاجها لعملي في الوحدة",
                "scope", Map.of("mode", "UNITS", "ids", List.of(squad.toString())))).body().path("id").asText());
        String number = jdbc.sql("select number from request where id = :r").param("r", id).query(String.class).single();
        Api mgr = login("mgrMove7");
        JsonNode item = inboxItem(mgr.get("/access-requests/inbox").body(), id);
        assertThat(mgr.post("/access-requests/" + id + "/decision", Map.of("taskId", item.path("taskId").asText(), "decision", "APPROVE", "roles", List.of("REQUESTER"))).status()).isEqualTo(200);

        // HR moves the person to the main unit, which no access manager covers
        jdbc.sql("update affiliation set valid_to = now() where person_id = :p").param("p", asker).update();
        jdbc.sql("insert into affiliation(id, person_id, organization_id, valid_from) values (:i, :p, :o, now())").param("i", UUID.randomUUID()).param("p", asker).param("o", main).update();
        Api fin = login("finMove7");
        JsonNode last = inboxItem(fin.get("/access-requests/inbox").body(), id);
        assertThat(last.path("movedTo").asText()).isEqualTo("وحدة MAINC");
        JsonNode shown = fin.post("/access-requests/" + id + "/preview", Map.of("taskId", last.path("taskId").asText(), "grants", List.of(Map.of("role", "REQUESTER")))).body();
        assertThat(shown.path("problems").get(0).asText()).as("the preview says so first").contains("نُقل مقدم الطلب");
        Res r = fin.post("/access-requests/" + id + "/decision", Map.of("taskId", last.path("taskId").asText(), "decision", "REROUTE"));
        assertThat(r.status()).as(r.toString()).isEqualTo(200);
        assertThat(r.body().path("rerouted").asBoolean()).isTrue();

        Map<String, Object> a = jdbc.sql("""
                select a.unit_org_id, a.recommended is null as advice_cleared, a.requested_scope is null as scope_cleared, r.number, r.current_revision, r.owner_org_id, r.status
                from access_request a join request r on r.id = a.request_id where a.request_id = :r""").param("r", id).query().singleRow();
        assertThat(a.get("unit_org_id")).isEqualTo(main);
        assertThat(a.get("owner_org_id")).isEqualTo(main);
        assertThat(a.get("number")).as("the same request").isEqualTo(number);
        assertThat(a.get("current_revision")).isEqualTo(2);
        assertThat(a.get("status")).isEqualTo("SUBMITTED");
        assertThat(a.get("advice_cleared")).as("advice for the old unit is not carried").isEqualTo(true);
        assertThat(a.get("scope_cleared")).as("units of the old unit are not carried").isEqualTo(true);
        assertThat(jdbc.sql("select count(*) from membership where person_id = :p").param("p", asker).query(Long.class).single()).isZero();
        assertThat(jdbc.sql("select count(*) from audit_event where entity_id = :r and action = 'ACCESS_REQUEST_UNIT_CHANGED' and reason = 'الوحدة تغيرت أثناء طلب الصلاحية'")
                .param("r", id.toString()).query(Long.class).single()).isEqualTo(1);
        // the current unit's route: nobody reviews the main unit, recorded, and the final approval decides for it
        JsonNode now = inboxItemOrNull(fin.get("/access-requests/inbox").body(), id);
        assertThat(now).as(() -> "tasks: " + jdbc.sql("select stage_key || ':' || status || ':' || final || ':' || coalesce(target_org_id::text, '-') || ':' || by_scope || ':' || coalesce(array_to_string(scope_orgs, ','), '-') from task_assignment where request_id = :r")
                .param("r", id).query(String.class).list() + " skips: " + jdbc.sql("select revision || ':' || reason_code from request_route_skip where request_id = :r").param("r", id).query(String.class).list()
                + " main=" + main + " root=" + root).isNotNull();
        assertThat(now.path("final").asBoolean()).isTrue();
        assertThat(now.path("unit").asText()).isEqualTo("وحدة MAINC");
        assertThat(now.path("reviewSkipped").asText()).isEqualTo("تم التجاوز — لا يوجد مسؤول صلاحيات يغطي الوحدة");
        assertThat(inboxItemOrNull(mgr.get("/access-requests/inbox").body(), id)).as("the old unit's manager no longer has it").isNull();
        JsonNode p = fin.post("/access-requests/" + id + "/preview", Map.of("taskId", now.path("taskId").asText(), "grants", List.of(Map.of("role", "REQUESTER")))).body();
        Res granted = fin.post("/access-requests/" + id + "/decision", Map.of("taskId", now.path("taskId").asText(), "decision", "APPROVE",
                "grants", List.of(Map.of("role", "REQUESTER")), "fingerprint", p.path("fingerprint").asText()));
        assertThat(granted.status()).as(granted.toString()).isEqualTo(200);
        assertThat(jdbc.sql("select organization_id from membership where person_id = :p").param("p", asker).query(UUID.class).single()).as("at the current unit").isEqualTo(main);
    }

    @Test
    @DisplayName("§36: a role shown for information is not requestable; the reviewer may add it")
    void shownNotRequestable() {
        opsHierarchy();
        accessRoles();
        List<Map<String, Object>> before = jdbc.sql("select role_code, audience from access_request_offer").query().listOfRows();
        try {
            zeroAccess("shownAsker", squad);
            person("shownMgr", "UNIT_ACCESS_MANAGER", section);
            Api admin = login("admin");
            assertThat(admin.put("/access-requests/offer", Map.of("REQUESTER", "EVERYONE", "CHAIN_APPROVER", "SHOWN")).status()).isEqualTo(200);
            Api me = login("shownAsker");
            JsonNode req = me.get("/access-requests/mine").body().path("requestable");
            assertThat(req.toString()).contains("CHAIN_APPROVER");
            req.forEach(r -> assertThat(r.path("requestable").asBoolean()).as(r.toString()).isEqualTo("REQUESTER".equals(r.path("code").asText())));
            assertThat(me.post("/access-requests", Map.of("roles", List.of("CHAIN_APPROVER"), "reason", "أحتاجها لعملي في الوحدة")).status()).isEqualTo(400);
            UUID id = UUID.fromString(me.post("/access-requests", Map.of("roles", List.of("REQUESTER"), "reason", "أحتاجها لعملي في الوحدة")).body().path("id").asText());
            assertThat(inboxItem(login("shownMgr").get("/access-requests/inbox").body(), id).path("extras").toString()).contains("CHAIN_APPROVER");
        } finally {
            jdbc.sql("delete from access_request_offer").update();
            before.forEach(r -> jdbc.sql("insert into access_request_offer(role_code, audience) values (:c, :a)").param("c", r.get("role_code")).param("a", r.get("audience")).update());
        }
    }

    private static JsonNode inboxItemOrNull(JsonNode box, UUID request) {
        for (JsonNode n : box) {
            if (n.path("requestId").asText().equals(request.toString())) {
                return n;
            }
        }
        return null;
    }

    @Test
    @DisplayName("Matrix: one unit's people with their grants; a changed scope replaces the grant together, keeping history")
    void unitMatrix() {
        opsHierarchy();
        UUID held = scoped("mx1", "ORG_MANAGER", team, unitTarget(team, false));
        Api admin = login("admin");
        JsonNode m = admin.get("/access/unit-matrix?organizationId=" + team).body();
        assertThat(m.path("total").asInt()).isGreaterThanOrEqualTo(2);
        assertThat(m.toString()).contains("شخص mx1").contains("شخص rTeam");
        String grantId = jdbc.sql("select id::text from membership where person_id = :p").param("p", held).query(String.class).single();
        Map<String, Object> next = new LinkedHashMap<>();
        next.put("personId", held.toString());
        next.put("organizationId", team.toString());
        next.put("roleCode", "ORG_MANAGER");
        next.put("scope", Map.of("mode", "CUSTOM", "targets", List.of(unitTarget(main, true))));
        Res replaced = admin.post("/access/grants/" + grantId + "/replace", Map.of("grant", next, "reason", "نطاق أوسع للتجربة"));
        assertThat(replaced.status()).as(String.valueOf(replaced.body())).isEqualTo(200);
        assertThat(jdbc.sql("select count(*) from membership where person_id = :p").param("p", held).query(Long.class).single()).as("the old one stays in history").isEqualTo(2);
        assertThat(jdbc.sql("select count(*) from membership where person_id = :p and (valid_to is null or valid_to > now())").param("p", held).query(Long.class).single()).isEqualTo(1);
        // a refused new scope changes nothing
        next.put("roleCode", "NO_SUCH_ROLE");
        String current = jdbc.sql("select id::text from membership where person_id = :p and valid_to is null").param("p", held).query(String.class).single();
        assertThat(admin.post("/access/grants/" + current + "/replace", Map.of("grant", next, "reason", "دور غير موجود")).status()).isEqualTo(400);
        assertThat(jdbc.sql("select count(*) from membership where id = cast(:id as uuid) and valid_to is null").param("id", current).query(Long.class).single()).as("rolled back").isEqualTo(1);
    }

    private List<String> problems(Map<String, Object> def) {
        Api admin = login("admin");
        JsonNode list = admin.get("/workflows").body();
        String workflowId = list.get(0).path("id").asText();
        JsonNode saved = admin.post("/workflows/" + workflowId + "/drafts", Map.of("definition", def)).body();
        JsonNode sim = admin.post("/workflow-versions/" + saved.path("id").asText() + "/simulate", Map.of("facts", Map.of())).body();
        List<String> out = new ArrayList<>();
        sim.path("errors").forEach(e -> out.add(e.path("message").asText()));
        return out;
    }

    @Test
    @DisplayName("What cannot be published: no path around the final approval, no loop, no dead end, no unclosed parallel")
    void refused() {
        requestType("NEW_RESERVATION", finalOnly(), null);
        Map<String, Object> fin = approval("fin", true, place("APPROVER", "ANY"));
        Map<String, Object> rv = approval("rv", false, place("FACILITIES_REVIEWER", "REQUEST_ORG"));
        Map<String, Object> ok = node("ok", "end_approved");
        Map<String, Object> s = node("st", "start");
        assertThat(problems(flow(List.of(s, rv, fin, ok), List.of(line("st", "rv", null), line("rv", "ok", "approved"), line("fin", "ok", "approved"))))).as("final not reachable, and a path around it")
                .anyMatch(p -> p.contains("غير موصولة"));
        assertThat(problems(flow(List.of(s, rv, fin, ok), List.of(line("st", "rv", null), line("rv", "fin", "rejected"), line("rv", "ok", "approved"), line("fin", "ok", "approved"))))).as("approving the review skips the final")
                .anyMatch(p -> p.contains("بدون موافقة نهائية"));
        assertThat(problems(flow(List.of(s, rv, fin, ok), List.of(line("st", "rv", null), line("rv", "fin", "approved"), line("fin", "rv", "rejected"), line("fin", "ok", "approved"))))).as("a loop")
                .anyMatch(p -> p.contains("حلقة"));
        assertThat(problems(flow(List.of(s, fin, approval("after", false, place("FACILITIES_REVIEWER", "ANY")), ok), List.of(line("st", "fin", null), line("fin", "after", "approved"), line("after", "ok", "approved"))))).as("after the final")
                .anyMatch(p -> p.contains("بعد الموافقة النهائية"));
        assertThat(problems(flow(List.of(s, node("par", "parallel"), rv, approval("r2", false, place("FACILITIES_REVIEWER", "ANY")), fin, ok),
                List.of(line("st", "par", null), line("par", "rv", null), line("par", "r2", null), line("rv", "fin", "approved"), line("r2", "fin", "approved"), line("fin", "ok", "approved"))))).as("unclosed parallel")
                .anyMatch(p -> p.contains("موافقات في نفس الوقت"));
        assertThat(problems(flow(List.of(s, node("qq", "decision", "condition", Map.of("fact", "resourceCount", "op", "gte", "value", 1)), fin, ok),
                List.of(line("st", "qq", null), line("qq", "fin", "yes"), line("fin", "ok", "approved"))))).as("a question with one line").anyMatch(p -> p.contains("«نعم» وخط «لا»"));
        assertThat(problems(flow(List.of(s, approval("xx", true, place("FACILITIES_REVIEWER", "ANY")), ok), List.of(line("st", "xx", null), line("xx", "ok", "approved"))))).as("final needs APPROVE")
                .anyMatch(p -> p.contains("الاعتماد النهائي"));
        assertThat(problems(flow(List.of(s, approval("xx", true, place("APPROVER", "FIXED", "orgId", UUID.randomUUID().toString())), ok), List.of(line("st", "xx", null), line("xx", "ok", "approved"))))).as("unknown unit")
                .anyMatch(p -> p.contains("غير موجودة"));
        assertThat(problems(flow(List.of(s, rv, fin, ok), List.of(line("st", "rv", null), line("rv", "fin", "approved"), line("fin", "ok", "approved"))))).as("a good chart").isEmpty();
    }

    @Test
    @DisplayName("Simulation: the route for a unit, where each step goes and who holds it, what a rejection would do, and the units with no place")
    void simulation() {
        jdbc.sql("insert into org_responsibility(code, name) values ('r_sim', 'مسؤولية')").update();
        jdbc.sql("insert into org_responsibility_rule(responsibility_code, scope_org_id, responsible_org_id) values ('r_sim', :s, :o)").param("s", branch).param("o", branch).update();
        Map<String, Object> def = flow(
                List.of(node("st", "start"), approval("rv", false, place("FACILITIES_REVIEWER", "RESPONSIBLE", "responsibility", "r_sim")), approval("fin", true, place("APPROVER", "ANY")), node("ok", "end_approved"), node("no", "end_rejected")),
                List.of(line("st", "rv", null), line("rv", "fin", "approved"), line("rv", "no", "rejected"), line("fin", "ok", "approved")));
        requestType("NEW_RESERVATION", finalOnly(), null);
        Api admin = login("admin");
        String workflowId = admin.get("/workflows").body().get(0).path("id").asText();
        String version = admin.post("/workflows/" + workflowId + "/drafts", Map.of("definition", def)).body().path("id").asText();
        JsonNode sim = admin.post("/workflow-versions/" + version + "/simulate", Map.of("facts", Map.of("orgId", unit.toString()))).body();
        assertThat(sim.path("valid").asBoolean()).isTrue();
        assertThat(sim.path("outcome").asText()).isEqualTo("APPROVED");
        JsonNode step = sim.path("route").get(1);
        assertThat(step.path("node").asText()).isEqualTo("rv");
        assertThat(step.path("places").get(0).path("orgs").get(0).asText()).isEqualTo("جهة BRANCH");
        assertThat(step.path("places").get(0).path("holders").asInt()).isEqualTo(1);
        JsonNode no = admin.post("/workflow-versions/" + version + "/simulate", Map.of("facts", Map.of("orgId", unit.toString(), "rejected", List.of("rv")))).body();
        assertThat(no.path("outcome").asText()).isEqualTo("REJECTED");
        JsonNode cover = sim.path("coverage");
        assertThat(cover.get(0).path("unresolved").asInt()).as("the units outside the branch have no place").isGreaterThan(0);
        assertThat(cover.get(0).path("total").asInt()).isGreaterThan(cover.get(0).path("unresolved").asInt());
    }

    @Test
    @DisplayName("Responsibilities are the administrator's, and audited")
    void responsibilities() {
        Api admin = login("admin");
        JsonNode list = admin.post("/responsibilities", Map.of("name", "الموافقة على المرافق")).body();
        String code = "";
        for (JsonNode r : list) {
            if (r.path("name").asText().equals("الموافقة على المرافق")) {
                code = r.path("code").asText();
            }
        }
        assertThat(code).isNotBlank();
        assertThat(admin.put("/responsibilities/" + code + "/rules/" + branch, Map.of("responsibleOrgId", other.toString())).status()).isEqualTo(200);
        assertThat(jdbc.sql("select responsible_org_id from org_responsibility_rule where responsibility_code = :c and scope_org_id = :s").param("c", code).param("s", branch).query(UUID.class).single()).isEqualTo(other);
        assertThat(login("req").post("/responsibilities", Map.of("name", "محاولة")).status()).isEqualTo(403);
        assertThat(jdbc.sql("select count(*) from audit_event where entity_id = :c and action = 'RESPONSIBILITY_RULE_SET'").param("c", code).query(Long.class).single()).isEqualTo(1);
    }
}
