import type { CollRef, DbLike, DocRef, DocSnap, Json, QuerySnap, Unsubscribe } from './types';

/**
 * An in-browser document store with the same shape as the artifact runtime's `db`,
 * for local development and for views where shared storage is not available.
 * Optionally persists to localStorage and syncs between tabs of the same browser.
 */

type Listener = () => void;

function deepMerge(target: Json, patch: Json): Json {
  const out: Json = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    const prev = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && prev && typeof prev === 'object' && !Array.isArray(prev)) {
      out[k] = deepMerge(prev as Json, v as Json);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function parentOf(path: string): string {
  const parts = path.split('/');
  return parts.slice(0, -1).join('/');
}

function snap(path: string, data: Json | undefined): DocSnap {
  const frozen = data ? (Object.freeze(clone(data)) as Json) : undefined;
  return { id: path.split('/').pop() ?? '', exists: frozen !== undefined, data: () => frozen };
}

let counter = 0;
function newId(): string {
  counter += 1;
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}${counter.toString(36)}`;
}

export class MemoryDb implements DbLike {
  private readonly docs = new Map<string, Json>();
  private readonly docListeners = new Map<string, Set<Listener>>();
  private readonly collListeners = new Map<string, Set<Listener>>();
  private readonly channel: BroadcastChannel | null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly storageKey: string | null;

  constructor(storageKey: string | null = null) {
    this.storageKey = storageKey;
    if (storageKey) {
      try {
        const raw = localStorage.getItem(storageKey);
        if (raw) for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, Json>)) this.docs.set(k, v);
      } catch {
        // Storage can be blocked; the store still works in memory.
      }
    }
    this.channel = typeof BroadcastChannel !== 'undefined' && storageKey ? new BroadcastChannel(storageKey) : null;
    this.channel?.addEventListener('message', (ev: MessageEvent<{ path: string; data: Json | null }>) => {
      const { path, data } = ev.data;
      if (data === null) this.docs.delete(path);
      else this.docs.set(path, data);
      this.notify(path, false);
    });
  }

  get size(): number {
    return this.docs.size;
  }

  /** Every document, for seeding and tests. */
  dump(): Record<string, Json> {
    return Object.fromEntries([...this.docs.entries()].map(([k, v]) => [k, clone(v)]));
  }

  private persist(): void {
    if (!this.storageKey) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(this.storageKey as string, JSON.stringify(Object.fromEntries(this.docs)));
      } catch {
        // Quota or blocked storage: keep going in memory.
      }
    }, 150);
  }

  private notify(path: string, broadcast = true): void {
    const fire = (set: Set<Listener> | undefined): void => set?.forEach((l) => queueMicrotask(l));
    fire(this.docListeners.get(path));
    fire(this.collListeners.get(parentOf(path)));
    if (broadcast) this.channel?.postMessage({ path, data: this.docs.get(path) ?? null });
    this.persist();
  }

  private write(path: string, data: Json | null): void {
    if (data === null) this.docs.delete(path);
    else this.docs.set(path, clone(data));
    this.notify(path);
  }

  doc(path: string): DocRef {
    if (path.split('/').length % 2 !== 0) throw new TypeError(`"${path}" is not a document path`);
    return {
      id: path.split('/').pop() ?? '',
      path,
      get: async () => snap(path, this.docs.get(path)),
      set: async (data) => this.write(path, data),
      update: async (data) => {
        const prev = this.docs.get(path);
        if (!prev) throw { code: 'invalid_argument', message: `${path} does not exist` };
        this.write(path, deepMerge(prev, data));
      },
      delete: async () => this.write(path, null),
      onSnapshot: (next) => {
        const l = (): void => next(snap(path, this.docs.get(path)));
        const set = this.docListeners.get(path) ?? new Set();
        set.add(l);
        this.docListeners.set(path, set);
        queueMicrotask(l);
        return () => set.delete(l);
      },
    };
  }

  collection(path: string): CollRef {
    if (path.split('/').length % 2 !== 1) throw new TypeError(`"${path}" is not a collection path`);
    const query = (): QuerySnap => ({
      docs: [...this.docs.entries()]
        .filter(([k]) => parentOf(k) === path)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => snap(k, v)),
    });
    return {
      path,
      doc: (id?: string) => this.doc(`${path}/${id ?? newId()}`),
      get: async () => query(),
      onSnapshot: (next): Unsubscribe => {
        const l = (): void => next(query());
        const set = this.collListeners.get(path) ?? new Set();
        set.add(l);
        this.collListeners.set(path, set);
        queueMicrotask(l);
        return () => set.delete(l);
      },
    };
  }
}
