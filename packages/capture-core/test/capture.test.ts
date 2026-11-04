import { describe, expect, it } from 'vitest';
import {
  CaptureInputError,
  ClipClosedError,
  LOW_STORAGE_WARNING_BYTES,
  applyWalkEvent,
  attachLocation,
  closeClip,
  createSha256Hasher,
  createWalk,
  estimatePreWalk,
  fingerprintChunks,
  isUuid,
  newPhoneId,
  startClip,
  stopClip,
  summariseWalk,
  type PhoneWalk,
  type WalkEvent,
} from '../src';
import { randomClipBytes, sha256Hex, uuid } from './fakes';

const lagos = { latitude: 6.5244, longitude: 3.3792, accuracyMetres: 12 };

function recording(locationPermission: 'granted' | 'denied' = 'granted') {
  return startClip({
    walkId: 'walk-1',
    roomId: 'room-1',
    userId: 'user-1',
    deviceId: 'device-1',
    startedAt: new Date('2026-11-03T08:00:00Z'),
    locationPermission,
    location: lagos,
    uuid,
  });
}

describe('DMS-018: fingerprint computed on the phone', () => {
  it('Matches Node\'s own SHA-256 for a clip hashed in uneven chunks', async () => {
    const bytes = randomClipBytes(1_000_003);
    const chunks = [bytes.subarray(0, 7), bytes.subarray(7, 500_000), bytes.subarray(500_000)];
    expect(await fingerprintChunks(chunks)).toEqual({ sha256: sha256Hex(bytes), sizeBytes: bytes.byteLength });
  });

  it('Computes the fingerprint at the moment recording stops', async () => {
    const bytes = randomClipBytes(64_000);
    const clip = await stopClip(recording(), { endedAt: new Date('2026-11-03T08:01:00Z'), file: [bytes] });
    expect(clip.state).toBe('closed');
    expect(clip.sha256).toBe(sha256Hex(bytes));
    expect(clip.sizeBytes).toBe(64_000);
    expect(clip.metadata.endedAt).toBe('2026-11-03T08:01:00.000Z');
  });

  it('Accepts another hasher, such as a native one, through the same interface', async () => {
    let updates = 0;
    const counting = () => {
      const inner = createSha256Hasher();
      return { update: (c: Uint8Array) => { updates += 1; inner.update(c); }, digestHex: () => inner.digestHex() };
    };
    await fingerprintChunks([new Uint8Array([1]), new Uint8Array([2])], counting);
    expect(updates).toBe(2);
  });
});

describe('DMS-017: capture metadata cannot change once a clip is closed', () => {
  it('Records user, device, start and end, and location only where the user allowed it', () => {
    const allowed = recording('granted');
    expect(allowed.metadata).toMatchObject({ userId: 'user-1', deviceId: 'device-1', location: lagos });
    expect(isUuid(allowed.metadata.clipId)).toBe(true);
    expect(recording('denied').metadata.location).toBeNull();
    expect(attachLocation(recording('denied'), lagos, 'denied').metadata.location).toBeNull();
  });

  it('Freezes the closed clip, so edits throw, and refuses metadata changes after closing', () => {
    const closed = closeClip(recording(), {
      endedAt: new Date('2026-11-03T08:01:00Z'),
      sha256: 'a'.repeat(64),
      sizeBytes: 10,
    });
    expect(Object.isFrozen(closed)).toBe(true);
    expect(Object.isFrozen(closed.metadata)).toBe(true);
    expect(() => {
      (closed.metadata as { userId: string }).userId = 'someone-else';
    }).toThrow(TypeError);
    expect(() => attachLocation(closed, lagos, 'granted')).toThrow(ClipClosedError);
    expect(() => closeClip(closed, { endedAt: new Date(), sha256: 'b'.repeat(64), sizeBytes: 1 })).toThrow(ClipClosedError);
  });

  it('Lets a location fix arrive while still recording', () => {
    const later = attachLocation(recording('granted'), { latitude: 6.6, longitude: 3.3, accuracyMetres: 5 }, 'granted');
    expect(later.metadata.location?.latitude).toBe(6.6);
  });

  it('Refuses a bad fingerprint, an end before the start, and an out-of-range location', () => {
    expect(() => closeClip(recording(), { endedAt: new Date('2026-11-03T08:01:00Z'), sha256: 'XYZ', sizeBytes: 1 })).toThrow(
      CaptureInputError,
    );
    expect(() =>
      closeClip(recording(), { endedAt: new Date('2026-11-03T07:00:00Z'), sha256: 'a'.repeat(64), sizeBytes: 1 }),
    ).toThrow(CaptureInputError);
    expect(() => attachLocation(recording(), { latitude: 91, longitude: 0, accuracyMetres: 1 }, 'granted')).toThrow(
      CaptureInputError,
    );
  });

  it('Makes clip IDs on the phone as UUIDs and refuses a source that does not', () => {
    expect(isUuid(newPhoneId(uuid))).toBe(true);
    expect(() => newPhoneId(() => 'not-a-uuid')).toThrow();
  });
});

