package ae.mover.system;

import java.util.Map;
import java.util.function.Supplier;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import ae.mover.common.ApiException;
import ae.mover.common.ErrorCode;
import ae.mover.common.Hashing;
import ae.mover.common.Json;
import ae.mover.security.Actor;

/**
 * Idempotency for commands a client may resend (submit, decision, close, completion, export).
 *
 * <p>The key row is inserted in the same transaction as the command. A concurrent duplicate blocks on the primary
 * key until the first transaction finishes; if it committed, the duplicate sees the stored record and replays the
 * current result without executing again; if it rolled back, the duplicate executes normally. Reusing a key with a
 * different body or operation is rejected.
 */
@Service
public class IdempotencyService {

    private final JdbcClient jdbc;
    private final Json json;

    public IdempotencyService(JdbcClient jdbc, Json json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public <T> T run(Actor actor, String key, String operation, Object body, Supplier<T> action, Supplier<T> replay) {
        if (key == null || key.isBlank()) {
            return action.get();
        }
        if (key.length() > 100) {
            throw ApiException.validation("مفتاح التكرار أطول من المسموح.");
        }
        String hash = Hashing.sha256(operation + "\n" + json.canonical(body == null ? Map.of() : body));
        int inserted = jdbc.sql("""
                insert into idempotency_record(person_id, idem_key, operation, request_hash)
                values (:p, :k, :op, :h) on conflict do nothing""")
                .param("p", actor.personId()).param("k", key).param("op", operation).param("h", hash).update();
        if (inserted == 0) {
            Map<String, Object> existing = jdbc.sql("select operation, request_hash, status_code from idempotency_record where person_id = :p and idem_key = :k")
                    .param("p", actor.personId()).param("k", key).query().singleRow();
            if (!operation.equals(existing.get("operation")) || !hash.equals(existing.get("request_hash"))) {
                throw new ApiException(ErrorCode.IDEMPOTENCY_CONFLICT,
                        "استُخدم مفتاح التكرار نفسه مع بيانات مختلفة. أنشئ مفتاحاً جديداً لهذا الإجراء.");
            }
            return replay.get();
        }
        T result = action.get();
        jdbc.sql("update idempotency_record set status_code = 200, response = cast(:r as jsonb) where person_id = :p and idem_key = :k")
                .param("r", json.write(Map.of("operation", operation, "completed", true)))
                .param("p", actor.personId()).param("k", key).update();
        return result;
    }
}
