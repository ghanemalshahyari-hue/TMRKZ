package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import com.fasterxml.jackson.core.type.TypeReference;

import ae.mover.access.AccessContext;
import ae.mover.access.AccessService;
import ae.mover.access.Permission;
import ae.mover.authz.Authorization;
import ae.mover.authz.AuthzSync;
import ae.mover.authz.FgaClient;
import ae.mover.security.Actor;

/**
 * ADR-103 (VM incident report of 24–25 Nov 2026): the authorisation decision path with fictional identities. The business
 * database (membership, delegation, responsibility seats, unit grants, duty permits — {@code GrantSource}) is the source of
 * truth; {@code authz_tuple} is only the mirror of what OpenFGA holds. An open-ended grant stores {@code valid_to = valid_from}
 * with {@code open_ended = true} in its condition (AuthzTuples), which a reader of the mirror can mistake for «expired»; these
 * tests prove it is valid in both deciders, and that editing the mirror by hand neither grants nor survives the reconciliation.
 */
class AuthzMirrorIT extends IntegrationTest {

    @Autowired
    AuthzSync sync;
    @Autowired
    Authorization authorization;
    @Autowired
    AccessService access;
    @Autowired
    FgaClient fga;

    UUID root;

    @BeforeEach
    void fixtures() {
        root = org("ROOT", null);
    }

