/**
 * The parts of the claude.ai artifact runtime this app uses (runtime contract 0.2.47),
 * typed narrowly. The real namespaces come from `window.claude.use(name)`; the local
 * fallbacks in this folder implement the same shapes so the app runs anywhere.
 */

export type Json = Record<string, unknown>;

export interface DocSnap {
  readonly id: string;
  readonly exists: boolean;
  data(): Json | undefined;
}

export interface QuerySnap {
  readonly docs: readonly DocSnap[];
}

export interface DbError {
  readonly code: string;
  readonly message: string;
}

export type Unsubscribe = () => void;

export interface DocRef {
  readonly id: string;
  readonly path: string;
  get(): Promise<DocSnap>;
  set(data: Json): Promise<void>;
  update(data: Json): Promise<void>;
  delete(): Promise<void>;
  onSnapshot(next: (snap: DocSnap) => void, error?: (e: DbError) => void): Unsubscribe;
}

export interface CollRef {
  readonly path: string;
  doc(id?: string): DocRef;
  get(): Promise<QuerySnap>;
  onSnapshot(next: (snap: QuerySnap) => void, error?: (e: DbError) => void): Unsubscribe;
}

export interface DbLike {
  doc(path: string): DocRef;
  collection(path: string): CollRef;
}

export interface AssetsLike {
  upload(blob: Blob, options?: { type?: string }): Promise<{ id: string; url: string; sizeBytes: number; contentType: string }>;
  list(): Promise<{ assets: { id: string; url: string; contentType: string; sizeBytes: number; createdAt: string }[] }>;
  delete(ref: string): Promise<{ deleted: boolean }>;
}

export interface SampleImageLimits {
  readonly maxCount: number;
  readonly maxInputBytes: number;
  readonly mediaTypes: readonly string[];
}

export interface SampleOptions {
  onText?: (update: { text: string; delta: string }) => void;
  signal?: AbortSignal;
  images?: Blob[];
  modelTier?: 'default' | 'complex' | 'quick';
  cache?: boolean;
}

export interface SampleFn {
  (input: string, options?: SampleOptions): Promise<{ text: string; truncated: boolean }>;
  json<T = unknown>(input: string, options?: SampleOptions): Promise<T>;
  limits(): Promise<{ maxPromptBytes: number; images?: SampleImageLimits }>;
}

export interface SampleError {
  readonly code: string;
  readonly message: string;
  readonly text?: string;
}

export interface DownloadsLike {
  save(request: { filename: string; data: string | Blob }): Promise<{ status: 'saved' | 'delivered' }>;
}

export function isSampleError(e: unknown): e is SampleError {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string';
}
