import type { PendingAnswer } from '../types';

/**
 * Offline-first answer queue for judges.
 *
 * Every answer is written here first (persisted to storage), then flushed to
 * the server. If the network is down or the request fails, the answer stays
 * queued and is retried on: reconnect, tab focus, the `online` event, and a
 * periodic timer. A later answer for the same team+question replaces the
 * earlier one, so only the judge's final choice is sent.
 *
 * Framework-free and storage-injectable so it can be unit-tested in Node.
 */

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type SendFn = (answer: PendingAnswer) => Promise<void>;

export interface FlushResult {
  sent: number;
  failed: number;
  remaining: number;
}

const MAX_ATTEMPTS_BEFORE_BACKOFF = 3;

export class OfflineAnswerQueue {
  private items: PendingAnswer[] = [];
  private listeners = new Set<() => void>();
  private flushing = false;
  private nextRetryAt = 0;

  private readonly storageKey: string;
  private readonly storage: KeyValueStorage | null;

  constructor(storageKey: string, storage: KeyValueStorage | null) {
    this.storageKey = storageKey;
    this.storage = storage;
    this.load();
  }

  // ---- persistence ----

  private load() {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(this.storageKey);
      const parsed = raw ? (JSON.parse(raw) as PendingAnswer[]) : [];
      this.items = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.items = [];
    }
  }

  private save() {
    if (!this.storage) return;
    try {
      if (this.items.length === 0) this.storage.removeItem(this.storageKey);
      else this.storage.setItem(this.storageKey, JSON.stringify(this.items));
    } catch {
      // storage full or unavailable: keep the in-memory copy
    }
    this.listeners.forEach((l) => l());
  }

  // ---- api ----

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size(): number {
    return this.items.length;
  }

  peek(): readonly PendingAnswer[] {
    return this.items;
  }

  /** Queue an answer; a newer answer for the same key replaces the old one. */
  enqueue(input: Omit<PendingAnswer, 'key' | 'queuedAt' | 'attempts'>): PendingAnswer {
    const key = `${input.team_id}|${input.question_id}`;
    const item: PendingAnswer = { ...input, key, queuedAt: Date.now(), attempts: 0 };
    this.items = this.items.filter((i) => i.key !== key);
    this.items.push(item);
    this.nextRetryAt = 0; // a fresh answer resets any backoff
    this.save();
    return item;
  }

  /**
   * Try to send everything in order. Stops at the first failure (keeps
   * ordering) and applies a short backoff after repeated failures.
   */
  async flush(send: SendFn, now = Date.now()): Promise<FlushResult> {
    if (this.flushing || this.items.length === 0 || now < this.nextRetryAt) {
      return { sent: 0, failed: 0, remaining: this.items.length };
    }
    this.flushing = true;
    let sent = 0;
    let failed = 0;
    try {
      while (this.items.length > 0) {
        const item = this.items[0];
        try {
          await send(item);
          this.items.shift();
          sent++;
          this.save();
        } catch {
          item.attempts += 1;
          failed++;
          if (item.attempts >= MAX_ATTEMPTS_BEFORE_BACKOFF) {
            this.nextRetryAt = Date.now() + Math.min(30_000, 2_000 * 2 ** (item.attempts - MAX_ATTEMPTS_BEFORE_BACKOFF));
          }
          this.save();
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
    return { sent, failed, remaining: this.items.length };
  }

  clear() {
    this.items = [];
    this.nextRetryAt = 0;
    this.save();
  }
}

/** localStorage when available (browser), otherwise memory-only. */
export function browserStorage(): KeyValueStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const probe = '__q_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}
