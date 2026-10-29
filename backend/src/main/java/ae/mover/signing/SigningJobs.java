package ae.mover.signing;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.Json;

/**
 * Signing jobs and their evidence. Creating a job and recording a signing outcome run in their own transactions, so
 * the record of an attempt survives whatever happens to the decision that would publish it.
 */
@Component
public class SigningJobs {

    public record Signature(String kind, String subject, String issuer, String serial, String notBefore, String notAfter,
                            String signingTime, String indication, String subIndication) {
    }

    public record JobView(String id, String status, int revision, String documentSha256, String provider, String signerName,
                          String failureCode, String failureMessage, String createdAt, String signedAt, String publishedAt,
                          String unpublishedReason, List<Signature> signatures) {
    }

    public record Job(UUID id, UUID requestId, int revision, UUID taskId, UUID signerPersonId, String documentSha256,
                      String status, byte[] signedDocument) {
    }

    private final JdbcClient jdbc;
    private final Json json;
    private final Clock clock;
    private final TransactionTemplate own;

    public SigningJobs(JdbcClient jdbc, Json json, Clock clock, PlatformTransactionManager txManager) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
        this.own = new TransactionTemplate(txManager);
        this.own.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    }

    public Optional<Job> live(UUID taskId, UUID personId, int revision, String sha256) {
        return jdbc.sql("""
                select * from signing_job where task_id = :t and signer_person_id = :p and revision = :r and document_sha256 = :s
                  and status in ('PENDING', 'SIGNED', 'PUBLISHED')""")
                .param("t", taskId).param("p", personId).param("r", revision).param("s", sha256)
                .query((rs, n) -> job(rs)).optional();
    }

    public UUID create(UUID requestId, int revision, UUID taskId, UUID personId, UUID orgId, String sha256,
                       Map<String, Object> canonical, String provider) {
        UUID id = UUID.randomUUID();
        own.executeWithoutResult(x -> jdbc.sql("""
                insert into signing_job(id, request_id, revision, task_id, signer_person_id, organization_id, document_sha256,
                                        canonical, provider, status, created_at)
                values (:id, :req, :rev, :task, :p, :org, :sha, cast(:doc as jsonb), :prov, 'PENDING', :now)""")
                .param("id", id).param("req", requestId).param("rev", revision).param("task", taskId).param("p", personId)
                .param("org", orgId).param("sha", sha256).param("doc", json.write(canonical)).param("prov", provider)
                .param("now", Db.ts(clock.instant())).update());
        return id;
    }

    /** Stores the provider's outcome: the signed document and its evidence, or the reason it was refused. */
    public void record(UUID jobId, ApprovalSigner.Outcome o, UUID validatedBy) {
        Instant now = clock.instant();
        own.executeWithoutResult(x -> {
            jdbc.sql("""
                    update signing_job set status = :st, signed_document = :doc, failure_code = :fc, failure_message = :fm,
                      signed_at = :sa, closed_at = :ca where id = :id""")
                    .param("st", o.ok() ? "SIGNED" : "FAILED").param("doc", o.signed())
                    .param("fc", o.failureCode()).param("fm", o.failureMessage())
                    .param("sa", o.ok() ? Db.ts(now) : null).param("ca", o.ok() ? null : Db.ts(now)).param("id", jobId).update();
            for (ApprovalSigner.Check c : o.checks()) {
                if ("UNKNOWN".equals(c.role()) || c.certificate() == null) {
                    continue;
                }
                jdbc.sql("""
                        insert into signature_evidence(id, signing_job_id, kind, signature_id, certificate, subject, issuer, serial,
                                                       not_before, not_after, signing_time, indication, sub_indication)
                        values (:id, :job, :k, :sid, :cert, :sub, :iss, :ser, :nb, :na, :st, :ind, :subi)""")
                        .param("id", UUID.randomUUID()).param("job", jobId).param("k", c.role()).param("sid", c.signatureId())
                        .param("cert", c.certificate()).param("sub", c.subject()).param("iss", c.issuer()).param("ser", c.serial())
                        .param("nb", Db.ts(c.notBefore())).param("na", Db.ts(c.notAfter())).param("st", Db.ts(c.signingTime()))
                        .param("ind", c.indication()).param("subi", c.subIndication()).update();
            }
            if (!o.checks().isEmpty()) {
                report(jobId, o.checks(), validatedBy, now);
            }
        });
    }

    /** Appends a validation report (at signing or a later verification). */
    public void report(UUID jobId, List<ApprovalSigner.Check> checks, UUID by, Instant at) {
        List<Map<String, Object>> items = new ArrayList<>();
        for (ApprovalSigner.Check c : checks) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("role", c.role());
            m.put("subject", c.subject());
            m.put("indication", c.indication());
            m.put("subIndication", c.subIndication());
            m.put("reason", c.reason());
            items.add(m);
        }
        jdbc.sql("""
                insert into validation_report(id, signing_job_id, validated_at, validated_by, passed, summary)
                values (:id, :job, :at, :by, :ok, cast(:s as jsonb))""")
                .param("id", UUID.randomUUID()).param("job", jobId).param("at", Db.ts(at)).param("by", by)
                .param("ok", !checks.isEmpty() && checks.stream().allMatch(ApprovalSigner.Check::passed))
                .param("s", json.write(Map.of("signatures", items))).update();
    }

    /** The job, locked in the caller's (decision) transaction. */
    public Job lock(UUID jobId) {
        return jdbc.sql("select * from signing_job where id = :id for update").param("id", jobId)
                .query((rs, n) -> job(rs)).optional().orElseThrow(ApiException::notFound);
    }

    public void published(UUID jobId, UUID decisionId, Instant at) {
        jdbc.sql("update signing_job set status = 'PUBLISHED', decision_id = :d, published_at = :at, closed_at = :at where id = :id")
                .param("d", decisionId).param("at", Db.ts(at)).param("id", jobId).update();
    }

    /** The decision that would have published the signature failed: the attempt stays on record, unpublished. */
    public void unpublished(UUID jobId, String reason) {
        own.executeWithoutResult(x -> jdbc.sql("""
                update signing_job set status = 'UNPUBLISHED', unpublished_reason = :r, closed_at = :at
                where id = :id and status = 'SIGNED'""")
                .param("r", reason).param("at", Db.ts(clock.instant())).param("id", jobId).update());
    }

    public JobView view(UUID jobId) {
        List<Signature> sigs = jdbc.sql("select * from signature_evidence where signing_job_id = :id order by kind desc")
                .param("id", jobId).query((rs, n) -> new Signature(rs.getString("kind"), rs.getString("subject"),
                        rs.getString("issuer"), rs.getString("serial"), Db.iso(rs, "not_before"), Db.iso(rs, "not_after"),
                        Db.iso(rs, "signing_time"), rs.getString("indication"), rs.getString("sub_indication"))).list();
        return jdbc.sql("""
                select j.*, p.display_name from signing_job j join person p on p.id = j.signer_person_id where j.id = :id""")
                .param("id", jobId).query((rs, n) -> new JobView(rs.getString("id"), rs.getString("status"), rs.getInt("revision"),
                        rs.getString("document_sha256"), rs.getString("provider"), rs.getString("display_name"),
                        rs.getString("failure_code"), rs.getString("failure_message"), Db.iso(rs, "created_at"),
                        Db.iso(rs, "signed_at"), Db.iso(rs, "published_at"), rs.getString("unpublished_reason"), sigs))
                .optional().orElseThrow(ApiException::notFound);
    }

    /** Certificates of the person and the seal as stored at signing (base64 DER), for later re-validation. */
    public Map<String, String> certificates(UUID jobId) {
        Map<String, String> out = new LinkedHashMap<>();
        jdbc.sql("select kind, certificate from signature_evidence where signing_job_id = :id").param("id", jobId)
                .query((rs, n) -> out.put(rs.getString("kind"), rs.getString("certificate"))).list();
        return out;
    }

    private static Job job(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new Job(Db.uuid(rs, "id"), Db.uuid(rs, "request_id"), rs.getInt("revision"), Db.uuid(rs, "task_id"),
                Db.uuid(rs, "signer_person_id"), rs.getString("document_sha256"), rs.getString("status"),
                rs.getBytes("signed_document"));
    }
}
