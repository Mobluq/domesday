import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHUNK_SIZE_BYTES,
  UploadQueue,
  backoffDelayMs,
  closeClip,
  mayUploadOn,
  planChunks,
  startClip,
  type ClosedClip,
  type NetworkKind,
} from '../src';
import { FakeServer, FakeStore, ManualClock, randomClipBytes, sha256Hex, uuid } from './fakes';

const CHUNK = 1024; // small chunks keep the tests fast; the default is 8 MiB

function recordClip(store: FakeStore, sizeBytes: number, roomId = 'room-1'): ClosedClip {
  const bytes = randomClipBytes(sizeBytes);
  const recording = startClip({
    walkId: 'walk-1',
    roomId,
    userId: 'user-1',
    deviceId: 'device-1',
    startedAt: new Date('2026-11-03T08:00:00Z'),
    locationPermission: 'denied',
    uuid,
  });
  const clip = closeClip(recording, { endedAt: new Date('2026-11-03T08:01:15Z'), sha256: sha256Hex(bytes), sizeBytes });
  store.put(clip.metadata.clipId, bytes);
  return clip;
}

function setup(network: NetworkKind = 'wifi') {
  const store = new FakeStore();
  const server = new FakeServer();
  const clock = new ManualClock();
  const net = { kind: network };
  const queue = new UploadQueue({
    transport: server,
    store,
    network: () => net.kind,
    now: clock.now,
    random: () => 0.5,
    chunkSizeBytes: CHUNK,
  });
  return { store, server, clock, net, queue };
}

describe('chunking and network policy', () => {
  it('Part 6: plans chunks of about 8 MB, every chunk full size except the last', () => {
    expect(DEFAULT_CHUNK_SIZE_BYTES).toBe(8 * 1024 * 1024);
    const plan = planChunks(100_000_000);
    expect(plan).toHaveLength(12);
    expect(plan.slice(0, 11).every((c) => c.length === DEFAULT_CHUNK_SIZE_BYTES)).toBe(true);
    expect(plan[11]).toEqual({ partNumber: 12, offset: 11 * DEFAULT_CHUNK_SIZE_BYTES, length: 7_725_312 });
    expect(() => planChunks(0)).toThrow(RangeError);
  });

  it('DMS-012: waits for Wi-Fi by default; mobile data only with an explicit opt-in; unknown counts as metered', () => {
    expect(mayUploadOn('wifi', { allowMobileData: false })).toBe(true);
    expect(mayUploadOn('cellular', { allowMobileData: false })).toBe(false);
    expect(mayUploadOn('cellular', { allowMobileData: true })).toBe(true);
    expect(mayUploadOn('unknown', { allowMobileData: true })).toBe(false);
    expect(mayUploadOn('none', { allowMobileData: true })).toBe(false);
  });

  it('Backs off exponentially with jitter, capped at five minutes', () => {
    expect(backoffDelayMs(1, { random: () => 0.999 })).toBeLessThan(2_000);
    expect(backoffDelayMs(3, { random: () => 0.999 })).toBeLessThan(8_000);
    expect(backoffDelayMs(30, { random: () => 0.999 })).toBeLessThan(5 * 60_000);
    expect(backoffDelayMs(5, { random: () => 0 })).toBe(0);
  });
});

