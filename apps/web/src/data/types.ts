import type {
  ConditionGrade,
  ConfidenceBand,
  InvestigationOutcome,
  LineKind,
  LineStatus,
  ReviewDecisionKind,
  Role,
  RoomWalkStatus,
  WalkStatus,
} from '@domesday/domain';

/**
 * The documents the app keeps in the shared store. Paths:
 *
 *   site/main                         the site, its rooms, people and categories
 *   register/main                     the imported fixed asset register
 *   walks/<walkId>                    one walk
 *   walks/<walkId>/rooms/<roomId>     a room on that walk: clip, frames, analysis
 *   walks/<walkId>/lines/<lineId>     an asset line and its review history
 *   walks/<walkId>/matches/<key>      a person's answer to a proposed register match
 *   walks/<walkId>/followups/<id>     investigations, safety and maintenance items, refilm requests
 *   reports/<code>                    an issued report, by verification code
 */

export type PersonId = string;
export type Box = readonly [number, number, number, number];

export type MediaRef = { readonly kind: 'asset'; readonly id: string } | { readonly kind: 'file'; readonly path: string } | { readonly kind: 'local'; readonly key: string };

export interface SampleDef {
  readonly video: string;
  /** A VP9 copy for browsers that cannot play H.264. */
  readonly webm?: string;
  readonly poster: string;
  readonly labelShots: readonly string[];
  readonly seconds: number;
}

export interface RoomDef {
  readonly id: string;
  readonly name: string;
  readonly floor: string;
  readonly note?: string;
  readonly sample?: SampleDef | null;
}

export interface Person {
  readonly id: PersonId;
  readonly name: string;
  readonly initials: string;
  readonly role: Role;
  readonly roleLabel: string;
  readonly duty: string;
}

export interface Category {
  readonly id: string;
  readonly name: string;
  readonly plural: string;
}

export interface Site {
  readonly id: string;
  readonly name: string;
  readonly city: string;
  readonly currency: 'NGN';
  readonly thresholdKobo: number | null;
  readonly separationRule: boolean;
  readonly rooms: readonly RoomDef[];
  readonly people: readonly Person[];
  readonly categories: readonly Category[];
  readonly currentWalkId: string;
  /** Null on a new site until its first walk is approved. */
  readonly previousWalkId: string | null;
  readonly registerImportedAt: string | null;
  readonly demo?: boolean;
  readonly cameras?: readonly CameraDef[];
}

/**
 * A CCTV camera linked to a room. Cameras are a second evidence source between walks:
 * stills of spaces, never live video, never used to follow people.
 */
export interface CameraDef {
  readonly id: string;
  readonly name: string;
  readonly roomId: string;
  readonly brand: string;
  /** How stills reach Domesday: the on-site gateway (RTSP or ONVIF), or files imported from the recorder. */
  readonly connection: 'gateway' | 'import';
  readonly schedule: 'off' | 'nightly' | 'every-4-hours';
  /** A sample still that ships with the demo, standing in for the camera. */
  readonly sampleStill?: string | null;
}

export interface Sighting {
  /** The approved line or register line this sighting is about, when it is one we expected. */
  readonly lineId: string | null;
  readonly registerId: string | null;
  readonly categoryId: string;
  readonly description: string;
  readonly status: 'visible' | 'not_visible' | 'new';
  readonly box: Box | null;
  readonly note: string | null;
}

/** One still from a camera, checked by the recogniser against what the room should hold. */
export interface CameraCheck {
  readonly id: string;
  readonly cameraId: string;
  readonly roomId: string;
  readonly capturedAt: string;
  readonly source: 'gateway' | 'import' | 'sample';
  readonly still: Frame | null;
  readonly sha256: string;
  readonly status: AnalysisStatus;
  readonly error: string | null;
  readonly sightings: readonly Sighting[];
  readonly blurred: number;
  readonly by: PersonId;
  readonly createdAt: string;
  readonly note: string | null;
}

export interface RegisterEntry {
  readonly registerId: string;
  readonly description: string;
  readonly categoryId: string | null;
  readonly roomId: string | null;
  readonly locationLabel: string;
  readonly quantity: number;
  readonly costKobo: number | null;
  readonly bookValueKobo: number | null;
  readonly acquired: string | null;
  readonly tagCode: string | null;
  readonly serial: string | null;
}

export interface Register {
  readonly importedAt: string;
  readonly importedBy: PersonId;
  readonly fileName: string;
  readonly lines: readonly RegisterEntry[];
}

export interface WalkEvent {
  readonly at: string;
  readonly by: PersonId | null;
  readonly kind: string;
  readonly text: string;
}

export interface Walk {
  readonly id: string;
  readonly siteId: string;
  readonly label: string;
  readonly status: WalkStatus;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly capturedBy: readonly PersonId[];
  readonly approvedAt: string | null;
  readonly approvedBy: PersonId | null;
  readonly previousWalkId: string | null;
  readonly demoHistory?: boolean;
  readonly events: readonly WalkEvent[];
}

export interface ClipCheck {
  readonly code: 'too_dark' | 'too_fast' | 'lens_blocked' | 'short' | 'portrait';
  readonly message: string;
}

