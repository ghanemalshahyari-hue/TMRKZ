package ae.mover.security;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "mover.security")
public record SecurityProperties(
        int sessionIdleMinutes,
        int sessionAbsoluteHours,
        boolean secureCookie,
        int maxFailedLogins,
        int lockMinutes) {

    public SecurityProperties {
        if (sessionIdleMinutes <= 0) sessionIdleMinutes = 30;
        if (sessionAbsoluteHours <= 0) sessionAbsoluteHours = 12;
        if (maxFailedLogins <= 0) maxFailedLogins = 5;
        if (lockMinutes <= 0) lockMinutes = 15;
    }
}
