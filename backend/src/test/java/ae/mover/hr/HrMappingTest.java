package ae.mover.hr;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import ae.mover.hr.HrMapping.Entity;

/** The parent from TNQL's ID path (owner, 11 Nov 2026): a unit view with an ID path and no parent column. */
class HrMappingTest {

    @Test
    @DisplayName("path_parent: the second-to-last segment, null at the root, never the unit itself; only on the parent field")
    void pathParent() {
        assertThat(HrMapping.pathParent("\\100000\\100001\\100007")).isEqualTo("100001");
        assertThat(HrMapping.pathParent("\\100000\\")).isNull();
        assertThat(HrMapping.pathParent("100000/100001")).isEqualTo("100000");
        assertThat(HrMapping.pathParent(" ")).isNull();

        List<HrMapping.Field> fields = new ArrayList<>();
        fields.add(new HrMapping.Field(Entity.UNIT, "external_unit_id", "ID", "none", List.of(), true));
        fields.add(new HrMapping.Field(Entity.UNIT, "name", "NAME", "none", List.of(), true));
        fields.add(new HrMapping.Field(Entity.UNIT, "parent_external_unit_id", "SORT_ORDER", "path_parent", List.of(), true));
        fields.add(new HrMapping.Field(Entity.UNIT, "status", "STATUS", "none", List.of(), true));
        fields.add(new HrMapping.Field(Entity.PERSON, "external_person_id", "PRS_ID", "none", List.of(), true));
        fields.add(new HrMapping.Field(Entity.PERSON, "employee_number", "MIL_NUMBER", "none", List.of(), true));
        fields.add(new HrMapping.Field(Entity.PERSON, "full_name", "FULL_NAME", "none", List.of(), true));
        fields.add(new HrMapping.Field(Entity.PERSON, "unit_external_id", "ORG_UNIT_ID", "none", List.of(), true));
        fields.add(new HrMapping.Field(Entity.PERSON, "status_text", "EMP_STATUS_DESC", "none", List.of(), true));
        Map<Entity, HrMapping.Rule> rules = new EnumMap<>(Entity.class);
        rules.put(Entity.UNIT, new HrMapping.Rule("STATUS", "EQUALS", List.of("1")));
        rules.put(Entity.PERSON, new HrMapping.Rule("EMP_STATUS", "EQUALS", List.of("1")));
        Map<Entity, List<String>> discovered = new EnumMap<>(Entity.class);
        discovered.put(Entity.UNIT, List.of("ID", "NAME", "SORT_ORDER", "STATUS"));
        discovered.put(Entity.PERSON, List.of("PRS_ID", "MIL_NUMBER", "FULL_NAME", "ORG_UNIT_ID", "EMP_STATUS_DESC", "EMP_STATUS"));
        HrMapping.Compiled c = HrMapping.compile(new HrMapping.Definition(fields, rules), discovered);
        Map<String, String> child = c.convert(Entity.UNIT, Map.of("ID", 100007, "NAME", "وحدة", "SORT_ORDER", "\\100000\\100001\\100007", "STATUS", 1));
        assertThat(child.get("parent_external_unit_id")).isEqualTo("100001");
        assertThat(child.get("active")).isEqualTo("true");
        Map<String, String> root = c.convert(Entity.UNIT, Map.of("ID", 100000, "NAME", "الجذر", "SORT_ORDER", "\\100000", "STATUS", 1));
        assertThat(root.get("parent_external_unit_id")).isNull();

        List<HrMapping.Field> wrong = new ArrayList<>(fields);
        wrong.set(1, new HrMapping.Field(Entity.UNIT, "name", "NAME", "path_parent", List.of(), true));
        assertThat(HrMapping.structuralProblems(new HrMapping.Definition(wrong, rules))).contains("التحويل path_parent لحقل الجهة الأم فقط");
    }
}