export interface Clip {
  readonly source: 'camera' | 'library' | 'sample';
  readonly fileName: string;
  readonly type: string;
  readonly sizeBytes: number;
  readonly durationS: number;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  /** Phone time when the fingerprint was taken. */
  readonly fingerprintedAt: string;
  /** The file's own modified time, when the phone reports one. */
  readonly recordedAt: string | null;
  readonly device: string;
  readonly checks: readonly ClipCheck[];
}

export interface Frame {
  readonly id: string;
  readonly ref: MediaRef;
  /** Seconds into the clip; null for a label shot. */
  readonly t: number | null;
  readonly w: number;
  readonly h: number;
  readonly sharpness?: number;
  readonly label?: boolean;
  /** How many faces, screens or documents were blurred in this frame before it was stored. */
  readonly blurred?: number;
}

export type AnalysisStatus = 'idle' | 'waiting' | 'running' | 'done' | 'failed';

export interface Analysis {
  readonly status: AnalysisStatus;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly by?: PersonId | null;
  readonly error?: string | null;
  readonly model?: string | null;
  readonly prompt?: string | null;
  readonly linesProposed?: number | null;
  readonly note?: string | null;
  readonly privacy?: { readonly faces: number; readonly screens: number; readonly documents: number } | null;
}

export interface RoomVisit {
  readonly roomId: string;
  readonly status: RoomWalkStatus;
  readonly skipReason: string | null;
  readonly filmedBy: PersonId | null;
  readonly filmedAt: string | null;
  readonly clip: Clip | null;
  readonly frames: readonly Frame[];
  readonly labelShots: readonly Frame[];
  readonly analysis: Analysis;
  readonly updatedAt: string;
  readonly refilmRequested?: { readonly by: PersonId; readonly at: string; readonly reason: string } | null;
}

export interface Reading {
  readonly value: string;
  /** "read" from a frame by the recogniser, or typed by a reviewer. */
  readonly source: 'read' | 'reviewer';
  readonly frameId?: string | null;
  readonly box?: Box | null;
}

export interface Evidence {
  readonly frameId: string;
  readonly box: Box | null;
}

export interface Decision {
  readonly kind: ReviewDecisionKind;
  readonly by: PersonId;
  readonly at: string;
  readonly reason?: string | null;
  readonly bulk?: boolean;
}

export interface HistoryEntry {
  readonly at: string;
  readonly by: PersonId | null;
  readonly action: string;
  readonly changes?: Readonly<Record<string, readonly [unknown, unknown]>>;
  readonly reason?: string | null;
}

export interface Line {
  readonly id: string;
  readonly walkId: string;
  readonly roomId: string;
  readonly createdAt: string;
  readonly kind: LineKind;
  readonly quantity: number;
  readonly categoryId: string;
  readonly description: string;
  readonly make: Reading | null;
  readonly model: Reading | null;
  readonly serial: Reading | null;
  readonly tagCode: Reading | null;
  readonly condition: ConditionGrade;
  readonly conditionReason: string;
  readonly band: ConfidenceBand;
  readonly bandReason: string | null;
  readonly safety: string | null;
  readonly evidence: readonly Evidence[];
  readonly proposedBy: { readonly kind: 'recogniser' | 'reviewer' | 'demo-history'; readonly model?: string; readonly prompt?: string; readonly at: string };
  readonly status: LineStatus;
  readonly decision: Decision | null;
  readonly mergedInto?: string | null;
  readonly mergedFrom?: readonly string[];
  readonly splitInto?: readonly string[] | null;
  readonly splitFrom?: string | null;
  readonly history: readonly HistoryEntry[];
  readonly notes: readonly string[];
  readonly registerId?: string | null;
  readonly version: number;
}

export interface MatchAnswer {
  readonly registerId: string;
  readonly lineId: string;
  readonly decision: 'confirmed' | 'rejected';
  readonly by: PersonId;
  readonly at: string;
  readonly score: number | null;
}

export type FollowupKind = 'investigation' | 'safety' | 'maintenance' | 'refilm' | 'location';

export interface Followup {
  readonly id: string;
  readonly kind: FollowupKind;
  readonly title: string;
  readonly lineId: string | null;
  readonly registerId: string | null;
  readonly roomId: string | null;
  readonly owner: PersonId | null;
  readonly due: string | null;
  readonly status: 'open' | 'closed';
  readonly outcome: InvestigationOutcome | null;
  readonly note: string | null;
  readonly createdAt: string;
  readonly createdBy: PersonId;
}

/**
 * A reviewer's correction of the recogniser, kept as a labelled example (DMS-055). Used only
 * for this site: recent corrections go into the next recognition prompts, never into training.
 */
export interface Correction {
  readonly id: string;
  readonly kind: 'relabel' | 'missed' | 'rejected' | 'box';
  readonly roomId: string;
  readonly lineId: string | null;
  readonly frameId: string | null;
  readonly box: Box | null;
  readonly from: { readonly categoryId: string; readonly description: string } | null;
  readonly to: { readonly categoryId: string; readonly description: string } | null;
  readonly reason: string | null;
  readonly by: PersonId;
  readonly at: string;
}

export interface ReportRecord {
  readonly code: string;
  readonly number: string;
  readonly walkId: string;
  readonly siteName: string;
  readonly title: string;
  readonly issuedAt: string;
  readonly issuedBy: PersonId;
  readonly digestHex: string;
  readonly pages: number;
}
