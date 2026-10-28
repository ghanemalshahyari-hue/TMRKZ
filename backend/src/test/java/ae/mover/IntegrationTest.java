package ae.mover;

import java.io.ByteArrayOutputStream;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.support.TransactionTemplate;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import ae.mover.common.Db;
import ae.mover.common.Times;
import ae.mover.forms.FormService;
import ae.mover.outbox.OutboxProcessor;
import ae.mover.security.AuthService;
import ae.mover.system.Bootstrap;
import ae.mover.workflow.WorkflowService;

/**
 * Base for acceptance tests: a real PostgreSQL database, the real application on a random port, and real HTTP
 * calls with server-side sessions. Each test builds its own uniquely-coded fixtures so tests never share state.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "spring.datasource.url=${MOVER_TEST_DB_URL:jdbc:postgresql://localhost:5433/mover_test}",
        "spring.datasource.username=${MOVER_TEST_DB_USER:mover}",
        "spring.datasource.password=${MOVER_TEST_DB_PASSWORD:devpass}",
        "mover.storage.root=${java.io.tmpdir}/mover-test-files",
        "mover.map.root=../map-packages",
        "mover.signature.attestation-key=test-attestation-key-0123456789abcdef-0123",
        "mover.demo.mode=false",
        "mover.demo.seed=false",
        "mover.outbox.enabled=false"})
public abstract class IntegrationTest {

    protected static final String PASSWORD = "Test#Pass-2026";
    protected static final ObjectMapper JSON = new ObjectMapper();

    @Value("${local.server.port}")
    protected int port;
    @Autowired
    protected JdbcClient jdbc;
    @Autowired
    protected AuthService auth;
    @Autowired
    protected FormService forms;
    @Autowired
    protected WorkflowService workflows;
    @Autowired
    protected TransactionTemplate tx;
    @Autowired
    protected OutboxProcessor outbox;

    protected final String sfx = UUID.randomUUID().toString().substring(0, 8);
    private static String passwordHash;

    // ---- fixtures -----------------------------------------------------------------------------------

    protected UUID org(String code, UUID parent) {
        UUID id = UUID.randomUUID();
        jdbc.sql("insert into organization(id, code, name, parent_id, valid_from) values (:id, :c, :n, :p, '2026-01-01T00:00:00Z')")
                .param("id", id).param("c", code + "-" + sfx).param("n", "جهة " + code).param("p", parent).update();
        return id;
    }

    protected UUID site(String code, UUID parent, UUID responsibleOrg) {
        UUID id = UUID.randomUUID();
        jdbc.sql("insert into site(id, code, name, kind, parent_id, lat, lng) values (:id, :c, :n, 'مرفق', :p, 25.2, 55.3)")
                .param("id", id).param("c", code + "-" + sfx).param("n", "موقع " + code).param("p", parent).update();
        jdbc.sql("insert into site_responsibility(id, site_id, organization_id, valid_from) values (:id, :s, :o, '2026-01-01T00:00:00Z')")
                .param("id", UUID.randomUUID()).param("s", id).param("o", responsibleOrg).update();
        return id;
    }

    protected UUID resource(String code, UUID site, UUID parent, int handoverMinutes) {
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into resource(id, site_id, code, name, kind, policy, parent_resource_id, handover_minutes)
                values (:id, :s, :c, :n, 'مورد', 'EXCLUSIVE', :p, :h)""")
                .param("id", id).param("s", site).param("c", code + "-" + sfx).param("n", "مورد " + code)
                .param("p", parent).param("h", handoverMinutes).update();
        return id;
    }

    protected UUID person(String username, String role, UUID org) {
        return person(username, role, org, null);
    }

    protected UUID person(String username, String role, UUID org, UUID siteScope) {
        if (passwordHash == null) {
            passwordHash = auth.hash(PASSWORD);
        }
        UUID id = UUID.randomUUID();
        jdbc.sql("insert into person(id, employee_no, display_name, username, password_hash) values (:id, :e, :n, :u, :h)")
                .param("id", id).param("e", "T-" + username + "-" + sfx).param("n", "شخص " + username)
                .param("u", username + "-" + sfx).param("h", passwordHash).update();
        membership(id, role, org, siteScope);
        return id;
    }

    protected UUID membership(UUID person, String role, UUID org, UUID siteScope) {
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into membership(id, person_id, organization_id, role_code, site_scope_id, valid_from)
                values (:id, :p, :o, :r, :s, '2026-01-01T00:00:00Z')""")
                .param("id", id).param("p", person).param("o", org).param("r", role).param("s", siteScope).update();
        return id;
    }

    /** Creates a request type with its own published form and workflow (stages: role|orgFrom|mode lists). */
    protected String requestType(String kind, Map<String, Object> workflow, Map<String, Object> form) {
        String code = "T_" + sfx.toUpperCase() + "_" + (int) (Math.random() * 100000);
        tx.executeWithoutResult(s -> {
            jdbc.sql("insert into request_type(code, name, kind, multi_sites, multi_orgs, sort_order) values (:c, :n, :k, true, true, 100)")
                    .param("c", code).param("n", "نوع اختبار " + code).param("k", kind).update();
            UUID formId = UUID.randomUUID();
            jdbc.sql("insert into form_definition(id, request_type_code) values (:id, :t)").param("id", formId).param("t", code).update();
            UUID fv = UUID.randomUUID();
            jdbc.sql("insert into form_version(id, form_id, version, status, schema) values (:id, :f, 1, 'DRAFT', cast(:s as jsonb))")
                    .param("id", fv).param("f", formId).param("s", write(form == null ? Bootstrap.defaultForm() : form)).update();
            forms.publishInternal(null, fv, null);
            UUID wf = UUID.randomUUID();
            jdbc.sql("insert into workflow_definition(id, request_type_code) values (:id, :t)").param("id", wf).param("t", code).update();
            UUID wv = UUID.randomUUID();
            jdbc.sql("insert into workflow_version(id, workflow_id, version, status, definition) values (:id, :w, 1, 'DRAFT', cast(:d as jsonb))")
                    .param("id", wv).param("w", wf).param("d", write(workflow)).update();
            workflows.publishInternal(null, wv);
        });
        return code;
    }

    protected static Map<String, Object> stage(String key, String mode, boolean fin, String... assignees) {
        List<Map<String, Object>> list = new ArrayList<>();
        for (String a : assignees) {
            String[] p = a.split("\\|");
            list.add(Map.of("role", p[0], "orgFrom", p[1]));
        }
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("key", key);
        s.put("name", "مرحلة " + key);
        s.put("mode", mode);
        s.put("slaDays", 2);
        s.put("assignees", list);
        s.put("final", fin);
        s.put("requiresSignature", fin);
        return s;
    }

    @SafeVarargs
    protected static Map<String, Object> workflow(List<Map<String, Object>> execution, Map<String, Object>... stages) {
        Map<String, Object> def = new LinkedHashMap<>();
        def.put("name", "تدفق اختبار");
        def.put("stages", List.of(stages));
        def.put("execution", execution);
        return def;
    }

    protected static Map<String, Object> finalOnly() {
        return workflow(List.of(), stage("final_approval", "ALL", true, "APPROVER|ANY"));
    }

    protected static String day(String isoDate) {
        return Times.startOfDay(LocalDate.parse(isoDate)).toString();
    }

    protected static String write(Object o) {
        try {
            return JSON.writeValueAsString(o);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    protected long activeReservations(UUID resource) {
        return jdbc.sql("select count(*) from reservation where resource_id = :r and status = 'ACTIVE'").param("r", resource)
                .query(Long.class).single();
    }

    // ---- HTTP client --------------------------------------------------------------------------------

    public record Res(int status, JsonNode body, byte[] raw) {
        public String code() {
            return body == null ? null : body.path("code").asText(null);
        }

        @Override
        public String toString() {
            return status + " " + (body == null ? "" : body.toString());
        }
    }

    protected Api login(String username) {
        Api api = new Api();
        Res r = api.post("/auth/login", Map.of("username", username + "-" + sfx, "password", PASSWORD));
        if (r.status() != 200) {
            throw new IllegalStateException("login failed for " + username + ": " + r);
        }
        return api;
    }

    protected class Api {
        final HttpClient http = HttpClient.newBuilder().cookieHandler(new CookieManager(null, CookiePolicy.ACCEPT_ALL)).build();

        String url(String path) {
            return "http://localhost:" + port + "/api/v1" + path;
        }

        public Res get(String path) {
            return send(HttpRequest.newBuilder(URI.create(url(path))).GET());
        }

        public Res post(String path, Object body) {
            return post(path, body, null);
        }

        public Res post(String path, Object body, String idemKey) {
            HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url(path)))
                    .header("Content-Type", "application/json").header("X-Requested-With", "mover")
                    .POST(HttpRequest.BodyPublishers.ofString(write(body == null ? Map.of() : body)));
            if (idemKey != null) {
                b.header("Idempotency-Key", idemKey);
            }
            return send(b);
        }

        public Res patch(String path, Object body) {
            return send(HttpRequest.newBuilder(URI.create(url(path))).header("Content-Type", "application/json")
                    .header("X-Requested-With", "mover").method("PATCH", HttpRequest.BodyPublishers.ofString(write(body))));
        }

        public Res upload(UUID requestId, String fieldId, String fileName, byte[] content) {
            String boundary = "----mover" + UUID.randomUUID();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            out.writeBytes(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"fieldId\"\r\n\r\n" + fieldId + "\r\n")
                    .getBytes(StandardCharsets.UTF_8));
            out.writeBytes(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + fileName
                    + "\"\r\nContent-Type: application/octet-stream\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            out.writeBytes(content);
            out.writeBytes(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
            return send(HttpRequest.newBuilder(URI.create(url("/requests/" + requestId + "/attachments")))
                    .header("Content-Type", "multipart/form-data; boundary=" + boundary).header("X-Requested-With", "mover")
                    .POST(HttpRequest.BodyPublishers.ofByteArray(out.toByteArray())));
        }

        Res send(HttpRequest.Builder b) {
            try {
                HttpResponse<byte[]> r = http.send(b.build(), HttpResponse.BodyHandlers.ofByteArray());
                JsonNode body = null;
                String ct = r.headers().firstValue("Content-Type").orElse("");
                if (ct.contains("json") && r.body().length > 0) {
                    body = JSON.readTree(r.body());
                }
                return new Res(r.statusCode(), body, r.body());
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        }

        // ---- domain shortcuts -----------------------------------------------------------------------

        public UUID draft(String type, String origin, UUID owner, List<UUID> resources, String start, String end,
                          Map<String, Object> values) {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("typeCode", type);
            body.put("origin", origin);
            body.put("ownerOrgId", owner.toString());
            body.put("resourceIds", resources.stream().map(UUID::toString).toList());
            Map<String, Object> period = new LinkedHashMap<>();
            period.put("start", start);
            period.put("end", end);
            body.put("period", period);
            body.put("values", values);
            Res r = post("/requests", body);
            if (r.status() != 200) {
                throw new IllegalStateException("create failed: " + r);
            }
            return UUID.fromString(r.body().path("id").asText());
        }

        public Res submit(UUID request) {
            int version = get("/requests/" + request).body().path("version").asInt();
            return post("/requests/" + request + "/submit", Map.of("expectedVersion", version), UUID.randomUUID().toString());
        }

        public UUID submitted(String type, UUID owner, List<UUID> resources, String start, String end) {
            UUID id = draft(type, "LIST", owner, resources, start, end, Map.of("reason", "مبرر اختبار كافٍ للطلب"));
            Res r = submit(id);
            if (r.status() != 200) {
                throw new IllegalStateException("submit failed: " + r);
            }
            return id;
        }

        public JsonNode tasks() {
            return get("/tasks").body();
        }

        public String taskFor(UUID request) {
            for (JsonNode t : tasks()) {
                if (t.path("requestId").asText().equals(request.toString())) {
                    return t.path("id").asText();
                }
            }
            return null;
        }

        public Res approve(String taskId, int revision) {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("decision", "APPROVE");
            body.put("expectedRevision", revision);
            body.put("signature", Map.of("password", PASSWORD, "confirm", true));
            return post("/tasks/" + taskId + "/decision", body, UUID.randomUUID().toString());
        }

        public Res decide(String taskId, String decision, String note, int revision) {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("decision", decision);
            body.put("note", note);
            body.put("expectedRevision", revision);
            return post("/tasks/" + taskId + "/decision", body);
        }
    }

    protected Instant now() {
        return Instant.now();
    }

    protected static String ids(List<UUID> ids) {
        return Db.ids(ids);
    }
}
