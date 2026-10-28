package ae.mover.common;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class Times {

    public static final ZoneId DISPLAY_ZONE = ZoneId.of("Asia/Dubai");

    @Bean
    public Clock clock() {
        return Clock.systemUTC();
    }

    public static Instant parse(String value, String label) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return Instant.parse(value);
        } catch (DateTimeParseException e) {
            throw ApiException.validation("صيغة الوقت غير صحيحة في «" + label + "». استخدم ISO-8601 بتوقيت UTC.");
        }
    }

    /** Accepts a calendar date (YYYY-MM-DD) or an ISO instant, interpreted as a date in the display zone. */
    public static LocalDate parseDate(String value, String label) {
        try {
            if (value != null && value.contains("T")) {
                return Instant.parse(value).atZone(DISPLAY_ZONE).toLocalDate();
            }
            return LocalDate.parse(value);
        } catch (DateTimeParseException | NullPointerException e) {
            throw ApiException.validation("صيغة التاريخ غير صحيحة في «" + label + "».");
        }
    }

    public static Instant startOfDay(LocalDate day) {
        return day.atStartOfDay(DISPLAY_ZONE).toInstant();
    }

    public static String iso(Instant value) {
        return value == null ? null : value.toString();
    }
}
