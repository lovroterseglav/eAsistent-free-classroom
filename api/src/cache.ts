interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TimedLruCache<T> {
  readonly #entries = new Map<string, CacheEntry<T>>();

  constructor(
    readonly ttlMs = 5 * 60_000,
    readonly maxEntries = 500,
  ) {}

  get size(): number {
    this.removeExpired();
    return this.#entries.size;
  }

  get(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    this.removeExpired();
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#entries.delete(oldest);
    }
  }

  private removeExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
  }
}
