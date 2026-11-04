// Pure logic for the Domesday phone app. No React Native imports, so all of it
// is testable in Node; the Expo app supplies cameras, files and the network.

export { defaultUuidSource, isUuid, newPhoneId, type UuidSource } from './ids';
export {
  createSha256Hasher,
  fingerprintChunks,
  isSha256Hex,
  type Fingerprint,
  type HasherFactory,
  type IncrementalHasher,
} from './fingerprint';
export {
  CaptureInputError,
  ClipClosedError,
  attachLocation,
  closeClip,
  startClip,
  stopClip,
  type CaptureLocation,
  type CaptureMetadata,
  type ClosedClip,
  type LocationPermission,
  type RecordingClip,
} from './clip';
export {
  applyWalkEvent,
  createWalk,
  summariseWalk,
  type PhoneRoom,
  type PhoneWalk,
  type WalkErrorCode,
  type WalkEvent,
  type WalkPhase,
  type WalkSummary,
  type WalkTransition,
} from './walk';
export {
  DEFAULT_PRE_WALK_ASSUMPTIONS,
  LOW_STORAGE_WARNING_BYTES,
  estimatePreWalk,
  type PreWalkAssumptions,
  type PreWalkEstimate,
  type PreWalkInput,
} from './pre-walk';
export {
  DEFAULT_CHUNK_SIZE_BYTES,
  DEFAULT_UPLOAD_PREFERENCES,
  backoffDelayMs,
  mayUploadOn,
  planChunks,
  type ChunkPlan,
  type NetworkKind,
  type UploadPreferences,
} from './upload/policy';
export {
  PermanentUploadError,
  TransientUploadError,
  UploadQueue,
  type ChunkRequest,
  type CompleteRequest,
  type CompleteResult,
  type LocalClipStore,
  type QueueItem,
  type QueueItemState,
  type RunReport,
  type UploadQueueDeps,
  type UploadQueueSnapshot,
  type UploadTransport,
} from './upload/queue';
