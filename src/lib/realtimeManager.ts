import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { healthStore, STALE_THRESHOLD_MS } from './connectionHealth';

/**
 * Keeps a set of Supabase realtime channels alive for hours.
 *
 * What it guards against (all seen in the production soak test):
 *   - channels that go CLOSED / CHANNEL_ERROR / TIMED_OUT and never rejoin
 *   - sockets dropped by sleep, tab freeze, or network loss
 *   - "healthy-looking" sockets that silently stopped delivering
 *
 * Mechanism:
 *   - every `watchdogMs` it runs a tiny server ping (proves the network),
 *     checks the socket and every channel's state, and rebuilds whatever is
 *     not joined.
 *   - browser `online`, `focus` and `visibilitychange` events trigger an
 *     immediate check, so waking a laptop reconnects within a second.
 *   - a full rebuild happens if nothing at all was heard for STALE_THRESHOLD_MS.
 *
 * Health is reported to `healthStore` so the /health page and the header chip
 * stay truthful.
 */

export interface ChannelSpec {
  name: string;
  /** Attach `.on(...)` handlers. Called each time the channel is (re)built. */
  configure: (channel: RealtimeChannel) => RealtimeChannel;
}

export interface RealtimeManagerOptions {
  client: SupabaseClient;
  /** Cheap request that proves the server is reachable (e.g. read one row). */
  ping: () => Promise<void>;
  /** Called after any successful rebuild so the page can reload state it may have missed. */
  onResync?: (reason: string) => void;
  watchdogMs?: number;
}

type JoinState = 'closed' | 'errored' | 'joined' | 'joining' | 'leaving';

export class RealtimeManager {
  private channels = new Map<string, RealtimeChannel>();
  private specs: ChannelSpec[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private checking = false;
  private lastRebuildAt = 0;
  private readonly watchdogMs: number;

  private readonly opts: RealtimeManagerOptions;

  constructor(opts: RealtimeManagerOptions) {
    this.opts = opts;
    this.watchdogMs = opts.watchdogMs ?? 15_000;
    this.onWake = this.onWake.bind(this);
  }

  start(specs: ChannelSpec[]) {
    this.specs = specs;
    this.running = true;
    for (const spec of specs) this.build(spec);
    this.timer = setInterval(() => void this.check('watchdog'), this.watchdogMs);
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onWake);
      window.addEventListener('focus', this.onWake);
      document.addEventListener('visibilitychange', this.onWake);
    }
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onWake);
      window.removeEventListener('focus', this.onWake);
      document.removeEventListener('visibilitychange', this.onWake);
    }
    for (const [name, ch] of this.channels) {
      healthStore.removeChannel(name);
      void this.destroy(ch);
    }
    this.channels.clear();
  }

  /**
   * Fully dispose a channel. `client.removeChannel()` only drops the channel
   * from the client's list when the server acknowledges the leave, which never
   * happens on a dead socket; the next `client.channel(sameTopic)` would then
   * return the dying object and stay stuck in "leaving" forever.
   */
  private async destroy(ch: RealtimeChannel) {
    const client = this.opts.client;
    try {
      await Promise.race([client.removeChannel(ch), new Promise((r) => setTimeout(r, 3000))]);
    } catch { /* socket already gone */ }
    try { ch.teardown(); } catch { /* already torn down */ }
    const rt = client.realtime as unknown as { channels: RealtimeChannel[] };
    rt.channels = rt.channels.filter((c) => c !== ch);
  }

  /** Tear everything down and rebuild (manual "refresh" button, wake from sleep). */
  async reconnectAll(reason: string) {
    if (!this.running) return;
    healthStore.noteReconnect();
    healthStore.setStatus('reconnecting');
    healthStore.logEvent(`Rebuilding channels: ${reason}`);
    for (const [, ch] of this.channels) await this.destroy(ch);
    this.channels.clear();
    this.opts.client.realtime.connect();
    for (const spec of this.specs) this.build(spec);
    this.lastRebuildAt = Date.now();
    this.opts.onResync?.(reason);
  }

  /** Run one health check now (used by the page's manual refresh). */
  checkNow(reason = 'manual') {
    return this.check(reason);
  }

  /** The live channel object (for broadcast sends). Undefined while rebuilding. */
  getChannel(name: string): RealtimeChannel | undefined {
    return this.channels.get(name);
  }

  /** Send a broadcast on one of the managed channels; false if not currently joined. */
  async broadcast(name: string, event: string, payload: Record<string, unknown>): Promise<boolean> {
    const ch = this.channels.get(name);
    if (!ch || this.state(ch) !== 'joined') return false;
    const res = await ch.send({ type: 'broadcast', event, payload });
    return res === 'ok';
  }

  // ---- internals ----

  private onWake() {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    void this.check('wake');
  }

  private build(spec: ChannelSpec) {
    const client = this.opts.client;
    healthStore.registerChannel(spec.name);
    const channel = spec.configure(client.channel(spec.name));
    channel.subscribe((status) => {
      healthStore.updateChannelStatus(spec.name, status);
      if (status === 'SUBSCRIBED') {
        healthStore.heartbeat();
        this.updateOverallStatus();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        // Phoenix will retry on its own; the watchdog rebuilds if it stays broken.
        this.updateOverallStatus();
      }
    });
    this.channels.set(spec.name, channel);
  }

  private state(ch: RealtimeChannel): JoinState {
    return (ch as unknown as { state: JoinState }).state;
  }

  private updateOverallStatus() {
    if (!this.running) return;
    const states = [...this.channels.values()].map((c) => this.state(c));
    if (states.length && states.every((s) => s === 'joined')) healthStore.setStatus('connected');
    else if (states.some((s) => s === 'errored' || s === 'closed')) healthStore.setStatus('disconnected');
    else healthStore.setStatus('reconnecting');
  }

  private async check(reason: string) {
    if (!this.running || this.checking) return;
    this.checking = true;
    try {
      // 1. Network reachability
      let pingOk = true;
      try {
        await this.opts.ping();
        healthStore.heartbeat();
      } catch {
        pingOk = false;
        healthStore.setStatus('disconnected');
      }
      if (!pingOk) return; // no point rebuilding channels without a network

      // 2. Socket
      const socketUp = this.opts.client.realtime.isConnected();

      // 3. Channels
      const broken = [...this.channels.entries()].filter(([, ch]) => {
        const s = this.state(ch);
        return s === 'errored' || s === 'closed';
      });

      const stale = healthStore.isStale(STALE_THRESHOLD_MS) && Date.now() - this.lastRebuildAt > STALE_THRESHOLD_MS;

      if (!socketUp || stale) {
        await this.reconnectAll(!socketUp ? `socket down (${reason})` : `stale (${reason})`);
        return;
      }

      if (broken.length) {
        healthStore.logEvent(`Rebuilding ${broken.length} channel(s): ${reason}`);
        for (const [name, ch] of broken) {
          await this.destroy(ch);
          this.channels.delete(name);
          const spec = this.specs.find((s) => s.name === name);
          if (spec) this.build(spec);
        }
        this.lastRebuildAt = Date.now();
        this.opts.onResync?.(`channels rebuilt (${reason})`);
        return;
      }

      this.updateOverallStatus();
    } finally {
      this.checking = false;
    }
  }
}
