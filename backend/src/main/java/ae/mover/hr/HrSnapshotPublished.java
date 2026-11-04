package ae.mover.hr;

import java.util.UUID;

/** Published after an HR snapshot has been published and projected (committed); listeners re-check what depends on the hierarchy. */
public record HrSnapshotPublished(UUID snapshotId) {
}
