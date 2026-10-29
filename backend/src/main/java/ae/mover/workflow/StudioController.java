package ae.mover.workflow;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ae.mover.access.AccessService;
import ae.mover.common.Json;
import ae.mover.forms.FormService;
import ae.mover.security.Actor;

/** Form and workflow studios: drafts, validation, simulation and publication of immutable versions. */
@RestController
@RequestMapping("/api/v1")
public class StudioController {

    private final AccessService access;
    private final FormService forms;
    private final WorkflowService workflows;
    private final Json json;

    public StudioController(AccessService access, FormService forms, WorkflowService workflows, Json json) {
        this.access = access;
        this.forms = forms;
        this.workflows = workflows;
        this.json = json;
    }

    @GetMapping("/forms")
    public List<FormService.FormSummary> forms(Actor actor) {
        return forms.list(access.context(actor));
    }

    @GetMapping("/form-versions/{id}")
    public FormService.FormVersionView formVersion(Actor actor, @PathVariable UUID id) {
        return forms.get(access.context(actor), id);
    }

    @PostMapping("/forms/{id}/drafts")
    public FormService.FormVersionView formDraft(Actor actor, @PathVariable UUID id, @RequestBody Map<String, Object> body) {
        return forms.saveDraft(access.context(actor), id, json.tree(body.get("schema")));
    }

    @PostMapping("/form-versions/{id}/validate")
    public FormService.ValidationResult validateForm(Actor actor, @PathVariable UUID id) {
        return forms.validate(access.context(actor), id);
    }

    /** Body: {schema, values, facts}. Evaluates visibility and requirement without saving anything. */
    @PostMapping("/forms/evaluate")
    public FormService.Evaluation evaluateForm(Actor actor, @RequestBody Map<String, Object> body) {
        return forms.evaluate(access.context(actor), json.tree(body.get("schema")),
                body.get("values") == null ? Map.of() : json.map(body.get("values")),
                body.get("facts") == null ? Map.of() : json.map(body.get("facts")));
    }

    @PostMapping("/form-versions/{id}/publish")
    public FormService.FormVersionView publishForm(Actor actor, @PathVariable UUID id) {
        return forms.publish(access.context(actor), id);
    }

    @GetMapping("/workflows")
    public List<WorkflowService.WorkflowSummary> workflows(Actor actor) {
        return workflows.list(access.context(actor));
    }

    @GetMapping("/workflow-versions/{id}")
    public WorkflowService.WorkflowVersionView workflowVersion(Actor actor, @PathVariable UUID id) {
        return workflows.get(access.context(actor), id);
    }

    @PostMapping("/workflows/{id}/drafts")
    public WorkflowService.WorkflowVersionView workflowDraft(Actor actor, @PathVariable UUID id, @RequestBody Map<String, Object> body) {
        return workflows.saveDraft(access.context(actor), id, json.tree(body.get("definition")));
    }

    @PostMapping("/workflow-versions/{id}/simulate")
    public WorkflowService.Simulation simulate(Actor actor, @PathVariable UUID id,
                                               @RequestBody(required = false) Map<String, Object> body) {
        Object facts = body == null ? null : body.get("facts");
        return workflows.simulate(access.context(actor), id, facts == null ? Map.of() : json.map(facts));
    }

    @PostMapping("/workflow-versions/{id}/publish")
    public WorkflowService.WorkflowVersionView publishWorkflow(Actor actor, @PathVariable UUID id) {
        return workflows.publish(access.context(actor), id);
    }

    @GetMapping("/workflow-versions/{id}/bpmn")
    public ResponseEntity<byte[]> bpmn(Actor actor, @PathVariable UUID id) {
        String xml = workflows.bpmn(access.context(actor), id);
        return ResponseEntity.ok().contentType(MediaType.APPLICATION_XML)
                .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.attachment().filename("workflow-" + id + ".bpmn20.xml").build().toString())
                .body(xml.getBytes(StandardCharsets.UTF_8));
    }
}
