package ae.mover.authz;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * OpenFGA settings (TMRKZ's own service and store, never another application's). {@code apiToken} is the preshared key
 * of the OpenFGA server; {@code storeId} is optional — when empty the store named {@code storeName} is created once and
 * recorded in the database. The authorisation model id is not configured: it is pinned per published policy version.
 */
@ConfigurationProperties(prefix = "tmrkz.authz")
public record AuthzProperties(
        String apiUrl,
        String apiToken,
        String storeId,
        String storeName,
        int timeoutMs,
        long pollMs,
        long reconcileMs,
        boolean syncEnabled) {

    public AuthzProperties {
        if (storeName == null || storeName.isBlank()) storeName = "tmrkz";
        if (timeoutMs <= 0) timeoutMs = 5000;
        if (pollMs <= 0) pollMs = 2000;
        if (reconcileMs <= 0) reconcileMs = 300_000;
    }

    public boolean configured() {
        return apiUrl != null && !apiUrl.isBlank();
    }
}
