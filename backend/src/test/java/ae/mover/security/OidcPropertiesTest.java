package ae.mover.security;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.mock.env.MockEnvironment;

/** Empty compose overrides must not erase or borrow the stable local platform provider (ADR-071). */
class OidcPropertiesTest {

    @Test
    void emptyEnterpriseAndPlatformOverridesKeepLocalProvider() {
        MockEnvironment env = new MockEnvironment()
                .withProperty("tmrkz.oidc.issuer", "")
                .withProperty("tmrkz.oidc.internal-base-url", "")
                .withProperty("tmrkz.oidc.client-id", "")
                .withProperty("tmrkz.oidc.client-secret", "")
                .withProperty("tmrkz.oidc.platform-issuer", "")
                .withProperty("tmrkz.oidc.platform-internal-base-url", "")
                .withProperty("tmrkz.oidc.platform-client-id", "")
                .withProperty("tmrkz.oidc.platform-client-secret", "")
                .withProperty("tmrkz.oidc.password-client-id", "tmrkz-platform-password")
                .withProperty("tmrkz.oidc.password-client-secret", "direct-secret");
        OidcProperties props = bind(env);
        assertThat(props.issuer()).isEqualTo("https://local.example/realms/tmrkz");
        assertThat(props.internalBaseUrl()).isEqualTo("https://local.example/realms/tmrkz");
        assertThat(props.clientId()).isEqualTo("tmrkz-web");
        assertThat(props.clientSecret()).isEqualTo("local-secret");
        assertThat(props.platformIssuer()).isEqualTo("https://local.example/realms/tmrkz");
        assertThat(props.platformTokenEndpoint()).startsWith("https://local.example/realms/tmrkz/");
        assertThat(props.passwordConfigured()).isTrue();
    }

    @Test
    void enterpriseAutomaticNeverBecomesPlatformDefault() {
        MockEnvironment env = new MockEnvironment()
                .withProperty("tmrkz.oidc.issuer", "https://enterprise.example/realms/master")
                .withProperty("tmrkz.oidc.internal-base-url", "https://enterprise.example/realms/master")
                .withProperty("tmrkz.oidc.client-id", "enterprise-tmrkz")
                .withProperty("tmrkz.oidc.client-secret", "enterprise-secret")
                .withProperty("tmrkz.oidc.platform-issuer", "")
                .withProperty("tmrkz.oidc.platform-internal-base-url", "")
                .withProperty("tmrkz.oidc.platform-client-id", "")
                .withProperty("tmrkz.oidc.platform-client-secret", "")
                .withProperty("tmrkz.oidc.password-client-id", "tmrkz-platform-password")
                .withProperty("tmrkz.oidc.password-client-secret", "direct-secret");
        OidcProperties props = bind(env);
        assertThat(props.issuer()).isEqualTo("https://enterprise.example/realms/master");
        assertThat(props.clientId()).isEqualTo("enterprise-tmrkz");
        assertThat(props.platformIssuer()).isEqualTo("https://local.example/realms/tmrkz");
        assertThat(props.platformClientId()).isEqualTo("tmrkz-web");
        assertThat(props.platformClientSecret()).isEqualTo("local-secret");
        assertThat(props.platformJwksEndpoint()).startsWith("https://local.example/realms/tmrkz/");
        assertThat(props.platformIssuer()).isNotEqualTo(props.issuer());
    }

    private OidcProperties bind(MockEnvironment env) {
        env.withProperty("tmrkz.oidc.local-issuer", "https://local.example/realms/tmrkz")
                .withProperty("tmrkz.oidc.local-internal-base-url", "https://local.example/realms/tmrkz")
                .withProperty("tmrkz.oidc.local-client-id", "tmrkz-web")
                .withProperty("tmrkz.oidc.local-client-secret", "local-secret")
                .withProperty("tmrkz.oidc.local-redirect-uri", "https://app.example/callback")
                .withProperty("tmrkz.oidc.local-post-logout-redirect-uri", "https://app.example/?signed-out=1")
                .withProperty("tmrkz.oidc.redirect-uri", "https://app.example/callback")
                .withProperty("tmrkz.oidc.post-logout-redirect-uri", "https://app.example/?signed-out=1")
                .withProperty("tmrkz.oidc.platform-accounts", "admin,developer");
        return Binder.get(env).bind("tmrkz.oidc", OidcProperties.class).get();
    }
}
