import { useSyncExternalStore } from 'react';
import { api } from '../api/client';
import type { UnitSymbol } from '../api/types';

/**
 * Unit identity symbols of organisations, fetched in batches (every component asking in the same tick shares one
 * request) and cached for the session. `null` = visible organisation without an assignment; an organisation the
 * person may not see is never returned and stays `hidden` (only its name is shown, no "not set" claim).
 */
export type SymbolState = { state: 'loading' } | { state: 'hidden' } | { state: 'none' } | { state: 'set'; symbol: UnitSymbol };

const cache = new Map<string, SymbolState>();
const listeners = new Set<() => void>();
let queued = new Set<string>();
let timer: number | undefined;
let approvedStandard: string | null = null;

function emit() {
  listeners.forEach((l) => l());
}

function flush() {
  timer = undefined;
  const ids = [...queued];
  queued = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    api
      .unitSymbols(batch)
      .then((r) => {
        approvedStandard = r.standard;
        for (const id of batch) {
          const s = r.symbols[id];
          cache.set(id, id in r.symbols ? (s ? { state: 'set', symbol: s } : { state: 'none' }) : { state: 'hidden' });
        }
        emit();
      })
      .catch(() => {
        batch.forEach((id) => cache.set(id, { state: 'hidden' }));
        emit();
      });
  }
}

function request(id: string) {
  if (cache.has(id) || queued.has(id)) return;
  cache.set(id, { state: 'loading' });
  queued.add(id);
  if (timer === undefined) timer = window.setTimeout(flush, 0);
}

const LOADING: SymbolState = { state: 'loading' };

export function useOrgSymbol(orgId: string | null | undefined): SymbolState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => {
      if (!orgId) return LOADING;
      if (!cache.has(orgId)) request(orgId);
      return cache.get(orgId) ?? LOADING;
    },
  );
}

/** After an assignment or removal: forget the cached answers so every view reloads them from the server. */
export function invalidateSymbols(ids?: string[]) {
  if (ids) ids.forEach((id) => cache.delete(id));
  else cache.clear();
  emit();
}

/** The standard and edition the institution approved (from the last lookup), e.g. «APP6-D». */
export function approvedSymbolStandard(): string | null {
  return approvedStandard;
}

export const STANDARD_LABEL: Record<string, string> = {
  'APP6-D': 'STANAG APP-6 D',
  'APP6-E': 'STANAG APP-6 E',
  '2525-D': 'MIL-STD-2525 D',
  '2525-E': 'MIL-STD-2525 E',
};

type Renderer = { Symbol: new (sidc: string, opts?: Record<string, unknown>) => { asSVG(): string; isValid(): boolean | object } };
let renderer: Promise<Renderer> | null = null;

/** The bundled renderer (milsymbol 3.0.4, MIT), loaded on first use as a separate local chunk. */
export function loadRenderer(): Promise<Renderer> {
  if (!renderer) renderer = import('milsymbol').then((m) => m.default as unknown as Renderer);
  return renderer;
}

/** SVG of a symbol as a data URL (generated locally from a checked numeric SIDC), and whether the renderer knows it. */
export async function renderSymbol(sidc: string, standard: string, size: number): Promise<{ url: string; valid: boolean }> {
  const ms = await loadRenderer();
  const sym = new ms.Symbol(sidc, { size, standard: standard === '2525' ? '2525' : 'APP6' });
  return { url: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sym.asSVG()), valid: sym.isValid() === true };
}