    private Map<String, Object> holderCondition(UUID person) {
        String c = jdbc.sql("select condition::text from authz_tuple where person_id = :p and relation = 'holder'")
                .param("p", person).query(String.class).single();
        try {
            return JSON.readValue(c, new TypeReference<Map<String, Object>>() { });
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private AccessContext decided(UUID person) {
        return access.load(new Actor(person, null, null, null), Instant.now()).withConfirmer(authorization);
    }

    private long mirrorRows(UUID person) {
        return jdbc.sql("select count(*) from authz_tuple where person_id = :p or subject = :s")
                .param("p", person).param("s", "user:" + person).query(Long.class).single();
    }

    @Test
    @DisplayName("AZ-1: an open-ended grant from 2024 stays valid — its mirror row reads valid_to = valid_from by design; the database and OpenFGA both allow")
    void openEndedGrantStaysValid() {
        UUID admin = person("oe", "SYSTEM_ADMIN", root);
        jdbc.sql("update membership set valid_from = '2024-01-01T00:00:00Z' where person_id = :p").param("p", admin).update();
        sync.run(true);

        Map<String, Object> c = holderCondition(admin);
        assertThat(c.get("open_ended")).as("open-ended flag").isEqualTo(true);
        assertThat(c.get("valid_to")).as("the value the incident report read as an expiry").isEqualTo(c.get("valid_from"));
        assertThat(Instant.parse((String) c.get("valid_to"))).isBefore(Instant.now());

        AccessContext ctx = decided(admin);
        assertThat(access.load(new Actor(admin, null, null, null), Instant.now()).canEverywhere(Permission.MANAGE_ACCESS))
                .as("database decision").isTrue();
        assertThat(authorization.everywhere(ctx, Permission.MANAGE_ACCESS)).as("OpenFGA's own answer").isTrue();
        assertThat(ctx.canEverywhere(Permission.MANAGE_ACCESS)).as("both deciders together").isTrue();
        assertThat(login("oe").get("/access/status").status()).as("an HTTP action needing global access management").isEqualTo(200);
    }

    @Test
    @DisplayName("AZ-2: a dated grant that has ended is refused by the database and by OpenFGA; one still running is allowed by both")
    void datedGrants() {
        UUID ended = person("ended", "SYSTEM_ADMIN", root);
        jdbc.sql("update membership set valid_to = :t, ended_reason = 'انتهت مدة الاختبار' where person_id = :p")
                .param("t", java.sql.Timestamp.from(Instant.now().minus(1, ChronoUnit.DAYS))).param("p", ended).update();
        UUID running = person("running", "SYSTEM_ADMIN", root);
        jdbc.sql("update membership set valid_to = :t where person_id = :p")
                .param("t", java.sql.Timestamp.from(Instant.now().plus(30, ChronoUnit.DAYS))).param("p", running).update();
        sync.run(true);

        assertThat(mirrorRows(ended)).as("an ended grant leaves nothing in the mirror").isZero();
        assertThat(authorization.everywhere(decided(ended), Permission.MANAGE_ACCESS)).as("OpenFGA, ended").isFalse();
        assertThat(decided(ended).canEverywhere(Permission.MANAGE_ACCESS)).isFalse();
        Res refused = login("ended").get("/access/status");
        assertThat(refused.status()).isEqualTo(403);
        assertThat(refused.code()).isEqualTo("NO_EFFECTIVE_ACCESS");

        assertThat(holderCondition(running).get("open_ended")).isEqualTo(false);
        assertThat(authorization.everywhere(decided(running), Permission.MANAGE_ACCESS)).as("OpenFGA, running").isTrue();
        assertThat(login("running").get("/access/status").status()).isEqualTo(200);
    }

    @Test
    @DisplayName("AZ-3: the VM's manual mirror edits (validity pushed to 2099, a holder copied to another person, even written into OpenFGA) grant nothing and are undone by the full reconciliation")
    void mirrorEditsHaveNoAuthority() {
        UUID admin = person("src", "SYSTEM_ADMIN", root);
        UUID copy = person("copy", "SYSTEM_ADMIN", root);
        // the copy's own grant has ended: it holds nothing in the business database
        jdbc.sql("update membership set valid_to = :t, ended_reason = 'انتهت' where person_id = :p")
                .param("t", java.sql.Timestamp.from(Instant.now().minus(1, ChronoUnit.HOURS))).param("p", copy).update();
        sync.run(true);
        Map<String, Object> before = holderCondition(admin);
        String holder = jdbc.sql("select object from authz_tuple where person_id = :p and relation = 'holder'")
                .param("p", admin).query(String.class).single();

        // 1) the incident's UPDATE: every holder whose valid_to is in the past pushed to 2099 (this includes open-ended grants)
        int pushed = jdbc.sql("""
                update authz_tuple set condition = jsonb_set(condition, '{valid_to}', '"2099-12-31T23:59:59Z"')
                where object like 'grant:%' and relation = 'holder' and (condition->>'valid_to')::timestamptz < now()
                  and person_id = :p""").param("p", admin).update();
        assertThat(pushed).as("the open-ended grant matched the incident's «expired» query").isEqualTo(1);
        // 2) the incident's copy: the administrator's holder row for another person, ON CONFLICT DO NOTHING
        int copied = jdbc.sql("""
                insert into authz_tuple(object, relation, subject, condition, person_id, kind)
                select object, relation, :s, condition, :p, kind from authz_tuple where person_id = :a and relation = 'holder'
                on conflict do nothing""").param("s", "user:" + copy).param("p", copy).param("a", admin).update();
        assertThat(copied).isEqualTo(1);
        // worse than the incident: the copied holder also written into OpenFGA itself
        AuthzSync.Ready ready = sync.ready();
        fga.write(ready.storeId(), ready.modelId(), List.of(new FgaClient.Tuple(holder, "holder", "user:" + copy, before)), List.of());

        // the business database decides first: the copy has no grant, so nothing is allowed whatever the mirror or OpenFGA hold
        assertThat(decided(copy).canEverywhere(Permission.MANAGE_ACCESS)).as("database decides first").isFalse();
        Res refused = login("copy").get("/access/status");
        assertThat(refused.status()).isEqualTo(403);
        assertThat(refused.code()).isEqualTo("NO_EFFECTIVE_ACCESS");

        // the full reconciliation (run every few minutes in production) compares the mirror with the grants and undoes both edits
        sync.run(true);
        assertThat(holderCondition(admin)).as("the administrator's row is back to the computed condition").isEqualTo(before);
        assertThat(mirrorRows(copy)).as("the copied rows are gone").isZero();
        assertThat(authorization.everywhere(decided(copy), Permission.MANAGE_ACCESS)).as("removed from OpenFGA too").isFalse();
        assertThat(authorization.everywhere(decided(admin), Permission.MANAGE_ACCESS)).isTrue();
        assertThat(jdbc.sql("select last_error from authz_sync_state where id = 1").query(String.class).optional().orElse(null))
                .as("the reconciliation tolerated the tuples OpenFGA did not hold").isNull();
    }
}
