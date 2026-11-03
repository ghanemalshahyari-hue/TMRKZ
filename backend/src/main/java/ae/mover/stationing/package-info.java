/**
 * Stationing Model V3 (docs/STATIONING_MODEL_V3_AR.md) — production domain logic prepared before its schema.
 *
 * <p>Four concepts stay separate: the Oracle hierarchy ({@link ae.mover.stationing.OrgHierarchy}), the site ↔ unit link,
 * authoritative stationing and facility responsibility (the existing {@code site_responsibility}); occupancy is its own
 * concept ({@link ae.mover.stationing.OccupancyRule}). The link, stationing, occupancy, deployment-area, policy-version
 * and outbox tables are proposed in the stop-gate report and are created only after ADR-028/V17 is deployed with the
 * owner's approval. Nothing in this package is wired into a user-visible path yet.
 */
package ae.mover.stationing;
