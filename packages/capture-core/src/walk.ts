import { isValidSkipReason, type RoomWalkStatus } from '@domesday/domain';
import type { ClosedClip } from './clip';

/** A room as the phone shows it during a walk (DMS-010). */
export interface PhoneRoom {
  readonly roomId: string;
  readonly name: string;
  /** Named on the phone during this walk and waiting for an administrator to confirm (DMS-002). */
  readonly provisional: boolean;
  readonly status: RoomWalkStatus;
  readonly skipReason: string | null;
  readonly clipIds: readonly string[];
}

export type WalkPhase = 'planned' | 'in_progress' | 'ended';

export interface PhoneWalk {
  readonly walkId: string;
  readonly siteId: string;
  readonly phase: WalkPhase;
  readonly rooms: readonly PhoneRoom[];
  /** The clip being recorded now, if any. Only one room is filmed at a time. */
  readonly recording: { readonly roomId: string; readonly clipId: string } | null;
}

export type WalkEvent =
  | { readonly type: 'start_walk' }
  | { readonly type: 'add_provisional_room'; readonly roomId: string; readonly name: string }
  | { readonly type: 'start_recording'; readonly roomId: string; readonly clipId: string }
  | { readonly type: 'stop_recording'; readonly clip: ClosedClip }
  | { readonly type: 'mark_room_filmed'; readonly roomId: string }
  | { readonly type: 'skip_room'; readonly roomId: string; readonly reason: string }
  | { readonly type: 'unskip_room'; readonly roomId: string }
  | { readonly type: 'end_walk' };

export type WalkErrorCode =
  | 'walk_not_started'
  | 'walk_already_started'
  | 'walk_ended'
  | 'unknown_room'
  | 'room_already_exists'
  | 'room_name_required'
  | 'already_recording'
  | 'not_recording'
  | 'clip_does_not_match_recording'
  | 'room_is_skipped'
  | 'room_has_no_clips'
  | 'skip_reason_required'
  | 'only_unstarted_rooms_can_be_skipped'
  | 'room_is_not_skipped';

export type WalkTransition =
  | { readonly ok: true; readonly walk: PhoneWalk }
  | { readonly ok: false; readonly code: WalkErrorCode; readonly message: string };

/** Start a walk from the site's room list. Every room begins "not started". */
export function createWalk(input: {
  readonly walkId: string;
  readonly siteId: string;
  readonly rooms: readonly { readonly roomId: string; readonly name: string }[];
}): PhoneWalk {
  return {
    walkId: input.walkId,
    siteId: input.siteId,
    phase: 'planned',
    rooms: input.rooms.map((r) => ({
      roomId: r.roomId,
      name: r.name,
      provisional: false,
      status: 'not_started' as const,
      skipReason: null,
      clipIds: [],
    })),
    recording: null,
  };
}

const fail = (code: WalkErrorCode, message: string): WalkTransition => ({ ok: false, code, message });

function updateRoom(walk: PhoneWalk, roomId: string, change: (room: PhoneRoom) => PhoneRoom): PhoneWalk {
  return { ...walk, rooms: walk.rooms.map((r) => (r.roomId === roomId ? change(r) : r)) };
}

/**
 * DMS-010: the walk and room state machine. Pure: it returns a new walk or a
 * refusal with a reason, and never changes the walk it is given.
 */
