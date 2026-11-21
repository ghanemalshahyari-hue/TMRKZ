import { describe, expect, it } from 'vitest';
import type { PostureUnit } from '../api/client';
import {
  COMPLETENESS_LABEL,
  EXPIRING_DAYS,
  MISSING_LABEL,
  TIMING_LABEL,
  completenessOf,
  matchesFilter,
  missingOf,
  postureCounts,
  timingOf,
} from './operationalPostureStatus';

/**
 * Operational-posture meaning-layer brief (owner, 21 Nov 2026 — FINISH THE OPERATIONAL POSTURE MEANING LAYER):
 * targeted tests for the shared status helper that every surface (tabs, list, detail, dock, map) reads from.
 *
 * Numbering mirrors the brief's §31 «TARGETED UI TESTS».
 */

const geom = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };

const baseUnit = (over: Partial<PostureUnit>): PostureUnit => ({
  id: 'u', code: 'U', name: 'الوحدة', parentId: null, depth: 0, state: 'STATIONED',
  kind: 'PERMANENT', plannedEnd: null, primary: null, alternative: null,
  site: null, otherUnitsAtSite: 0, request: null,
  ...over,
});

describe('operationalPostureStatus — shared status model (brief §2)', () => {
  it('POSTURE-STATUS-01: a unit with site + PRIMARY + SUB is COMPLETE', () => {
    const u = baseUnit({ site: { id: 's', name: 'موقع', geometry: null }, primary: geom, alternative: geom });
    expect(completenessOf(u)).toBe('COMPLETE');
    expect(COMPLETENESS_LABEL.COMPLETE).toBe('موقف مكتمل');
    expect(missingOf(u)).toBeNull();
  });

  it('POSTURE-STATUS-02: INCOMPLETE_DEPLOYMENT when PRIMARY is missing; row carries «ينقص الرئيسية»', () => {
    const u = baseUnit({ site: { id: 's', name: 'موقع', geometry: null }, primary: null, alternative: geom });
    expect(completenessOf(u)).toBe('INCOMPLETE_DEPLOYMENT');
    expect(missingOf(u)).toBe('PRIMARY');
    expect(MISSING_LABEL.PRIMARY).toBe('ينقص الرئيسية');
  });

  it('POSTURE-STATUS-03: INCOMPLETE_DEPLOYMENT when SUB is missing; row carries «ينقص الفرعية»', () => {
    const u = baseUnit({ site: { id: 's', name: 'موقع', geometry: null }, primary: geom, alternative: null });
    expect(completenessOf(u)).toBe('INCOMPLETE_DEPLOYMENT');
    expect(missingOf(u)).toBe('SUB');
  });

  it('POSTURE-STATUS-03b: both areas missing — «تنقص الرئيسية والفرعية»', () => {
    const u = baseUnit({ site: { id: 's', name: 'موقع', geometry: null }, primary: null, alternative: null });
    expect(missingOf(u)).toBe('BOTH');
    expect(MISSING_LABEL.BOTH).toBe('تنقص الرئيسية والفرعية');
  });

  it('POSTURE-STATUS-04: no site → NO_STATIONING, timing NONE', () => {
    const u = baseUnit({});
    expect(completenessOf(u)).toBe('NO_STATIONING');
    expect(timingOf(u)).toBe('NONE');
  });

  it('POSTURE-STATUS-05: TEMPORARY timing when kind=TEMPORARY and plannedEnd is comfortably in the future', () => {
    const far = new Date(Date.now() + 365 * 86_400_000).toISOString();
    const u = baseUnit({ site: { id: 's', name: 'موقع', geometry: null }, kind: 'TEMPORARY', plannedEnd: far });
    expect(timingOf(u)).toBe('TEMPORARY');
    expect(TIMING_LABEL.TEMPORARY).toBe('تمركز مؤقت');
  });

  it(`POSTURE-STATUS-06: TEMPORARY_EXPIRING when plannedEnd is within ${EXPIRING_DAYS} days (brief §3: reuse shared threshold)`, () => {
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const u = baseUnit({ site: { id: 's', name: 'موقع', geometry: null }, kind: 'TEMPORARY', plannedEnd: soon });
    expect(timingOf(u)).toBe('TEMPORARY_EXPIRING');
  });
});

