package ae.mover.common;

import org.springframework.boot.jackson.autoconfigure.JsonMapperBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import tools.jackson.core.JsonGenerator;
import tools.jackson.databind.SerializationContext;
import tools.jackson.databind.ValueSerializer;
import tools.jackson.databind.module.SimpleModule;

/**
 * Spring Boot 4 serialises HTTP responses with Jackson 3, while stored documents (form schemas, workflow definitions,
 * geometries) are parsed internally with Jackson 2 (shared with the embedded Flowable engine). This bridge writes
 * Jackson 2 trees as the raw JSON they represent instead of as bean properties.
 */
@Configuration
public class JacksonConfig {

    @Bean
    public JsonMapperBuilderCustomizer jackson2TreeBridge() {
        SimpleModule module = new SimpleModule("mover-jackson2-tree-bridge");
        module.addSerializer(com.fasterxml.jackson.databind.JsonNode.class, new ValueSerializer<com.fasterxml.jackson.databind.JsonNode>() {
            @Override
            public void serialize(com.fasterxml.jackson.databind.JsonNode value, JsonGenerator gen, SerializationContext ctxt) {
                gen.writeRawValue(value.toString());
            }
        });
        return builder -> builder.addModule(module);
    }
}
