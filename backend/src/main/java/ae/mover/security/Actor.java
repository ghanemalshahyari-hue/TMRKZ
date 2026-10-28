package ae.mover.security;

import java.util.UUID;

/** The authenticated person behind the current HTTP request. Always derived from the server-side session. */
public record Actor(UUID personId, String username, String displayName, String sessionId) {
}