describe('operationalPostureStatus — filter (brief §6/§7 one filter drives list + map)', () => {
  const complete = baseUnit({ id: 'a', site: { id: 's1', name: 'A', geometry: null }, primary: geom, alternative: geom });
  const incomplete = baseUnit({ id: 'b', site: { id: 's2', name: 'B', geometry: null }, primary: geom, alternative: null });
  const noStation = baseUnit({ id: 'c' });
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const expiring = baseUnit({ id: 'd', site: { id: 's3', name: 'D', geometry: null }, primary: geom, alternative: geom, kind: 'TEMPORARY', plannedEnd: soon });
  const withRequest = baseUnit({ id: 'e', site: { id: 's4', name: 'E', geometry: null }, primary: geom, alternative: geom, request: { purpose: 'DEPLOYMENT_AREAS', state: 'UNDER_REVIEW' } });

  it('POSTURE-FILTER-01: filter=COMPLETE lets COMPLETE units through and omits the rest', () => {
    expect(matchesFilter(complete, 'COMPLETE')).toBe(true);
    expect(matchesFilter(incomplete, 'COMPLETE')).toBe(false);
    expect(matchesFilter(noStation, 'COMPLETE')).toBe(false);
  });

  it('POSTURE-FILTER-02: filter=INCOMPLETE lets site+missing-area units through', () => {
    expect(matchesFilter(complete, 'INCOMPLETE')).toBe(false);
    expect(matchesFilter(incomplete, 'INCOMPLETE')).toBe(true);
    expect(matchesFilter(noStation, 'INCOMPLETE')).toBe(false);
  });

  it('POSTURE-FILTER-03: filter=NO_STATIONING shows the unsited unit only', () => {
    expect(matchesFilter(noStation, 'NO_STATIONING')).toBe(true);
    expect(matchesFilter(complete, 'NO_STATIONING')).toBe(false);
  });

  it('POSTURE-FILTER-04: filter=EXPIRING is stricter than TEMPORARY — a far temporary never matches EXPIRING', () => {
    const far = new Date(Date.now() + 365 * 86_400_000).toISOString();
    const farTemp = baseUnit({ id: 'f', site: { id: 's5', name: 'F', geometry: null }, primary: geom, alternative: geom, kind: 'TEMPORARY', plannedEnd: far });
    expect(matchesFilter(farTemp, 'TEMPORARY')).toBe(true);
    expect(matchesFilter(farTemp, 'EXPIRING')).toBe(false);
    expect(matchesFilter(expiring, 'EXPIRING')).toBe(true);
    expect(matchesFilter(expiring, 'TEMPORARY')).toBe(true);
  });

  it('POSTURE-FILTER-05: filter=REQUESTS is independent of completeness', () => {
    expect(matchesFilter(withRequest, 'REQUESTS')).toBe(true);
    expect(matchesFilter(complete, 'REQUESTS')).toBe(false);
  });

  it('POSTURE-COUNT-01: the dock counts equal the map/list population — no hard-coded totals', () => {
    const counts = postureCounts([complete, incomplete, noStation, expiring, withRequest]);
    expect(counts.all).toBe(5);
    expect(counts.complete).toBe(3); // complete + expiring + withRequest (they have both areas)
    expect(counts.incomplete).toBe(1);
    expect(counts.noStationing).toBe(1);
    expect(counts.temporary).toBe(1);
    expect(counts.expiring).toBe(1);
    expect(counts.requests).toBe(1);
    expect(counts.sites).toBe(4);
  });
});
