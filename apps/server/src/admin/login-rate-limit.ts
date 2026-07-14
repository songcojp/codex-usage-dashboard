type Entry = { failures: number; startedAt: number; updatedAt: number };

export type LoginRateLimiterOptions = {
  now?: () => number;
  maxFailures?: number;
  windowMs?: number;
  capacity?: number;
  cleanupIntervalMs?: number;
};

export class LoginRateLimiter {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;
  readonly #maxFailures: number;
  readonly #windowMs: number;
  readonly #capacity: number;
  readonly #cleanupIntervalMs: number;
  #lastCleanupAt: number;

  constructor(options: LoginRateLimiterOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxFailures = options.maxFailures ?? 5;
    this.#windowMs = options.windowMs ?? 15 * 60 * 1000;
    this.#capacity = options.capacity ?? 10_000;
    this.#cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000;
    this.#lastCleanupAt = this.#now();
  }

  get size(): number { return this.#entries.size; }
  has(key: string): boolean { return this.#entries.has(key); }

  isBlocked(key: string): boolean {
    const now = this.#now();
    this.#cleanup(now);
    const entry = this.#activeEntry(key, now);
    return entry !== undefined && entry.failures >= this.#maxFailures;
  }

  recordFailure(key: string): boolean {
    const now = this.#now();
    this.#cleanup(now);
    const current = this.#activeEntry(key, now);
    if (!current && !this.#entries.has(key) && this.#entries.size >= this.#capacity) this.#evictOldest();
    const entry = current ?? { failures: 0, startedAt: now, updatedAt: now };
    entry.failures += 1;
    entry.updatedAt = now;
    this.#entries.set(key, entry);
    return entry.failures > this.#maxFailures;
  }

  reset(key: string): void { this.#entries.delete(key); }

  #activeEntry(key: string, now: number): Entry | undefined {
    const entry = this.#entries.get(key);
    if (entry && now - entry.startedAt >= this.#windowMs) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry;
  }

  #cleanup(now: number): void {
    if (now - this.#lastCleanupAt < this.#cleanupIntervalMs) return;
    for (const [key, entry] of this.#entries) {
      if (now - entry.startedAt >= this.#windowMs) this.#entries.delete(key);
    }
    this.#lastCleanupAt = now;
  }

  #evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestUpdatedAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.#entries) {
      if (entry.updatedAt < oldestUpdatedAt) {
        oldestKey = key;
        oldestUpdatedAt = entry.updatedAt;
      }
    }
    if (oldestKey !== undefined) this.#entries.delete(oldestKey);
  }
}
