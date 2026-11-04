import { MemoryDb } from './memory-db';
import type { AssetsLike, DbLike, DownloadsLike, Json, SampleFn, SampleImageLimits } from './types';

/**
 * Connects to the claude.ai artifact runtime. Each capability is optional and is
 * replaced by a local stand-in when this view cannot run it:
 *
 * - db: shared, live documents (local: an in-browser store, this device only)
 * - assets: stored frames (local: object URLs, this page load only)
 * - sample: Claude looks at the frames (local: none, so recognition waits for a device that can)
 * - downloads: saving reports and files (local: a normal browser download)
 */
export interface Runtime {
  readonly shared: boolean;
  readonly db: DbLike;
  readonly assets: AssetsLike | null;
  readonly sample: SampleFn | null;
  readonly imageLimits: SampleImageLimits | null;
  readonly downloads: DownloadsLike | null;
  /** True when a local store was filled from seed.json on this load. */
  readonly seededLocally: boolean;
}

interface ClaudeWindow {
  claude?: { use?: (name: string) => Promise<unknown> };
}

async function use<T>(name: string): Promise<T | null> {
  const c = (window as unknown as ClaudeWindow).claude;
  if (!c || typeof c.use !== 'function') return null;
  try {
    return ((await c.use(name)) as T | null) ?? null;
  } catch {
    return null;
  }
}

export interface SeedFile {
  readonly version: number;
  readonly currentWalkId: string;
  readonly previousWalkId: string;
  readonly docs: Record<string, Json>;
}

export async function loadSeed(): Promise<SeedFile> {
  const res = await fetch('./seed.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`seed.json: ${res.status}`);
  return (await res.json()) as SeedFile;
}

export async function connectRuntime(): Promise<Runtime> {
  const [db, assets, sample, downloads] = await Promise.all([
    use<DbLike>('db'),
    use<AssetsLike>('assets'),
    use<SampleFn>('sample'),
    use<DownloadsLike>('downloads'),
  ]);
  let imageLimits: SampleImageLimits | null = null;
  if (sample) {
    try {
      imageLimits = (await sample.limits()).images ?? null;
    } catch {
      imageLimits = null;
    }
  }
  if (db) return { shared: true, db, assets, sample, imageLimits, downloads, seededLocally: false };

  const local = new MemoryDb('domesday-local-v1');
  let seededLocally = false;
  if (local.size === 0) {
    try {
      const seed = await loadSeed();
      for (const [path, data] of Object.entries(seed.docs)) await local.doc(path).set(data);
      seededLocally = true;
    } catch {
      // No seed file: the app shows its empty state.
    }
  }
  return { shared: false, db: local, assets, sample, imageLimits, downloads, seededLocally };
}
