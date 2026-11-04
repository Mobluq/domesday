import { fingerprintChunks, isSha256Hex, type HasherFactory } from './fingerprint';
import { defaultUuidSource, newPhoneId, type UuidSource } from './ids';

export interface CaptureLocation {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyMetres: number;
}

export type LocationPermission = 'granted' | 'denied';

/** DMS-017: capture metadata recorded with each clip. Times are the phone's clock, as ISO 8601 text. */
export interface CaptureMetadata {
  readonly clipId: string;
  readonly walkId: string;
  readonly roomId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** Only where the user has allowed location. */
  readonly location: CaptureLocation | null;
}

/** A clip while the camera is still recording. Location may still arrive. */
export interface RecordingClip {
  readonly state: 'recording';
  readonly metadata: CaptureMetadata;
}

/** A clip whose recording has stopped. Its metadata and fingerprint can no longer change (DMS-017, DMS-018). */
export interface ClosedClip {
  readonly state: 'closed';
  readonly metadata: CaptureMetadata & { readonly endedAt: string };
  readonly sha256: string;
  readonly sizeBytes: number;
}

export class ClipClosedError extends Error {
  override readonly name = 'ClipClosedError';
}

export class CaptureInputError extends Error {
  override readonly name = 'CaptureInputError';
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function validLocation(location: CaptureLocation): CaptureLocation {
  const { latitude, longitude, accuracyMetres } = location;
  if (!(latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180 && accuracyMetres >= 0)) {
    throw new CaptureInputError('location is out of range');
  }
  return { latitude, longitude, accuracyMetres };
}

function iso(date: Date, field: string): string {
  if (Number.isNaN(date.getTime())) throw new CaptureInputError(`${field} is not a valid date`);
  return date.toISOString();
}

/** Start recording a room. The clip gets its UUID here, on the phone. */
export function startClip(input: {
  readonly walkId: string;
  readonly roomId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly startedAt: Date;
  readonly locationPermission: LocationPermission;
  readonly location?: CaptureLocation | null;
  readonly uuid?: UuidSource;
}): RecordingClip {
  const location = input.locationPermission === 'granted' && input.location ? validLocation(input.location) : null;
  return deepFreeze({
    state: 'recording',
    metadata: {
      clipId: newPhoneId(input.uuid ?? defaultUuidSource),
      walkId: input.walkId,
      roomId: input.roomId,
      userId: input.userId,
      deviceId: input.deviceId,
      startedAt: iso(input.startedAt, 'startedAt'),
      endedAt: null,
      location,
    },
  });
}

/** Add a location fix that arrived while recording. Ignored when the user has not allowed location. */
export function attachLocation(
  clip: RecordingClip | ClosedClip,
  location: CaptureLocation,
  permission: LocationPermission,
): RecordingClip {
  if (clip.state !== 'recording') throw new ClipClosedError('capture metadata cannot change once a clip is closed');
  if (permission !== 'granted') return clip;
  return deepFreeze({ state: 'recording', metadata: { ...clip.metadata, location: validLocation(location) } });
}

/**
 * Close a clip with a fingerprint the platform computed natively. Prefer stopClip,
 * which computes the fingerprint itself at the moment recording stops.
 */
export function closeClip(
  clip: RecordingClip | ClosedClip,
  input: { readonly endedAt: Date; readonly sha256: string; readonly sizeBytes: number },
): ClosedClip {
  if (clip.state !== 'recording') throw new ClipClosedError('this clip is already closed');
  const endedAt = iso(input.endedAt, 'endedAt');
  if (endedAt < clip.metadata.startedAt) throw new CaptureInputError('endedAt is before startedAt');
  if (!isSha256Hex(input.sha256)) throw new CaptureInputError('sha256 must be 64 lower-case hex characters');
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) throw new CaptureInputError('sizeBytes must be positive');
  return deepFreeze({
    state: 'closed',
    metadata: { ...clip.metadata, endedAt },
    sha256: input.sha256,
    sizeBytes: input.sizeBytes,
  });
}

/** DMS-018: stop recording and compute the SHA-256 fingerprint of the clip file there and then. */
export async function stopClip(
  clip: RecordingClip,
  input: {
    readonly endedAt: Date;
    readonly file: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
    readonly createHasher?: HasherFactory;
  },
): Promise<ClosedClip> {
  const { sha256, sizeBytes } = await fingerprintChunks(input.file, input.createHasher);
  return closeClip(clip, { endedAt: input.endedAt, sha256, sizeBytes });
}
