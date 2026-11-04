import { setAssetUrlMode } from './media';
import { MemoryDb } from './memory-db';
import { createServerRuntime } from './server';
import type { AssetsLike, DbLike, DownloadsLike, Json, SampleFn, SampleImageLimits } from './types';

/**
 * Connects the app to wherever it is running:
 *
 * - artifact: inside claude.ai, through `window.claude.use(name)`.
 * - server: on the Domesday website, through the functions in apps/web/api (see DEPLOY.md).
 * - local: neither, so an in-browser store on this device (filled from seed.json).
 *
 * Each capability is optional and is replaced by a local stand-in when this view cannot run it:
 *
 * - db: shared, live documents (local: an in-browser store, this device only)
 * - assets: stored frames (local: object URLs, this page load only)
 * - sample: Claude looks at the frames (local: none, so recognition waits for a device that can)
 * - downloads: saving reports and files (website and local: a normal browser download)
 */
export interface Runtime {
  readonly mode: 'artifact' | 'server' | 'local';
  /** True when everyone who opens the app sees the same data (artifact and server). */
  readonly shared: boolean;
  readonly db: DbLike;
  readonly assets: AssetsLike | null;
  readonly sample: SampleFn | null;
  readonly imageLimits: SampleImageLimits | null;
  readonly downloads: DownloadsLike | null;
  /** True when a local store was filled from seed.json on this load. */
  readonly seededLocally: boolean;
  /** Whether recognition can run here. */
  readonly ai: boolean;
  /**
   * The website needs an access code and has none that works (none saved, or the saved one
   * was refused). Ask for it, pass it to saveAccessCode, then connect again.
   */
  readonly needsAccessCode: boolean;
}

interface ClaudeWindow {
  claude?: { use?: (name: string) => Promise<unknown> };
}

function inArtifact(): boolean {
  const c = (window as unknown as ClaudeWindow).claude;
  return Boolean(c && typeof c.use === 'function');
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

// Access code (website only) -----------------------------------------------------------------

const ACCESS_CODE_KEY = 'domesday.accessCode';
/** api/blob reads this cookie, because <img src> cannot send the access code header. */
const ACCESS_COOKIE = 'domesday_code';

function writeAccessCookie(code: string): void {
  try {
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = code
      ? `${ACCESS_COOKIE}=${encodeURIComponent(code)}; Path=/; Max-Age=31536000; SameSite=Strict${secure}`
      : `${ACCESS_COOKIE}=; Path=/; Max-Age=0; SameSite=Strict${secure}`;
  } catch {
    // Cookies blocked: the API still works; stored images may not show.
  }
}

/** Remembers the website's access code in this browser. An empty code forgets it. Connect again afterwards. */
export function saveAccessCode(code: string): void {
  const value = code.trim();
  try {
    if (value) localStorage.setItem(ACCESS_CODE_KEY, value);
    else localStorage.removeItem(ACCESS_CODE_KEY);
  } catch {
    // Storage blocked: the code lasts for this page only, through the cookie.
  }
  writeAccessCookie(value);
}

/** The access code this browser saved for the website, if any (sent with direct API calls). */
export function currentAccessCode(): string | null {
  return savedAccessCode();
}

function savedAccessCode(): string | null {
  try {
    return localStorage.getItem(ACCESS_CODE_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

// The website's server ---------------------------------------------------------------------------

interface Health {
  readonly store: boolean;
  readonly ai: boolean;
  readonly accessCodeRequired: boolean;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** The website's /api/health, or null when there is no API here (a static host, `vite dev`, a timeout). */
async function fetchHealth(): Promise<Health | null> {
  try {
    const res = await fetchWithTimeout('./api/health', { headers: { accept: 'application/json' } }, 2_500);
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) return null;
    const body = (await res.json()) as Record<string, unknown> | null;
    if (!body || body.ok !== true) return null;
    return { store: body.store === true, ai: body.ai === true, accessCodeRequired: body.accessCodeRequired === true };
  } catch {
    return null;
  }
}

/** False only when the server says the code is wrong; a network problem shows up later instead. */
async function accessCodeAccepted(code: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(
      './api/db',
      { method: 'POST', headers: { 'content-type': 'application/json', 'x-domesday-code': code }, body: JSON.stringify({ op: 'version' }) },
      5_000,
    );
    return res.status !== 401;
  } catch {
    return true;
  }
}

async function connectServer(health: Health): Promise<Runtime> {
  let code = health.accessCodeRequired ? savedAccessCode() : null;
  let needsAccessCode = false;
  if (health.accessCodeRequired) {
    needsAccessCode = code === null || !(await accessCodeAccepted(code));
    if (needsAccessCode) code = null;
    else if (code) writeAccessCookie(code);
  }
  setAssetUrlMode('server');
  const server = createServerRuntime('./api', code);
  const ai = health.ai && !needsAccessCode;
  return {
    mode: 'server',
    shared: true,
    db: server.db,
    assets: server.assets,
    sample: ai ? server.sample : null,
    imageLimits: ai ? server.imageLimits : null,
    downloads: null,
    seededLocally: false,
    ai,
    needsAccessCode,
  };
}

// Local -----------------------------------------------------------------------------------------

async function connectLocal(parts: { assets: AssetsLike | null; sample: SampleFn | null; imageLimits: SampleImageLimits | null; downloads: DownloadsLike | null }): Promise<Runtime> {
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
  return { mode: 'local', shared: false, db: local, ...parts, seededLocally, ai: Boolean(parts.sample && parts.imageLimits), needsAccessCode: false };
}

export async function connectRuntime(): Promise<Runtime> {
  if (!inArtifact()) {
    const health = await fetchHealth();
    // An empty store shows the app's own "Load the demo site" screen, as in the artifact.
    if (health?.store) return connectServer(health);
    setAssetUrlMode('artifact');
    return connectLocal({ assets: null, sample: null, imageLimits: null, downloads: null });
  }

  setAssetUrlMode('artifact');
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
  if (db) return { mode: 'artifact', shared: true, db, assets, sample, imageLimits, downloads, seededLocally: false, ai: Boolean(sample && imageLimits), needsAccessCode: false };
  return connectLocal({ assets, sample, imageLimits, downloads });
}
