package ae.mover.common;

import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;

import org.springframework.core.NestedExceptionUtils;
import org.springframework.dao.DataAccessException;

/** Small JDBC helpers. Id lists are passed as comma-separated text and cast in SQL to avoid driver-specific arrays. */
public final class Db {

    private Db() {
    }

    public static OffsetDateTime ts(Instant instant) {
        return instant == null ? null : instant.atOffset(ZoneOffset.UTC);
    }

    public static Instant instant(ResultSet rs, String column) throws SQLException {
        OffsetDateTime value = rs.getObject(column, OffsetDateTime.class);
        return value == null ? null : value.toInstant();
    }

    /** Normalises timestamp values returned by generic row mapping (Timestamp, OffsetDateTime or Instant). */
    public static Instant toInstant(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Instant i) {
            return i;
        }
        if (value instanceof OffsetDateTime o) {
            return o.toInstant();
        }
        if (value instanceof java.sql.Timestamp t) {
            return t.toInstant();
        }
        throw new IllegalArgumentException("Unsupported timestamp value " + value.getClass());
    }

    public static String iso(ResultSet rs, String column) throws SQLException {
        Instant value = instant(rs, column);
        return value == null ? null : value.toString();
    }

    public static UUID uuid(ResultSet rs, String column) throws SQLException {
        return rs.getObject(column, UUID.class);
    }

    public static List<String> strings(ResultSet rs, String column) throws SQLException {
        Array array = rs.getArray(column);
        if (array == null) {
            return List.of();
        }
        Object[] values = (Object[]) array.getArray();
        List<String> out = new ArrayList<>(values.length);
        for (Object v : values) {
            out.add(String.valueOf(v));
        }
        return out;
    }

    /** Comma-separated ids for use as {@code = any(string_to_array(:p, ',')::uuid[])}. */
    public static String ids(Collection<UUID> ids) {
        if (ids == null || ids.isEmpty()) {
            return "";
        }
        return ids.stream().map(UUID::toString).collect(Collectors.joining(","));
    }

    public static String texts(Collection<String> values) {
        if (values == null || values.isEmpty()) {
            return "";
        }
        return String.join(",", values);
    }

    public static Optional<String> sqlState(DataAccessException e) {
        Throwable cause = NestedExceptionUtils.getMostSpecificCause(e);
        while (cause != null) {
            if (cause instanceof SQLException sql && sql.getSQLState() != null) {
                return Optional.of(sql.getSQLState());
            }
            cause = cause.getCause();
        }
        return Optional.empty();
    }

    public static boolean isExclusionViolation(DataAccessException e) {
        return sqlState(e).filter("23P01"::equals).isPresent();
    }

    public static boolean isCheckViolation(DataAccessException e) {
        return sqlState(e).filter("23514"::equals).isPresent();
    }
}
