package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Connection;
import java.sql.SQLException;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;

import ae.mover.hr.HrConnectionFactory;
import ae.mover.hr.HrSourceAdapter;
import ae.mover.security.DirectoryProfile;
import ae.mover.security.EmploymentContextResolver;
import ae.mover.security.IdentityService;
import ae.mover.security.OidcClient;

/**
 * Proves that the login path never contacts Oracle when HR is not in force.
 * The factory bean throws on any call; a successful sign-in with zero calls is the proof.
 */
@Import(OracleAbsenceIT.NeverConnectFactory.class)
class OracleAbsenceIT extends IntegrationTest {

    @TestConfiguration
    static class NeverConnectFactory {
        static final AtomicInteger CALLS = new AtomicInteger();

        @Bean
        @Primary
        HrConnectionFactory failOnConnect() {
            return new HrConnectionFactory() {
                @Override
                public Connection connect(HrSourceAdapter.Config cfg) throws SQLException {
                    CALLS.incrementAndGet();
                    throw new SQLException("Oracle must not be contacted during login");
                }
            };
        }
    }

    private static final String ISSUER = "http://idp.test/realms/tmrkz";

    @Autowired IdentityService identities;
    @Autowired EmploymentContextResolver employment;

    UUID root;

    @BeforeEach
    void clean() {
        NeverConnectFactory.CALLS.set(0);
        jdbc.sql("delete from hr_sync_issue").update();
        jdbc.sql("delete from hr_unit").update();
        jdbc.sql("delete from hr_person").update();
        jdbc.sql("delete from hr_snapshot_scope").update();
        jdbc.sql("delete from hr_snapshot").update();
        jdbc.sql("delete from hr_sync_run").update();
        jdbc.sql("delete from hr_mapping_version").update();
        jdbc.sql("delete from hr_source").update();
        root = org("OA-ROOT", null);
        person("oa-admin", "SYSTEM_ADMIN", root);
    }

    private OidcClient.Identity signIn(String subject, String account) {
        return new OidcClient.Identity(ISSUER, subject, account, "دخول " + account, account,
                Instant.now(), null, "LOGIN", "/", null, false,
                new DirectoryProfile(null, null, null, null, null, null, true));
    }

    @Test
    @DisplayName("ORACLE-ABSENCE: mode is LDAP and login succeeds without any Oracle connection")
    void loginWithoutOracle() {
        assertThat(employment.mode()).isEqualTo(EmploymentContextResolver.Source.LDAP);

        String sub = "oa-sub-" + sfx;
        String acct = ("oa-user-" + sfx).toLowerCase();
        UUID person = identities.resolve(signIn(sub, acct));
        assertThat(person).isNotNull();
        assertThat(NeverConnectFactory.CALLS.get())
                .as("Oracle connection factory must not be called during login")
                .isZero();

        // second login — same person, still no Oracle call
        UUID same = identities.resolve(signIn(sub, acct));
        assertThat(same).isEqualTo(person);
        assertThat(NeverConnectFactory.CALLS.get()).isZero();

        EmploymentContextResolver.Context ctx = employment.of(person);
        assertThat(ctx.source()).isEqualTo(EmploymentContextResolver.Source.LDAP);
    }

    @Test
    @DisplayName("ORACLE-ABSENCE: HR source enabled but no published snapshot keeps mode LDAP")
    void enabledSourceNoSnapshot() {
        jdbc.sql("""
                insert into hr_source(id, name, enabled, unit_view, person_view)
                values (:id, :n, true, 'hr.units_v', 'hr.people_v')""")
                .param("id", UUID.randomUUID()).param("n", "مصدر HR " + sfx).update();

        assertThat(employment.mode())
                .as("source enabled but no published snapshot → still LDAP")
                .isEqualTo(EmploymentContextResolver.Source.LDAP);

        UUID person = identities.resolve(signIn("oa-sub2-" + sfx, ("oa-user2-" + sfx).toLowerCase()));
        assertThat(person).isNotNull();
        assertThat(NeverConnectFactory.CALLS.get()).isZero();
    }
}
