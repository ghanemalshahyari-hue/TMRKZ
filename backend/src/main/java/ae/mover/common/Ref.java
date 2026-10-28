package ae.mover.common;

import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonInclude;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record Ref(String id, String name, String code) {

    public static Ref of(UUID id, String name) {
        return id == null ? null : new Ref(id.toString(), name, null);
    }

    public static Ref of(UUID id, String name, String code) {
        return id == null ? null : new Ref(id.toString(), name, code);
    }
}