describe('DMS-010: the walk and room state machine', () => {
  const twelveRooms = Array.from({ length: 12 }, (_, i) => ({ roomId: `room-${i + 1}`, name: `Room ${i + 1}` }));

  function run(walk: PhoneWalk, ...events: WalkEvent[]): PhoneWalk {
    let current = walk;
    for (const event of events) {
      const result = applyWalkEvent(current, event);
      if (!result.ok) throw new Error(`${event.type}: ${result.code}`);
      current = result.walk;
    }
    return current;
  }

  async function closedClipFor(roomId: string, clipId: string) {
    const rec = startClip({
      walkId: 'walk-1',
      roomId,
      userId: 'user-1',
      deviceId: 'device-1',
      startedAt: new Date('2026-11-03T08:00:00Z'),
      locationPermission: 'denied',
      uuid: () => clipId,
    });
    return stopClip(rec, { endedAt: new Date('2026-11-03T08:01:00Z'), file: [new Uint8Array([1, 2, 3])] });
  }

  it('Given a site with 12 rooms, when the walk starts, then it shows the 12 rooms as not started', () => {
    const walk = run(createWalk({ walkId: 'walk-1', siteId: 'site-1', rooms: twelveRooms }), { type: 'start_walk' });
    expect(walk.rooms).toHaveLength(12);
    expect(walk.rooms.every((r) => r.status === 'not_started')).toBe(true);
  });

  it('A skipped room needs a reason', () => {
    const walk = run(createWalk({ walkId: 'walk-1', siteId: 'site-1', rooms: twelveRooms }), { type: 'start_walk' });
    const refused = applyWalkEvent(walk, { type: 'skip_room', roomId: 'room-3', reason: '   ' });
    expect(refused).toMatchObject({ ok: false, code: 'skip_reason_required' });
    const skipped = run(walk, { type: 'skip_room', roomId: 'room-3', reason: 'Locked; key with security' });
    expect(skipped.rooms[2]).toMatchObject({ status: 'skipped', skipReason: 'Locked; key with security' });
  });

  it('Films a room: record, stop, then mark done; a room cannot be done without a clip', async () => {
    const clipId = uuid();
    let walk = run(createWalk({ walkId: 'walk-1', siteId: 'site-1', rooms: twelveRooms }), { type: 'start_walk' });
    expect(applyWalkEvent(walk, { type: 'mark_room_filmed', roomId: 'room-1' })).toMatchObject({ ok: false, code: 'room_has_no_clips' });
    walk = run(walk, { type: 'start_recording', roomId: 'room-1', clipId });
    expect(applyWalkEvent(walk, { type: 'start_recording', roomId: 'room-2', clipId: uuid() })).toMatchObject({
      ok: false,
      code: 'already_recording',
    });
    walk = run(walk, { type: 'stop_recording', clip: await closedClipFor('room-1', clipId) }, { type: 'mark_room_filmed', roomId: 'room-1' });
    expect(walk.rooms[0]).toMatchObject({ status: 'filmed', clipIds: [clipId] });
    expect(applyWalkEvent(walk, { type: 'skip_room', roomId: 'room-1', reason: 'x' })).toMatchObject({
      ok: false,
      code: 'only_unstarted_rooms_can_be_skipped',
    });
  });

  it('DMS-002: a room not on the list can be named on the phone and is saved as provisional', () => {
    const walk = run(
      createWalk({ walkId: 'walk-1', siteId: 'site-1', rooms: twelveRooms }),
      { type: 'start_walk' },
      { type: 'add_provisional_room', roomId: 'room-new', name: '  Store room behind kitchen ' },
    );
    expect(walk.rooms.at(-1)).toMatchObject({ roomId: 'room-new', name: 'Store room behind kitchen', provisional: true, status: 'not_started' });
    expect(summariseWalk(walk).provisionalRooms).toEqual(['room-new']);
  });

  it('Part 5: ending the walk summarises rooms filmed, rooms skipped with reasons, and total size', async () => {
    const clipId = uuid();
    const walk = run(
      createWalk({ walkId: 'walk-1', siteId: 'site-1', rooms: twelveRooms.slice(0, 3) }),
      { type: 'start_walk' },
      { type: 'start_recording', roomId: 'room-1', clipId },
      { type: 'stop_recording', clip: await closedClipFor('room-1', clipId) },
      { type: 'mark_room_filmed', roomId: 'room-1' },
      { type: 'skip_room', roomId: 'room-2', reason: 'Occupied by a guest' },
      { type: 'end_walk' },
    );
    expect(walk.phase).toBe('ended');
    expect(summariseWalk(walk, new Map([[clipId, 45_000_000]]))).toEqual({
      filmed: ['room-1'],
      skipped: [{ roomId: 'room-2', reason: 'Occupied by a guest' }],
      notStarted: ['room-3'],
      provisionalRooms: [],
      clipCount: 1,
      totalBytes: 45_000_000,
    });
    expect(applyWalkEvent(walk, { type: 'start_recording', roomId: 'room-3', clipId: uuid() })).toMatchObject({ ok: false, code: 'walk_ended' });
  });

  it('Refuses to end the walk while recording', () => {
    const walk = run(createWalk({ walkId: 'walk-1', siteId: 'site-1', rooms: twelveRooms }), { type: 'start_walk' }, {
      type: 'start_recording',
      roomId: 'room-1',
      clipId: uuid(),
    });
    expect(applyWalkEvent(walk, { type: 'end_walk' })).toMatchObject({ ok: false, code: 'already_recording' });
  });
});

