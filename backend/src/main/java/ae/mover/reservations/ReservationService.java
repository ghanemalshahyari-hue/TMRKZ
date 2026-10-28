package ae.mover.reservations;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import ae.mover.common.ApiException;
import ae.mover.common.Db;
import ae.mover.common.ErrorCode;

/**
 * Reservation records and their scope locks. Every mutation of an active reservation's period re-derives its locks
 * in the caller's transaction; PostgreSQL exclusion constraints reject any overlap (including parent/child scope
 * conflicts), so a conflicting commit fails as a whole and leaves no partial reservation behind.
 */
@Service
public class ReservationService {

    private final JdbcClient jdbc;
    private final Clock clock;

    public ReservationService(JdbcClient jdbc, Clock clock) {
        this.jdbc = jdbc;
        this.clock = clock;
    }

    public record Reservation(UUID id, UUID resourceId, String resourceName, UUID organizationId, UUID requestId,
                              Instant start, Instant end, String status) {
    }

    public Reservation get(UUID id) {
        return jdbc.sql("""
                select v.*, r.name as resource_name from reservation v join resource r on r.id = v.resource_id where v.id = :id""")
                .param("id", id).query((rs, n) -> new Reservation(Db.uuid(rs, "id"), Db.uuid(rs, "resource_id"),
                        rs.getString("resource_name"), Db.uuid(rs, "organization_id"), Db.uuid(rs, "request_id"),
                        Db.instant(rs, "period_start"), Db.instant(rs, "period_end"), rs.getString("status")))
                .optional().orElseThrow(ApiException::notFound);
    }

    public Reservation lock(UUID id) {
        jdbc.sql("select id from reservation where id = :id for update").param("id", id).query(UUID.class)
                .optional().orElseThrow(ApiException::notFound);
        return get(id);
    }

