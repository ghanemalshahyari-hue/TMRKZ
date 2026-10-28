package ae.mover.common;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.stereotype.Component;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * Internal JSON handling for stored documents (jsonb columns, schemas, canonical approval documents).
 * HTTP message conversion is left to Spring's own mapper.
 */
@Component
public class Json {

    private final ObjectMapper mapper = JsonMapper.builder()
            .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .build();

    private final ObjectMapper canonical = JsonMapper.builder()
            .enable(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY)
            .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)
            .build();

    public String write(Object value) {
        try {
            return mapper.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("JSON serialisation failed", e);
        }
    }

    /** Deterministic serialisation (sorted keys) used for hashing approval documents and request revisions. */
    public String canonical(Object value) {
        try {
            JsonNode tree = canonical.valueToTree(value);
            return canonical.writeValueAsString(canonical.treeToValue(tree, Object.class));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("JSON serialisation failed", e);
        }
    }

    public JsonNode tree(String value) {
        if (value == null) {
            return mapper.nullNode();
        }
        try {
            return mapper.readTree(value);
        } catch (JsonProcessingException e) {
            throw ApiException.validation("صيغة JSON غير صحيحة.");
        }
    }

    public JsonNode tree(Object value) {
        return mapper.valueToTree(value);
    }

    public ObjectNode object() {
        return mapper.createObjectNode();
    }

    public <T> T read(String value, Class<T> type) {
        try {
            return mapper.readValue(value, type);
        } catch (JsonProcessingException e) {
            throw ApiException.validation("صيغة JSON غير صحيحة.");
        }
    }

    public <T> T convert(Object value, Class<T> type) {
        return mapper.convertValue(value, type);
    }

    public <T> T convert(Object value, TypeReference<T> type) {
        return mapper.convertValue(value, type);
    }

    public Map<String, Object> map(Object value) {
        if (value == null) {
            return new LinkedHashMap<>();
        }
        return mapper.convertValue(value, new TypeReference<LinkedHashMap<String, Object>>() {
        });
    }

    public Map<String, Object> map(String value) {
        if (value == null) {
            return new LinkedHashMap<>();
        }
        try {
            return mapper.readValue(value, new TypeReference<LinkedHashMap<String, Object>>() {
            });
        } catch (JsonProcessingException e) {
            throw ApiException.validation("صيغة JSON غير صحيحة.");
        }
    }

    public List<Object> list(Object value) {
        return mapper.convertValue(value, new TypeReference<List<Object>>() {
        });
    }

    public ObjectMapper mapper() {
        return mapper;
    }
}
