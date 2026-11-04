/**
 * Stationing Model V3 (docs/STATIONING_MODEL_V3_AR.md) — domain logic and its foundation persistence (ADR-031, V18).
 *
 * <p>Four concepts stay separate: the Oracle hierarchy ({@link ae.mover.stationing.OrgHierarchy}), the site ↔ unit link
 * ({@code site_link}), authoritative stationing ({@code org_stationing}) and facility responsibility (the existing
 * {@code site_responsibility}); occupancy is its own concept ({@link ae.mover.stationing.OccupancyRule}). V18 holds the
 * versioned policy, stationing, links, the outbound outbox and the terrain slope dataset; re-stationing requests,
 * deployment areas and their routes follow with the request workflow. No page uses this package yet.
 */
package ae.mover.stationing;
