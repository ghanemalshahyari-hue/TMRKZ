package ae.mover.stationing;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Set;

import ae.mover.common.Json;

/**
 * Delivers an outbound stationing event as one HTTP POST of its {@code tmrkz.stationing.v1} payload to a consumer
 * endpoint inside the isolated network. The event id travels as {@code Idempotency-Key}; 2xx, and 409 (already
 * received), count as delivered; a client error that will not change on retry (400, 401, 403, 404, 410, 422) parks the
 * event at once; anything else, including timeouts and refused connections, is retried by the sender. The optional
 * bearer token comes from the environment, never from source control.
 */
public final class HttpStationingDestination implements StationingEventSender.Destination {

    private static final Set<Integer> PERMANENT = Set.of(400, 401, 403, 404, 410, 422);

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private final URI url;
    private final String token;
    private final Json json;

    public HttpStationingDestination(URI url, String token, Json json) {
        this.url = url;
        this.token = token == null || token.isBlank() ? null : token;
        this.json = json;
    }

    @Override
    public Result deliver(StationingEvent event) {
        HttpRequest.Builder b = HttpRequest.newBuilder(url).timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json")
                .header("Idempotency-Key", event.eventId().toString())
                .header("X-Event-Schema", StationingEvent.SCHEMA)
                .POST(HttpRequest.BodyPublishers.ofString(json.write(event.payload())));
        if (token != null) {
            b.header("Authorization", "Bearer " + token);
        }
        try {
            int status = http.send(b.build(), HttpResponse.BodyHandlers.discarding()).statusCode();
            if (status / 100 == 2 || status == 409) {
                return Result.ok();
            }
            return PERMANENT.contains(status) ? Result.refuse("HTTP " + status) : Result.retry("HTTP " + status);
        } catch (IOException e) {
            return Result.retry(e.getClass().getSimpleName() + ": " + e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return Result.retry("interrupted");
        }
    }
}
