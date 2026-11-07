import { maxFootprintOn } from './terrainAnalysis';
import { describe, expect, it } from 'vitest';
import type { GeoPolygon, TerrainAssessment } from '../api/types';
import { connectors, discrepancy, previewLeg, ruleLines, serverLegFor, VERDICT } from './terrainAnalysis';

const sq = (lng: number, lat: number, d = 0.003): GeoPolygon => ({ type: 'Polygon', coordinates: [[[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]]] });

const assessment = (o: Partial<TerrainAssessment> = {}): TerrainAssessment => ({
  datasetCode: 'copernicus-glo30',
  datasetVersion: '2026.11',
  surfaceModel: 'DSM',
  method: 'PIXEL_CENTRE_COUNT/LARGEST_SHARE/PRIORITY_TIE',
  policyVersion: 2,
  shares: [{ code: 'MOUNTAINOUS', label: 'جبلي', cells: 58, areaM2: 52000, percent: 58 }],
  coveredCells: 100,
  estimatedCells: 100,
  controllingClass: 'MOUNTAINOUS',
  controllingLabel: 'جبلي',
  tie: false,
  tied: [],
  resolved: true,
  allowanceM: 2000,
  primary: { baseMinM: 5000, baseMaxM: 8000, effectiveMinM: 5000, effectiveMaxM: 10000, terrainApplies: true },
  alternative: { baseMinM: 3000, baseMaxM: 5000, effectiveMinM: 3000, effectiveMaxM: 7000, terrainApplies: true },
  ...o,
});

describe('connectors of the 3D view', () => {
  const g = { current: sq(56.0, 24.8), site: sq(56.08, 24.85), primary: sq(56.12, 24.9), alternative: sq(56.15, 24.92) };

  it('are exactly current → site, site → primary, primary → alternative, in that direction', () => {
    const c = connectors(g);
    expect(c.map((x) => x.kind)).toEqual(['move', 'primary', 'alternative']);
    expect(c[0].fromLabel).toBe('الموقع الحالي');
    expect(c[0].toLabel).toBe('موقع إعادة التمركز');
    expect(c[1].toLabel).toBe('منطقة الانتشار الرئيسية');
    // the alternative is reached from the PRIMARY area, never from the re-stationing site
    expect(c[2].fromLabel).toBe('منطقة الانتشار الرئيسية');
    expect(c[2].from).toEqual(c[1].to);
    expect(c[2].toLabel).toBe('منطقة الانتشار البديلة');
  });

  it('draw only the legs whose two ends exist, never all to all', () => {
    expect(connectors({ ...g, primary: null }).map((x) => x.kind)).toEqual(['move']);
    expect(connectors({ ...g, current: null }).map((x) => x.kind)).toEqual(['primary', 'alternative']);
    expect(connectors({ current: null, site: null, primary: null, alternative: null })).toEqual([]);
  });
});

describe('deployment leg preview (the server decides on save)', () => {
  const policy = { exception: { allowed: true, maxExtraM: 1000 } };

  it('uses the server analysis range: the allowance raises the maximum only', () => {
    const l = previewLeg('primary', 9400, assessment(), policy)!;
    expect(l.status).toBe('OK');
    expect([l.baseMinM, l.baseMaxM, l.effectiveMinM, l.effectiveMaxM]).toEqual([5000, 8000, 5000, 10000]);
    expect(l.terrain?.allowanceM).toBe(2000);
    expect(ruleLines(l)).toEqual({ base: '5–8 كم', terrain: '+2 كم (جبلي)', effective: '5–10 كم', exception: 'حتى 11 كم باستثناء معتمد' });
  });

  it('flat ground has no allowance; beyond the maximum is out of range or needs the exception', () => {
    const flat = assessment({ controllingClass: 'FLAT', controllingLabel: 'مستوٍ', allowanceM: 0, primary: { baseMinM: 5000, baseMaxM: 8000, effectiveMinM: 5000, effectiveMaxM: 8000, terrainApplies: true } });
    expect(previewLeg('primary', 9400, flat, policy)!.status).toBe('OUT_OF_RANGE');
    expect(previewLeg('primary', 8600, flat, policy)!.status).toBe('NEEDS_EXCEPTION');
    expect(previewLeg('primary', 8600, flat, { exception: { allowed: false, maxExtraM: 0 } })!.status).toBe('OUT_OF_RANGE');
    expect(previewLeg('primary', 4000, flat, policy)!.status).toBe('OUT_OF_RANGE');
    expect(ruleLines(previewLeg('primary', 6000, flat, null)!).terrain).toBe('+0 كم (مستوٍ)');
  });

  it('the alternative leg reads the alternative range; an unresolved tie blocks', () => {
    expect(previewLeg('alternative', 6500, assessment(), policy)!.status).toBe('OK');
    expect(previewLeg('alternative', 6500, assessment({ tie: true, resolved: false }), policy)!.status).toBe('TERRAIN_TIE_UNRESOLVED');
    expect(previewLeg('alternative', null, assessment(), policy)!.status).toBe('NOT_PLACED');
    expect(previewLeg('alternative', 6500, null, policy)).toBeUndefined();
    expect(VERDICT.OK.text).toBe('ضمن النطاق');
  });

  it('the server check counts only for the geometry it checked, and a disagreement is reported', () => {
    const server = { ...previewLeg('primary', 9400, assessment(), policy)!, effectiveMaxM: 9000 };
    expect(serverLegFor('primary', { legs: [server] }, 'a', 'a')).toBe(server);
    expect(serverLegFor('primary', { legs: [server] }, 'a', 'b')).toBeNull();
    expect(discrepancy(previewLeg('primary', 9400, assessment(), policy), server)).toBe('النطاق الفعّال يختلف عن فحص الخادم');
    expect(discrepancy(previewLeg('primary', 9400, assessment(), policy), { ...server, effectiveMaxM: 10000 })).toBeNull();
  });
});

describe('the footprint on ground that is not flat', () => {
  const classes = [{ code: 'FLAT', label: 'مستوٍ', fromPct: 0, toPct: 2 }, { code: 'HILLY', label: 'تلال', fromPct: 2, toPct: null }];
  const policy = (footprintTerrainExtra: { kind: 'ABSOLUTE' | 'PERCENT'; value: number } | null) =>
    ({ maxFootprintAreaM2: 2_000_000, footprintTerrainExtra, terrainSlopeClassification: { datasetCode: '', datasetVersion: '', classes } });

  it('adds only where the ground is not flat, an amount or a percentage', () => {
    expect(maxFootprintOn(policy({ kind: 'PERCENT', value: 20 }), 'HILLY')).toBe(2_400_000);
    expect(maxFootprintOn(policy({ kind: 'ABSOLUTE', value: 500_000 }), 'HILLY')).toBe(2_500_000);
    expect(maxFootprintOn(policy({ kind: 'PERCENT', value: 20 }), 'FLAT')).toBe(2_000_000);
    expect(maxFootprintOn(policy({ kind: 'PERCENT', value: 20 }), null)).toBe(2_000_000);
    expect(maxFootprintOn(policy(null), 'HILLY')).toBe(2_000_000);
  });
});