describe('DMS-012: resumable uploads', () => {
  it('Given an upload interrupted at 70%, when the network returns, then it resumes from the last confirmed chunk, not from zero', async () => {
    const { store, server, clock, queue } = setup();
    const clip = recordClip(store, 10 * CHUNK);
    queue.enqueue(clip);

    server.failOnPutNumber = 8; // seven of ten chunks confirmed, then the signal drops
    const first = await queue.runOnce();
    expect(first.retryScheduled).toEqual([clip.metadata.clipId]);
    expect(Object.keys(queue.get(clip.metadata.clipId)?.confirmedParts ?? {})).toHaveLength(7);
    expect(queue.get(clip.metadata.clipId)?.state).toBe('retry_scheduled');

    server.failOnPutNumber = null;
    clock.advance(60_000);
    const sentBefore = server.putLog.length;
    const second = await queue.runOnce();

    expect(second.verified).toEqual([clip.metadata.clipId]);
    expect(server.putLog.slice(sentBefore).map((p) => p.partNumber)).toEqual([8, 9, 10]);
    for (let part = 1; part <= 10; part += 1) {
      expect(server.putLog.filter((p) => p.partNumber === part)).toHaveLength(1);
    }
    expect(server.openSessionCalls).toBe(1);
  });

  it('Resumes from the last confirmed chunk after the app restarts, using the saved queue', async () => {
    const { store, server, clock, queue } = setup();
    const clip = recordClip(store, 6 * CHUNK);
    queue.enqueue(clip);
    server.failOnPutNumber = 4;
    await queue.runOnce();
    const saved = JSON.parse(JSON.stringify(queue.snapshot()));

    server.failOnPutNumber = null;
    clock.advance(60_000);
    const restarted = new UploadQueue(
      { transport: server, store, network: () => 'wifi', now: clock.now, random: () => 0.5, chunkSizeBytes: CHUNK },
      saved,
    );
    const report = await restarted.runOnce();
    expect(report.verified).toEqual([clip.metadata.clipId]);
    expect(server.putLog.map((p) => p.partNumber)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('Does not retry before the backoff delay has passed', async () => {
    const { store, server, queue } = setup();
    queue.enqueue(recordClip(store, 2 * CHUNK));
    server.failOnPutNumber = 1;
    await queue.runOnce();
    server.failOnPutNumber = null;
    const again = await queue.runOnce();
    expect(again.chunksSent).toBe(0);
  });

  it('Pauses mid-upload when Wi-Fi drops to mobile data the user has not allowed', async () => {
    const { store, net, queue } = setup();
    const clip = recordClip(store, 3 * CHUNK);
    queue.enqueue(clip);
    let reads = 0;
    const original = store.readChunk.bind(store);
    store.readChunk = async (...args) => {
      reads += 1;
      if (reads === 2) net.kind = 'cellular';
      return original(...args);
    };
    const report = await queue.runOnce();
    expect(report.waitingForNetwork).toBe(true);
    expect(queue.get(clip.metadata.clipId)?.state).toBe('waiting_for_network');
    expect(Object.keys(queue.get(clip.metadata.clipId)?.confirmedParts ?? {})).toHaveLength(2);
  });
});

describe('DMS-011 and DMS-153: capture never depends on the network', () => {
  it('Given airplane mode for a whole walk, when the phone reconnects, then every clip uploads without refilming', async () => {
    const { store, server, net, queue } = setup('none');
    const clips = [recordClip(store, 3 * CHUNK, 'room-1'), recordClip(store, 2 * CHUNK, 'room-2'), recordClip(store, 5 * CHUNK, 'room-3')];
    for (const clip of clips) queue.enqueue(clip);

    const offline = await queue.runOnce();
    expect(offline.waitingForNetwork).toBe(true);
    expect(server.putLog).toHaveLength(0);
    expect(queue.list().every((i) => i.state === 'waiting_for_network')).toBe(true);

    net.kind = 'wifi';
    const online = await queue.runOnce();
    expect([...online.verified].sort()).toEqual(clips.map((c) => c.metadata.clipId).sort());
    expect(server.sessions.size).toBe(3);
  });

  it('DMS-012: on mobile data nothing uploads until the user allows it', async () => {
    const { store, server, queue } = setup('cellular');
    const clip = recordClip(store, 2 * CHUNK);
    queue.enqueue(clip);
    expect((await queue.runOnce()).waitingForNetwork).toBe(true);
    expect(server.putLog).toHaveLength(0);
    queue.setPreferences({ allowMobileData: true });
    expect((await queue.runOnce()).verified).toEqual([clip.metadata.clipId]);
  });
});

describe('DMS-018 and DMS-023: fingerprint and local copies', () => {
  it('Sends the fingerprint with the final request only, never with the chunks', async () => {
    const { store, server, queue } = setup();
    const clip = recordClip(store, 3 * CHUNK);
    queue.enqueue(clip);
    await queue.runOnce();
    expect(server.putLog.every((p) => !p.carriedFingerprint)).toBe(true);
    expect(server.completeLog).toHaveLength(1);
    expect(server.completeLog[0]).toMatchObject({ clipId: clip.metadata.clipId, sha256: clip.sha256 });
    expect(server.completeLog[0]?.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    expect(server.completeLog[0]?.deviceTime).toBe('2026-11-03T09:00:00.000Z');
  });

  it('Given an uploaded clip, when the server confirms it, then the local copy is deleted', async () => {
    const { store, queue } = setup();
    const clip = recordClip(store, 2 * CHUNK);
    queue.enqueue(clip);
    await queue.runOnce();
    expect(store.deleted).toEqual([clip.metadata.clipId]);
    expect(queue.get(clip.metadata.clipId)?.state).toBe('verified');
  });

  it('Given a clip altered after recording, the server rejects it; the phone keeps its copy and does not retry', async () => {
    const { store, server, clock, queue } = setup();
    const clip = recordClip(store, 3 * CHUNK);
    const tampered = store.files.get(clip.metadata.clipId) as Uint8Array;
    tampered[100] = (tampered[100] ?? 0) ^ 0xff;
    queue.enqueue(clip);

    const report = await queue.runOnce();
    expect(report.rejected).toEqual([clip.metadata.clipId]);
    expect(queue.get(clip.metadata.clipId)).toMatchObject({ state: 'rejected', lastError: 'fingerprint_mismatch' });
    expect(store.deleted).toHaveLength(0);

    clock.advance(24 * 60 * 60_000);
    expect((await queue.runOnce()).chunksSent).toBe(0);
    expect(server.completeLog).toHaveLength(1);
  });

  it('Queuing the same clip twice keeps one item: the phone-made UUID is the idempotency key', async () => {
    const { store, server, queue } = setup();
    const clip = recordClip(store, CHUNK);
    queue.enqueue(clip);
    queue.enqueue(clip);
    expect(queue.list()).toHaveLength(1);
    await queue.runOnce();
    expect(server.sessions.size).toBe(1);
  });
});
