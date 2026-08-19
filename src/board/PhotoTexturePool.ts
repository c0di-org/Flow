import { Assets, Texture } from 'pixi.js';

type Entry = {
  texture: Texture;
  estimatedBytes: number;
  lastUsed: number;
  refs: number;
};

function suggestedBudget() {
  const ua = navigator.userAgent.toLowerCase();
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (/android|mobile/.test(ua)) return 96 * 1024 * 1024;
  if (memory && memory <= 4) return 128 * 1024 * 1024;
  if (memory && memory >= 16) return 320 * 1024 * 1024;
  return 224 * 1024 * 1024;
}

export class PhotoTexturePool {
  private entries = new Map<string, Entry>();
  private loading = new Map<string, Promise<Texture>>();
  private queue: Array<() => void> = [];
  private activeLoads = 0;
  private generation = 0;
  private clearing?: Promise<void>;

  constructor(private readonly budgetBytes = suggestedBudget(), private readonly maxConcurrentLoads = 4) {}

  private async withSlot<T>(work: () => Promise<T>): Promise<T> {
    if (this.activeLoads >= this.maxConcurrentLoads) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.activeLoads++;
    try {
      return await work();
    } finally {
      this.activeLoads--;
      this.queue.shift()?.();
    }
  }

  async acquire(url: string): Promise<Texture> {
    if (this.clearing) await this.clearing;
    const existing = this.entries.get(url);
    if (existing) {
      existing.lastUsed = performance.now();
      existing.refs++;
      return existing.texture;
    }

    const inflight = this.loading.get(url);
    if (inflight) {
      const texture = await inflight;
      const entry = this.entries.get(url);
      if (entry) entry.refs++;
      return texture;
    }

    const generation = this.generation;
    let promise: Promise<Texture>;
    promise = this.withSlot(() => Assets.load(url) as Promise<Texture>).then((texture: Texture) => {
      if (generation !== this.generation) {
        throw new Error('Texture load was superseded by a renderer reset');
      }
      const estimatedBytes = Math.max(1, texture.width) * Math.max(1, texture.height) * 4;
      this.entries.set(url, { texture, estimatedBytes, lastUsed: performance.now(), refs: 1 });
      if (this.loading.get(url) === promise) this.loading.delete(url);
      void this.evict();
      return texture;
    }).catch((error) => {
      if (this.loading.get(url) === promise) this.loading.delete(url);
      throw error;
    });
    this.loading.set(url, promise);
    return promise;
  }

  release(url: string) {
    const entry = this.entries.get(url);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    entry.lastUsed = performance.now();
    void this.evict();
  }

  touch(url: string) {
    const entry = this.entries.get(url);
    if (entry) entry.lastUsed = performance.now();
  }

  private async evict() {
    let total = [...this.entries.values()].reduce((sum, entry) => sum + entry.estimatedBytes, 0);
    if (total <= this.budgetBytes) return;

    const candidates = [...this.entries.entries()]
      .filter(([, entry]) => entry.refs === 0)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);

    for (const [url, entry] of candidates) {
      if (total <= this.budgetBytes) break;
      this.entries.delete(url);
      total -= entry.estimatedBytes;
      await Assets.unload(url).catch(() => undefined);
    }
  }

  async clear() {
    if (this.clearing) return this.clearing;
    this.generation++;
    const pendingUrls = [...this.loading.keys()];
    const pending = [...this.loading.values()];
    const loadedUrls = [...this.entries.keys()];
    this.loading.clear();
    this.entries.clear();

    const task = (async () => {
      // Let already-started/queued loads settle before unloading their shared
      // Assets cache entries. New acquires wait on `clearing`, preventing a
      // context-reset race from unloading a freshly re-requested texture.
      await Promise.allSettled(pending);
      const urls = [...new Set([...loadedUrls, ...pendingUrls])];
      await Promise.all(urls.map((url) => Assets.unload(url).catch(() => undefined)));
    })();
    this.clearing = task;
    try {
      await task;
    } finally {
      if (this.clearing === task) this.clearing = undefined;
    }
  }
}