    public UUID create(UUID resourceId, UUID orgId, UUID requestId, Integer revision, String source, Instant start,
                       Instant end, String purpose, UUID actor) {
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                insert into reservation(id, resource_id, organization_id, request_id, request_revision, source,
                                        period_start, period_end, status, purpose, created_at, updated_at)
                values (:id, :res, :org, :req, :rev, :src, :s, :e, 'ACTIVE', :p, :now, :now)""")
                .param("id", id).param("res", resourceId).param("org", orgId).param("req", requestId).param("rev", revision)
                .param("src", source).param("s", Db.ts(start)).param("e", Db.ts(end)).param("p", purpose)
                .param("now", Db.ts(clock.instant())).update();
        insertLocks(id, resourceId, start, end);
        recordChange(id, requestId, "CREATED", null, null, start, end, null, "ACTIVE", start, actor);
        return id;
    }

    /** Changes the period of an active reservation (extension / modification). Conflicts abort the transaction. */
    public void changePeriod(Reservation r, Instant newStart, Instant newEnd, UUID requestId, String kind, UUID actor) {
        if (!"ACTIVE".equals(r.status())) {
            throw ApiException.validation("الحجز المرتبط لم يعد نشطاً.");
        }
        if (newEnd != null && !newEnd.isAfter(newStart)) {
            throw ApiException.validation("نهاية الفترة يجب أن تكون بعد بدايتها.");
        }
        jdbc.sql("update reservation set period_start = :s, period_end = :e, updated_at = :now, version = version + 1 where id = :id")
                .param("s", Db.ts(newStart)).param("e", Db.ts(newEnd)).param("now", Db.ts(clock.instant()))
                .param("id", r.id()).update();
        jdbc.sql("delete from reservation_lock where reservation_id = :id").param("id", r.id()).update();
        insertLocks(r.id(), r.resourceId(), newStart, newEnd);
        recordChange(r.id(), requestId, kind, r.start(), r.end(), newStart, newEnd, "ACTIVE", "ACTIVE", clock.instant(), actor);
    }

    /**
     * Ends a reservation at {@code effective}: if that is at or before its start the reservation is cancelled entirely,
     * otherwise its period is truncated. Status becomes CANCELLED or RELEASED (evacuation with handover evidence).
     */
    public void end(Reservation r, Instant effective, String newStatus, UUID requestId, String kind, UUID actor) {
        if (!"ACTIVE".equals(r.status())) {
            throw ApiException.validation("الحجز المرتبط لم يعد نشطاً.");
        }
        Instant end = r.end() == null || effective.isBefore(r.end()) ? effective : r.end();
        boolean whole = !end.isAfter(r.start());
        jdbc.sql("""
                update reservation set status = :st, period_end = :e, updated_at = :now, version = version + 1 where id = :id""")
                .param("st", newStatus).param("e", Db.ts(whole ? r.end() : end)).param("now", Db.ts(clock.instant()))
                .param("id", r.id()).update();
        jdbc.sql("delete from reservation_lock where reservation_id = :id").param("id", r.id()).update();
        if (!whole) {
            // The part of the period already in force stays reserved and keeps blocking overlapping requests.
            insertLocks(r.id(), r.resourceId(), r.start(), end);
        }
        recordChange(r.id(), requestId, kind, r.start(), r.end(), r.start(), whole ? r.end() : end, "ACTIVE", newStatus,
                effective, actor);
    }

    private void insertLocks(UUID reservationId, UUID resourceId, Instant start, Instant end) {
        Map<String, Object> res = jdbc.sql("select name, policy, handover_minutes from resource where id = :id")
                .param("id", resourceId).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
        if (!"EXCLUSIVE".equals(res.get("policy"))) {
            return; // shared resources do not take exclusive locks (capacity rules: open item, see docs/STATUS.md)
        }
        int handover = ((Number) res.get("handover_minutes")).intValue();
        Instant blockedEnd = end == null ? null : end.plusSeconds(handover * 60L);
        try {
            jdbc.sql("""
                    insert into reservation_lock(reservation_id, resource_id, kind, period)
                    with recursive down(id) as (
                        select id from resource where id = :rid
                        union all select r.id from resource r join down on r.parent_resource_id = down.id),
                    up(id, parent_id) as (
                        select id, parent_resource_id from resource where id = :rid
                        union all select r.id, r.parent_resource_id from resource r join up on r.id = up.parent_id)
                    select :resv, id, 'X', tstzrange(:s, :e, '[)') from down
                    union all
                    select :resv, id, 'I', tstzrange(:s, :e, '[)') from up where id <> :rid""")
                    .param("rid", resourceId).param("resv", reservationId).param("s", Db.ts(start)).param("e", Db.ts(blockedEnd))
                    .update();
        } catch (DataAccessException e) {
            if (Db.isExclusionViolation(e)) {
                Map<String, Object> details = new LinkedHashMap<>();
                details.put("resourceId", resourceId.toString());
                details.put("resourceName", res.get("name"));
                throw new ApiException(ErrorCode.RESERVATION_CONFLICT,
                        "تعذر تثبيت الحجز: «" + res.get("name") + "» محجوز خلال جزء من الفترة"
                                + (handover > 0 ? " أو فترة التسليم المهيأة (" + handover + " دقيقة)" : "")
                                + ". لم يُسجل أي حجز من هذا الطلب، ويمكن إرجاعه لتعديل الفترة.", details);
            }
            throw e;
        }
    }

    private void recordChange(UUID reservationId, UUID requestId, String kind, Instant prevStart, Instant prevEnd,
                              Instant newStart, Instant newEnd, String prevStatus, String newStatus, Instant effective,
                              UUID actor) {
        jdbc.sql("""
                insert into reservation_change(id, reservation_id, request_id, change_kind, previous_start, previous_end,
                    new_start, new_end, previous_status, new_status, effective_at, created_by, created_at)
                values (:id, :r, :req, :k, :ps, :pe, :ns, :ne, :pst, :nst, :eff, :by, :now)""")
                .param("id", UUID.randomUUID()).param("r", reservationId).param("req", requestId).param("k", kind)
                .param("ps", Db.ts(prevStart)).param("pe", Db.ts(prevEnd)).param("ns", Db.ts(newStart)).param("ne", Db.ts(newEnd))
                .param("pst", prevStatus).param("nst", newStatus).param("eff", Db.ts(effective)).param("by", actor)
                .param("now", Db.ts(clock.instant())).update();
    }

    public record Conflict(String resourceId, String resourceName) {
    }

    /**
     * Preview of conflicts for a candidate period (no locks taken). The authoritative check happens again when the
     * final approval commits.
     */
    public List<Conflict> conflicts(List<UUID> resourceIds, Instant start, Instant end, UUID excludeReservation) {
        List<Conflict> out = new ArrayList<>();
        for (UUID rid : resourceIds) {
            Map<String, Object> res = jdbc.sql("select name, policy, handover_minutes from resource where id = :id")
                    .param("id", rid).query().listOfRows().stream().findFirst().orElseThrow(ApiException::notFound);
            if (!"EXCLUSIVE".equals(res.get("policy"))) {
                continue;
            }
            Instant blockedEnd = end == null ? null : end.plusSeconds(((Number) res.get("handover_minutes")).intValue() * 60L);
            boolean conflict = jdbc.sql("""
                    with recursive down(id) as (
                        select id from resource where id = :rid
                        union all select r.id from resource r join down on r.parent_resource_id = down.id),
                    up(id, parent_id) as (
                        select id, parent_resource_id from resource where id = :rid
                        union all select r.id, r.parent_resource_id from resource r join up on r.id = up.parent_id)
                    select exists (
                        select 1 from reservation_lock l
                        where l.period && tstzrange(:s, :e, '[)')
                          and (cast(:ex as uuid) is null or l.reservation_id <> cast(:ex as uuid))
                          and ((l.resource_id in (select id from down))
                               or (l.kind = 'X' and l.resource_id in (select id from up where id <> :rid))))""")
                    .param("rid", rid).param("s", Db.ts(start)).param("e", Db.ts(blockedEnd))
                    .param("ex", excludeReservation == null ? null : excludeReservation.toString())
                    .query(Boolean.class).single();
            if (conflict) {
                out.add(new Conflict(rid.toString(), (String) res.get("name")));
            }
        }
        return out;
    }
}
