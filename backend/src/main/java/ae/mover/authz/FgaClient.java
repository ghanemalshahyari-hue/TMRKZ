package ae.mover.authz;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.stereotype.Component;

import com.fasterxml.jackson.databind.JsonNode;

import ae.mover.common.Json;

/** Minimal OpenFGA HTTP API client (stores, models, tuple writes, checks). Every call has a timeout. */
@Component
public class FgaClient {

    /** OpenFGA could not be reached or refused the call; decisions depending on it must be refused. */
    public static class FgaException extends RuntimeException {
        public FgaException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    public record Tuple(String object, String relation, String subject, Map<String, Object> condition) {

        Map<String, Object> key() {
            Map<String, Object> k = new LinkedHashMap<>();
            k.put("user", subject);
            k.put("relation", relation);
            k.put("object", object);
            if (condition != null) {
                k.put("condition", Map.of("name", AuthzModel.CONDITION, "context", condition));
            }
            return k;
        }
    }

    private final AuthzProperties props;
    private final Json json;
    private final HttpClient http;

    public FgaClient(AuthzProperties props, Json json) {
        this.props = props;
        this.json = json;
        this.http = HttpClient.newBuilder().connectTimeout(Duration.ofMillis(Math.min(props.timeoutMs(), 3000))).build();
    }

    public boolean configured() {
        return props.configured();
    }

    public String findOrCreateStore(String name) {
        JsonNode stores = call("GET", "/stores?page_size=100", null).path("stores");
        for (JsonNode s : stores) {
            if (name.equals(s.path("name").asText()) && s.path("deleted_at").isMissingNode()) {
                return s.path("id").asText();
            }
        }
        return call("POST", "/stores", Map.of("name", name)).path("id").asText();
    }

    public String createStore(String name) {
        return call("POST", "/stores", Map.of("name", name)).path("id").asText();
    }

    public void deleteStore(String storeId) {
        call("DELETE", "/stores/" + storeId, null);
    }

    public boolean storeExists(String storeId) {
        try {
            call("GET", "/stores/" + storeId, null);
            return true;
        } catch (FgaException e) {
            if (e.getMessage() != null && e.getMessage().contains("HTTP 404")) {
                return false;
            }
            throw e;
        }
    }

    public String writeModel(String storeId, Map<String, Object> model) {
        return call("POST", "/stores/" + storeId + "/authorization-models", model).path("authorization_model_id").asText();
    }

    public boolean modelExists(String storeId, String modelId) {
        try {
            return call("GET", "/stores/" + storeId + "/authorization-models/" + modelId, null).has("authorization_model");
        } catch (FgaException e) {
            return false;
        }
    }

    /** Writes and deletes in one transaction (at most 100 tuples together, the server's default limit). */
    public void write(String storeId, String modelId, List<Tuple> writes, List<Tuple> deletes) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("authorization_model_id", modelId);
        if (!writes.isEmpty()) {
            body.put("writes", Map.of("tuple_keys", writes.stream().map(Tuple::key).toList()));
        }
        if (!deletes.isEmpty()) {
            List<Map<String, Object>> keys = new ArrayList<>();
            for (Tuple t : deletes) {
                keys.add(Map.of("user", t.subject(), "relation", t.relation(), "object", t.object()));
            }
            body.put("deletes", Map.of("tuple_keys", keys));
        }
        call("POST", "/stores/" + storeId + "/write", body);
    }

    /** A check at higher consistency (no cached answer), with contextual tuples and condition context. */
    public boolean check(String storeId, String modelId, String user, String relation, String object,
                         List<Tuple> contextual, Map<String, Object> context) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("tuple_key", Map.of("user", user, "relation", relation, "object", object));
        body.put("authorization_model_id", modelId);
        body.put("consistency", "HIGHER_CONSISTENCY");
        if (!contextual.isEmpty()) {
            body.put("contextual_tuples", Map.of("tuple_keys", contextual.stream().map(Tuple::key).toList()));
        }
        body.put("context", context);
        return call("POST", "/stores/" + storeId + "/check", body).path("allowed").asBoolean(false);
    }

    private JsonNode call(String method, String path, Object body) {
        if (!props.configured()) {
            throw new FgaException("OpenFGA is not configured", null);
        }
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(props.apiUrl().replaceAll("/+$", "") + path))
                .timeout(Duration.ofMillis(props.timeoutMs()))
                .header("Content-Type", "application/json");
        if (props.apiToken() != null && !props.apiToken().isBlank()) {
            b.header("Authorization", "Bearer " + props.apiToken());
        }
        b.method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(json.write(body), StandardCharsets.UTF_8));
        HttpResponse<String> res;
        try {
            res = http.send(b.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new FgaException("OpenFGA unreachable: " + e.getClass().getSimpleName(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new FgaException("OpenFGA call interrupted", e);
        }
        if (res.statusCode() / 100 != 2) {
            String text = res.body() == null ? "" : res.body();
            throw new FgaException("OpenFGA HTTP " + res.statusCode() + ": " + text.substring(0, Math.min(400, text.length())), null);
        }
        return json.tree(res.body() == null || res.body().isBlank() ? "{}" : res.body());
    }
}
