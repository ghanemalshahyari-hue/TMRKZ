package ae.mover.requests;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import ae.mover.access.AccessService;
import ae.mover.access.Permission;
import ae.mover.attachments.AttachmentService;
import ae.mover.common.PageResult;
import ae.mover.requests.Commands.ChangeRequestInput;
import ae.mover.requests.Commands.CloseInput;
import ae.mover.requests.Commands.DecisionInput;
import ae.mover.requests.Commands.DraftInput;
import ae.mover.requests.Commands.SubmitInput;
import ae.mover.reservations.ExecutionService;
import ae.mover.security.Actor;

@RestController
@RequestMapping("/api/v1")
public class RequestController {

    private final AccessService access;
    private final RequestTypes types;
    private final RequestService requests;
    private final RequestViews views;
    private final DecisionService decisions;
    private final ExecutionService execution;
    private final AttachmentService attachments;

    public RequestController(AccessService access, RequestTypes types, RequestService requests, RequestViews views,
                             DecisionService decisions, ExecutionService execution, AttachmentService attachments) {
        this.access = access;
        this.types = types;
        this.requests = requests;
        this.views = views;
        this.decisions = decisions;
        this.execution = execution;
        this.attachments = attachments;
    }

    @GetMapping("/request-types")
    public List<RequestTypes.TypeView> requestTypes(Actor actor) {
        access.context(actor).requireAny(Permission.VIEW, Permission.VIEW_SUMMARY, Permission.CREATE, Permission.CONFIGURE);
        return types.views();
    }

    @GetMapping("/requests")
    public PageResult<RequestViews.RequestListItem> list(Actor actor, @RequestParam(required = false) String status,
                                                         @RequestParam(required = false) String q,
                                                         @RequestParam(required = false) Integer page,
                                                         @RequestParam(required = false) Integer size,
                                                         @RequestParam(required = false, defaultValue = "false") boolean excludeDrafts,
                                                         @RequestParam(required = false, defaultValue = "false") boolean mine) {
        return views.list(access.context(actor), status, q, page, size, excludeDrafts, mine);
    }

    @PostMapping("/requests")
    public RequestViews.RequestDetail create(Actor actor, @RequestBody DraftInput in) {
        var ctx = access.context(actor);
        return views.detail(ctx, requests.create(ctx, in));
    }

    @GetMapping("/requests/{id}")
    public RequestViews.RequestDetail detail(Actor actor, @PathVariable UUID id) {
        return views.detail(access.context(actor), id);
    }

    @GetMapping("/requests/{id}/boundaries")
    public Map<String, Object> boundaries(Actor actor, @PathVariable UUID id, @RequestParam(required = false) Integer revision) {
        return views.boundaries(access.context(actor), id, revision);
    }

    @PatchMapping("/requests/{id}/draft")
    public RequestViews.RequestDetail updateDraft(Actor actor, @PathVariable UUID id, @RequestBody DraftInput in) {
        var ctx = access.context(actor);
        requests.updateDraft(ctx, id, in);
        return views.detail(ctx, id);
    }

    @PostMapping("/requests/{id}/submit")
    public RequestViews.RequestDetail submit(Actor actor, @PathVariable UUID id, @RequestBody SubmitInput in,
                                             @RequestHeader(value = "Idempotency-Key", required = false) String key) {
        return requests.submit(access.context(actor), id, in, key);
    }

    @PostMapping("/requests/{id}/close")
    public RequestViews.RequestDetail close(Actor actor, @PathVariable UUID id, @RequestBody(required = false) CloseInput in,
                                            @RequestHeader(value = "Idempotency-Key", required = false) String key) {
        return execution.close(access.context(actor), id, in == null ? new CloseInput(null) : in, key);
    }

    @PostMapping(value = "/requests/{id}/attachments", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public RequestViews.AttachmentView upload(Actor actor, @PathVariable UUID id, @RequestParam("fieldId") String fieldId,
                                              @RequestParam("file") MultipartFile file) throws IOException {
        return attachments.upload(access.context(actor), id, fieldId, file.getOriginalFilename(), file.getBytes());
    }

    @GetMapping("/attachments/{id}/content")
    public ResponseEntity<byte[]> download(Actor actor, @PathVariable UUID id) {
        AttachmentService.Download d = attachments.download(access.context(actor), id);
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.attachment().filename(d.fileName(), StandardCharsets.UTF_8).build().toString())
                .header("X-Content-Type-Options", "nosniff")
                .contentType(MediaType.parseMediaType(d.contentType()))
                .body(d.content());
    }

    @PostMapping("/reservations/{id}/change-requests")
    public RequestViews.RequestDetail changeRequest(Actor actor, @PathVariable UUID id, @RequestBody ChangeRequestInput in) {
        var ctx = access.context(actor);
        return views.detail(ctx, requests.changeRequest(ctx, id, in.typeCode()));
    }

    // ---- tasks --------------------------------------------------------------------------------------

    @GetMapping("/tasks")
    public List<DecisionService.TaskItem> tasks(Actor actor) {
        return decisions.myTasks(access.context(actor));
    }

    @GetMapping("/tasks/{id}/approval-document")
    public DecisionService.ApprovalDocumentPreview approvalDocument(Actor actor, @PathVariable UUID id) {
        return decisions.approvalDocument(access.context(actor), id);
    }

    @PostMapping("/tasks/{id}/decision")
    public RequestViews.RequestDetail decide(Actor actor, @PathVariable UUID id, @RequestBody DecisionInput in,
                                             @RequestHeader(value = "Idempotency-Key", required = false) String key) {
        return decisions.decide(access.context(actor), id, in, key);
    }
}
