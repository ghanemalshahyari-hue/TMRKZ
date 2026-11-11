package ae.mover.assistant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.sun.net.httpserver.HttpServer;

import ae.mover.knowledge.KnowledgeService;

/** «المساعد الذكي» against a stand-in OpenAI-compatible server (ADR-056): what the model is given, what comes back. */
class AssistantServiceTest {

    HttpServer server;
    final AtomicReference<String> lastRequest = new AtomicReference<>();
    final AtomicReference<String> lastAuth = new AtomicReference<>();
    volatile String reply = "{\"choices\":[{\"message\":{\"content\":\"<think>خطوات</think>1. افتح «مصفوفة الوحدات».\"}}]}";
    volatile int code = 200;

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/chat/completions", ex -> {
            lastRequest.set(new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            lastAuth.set(ex.getRequestHeaders().getFirst("Authorization"));
            byte[] b = reply.getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(code, b.length);
            ex.getResponseBody().write(b);
            ex.close();
        });
        server.createContext("/v1/models", ex -> {
            byte[] b = "{\"data\":[]}".getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(200, b.length);
            ex.getResponseBody().write(b);
            ex.close();
        });
        server.start();
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    private AssistantService service(String key) {
        return new AssistantService(new KnowledgeService(), null, true, "http://127.0.0.1:" + server.getAddress().getPort() + "/v1/", "qwen2.5:7b", key, 10);
    }

    @Test
    @DisplayName("AI-1: the model gets the system rules, the cited guides and the question; its reasoning tags are removed")
    void grounded() throws Exception {
        KnowledgeService k = new KnowledgeService();
        List<KnowledgeService.Hit> hits = k.search("كيف اضيف مستخدم للوحده", d -> true, 2);
        String answer = service("secret-key").complete("كيف أضيف مستخدماً؟", hits);
        assertThat(answer).isEqualTo("1. افتح «مصفوفة الوحدات».");
        String sent = lastRequest.get();
        assertThat(sent).contains("\"model\":\"qwen2.5:7b\"").contains("مساعد تمركز").contains("tmrkz://okf/how-to/add-user")
                .contains("كيف أضيف مستخدماً؟").contains("\"stream\":false");
        assertThat(lastAuth.get()).isEqualTo("Bearer secret-key");
        assertThat(service("secret-key").status()).containsEntry("reachable", true).containsEntry("model", "qwen2.5:7b");
    }

    @Test
    @DisplayName("AI-2: a failing or empty server is an error the caller turns into the guide's own answer")
    void failures() {
        KnowledgeService k = new KnowledgeService();
        List<KnowledgeService.Hit> hits = k.search("اشعارات سطح المكتب", d -> true, 1);
        code = 500;
        assertThatThrownBy(() -> service("").complete("سؤال", hits)).isInstanceOf(IOException.class);
        code = 200;
        reply = "{\"choices\":[{\"message\":{\"content\":\"<think>only</think>\"}}]}";
        assertThatThrownBy(() -> service("").complete("سؤال", hits)).isInstanceOf(IOException.class).hasMessageContaining("empty");
        assertThat(lastAuth.get()).as("no key, no header").isNull();
        AssistantService off = new AssistantService(k, null, false, "http://127.0.0.1:1/v1", "m", "", 10);
        assertThat(off.status()).containsEntry("enabled", false).containsEntry("reachable", false);
    }
}
