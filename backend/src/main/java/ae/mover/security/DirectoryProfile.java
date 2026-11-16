package ae.mover.security;

/**
 * What the directory states about a person at sign-in, beyond who they are (ADR-068): the employee number, and — when the
 * installation names the attributes or claims that carry them — rank, position, the current Unit ID, its name, and the main
 * Unit ID. Each value is as received, trimmed, at most {@value #MAX} characters, or null. It proves nothing and grants nothing:
 * the unit is joined to TMRKZ's tree by its Unit ID only, and Oracle decides once it is in force. {@code employment}: the sign-in
 * path reads at least one employment attribute or claim (otherwise what an earlier sign-in recorded is kept).
 */
public record DirectoryProfile(String employeeNumber, String rank, String position, String unitId, String unitName, String mainUnitId,
                               boolean employment) {

    public static final int MAX = 200;
    public static final DirectoryProfile EMPTY = new DirectoryProfile(null, null, null, null, null, null, false);

    public DirectoryProfile {
        employeeNumber = clean(employeeNumber);
        rank = clean(rank);
        position = clean(position);
        unitId = clean(unitId);
        unitName = clean(unitName);
        mainUnitId = clean(mainUnitId);
    }

    /** Trimmed text without control characters, cut to {@value #MAX}; blank is null. */
    public static String clean(String value) {
        if (value == null) {
            return null;
        }
        String s = value.codePoints().filter(c -> !Character.isISOControl(c))
                .collect(StringBuilder::new, StringBuilder::appendCodePoint, StringBuilder::append).toString().trim();
        if (s.isEmpty()) {
            return null;
        }
        return s.length() > MAX ? s.substring(0, MAX) : s;
    }
}