describe('DMS-019: storage and battery before a walk', () => {
  it('Given less than 2 GB free, when a walk starts, then the app warns and estimates how many rooms will fit', () => {
    const estimate = estimatePreWalk({ freeStorageBytes: 1_500_000_000, batteryPercent: 90, charging: false, plannedRooms: 50 });
    expect(LOW_STORAGE_WARNING_BYTES).toBe(2_000_000_000);
    expect(estimate.storageWarning).toBe(true);
    // (1.5 GB - 0.5 GB reserve) / (90 s at 60 MB a minute = 90 MB a room) = 11 rooms
    expect(estimate.roomsThatFitStorage).toBe(11);
    expect(estimate.roomsThatFit).toBe(11);
    expect(estimate.canFilmAllPlannedRooms).toBe(false);
  });

  it('Gives no warning when storage and battery cover the planned rooms', () => {
    const estimate = estimatePreWalk({ freeStorageBytes: 20_000_000_000, batteryPercent: 100, charging: false, plannedRooms: 40 });
    expect(estimate).toMatchObject({ storageWarning: false, batteryWarning: false, canFilmAllPlannedRooms: true });
    expect(estimate.bytesNeeded).toBe(3_600_000_000);
  });

  it('Warns when the battery is too low for the planned rooms, and ignores the battery while charging', () => {
    const low = estimatePreWalk({ freeStorageBytes: 20_000_000_000, batteryPercent: 30, charging: false, plannedRooms: 50 });
    // (30% - 10% kept) / (1.5 minutes x 25/60 % a minute = 0.625% a room) = 32 rooms
    expect(low).toMatchObject({ batteryWarning: true, roomsThatFitBattery: 32, roomsThatFit: 32 });
    const charging = estimatePreWalk({ freeStorageBytes: 20_000_000_000, batteryPercent: 30, charging: true, plannedRooms: 50 });
    expect(charging).toMatchObject({ batteryWarning: false, roomsThatFitBattery: null });
  });
});
