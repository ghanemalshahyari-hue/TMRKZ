package ae.mover.assistant;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.stereotype.Component;

import ae.mover.security.IntegrationSettingsService.Assistant;

/**
 * «اختبار الاتصال» for the assistant (owner, 20 Nov 2026): opens the server at the given base URL and asks for the list
 * of models, so the administrator sees before saving whether the credentials and address reach the model. No user
 * question is sent during a test.
 */
@Component
public class AssistantTester {

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

    public Map<String, Object> test(Assistant in) {
        Map<String, Object> out = new LinkedHashMap<>();
        long t0 = System.nanoTime();
        if (in == null || in.baseUrl() == null || in.baseUrl().isBlank()) {
            out.put("ok", false);
            out.put("step", "URL");
            out.put("message", "اكتب عنوان خادم النموذج أولاً.");
            return out;
        }
        String url = in.baseUrl();
        while (url.endsWith("/")) {
            url = url.substring(0, url.length() - 1);
        }
        try {
            HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url + "/models")).timeout(Duration.ofSeconds(Math.max(5, Math.min(60, in.timeoutSeconds() == null ? 10 : in.timeoutSeconds())))).GET();
            if (in.apiKey() != null && !in.apiKey().isBlank()) {
                b.header("Authorization", "Bearer " + in.apiKey());
            }
            HttpResponse<String> r = http.send(b.build(), HttpResponse.BodyHandlers.ofString());
            out.put("ok", r.statusCode() == 200);
            out.put("step", "MODELS");
            out.put("status", r.statusCode());
            out.put("message", r.statusCode() == 200 ? "خادم النموذج يستجيب" : "ردّ خادم النموذج: " + r.statusCode());
            if (r.statusCode() == 200 && in.model() != null && !in.model().isBlank()) {
                out.put("knownModel", r.body() != null && r.body().contains("\"" + in.model() + "\""));
            }
        } catch (IOException | InterruptedException | IllegalArgumentException e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            out.put("ok", false);
            out.put("step", "CONNECT");
            out.put("message", "تعذّر الوصول إلى خادم النموذج: " + e.getMessage());
        }
        out.put("url", url);
        out.put("elapsedMs", (System.nanoTime() - t0) / 1_000_000);
        return out;
    }
}
