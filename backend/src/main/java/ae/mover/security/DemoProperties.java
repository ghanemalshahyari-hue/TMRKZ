package ae.mover.security;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Demonstration switches. {@code mode} enables quick user switching for the fictional dataset only and must be
 * false in any deployment holding real data. {@code seed} loads fictional organisations, facilities and people.
 */
@ConfigurationProperties(prefix = "mover.demo")
public record DemoProperties(boolean mode, boolean seed, String password) {
}
