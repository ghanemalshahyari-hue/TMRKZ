package ae.mover;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.File;
import java.net.InetAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.unboundid.ldap.listener.InMemoryDirectoryServer;
import com.unboundid.ldap.listener.InMemoryDirectoryServerConfig;
import com.unboundid.ldap.listener.InMemoryListenerConfig;
import com.unboundid.ldap.listener.interceptor.InMemoryInterceptedSimpleBindRequest;
import com.unboundid.ldap.listener.interceptor.InMemoryOperationInterceptor;
import com.unboundid.ldap.sdk.Entry;
import com.unboundid.ldap.sdk.SimpleBindRequest;
import com.unboundid.util.ssl.KeyStoreKeyManager;
import com.unboundid.util.ssl.SSLUtil;
import com.unboundid.util.ssl.TrustAllTrustManager;

import ae.mover.security.DirectoryAuthenticator;
import ae.mover.security.DirectoryAuthenticator.DirectoryException;
import ae.mover.security.DirectoryAuthenticator.Failure;
import ae.mover.security.LdapProperties;

/**
 * ADR-100 (owner, 24 Nov 2026: «it should allow anyone who has LDAP credentials … every time the app fails as it asks for bind»):
 * sign-in with no service account against a fictional directory that behaves as Active Directory does — it accepts a simple bind
 * as {@code user@dnsDomain}, its people are {@code user} objects with {@code sAMAccountName}, {@code userPrincipalName} and a
 * binary {@code objectGUID}, and they have neither {@code uid} nor {@code entryUUID}. No Spring context or database is needed.
 */
class ActiveDirectoryDirectBindTest {

    private static final String BASE = "dc=corp,dc=test";
    private static final String STAFF = "ou=Staff," + BASE;
    private static final String PASSWORD = "Ad#Direct-Pass-1";
    private static final byte[] GUID = HexFormat.of().parseHex("0f1e2d3c4b5a69788796a5b4c3d2e1f0");
    /** As AD: a bind name user@domain names the entry with that userPrincipalName (or sAMAccountName@dnsDomain). */
    private static final Map<String, String> UPN = new ConcurrentHashMap<>();
    private static InMemoryDirectoryServer ldap;
    private static Path caDir;

    @BeforeAll
    static void directory() throws Exception {
        Path dir = Files.createTempDirectory("tmrkz-ad");
        File keystore = dir.resolve("ad.p12").toFile();
        String keytool = Path.of(System.getProperty("java.home"), "bin", "keytool").toString();
        DirectorySignInIT.run(keytool, "-genkeypair", "-alias", "ad", "-keyalg", "RSA", "-keysize", "2048", "-dname", "CN=localhost",
                "-ext", "SAN=dns:localhost,ip:127.0.0.1", "-validity", "2", "-keystore", keystore.getPath(),
                "-storetype", "PKCS12", "-storepass", "changeit", "-keypass", "changeit");
        caDir = Files.createDirectories(dir.resolve("ca"));
        DirectorySignInIT.run(keytool, "-exportcert", "-rfc", "-alias", "ad", "-keystore", keystore.getPath(), "-storetype", "PKCS12",
                "-storepass", "changeit", "-file", caDir.resolve("ad-ca.pem").toString());

        InMemoryDirectoryServerConfig cfg = new InMemoryDirectoryServerConfig(BASE);
        cfg.setSchema(null); // AD's own attribute names, without loading AD's schema
        cfg.setGenerateOperationalAttributes(false); // AD has no entryUUID: only the objectGUID of each entry
        cfg.addInMemoryOperationInterceptor(new InMemoryOperationInterceptor() {
            @Override
            public void processSimpleBindRequest(InMemoryInterceptedSimpleBindRequest request) {
                SimpleBindRequest r = request.getRequest();
                String name = r.getBindDN();
                if (name.indexOf('@') > 0 && name.indexOf('=') < 0) {
                    // an unknown account is AD's "invalid credentials" (49), as a wrong password is
                    String dn = UPN.getOrDefault(name.toLowerCase(Locale.ROOT), "cn=no such account," + BASE);
                    request.setRequest(new SimpleBindRequest(dn, r.getPassword().getValue()));
                }
            }
        });
        SSLUtil server = new SSLUtil(new KeyStoreKeyManager(keystore, "changeit".toCharArray(), "PKCS12", "ad"), new TrustAllTrustManager());
        cfg.setListenerConfigs(InMemoryListenerConfig.createLDAPConfig("ldap", InetAddress.getLoopbackAddress(), 0,
                server.createSSLSocketFactory()));
        ldap = new InMemoryDirectoryServer(cfg);
        ldap.add("dn: " + BASE, "objectClass: top", "objectClass: domain", "dc: corp");
        ldap.add("dn: " + STAFF, "objectClass: top", "objectClass: organizationalUnit", "ou: Staff");
        person("Jane Doe", "jdoe", "jdoe@corp.test", GUID);
        // a UPN prefix that differs from the account name: AD accepts sAMAccountName@dnsDomain as well
        person("Sam Other", "u12345", "sam.other@corp.test", HexFormat.of().parseHex("00112233445566778899aabbccddeeff"));
        ldap.startListening();
    }

    private static void person(String cn, String sam, String upn, byte[] guid) throws Exception {
        String dn = "cn=" + cn + "," + STAFF;
        Entry e = new Entry(dn);
        e.addAttribute("objectClass", "top", "person", "organizationalPerson", "user");
        e.addAttribute("cn", cn);
        e.addAttribute("displayName", cn);
        e.addAttribute("sAMAccountName", sam);
        e.addAttribute("userPrincipalName", upn);
        e.addAttribute("objectGUID", guid);
        e.addAttribute("MilNumber", "M-" + sam);
        e.addAttribute("userPassword", PASSWORD);
        ldap.add(e);
        UPN.put(upn.toLowerCase(Locale.ROOT), dn);
        UPN.put((sam + "@corp.test").toLowerCase(Locale.ROOT), dn);
    }

