package ae.mover.hr;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * HR mirror settings. {@code settingsKey} protects the stored source credentials and belongs to TMRKZ alone (never the
 * key of another application). The interval is in seconds; TNQL's {@code TNQL_HR_SYNC_INTERVAL} is also seconds, so a
 * migrated value keeps its unit.
 */
@ConfigurationProperties(prefix = "tmrkz.hr")
public record HrProperties(
        String settingsKey,
        long syncIntervalSeconds,
        long maxRunSeconds,
        boolean schedulerEnabled,
        int fetchSize,
        int insertBatch,
        int retainSnapshots) {

    public HrProperties {
        if (syncIntervalSeconds <= 0) syncIntervalSeconds = 3600;
        if (maxRunSeconds <= 0) maxRunSeconds = 1800;
        if (fetchSize <= 0) fetchSize = 5000;
        if (insertBatch <= 0) insertBatch = 2000;
        if (retainSnapshots <= 0) retainSnapshots = 3;
    }
}