export function applyWalkEvent(walk: PhoneWalk, event: WalkEvent): WalkTransition {
  if (walk.phase === 'ended') return fail('walk_ended', 'This walk has ended.');
  const room = 'roomId' in event ? walk.rooms.find((r) => r.roomId === event.roomId) : undefined;

  switch (event.type) {
    case 'start_walk':
      if (walk.phase !== 'planned') return fail('walk_already_started', 'This walk has already started.');
      return { ok: true, walk: { ...walk, phase: 'in_progress' } };

    case 'add_provisional_room': {
      // DMS-002: a room not in the list can be named on the phone and is saved as provisional.
      const name = event.name.trim();
      if (name.length === 0) return fail('room_name_required', 'Give the room a name.');
      if (room) return fail('room_already_exists', 'A room with this ID is already on the walk.');
      const added: PhoneRoom = { roomId: event.roomId, name, provisional: true, status: 'not_started', skipReason: null, clipIds: [] };
      return { ok: true, walk: { ...walk, rooms: [...walk.rooms, added] } };
    }

    case 'start_recording':
      if (walk.phase !== 'in_progress') return fail('walk_not_started', 'Start the walk first.');
      if (!room) return fail('unknown_room', 'That room is not on this walk.');
      if (walk.recording) return fail('already_recording', 'Stop the current recording first.');
      if (room.status === 'skipped') return fail('room_is_skipped', 'Undo the skip before filming this room.');
      return { ok: true, walk: { ...walk, recording: { roomId: room.roomId, clipId: event.clipId } } };

    case 'stop_recording': {
      if (!walk.recording) return fail('not_recording', 'Nothing is being recorded.');
      const { clipId, roomId } = event.clip.metadata;
      if (clipId !== walk.recording.clipId || roomId !== walk.recording.roomId) {
        return fail('clip_does_not_match_recording', 'This clip is not the one being recorded.');
      }
      const stopped = updateRoom(walk, roomId, (r) => ({ ...r, clipIds: [...r.clipIds, clipId] }));
      return { ok: true, walk: { ...stopped, recording: null } };
    }

    case 'mark_room_filmed':
      if (!room) return fail('unknown_room', 'That room is not on this walk.');
      if (walk.recording?.roomId === room.roomId) return fail('already_recording', 'Stop recording before marking the room done.');
      if (room.clipIds.length === 0) return fail('room_has_no_clips', 'Film the room before marking it done.');
      return { ok: true, walk: updateRoom(walk, room.roomId, (r) => ({ ...r, status: 'filmed', skipReason: null })) };

    case 'skip_room':
      // DMS-010: a skipped room needs a reason.
      if (!room) return fail('unknown_room', 'That room is not on this walk.');
      if (room.status !== 'not_started' || room.clipIds.length > 0 || walk.recording?.roomId === room.roomId) {
        return fail('only_unstarted_rooms_can_be_skipped', 'Only a room that has not been filmed can be skipped.');
      }
      if (!isValidSkipReason(event.reason)) return fail('skip_reason_required', 'Say why the room is being skipped.');
      return { ok: true, walk: updateRoom(walk, room.roomId, (r) => ({ ...r, status: 'skipped', skipReason: event.reason.trim() })) };

    case 'unskip_room':
      if (!room) return fail('unknown_room', 'That room is not on this walk.');
      if (room.status !== 'skipped') return fail('room_is_not_skipped', 'That room is not skipped.');
      return { ok: true, walk: updateRoom(walk, room.roomId, (r) => ({ ...r, status: 'not_started', skipReason: null })) };

    case 'end_walk':
      if (walk.phase !== 'in_progress') return fail('walk_not_started', 'Start the walk first.');
      if (walk.recording) return fail('already_recording', 'Stop the current recording before ending the walk.');
      return { ok: true, walk: { ...walk, phase: 'ended' } };
  }
}

export interface WalkSummary {
  readonly filmed: readonly string[];
  readonly skipped: readonly { readonly roomId: string; readonly reason: string }[];
  /** Rooms nobody on this phone filmed. Another person may film them on the same walk (DMS-022). */
  readonly notStarted: readonly string[];
  readonly provisionalRooms: readonly string[];
  readonly clipCount: number;
  readonly totalBytes: number;
}

/** Part 5 ("End the walk"): rooms filmed, rooms skipped with reasons, and total size. */
export function summariseWalk(walk: PhoneWalk, clipSizes: ReadonlyMap<string, number> = new Map()): WalkSummary {
  const clipIds = walk.rooms.flatMap((r) => r.clipIds);
  return {
    filmed: walk.rooms.filter((r) => r.status === 'filmed').map((r) => r.roomId),
    skipped: walk.rooms.filter((r) => r.status === 'skipped').map((r) => ({ roomId: r.roomId, reason: r.skipReason ?? '' })),
    notStarted: walk.rooms.filter((r) => r.status === 'not_started').map((r) => r.roomId),
    provisionalRooms: walk.rooms.filter((r) => r.provisional).map((r) => r.roomId),
    clipCount: clipIds.length,
    totalBytes: clipIds.reduce((sum, id) => sum + (clipSizes.get(id) ?? 0), 0),
  };
}
