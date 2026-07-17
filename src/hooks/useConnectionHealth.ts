import { useSyncExternalStore } from 'react';
import { healthStore, type HealthState } from '../lib/connectionHealth';

/**
 * React binding for the connection health store.
 * Re-renders the component whenever session/heartbeat/channel-pool state changes.
 */
export function useConnectionHealth(): HealthState {
  return useSyncExternalStore(
    (listener) => healthStore.subscribe(listener),
    () => healthStore.getState()
  );
}
