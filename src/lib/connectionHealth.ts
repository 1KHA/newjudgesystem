/**
 * Connection Health Store
 * ------------------------
 * Framework-agnostic store that tracks real-time connection health:
 * - Session info (id, uptime)
 * - Channel pool (every Supabase realtime channel, its status and activity)
 * - Heartbeat (last activity timestamp)
 * - Connection status (connected / reconnecting / disconnected)
 * - Reconnect attempts + recent event log
 *
 * It deliberately has NO dependency on React or Supabase so it can be
 * unit-tested in plain Node. React components subscribe via
 * `useSyncExternalStore` (see useConnectionHealth in hooks/useConnectionHealth.ts).
 */

export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

export interface ChannelInfo {
  name: string;
  status: string; // SUBSCRIBED | CLOSED | CHANNEL_ERROR | TIMED_OUT | joining...
  subscribedAt: number | null;
  lastEventAt: number | null;
  eventCount: number;
}

export interface LogEntry {
  at: number;
  message: string;
}

export interface HealthState {
  sessionId: string;
  sessionStartedAt: number | null;
  status: ConnectionStatus;
  lastHeartbeatAt: number | null;
  reconnectCount: number;
  channels: ChannelInfo[];
  log: LogEntry[];
}

const MAX_LOG_ENTRIES = 50;

/** How long (ms) without any heartbeat before the connection is considered stale */
export const STALE_THRESHOLD_MS = 60_000;
/** How long (ms) without heartbeat after a wake/focus before forcing reconnect */
export const WAKE_THRESHOLD_MS = 30_000;
/** Interval (ms) between automatic health checks */
export const HEALTH_CHECK_INTERVAL_MS = 30_000;

const initialState: HealthState = {
  sessionId: '',
  sessionStartedAt: null,
  status: 'disconnected',
  lastHeartbeatAt: null,
  reconnectCount: 0,
  channels: [],
  log: []
};

let state: HealthState = initialState;
const listeners = new Set<() => void>();

function setState(partial: Partial<HealthState>) {
  state = { ...state, ...partial };
  listeners.forEach(l => l());
}

function pushLog(message: string) {
  const entry: LogEntry = { at: Date.now(), message };
  const log = [entry, ...state.log].slice(0, MAX_LOG_ENTRIES);
  state = { ...state, log };
}

export const healthStore = {
  getState: (): HealthState => state,

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** Bind the store to an active session */
  startSession(sessionId: string, now = Date.now()) {
    setState({
      sessionId,
      sessionStartedAt: now,
      status: 'reconnecting',
      lastHeartbeatAt: now,
      reconnectCount: 0,
      channels: []
    });
    pushLog(`Session started: ${sessionId}`);
    listeners.forEach(l => l());
  },

  /** Detach from the session and reset everything (used on session end) */
  endSession() {
    setState({ ...initialState });
    pushLog('Session ended');
    listeners.forEach(l => l());
  },

  setStatus(status: ConnectionStatus) {
    if (state.status !== status) {
      setState({ status });
      pushLog(`Status: ${status}`);
      listeners.forEach(l => l());
    }
  },

  /** Record connection activity (data received, successful load, etc.) */
  heartbeat(now = Date.now()) {
    setState({ lastHeartbeatAt: now });
  },

  /** Milliseconds since the last heartbeat (null if never beat) */
  msSinceHeartbeat(now = Date.now()): number | null {
    return state.lastHeartbeatAt === null ? null : now - state.lastHeartbeatAt;
  },

  /** True when no heartbeat has been seen for longer than `threshold` ms */
  isStale(threshold = STALE_THRESHOLD_MS, now = Date.now()): boolean {
    const ms = this.msSinceHeartbeat(now);
    return ms !== null && ms > threshold;
  },

  noteReconnect() {
    setState({ reconnectCount: state.reconnectCount + 1 });
    pushLog(`Reconnect attempt #${state.reconnectCount + 1}`);
    listeners.forEach(l => l());
  },

  // ---- Channel pool ----

  registerChannel(name: string) {
    const channels = state.channels.filter(c => c.name !== name);
    channels.push({ name, status: 'joining', subscribedAt: null, lastEventAt: null, eventCount: 0 });
    setState({ channels });
    pushLog(`Channel registered: ${name}`);
    listeners.forEach(l => l());
  },

  updateChannelStatus(name: string, status: string, now = Date.now()) {
    const channels = state.channels.map(c =>
      c.name === name
        ? { ...c, status, subscribedAt: status === 'SUBSCRIBED' ? (c.subscribedAt ?? now) : c.subscribedAt }
        : c
    );
    setState({ channels });
    pushLog(`Channel ${name}: ${status}`);
    listeners.forEach(l => l());
  },

  noteChannelEvent(name: string, now = Date.now()) {
    const channels = state.channels.map(c =>
      c.name === name
        ? { ...c, lastEventAt: now, eventCount: c.eventCount + 1 }
        : c
    );
    setState({ channels, lastHeartbeatAt: now });
  },

  removeChannel(name: string) {
    const channels = state.channels.filter(c => c.name !== name);
    setState({ channels });
    pushLog(`Channel removed: ${name}`);
    listeners.forEach(l => l());
  },

  logEvent(message: string) {
    pushLog(message);
    listeners.forEach(l => l());
  }
};