    @AfterAll
    static void stop() {
        if (ldap != null) {
            ldap.shutDown(true);
        }
    }

    private static LdapProperties props(String bindDn, String bindPassword, String user, String uuid, String cls, String emp,
                                        String usersDn, String domain) {
        return new LdapProperties("ldap://localhost:" + ldap.getListenPort(), true, bindDn, bindPassword, usersDn, user, uuid, emp,
                cls, caDir.toString(), null, 3000, 5000, 0, 0, null, null, null, null, null, null, null, domain);
    }

    /** What a VM's .env still says after the standard directory: uid / entryUUID / inetOrgPerson, and no service account. */
    private static LdapProperties leftover() {
        return props(null, null, "uid", "entryUUID", "inetOrgPerson", "employeeNumber", BASE, null);
    }

    @Test
    @DisplayName("ADR-100: with no service account and no domain, people bind as user@<DC= parts of the base>; that is configured")
    void derivedDomain() {
        LdapProperties p = leftover();
        assertThat(p.configured()).isTrue();
        assertThat(p.direct()).isTrue();
        assertThat(p.upnSuffix()).isEqualTo("corp.test");
        assertThat(LdapProperties.domainOf("OU=Staff,DC=Corp,DC=Example,DC=com")).isEqualTo("Corp.Example.com");
        assertThat(LdapProperties.domainOf("ou=people,o=org")).isNull();
        // an explicit LDAP_DOMAIN wins; a complete service account keeps the search-first profile (ADR-016) unchanged
        assertThat(props(null, null, "uid", "entryUUID", "inetOrgPerson", "employeeNumber", BASE, "corp.example").upnSuffix())
                .isEqualTo("corp.example");
        LdapProperties service = props("cn=svc," + BASE, "secret", "uid", "entryUUID", "inetOrgPerson", "employeeNumber", BASE, null);
        assertThat(service.direct()).isFalse();
        assertThat(service.configured()).isTrue();
        assertThatThrownBy(() -> props(null, null, "uid", "entryUUID", "inetOrgPerson", "employeeNumber", BASE, "bad domain!"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("ADR-100: AD signs in with its own names even when the settings still name uid/entryUUID/inetOrgPerson")
    void leftoverStandardNames() throws Exception {
        DirectoryAuthenticator auth = new DirectoryAuthenticator(leftover());
        DirectoryAuthenticator.DirectoryUser u = auth.authenticate("jdoe", PASSWORD);
        assertThat(u.uuid()).isEqualTo(HexFormat.of().formatHex(GUID));
        assertThat(u.username()).isEqualTo("jdoe");
        assertThat(u.displayName()).isEqualTo("Jane Doe");
        // the forms people type: the NetBIOS-prefixed login and user@domain are the same person
        assertThat(auth.authenticate("CORP\\jdoe", PASSWORD).uuid()).isEqualTo(u.uuid());
        assertThat(auth.authenticate("jdoe@corp.test", PASSWORD).uuid()).isEqualTo(u.uuid());
        assertThat(auth.authenticate("jdoe@CORP.TEST", PASSWORD).uuid()).isEqualTo(u.uuid());
        // an account whose UPN prefix differs from its sAMAccountName
        assertThat(auth.authenticate("u12345", PASSWORD).username()).isEqualTo("u12345");
        // step-up: the same bind again, and the entry must carry the linked identifier
        assertThat(auth.reauthenticate(u.uuid(), "jdoe", PASSWORD).uuid()).isEqualTo(u.uuid());
        assertThatThrownBy(() -> auth.reauthenticate("00112233445566778899aabbccddeeff", "jdoe", PASSWORD))
                .isInstanceOfSatisfying(DirectoryException.class, e -> assertThat(e.failure()).isEqualTo(Failure.INVALID_CREDENTIALS));
    }

    @Test
    @DisplayName("ADR-100: a wrong password, an unknown login, another domain and an empty password get the one refusal")
    void refusals() {
        DirectoryAuthenticator auth = new DirectoryAuthenticator(leftover());
        for (String[] c : new String[][]{{"jdoe", "wrong"}, {"nobody", PASSWORD}, {"jdoe@other.test", PASSWORD}, {"jdoe", ""},
                {"jd)(uid=*", PASSWORD}}) {
            assertThatThrownBy(() -> auth.authenticate(c[0], c[1]))
                    .isInstanceOfSatisfying(DirectoryException.class, e -> assertThat(e.failure()).isEqualTo(Failure.INVALID_CREDENTIALS));
        }
    }

    @Test
    @DisplayName("ADR-100: the Active Directory preset (sAMAccountName / objectGUID / user, MilNumber) with no service account")
    void adPreset() throws Exception {
        DirectoryAuthenticator auth = new DirectoryAuthenticator(
                props(null, null, "sAMAccountName", "objectGUID", "user", "MilNumber", STAFF, "corp.test"));
        DirectoryAuthenticator.DirectoryUser u = auth.authenticate("jdoe", PASSWORD);
        assertThat(u.uuid()).isEqualTo(HexFormat.of().formatHex(GUID));
        assertThat(u.employeeNumber()).isEqualTo("M-jdoe");
        assertThat(auth.reauthenticate(u.uuid(), "jdoe", PASSWORD).username()).isEqualTo("jdoe");
    }
}
