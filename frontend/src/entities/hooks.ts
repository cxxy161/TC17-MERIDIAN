import { useMemo } from 'react';
import { useGameStore } from '../store/useGameStore';
import { buildCatalogIndex, type CatalogIndex } from './catalogIndex';
import { buildWorldIndex, type WorldIndex } from './worldIndex';

/**
 * `catalog` is replaced only when the production pack is (re)loaded, so this index is built once
 * per pack instead of being rebuilt inside every panel render.
 */
export function useCatalogIndex(): CatalogIndex {
  const catalog = useGameStore((s) => s.catalog);
  return useMemo(() => buildCatalogIndex(catalog), [catalog]);
}

/**
 * `state` is replaced on every tick, so this rebuilds each tick — but it walks only the entries
 * that actually exist (sparse holdings) plus one pass over the tickers, instead of every panel
 * re-deriving its own maps/filters from raw arrays.
 */
export function useWorldIndex(): WorldIndex {
  const state = useGameStore((s) => s.state);
  return useMemo(() => buildWorldIndex(state), [state]);
}
