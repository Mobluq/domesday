import { UI_COPY } from '@domesday/domain';
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { megabytes } from '../data/derive';
import { Btn } from '../ui/bits';
import { Icon, type IconName } from '../ui/icons';
import {
  assessFrame,
  GUIDE_IDLE,
  isMovingTooFast,
  layoutRegions,
  loadDetector,
  mergeTally,
  motionScore,
  QUALITY,
  settleGuide,
  spottedList,
  type Detector,
  type GuideState,
  type PlacedRegion,
  type Prompt,
  type Tally,
} from './detector';
import { measure } from './frames';
import './live-camera.css';

/**
 * Filming inside the app: a live viewfinder with live guidance, label shots and live item
 * labels from an on-device detector. For when Domesday runs as its own website. Inside a
 * claude.ai artifact the platform refuses camera access, so the capture screen keeps the
 * file input that opens the phone's own camera app.
 */

export interface LiveCameraResult {
  clip: Blob;
  fileName: string;
  mimeType: string;
  labelShots: Blob[];
  startedAt: string;
  spotted: { categoryId: string; label: string; count: number }[];
}

export interface LiveCameraProps {
  roomName: string;
  /** How long a room usually takes. The guidance moves to sweep 2 at half of it. */
  expectedSeconds?: number;
  onDone(result: LiveCameraResult): void;
  onCancel(): void;
  /** The camera cannot be used here. reason is a plain sentence to show the person. */
  onFallback(reason: string): void;
}

const CONSTRAINTS: MediaStreamConstraints = {
  // Domesday records no sound by default.
  audio: false,
  video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
};
const VIDEO_BITS_PER_SECOND = 2_500_000;
const CHUNK_MS = 1000;
const DETECT_EVERY_MS = 600;
const MAX_REGIONS = 8;
const MAX_CHIPS = 6;
const SMALL_EDGE = 160;
const PHOTO_TIMEOUT_MS = 4000;
const MIME_TYPES = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8'] as const;

const PROMPT_ICON: Readonly<Record<Prompt, IconName>> = { lensBlocked: 'unsafe', tooDark: 'info', slowDown: 'worse' };
const NO_REGIONS: PlacedRegion[] = [];
const NO_TALLY: Tally = new Map();
const LABEL_ABOVE: CSSProperties = { top: 'auto', bottom: 'calc(100% + 6px)' };

type Availability = 'ok' | 'blocked' | 'unsupported';
type FeaturePolicy = { allowsFeature(feature: string): boolean };

function cameraPolicy(): boolean | null {
  const doc = document as Document & { permissionsPolicy?: FeaturePolicy; featurePolicy?: FeaturePolicy };
  const policy = doc.permissionsPolicy ?? doc.featurePolicy;
  if (!policy || typeof policy.allowsFeature !== 'function') return null;
  try {
    return policy.allowsFeature('camera');
  } catch {
    return null;
  }
}

function inCrossOriginFrame(): boolean {
  try {
    if (window.self === window.top) return false;
  } catch {
    return true;
  }
  const ancestors = window.location.ancestorOrigins as DOMStringList | undefined;
  if (ancestors && ancestors.length > 0) return Array.from(ancestors).some((o) => o !== window.location.origin);
  try {
    // Reading a cross-origin parent's location throws.
    return window.top?.location.origin !== window.location.origin;
  } catch {
    return true;
  }
}

/**
 * Whether the in-app camera can work here, without asking for it: 'unsupported' when the
 * browser cannot film into a page, 'blocked' when the page may not use the camera (refused
 * before, or framed by a site that does not allow it), otherwise 'ok'.
 */
export async function cameraAvailable(): Promise<Availability> {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'unsupported';
  if (!window.isSecureContext || typeof navigator.mediaDevices?.getUserMedia !== 'function' || typeof MediaRecorder === 'undefined') return 'unsupported';
  const policy = cameraPolicy();
  if (policy === false || (policy === null && inCrossOriginFrame())) return 'blocked';
  try {
    const status = await navigator.permissions?.query({ name: 'camera' });
    if (status?.state === 'denied') return 'blocked';
  } catch {
    // Some browsers cannot be asked about the camera. Asking for the camera will tell.
  }
  return 'ok';
}

/** The first recording type the browser supports: MP4 (Safari), then WebM with VP9, then VP8. '' means the browser's default. */
export function pickMimeType(isSupported: (type: string) => boolean = (t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)): string {
  for (const type of MIME_TYPES) {
    try {
      if (isSupported(type)) return type;
    } catch {
      // Try the next one.
    }
  }
  return '';
}

function cameraProblem(e: unknown): string {
  const name = typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'Camera access was not allowed.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The camera could not start. Another app may be using it.';
    default:
      return 'The camera could not start.';
  }
}

function extensionFor(type: string): string {
  if (type.includes('mp4')) return 'mp4';
  if (type.includes('quicktime')) return 'mov';
  if (type.includes('matroska')) return 'mkv';
  return 'webm';
}

function clipName(room: string, at: Date, type: string): string {
  const slug =
    room
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'room';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${slug}-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}.${extensionFor(type)}`;
}

const clock = (s: number): string => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const pct = (n: number): string => `${(n * 100).toFixed(2)}%`;

function whenEvent(el: HTMLElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      window.clearTimeout(timer);
      el.removeEventListener(event, done);
      resolve();
    };
    const timer = window.setTimeout(done, timeoutMs);
    el.addEventListener(event, done, { once: true });
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('Timed out')), ms);
    p.then(
      (v) => {
        window.clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        window.clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** A still of the video at its full resolution. */
async function grabFrame(video: HTMLVideoElement): Promise<Blob | null> {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, w, h);
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.92));
}

type Phase = 'starting' | 'ready' | 'recording' | 'stopping' | 'paused' | 'done' | 'failed';

interface Session {
  phase: Phase;
  disposed: boolean;
  /** Bumped to drop a camera that is still starting. */
  gen: number;
  stream: MediaStream | null;
  recorder: MediaRecorder | null;
  chunks: Blob[];
  bytes: number;
  finished: boolean;
  startedAt: Date | null;
  startedMs: number;
  shots: Blob[];
  shooting: boolean;
  photoFailed: boolean;
  sweepByHand: boolean;
  detector: Detector | null;
  detectorAsked: boolean;
  tally: Tally;
  fast: boolean;
  wake: WakeLockSentinel | null;
}

interface Controls {
  toggleRecording(): void;
  takeLabelShot(): void;
  toggleSweep(): void;
  requestClose(): void;
  discard(): void;
}

export function LiveCamera(props: LiveCameraProps): ReactElement {
  const { roomName } = props;
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const controls = useRef<Controls | null>(null);
  const confirmingRef = useRef(false);
  const titleId = useId();
  const textId = useId();

  const [phase, setPhase] = useState<Phase>('starting');
  const [problem, setProblem] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [bytes, setBytes] = useState(0);
  const [sweep, setSweep] = useState<1 | 2>(1);
  const [shots, setShots] = useState(0);
  const [shooting, setShooting] = useState(false);
  const [flash, setFlash] = useState(0);
  const [said, setSaid] = useState('');
  const [labels, setLabels] = useState<'loading' | 'on' | 'off'>('loading');
  const [regions, setRegions] = useState<PlacedRegion[]>(NO_REGIONS);
  const [tally, setTally] = useState<Tally>(NO_TALLY);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const s: Session = {
      phase: 'starting',
      disposed: false,
      gen: 0,
      stream: null,
      recorder: null,
      chunks: [],
      bytes: 0,
      finished: false,
      startedAt: null,
      startedMs: 0,
      shots: [],
      shooting: false,
      photoFailed: false,
      sweepByHand: false,
      detector: null,
      detectorAsked: false,
      tally: NO_TALLY,
      fast: false,
      wake: null,
    };
    const go = (p: Phase): void => {
      s.phase = p;
      setPhase(p);
    };
    const live = (): boolean => s.phase === 'ready' || s.phase === 'recording';
    const cameraLive = (): boolean => s.stream?.getVideoTracks()[0]?.readyState === 'live';

    // Keep the screen on while filming: a phone that locks itself hides the page, which stops the recording.
    const holdAwake = async (): Promise<void> => {
      if (s.wake || document.hidden || !('wakeLock' in navigator)) return;
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (s.disposed || !live()) {
          void lock.release().catch(() => undefined);
          return;
        }
        s.wake = lock;
        lock.addEventListener('release', () => {
          if (s.wake === lock) s.wake = null;
        });
      } catch {
        // Not allowed here, or the battery is low.
      }
    };
    const letSleep = (): void => {
      const lock = s.wake;
      s.wake = null;
      void lock?.release().catch(() => undefined);
    };

    const releaseCamera = (): void => {
      const stream = s.stream;
      s.stream = null;
      for (const t of stream?.getTracks() ?? []) t.stop();
      const v = videoRef.current;
      if (v) v.srcObject = null;
      letSleep();
    };

    /** Stop recording and keep nothing. */
    const dropRecorder = (): void => {
      const rec = s.recorder;
      s.recorder = null;
      s.finished = true;
      try {
        if (rec && rec.state !== 'inactive') rec.stop();
      } catch {
        // Already stopped.
      }
    };

    const fail = (reason: string): void => {
      s.gen += 1;
      dropRecorder();
      releaseCamera();
      setRegions(NO_REGIONS);
      setProblem(reason);
      go('failed');
      latest.current.onFallback(reason);
    };

    const finish = (): void => {
      if (s.finished || s.disposed) return;
      s.finished = true;
      const rec = s.recorder;
      s.recorder = null;
      const mimeType = rec?.mimeType || s.chunks[0]?.type || pickMimeType() || 'video/webm';
      const type = mimeType.split(';')[0]?.trim() || 'video/webm';
      const clip = new Blob(s.chunks, { type });
      s.chunks = [];
      if (clip.size === 0) {
        if (cameraLive()) {
          s.finished = false;
          setProblem('Nothing was recorded. Try again.');
          go('ready');
        } else {
          fail('The camera stopped before anything was recorded.');
        }
        return;
      }
      releaseCamera();
      setRegions(NO_REGIONS);
      go('done');
      const startedAt = s.startedAt ?? new Date();
      latest.current.onDone({
        clip,
        fileName: clipName(latest.current.roomName, startedAt, type),
        mimeType,
        labelShots: [...s.shots],
        startedAt: startedAt.toISOString(),
        spotted: spottedList(s.tally).map((x) => ({ categoryId: x.categoryId, label: x.label, count: x.count })),
      });
    };

    const stopRecording = (): void => {
      const rec = s.recorder;
      if (!rec || s.phase !== 'recording') return;
      go('stopping');
      try {
        if (rec.state === 'inactive') finish();
        else rec.stop();
      } catch {
        finish();
      }
    };

    const startRecording = (): void => {
      const stream = s.stream;
      if (s.phase !== 'ready' || !stream) return;
      const mimeType = pickMimeType();
      let rec: MediaRecorder;
      try {
        rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: VIDEO_BITS_PER_SECOND } : { videoBitsPerSecond: VIDEO_BITS_PER_SECOND });
      } catch {
        try {
          rec = new MediaRecorder(stream);
        } catch {
          setProblem('Recording could not start on this device.');
          return;
        }
      }
      s.recorder = rec;
      s.chunks = [];
      s.bytes = 0;
      s.finished = false;
      rec.addEventListener('dataavailable', (e) => {
        if (s.recorder !== rec || e.data.size === 0) return;
        s.chunks.push(e.data);
        s.bytes += e.data.size;
        setBytes(s.bytes);
      });
      rec.addEventListener('stop', finish);
      rec.addEventListener('error', () => {
        // Keep what was recorded.
        if (rec.state === 'inactive') finish();
        else stopRecording();
      });
      try {
        rec.start(CHUNK_MS);
      } catch {
        s.recorder = null;
        setProblem('Recording could not start on this device.');
        return;
      }
      s.startedAt = new Date();
      s.startedMs = performance.now();
      s.tally = NO_TALLY;
      setTally(NO_TALLY);
      setBytes(0);
      setElapsed(0);
      setProblem(null);
      go('recording');
    };

    const onTrackEnded = (): void => {
      if (s.disposed) return;
      if (s.phase === 'recording') stopRecording();
      else if (s.phase === 'ready') fail('The camera stopped working.');
    };

    // Live labels: every DETECT_EVERY_MS once the detector has loaded, idle while not filming.
    let detectTimer = 0;
    let detectFailures = 0;
    const detectLoop = async (): Promise<void> => {
      const detector = s.detector;
      if (!detector || s.disposed) return;
      const t0 = performance.now();
      const v = videoRef.current;
      if (live() && v && v.videoWidth && !document.hidden) {
        try {
          const found = await detector.detect(v);
          if (s.disposed) return;
          detectFailures = 0;
          setRegions(live() && !s.fast ? layoutRegions(found, { w: v.videoWidth, h: v.videoHeight }, { w: v.clientWidth, h: v.clientHeight }, MAX_REGIONS) : NO_REGIONS);
          if (s.phase === 'recording') {
            const next = mergeTally(s.tally, found);
            if (next !== s.tally) {
              s.tally = next;
              setTally(next);
            }
          }
        } catch (e) {
          detectFailures += 1;
          if (detectFailures >= 3) {
            console.warn('Live labels stopped.', e);
            s.detector = null;
            setLabels('off');
            setRegions(NO_REGIONS);
            return;
          }
        }
      } else {
        setRegions(NO_REGIONS);
      }
      if (!s.disposed) detectTimer = window.setTimeout(() => void detectLoop(), Math.max(50, DETECT_EVERY_MS - (performance.now() - t0)));
    };

    const start = async (): Promise<void> => {
      const gen = ++s.gen;
      go('starting');
      setProblem(null);
      const media = navigator.mediaDevices as MediaDevices | undefined;
      if (typeof media?.getUserMedia !== 'function' || typeof MediaRecorder === 'undefined') {
        fail('This browser cannot film inside the app.');
        return;
      }
      let stream: MediaStream;
      try {
        stream = await media.getUserMedia(CONSTRAINTS);
      } catch (e) {
        if (gen === s.gen && !s.disposed) fail(cameraProblem(e));
        return;
      }
      const track = stream.getVideoTracks()[0];
      if (gen !== s.gen || s.disposed || !track) {
        for (const t of stream.getTracks()) t.stop();
        if (!track && gen === s.gen && !s.disposed) fail('No camera was found on this device.');
        return;
      }
      s.stream = stream;
      track.addEventListener('ended', onTrackEnded);
      const v = videoRef.current;
      if (!v) {
        releaseCamera();
        return;
      }
      v.muted = true;
      v.srcObject = stream;
      await v.play().catch(() => undefined);
      if (!v.videoWidth) await whenEvent(v, 'loadedmetadata', 5000);
      if (gen !== s.gen || s.disposed) return;
      go('ready');
      void holdAwake();
      if (!s.detectorAsked) {
        s.detectorAsked = true;
        void loadDetector().then((detector) => {
          if (s.disposed) return;
          s.detector = detector;
          setLabels(detector ? 'on' : 'off');
          if (detector) void detectLoop();
        });
      }
    };

    // Live guidance and the recording clock, on a small frame every QUALITY.everyMs.
    const small = document.createElement('canvas');
    const smallCtx = small.getContext('2d', { willReadFrequently: true });
    let guide: GuideState = GUIDE_IDLE;
    let lastSignature: Float32Array | null = null;
    const tick = (): void => {
      if (s.disposed) return;
      if (s.phase === 'recording') {
        const seconds = (performance.now() - s.startedMs) / 1000;
        setElapsed(Math.floor(seconds));
        if (!s.sweepByHand && seconds >= Math.max(10, latest.current.expectedSeconds ?? 60) / 2) setSweep(2);
      }
      const v = videoRef.current;
      if (!live() || document.hidden || !v || !smallCtx || !v.videoWidth || v.readyState < 2) {
        lastSignature = null;
        s.fast = false;
        if (!live() && guide.shown) {
          guide = GUIDE_IDLE;
          setPrompt(null);
        }
        return;
      }
      const k = SMALL_EDGE / Math.max(v.videoWidth, v.videoHeight);
      const w = Math.max(8, Math.round(v.videoWidth * k));
      const h = Math.max(8, Math.round(v.videoHeight * k));
      if (small.width !== w || small.height !== h) {
        small.width = w;
        small.height = h;
      }
      let m: ReturnType<typeof measure>;
      try {
        smallCtx.drawImage(v, 0, 0, w, h);
        m = measure(smallCtx.getImageData(0, 0, w, h).data, w, h);
      } catch {
        return;
      }
      // Movement only matters while recording.
      const motion = s.phase === 'recording' && lastSignature ? motionScore(lastSignature, m.signature) : null;
      lastSignature = m.signature;
      s.fast = isMovingTooFast(motion);
      guide = settleGuide(guide, assessFrame(m, motion), performance.now());
      setPrompt(guide.shown);
    };
    const tickTimer = window.setInterval(tick, QUALITY.everyMs);

    const takeLabelShot = async (): Promise<void> => {
      const v = videoRef.current;
      const track = s.stream?.getVideoTracks()[0];
      if (!v || !track || s.shooting || !live()) return;
      s.shooting = true;
      setShooting(true);
      try {
        let blob: Blob | null = null;
        if (!s.photoFailed && typeof ImageCapture !== 'undefined') {
          try {
            blob = await withTimeout(new ImageCapture(track).takePhoto(), PHOTO_TIMEOUT_MS);
          } catch {
            // Some cameras refuse a photo while the video runs. Grab the video from now on.
            s.photoFailed = true;
          }
        }
        if (!blob || blob.size === 0) blob = await grabFrame(v);
        if (s.disposed) return;
        if (!blob) {
          setSaid('The label shot did not work. Try again.');
          return;
        }
        s.shots.push(blob);
        setShots(s.shots.length);
        setFlash((n) => n + 1);
        setSaid(`Label shot ${s.shots.length} taken`);
      } finally {
        s.shooting = false;
        if (!s.disposed) setShooting(false);
      }
    };

    const discard = (): void => {
      if (s.phase === 'done') return;
      s.gen += 1;
      dropRecorder();
      releaseCamera();
      setRegions(NO_REGIONS);
      go('done');
      latest.current.onCancel();
    };

    const requestClose = (): void => {
      if (s.phase === 'recording' || s.phase === 'stopping' || s.shots.length > 0) setConfirming(true);
      else discard();
    };

    const onVisibility = (): void => {
      if (s.disposed) return;
      if (document.hidden) {
        // Stop and keep what was recorded. Without a recording, let go of the camera until the page is back.
        if (s.phase === 'recording') stopRecording();
        else if (s.phase === 'ready' || s.phase === 'starting') {
          s.gen += 1;
          releaseCamera();
          setRegions(NO_REGIONS);
          go('paused');
        }
      } else if (s.phase === 'paused') {
        void start();
      } else if (live()) {
        void holdAwake();
      }
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || s.disposed) return;
      e.preventDefault();
      if (confirmingRef.current) setConfirming(false);
      else requestClose();
    };

    controls.current = {
      toggleRecording: () => (s.phase === 'recording' ? stopRecording() : startRecording()),
      takeLabelShot: () => void takeLabelShot(),
      toggleSweep: () => {
        s.sweepByHand = true;
        setSweep((n) => (n === 1 ? 2 : 1));
      },
      requestClose,
      discard,
    };

    // A modal over the whole app: the page behind cannot be reached or scrolled.
    const appRoot = document.getElementById('root');
    const madeInert = Boolean(appRoot && !appRoot.hasAttribute('inert'));
    if (madeInert) appRoot?.setAttribute('inert', '');
    const html = document.documentElement;
    const overflow = html.style.overflow;
    html.style.overflow = 'hidden';
    rootRef.current?.focus();
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('keydown', onKey);
    void start();

    return () => {
      s.disposed = true;
      s.gen += 1;
      window.clearInterval(tickTimer);
      window.clearTimeout(detectTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('keydown', onKey);
      dropRecorder();
      releaseCamera();
      if (madeInert) appRoot?.removeAttribute('inert');
      html.style.overflow = overflow;
      controls.current = null;
    };
  }, []);

  // Back to the close button when the confirmation goes away.
  useEffect(() => {
    const was = confirmingRef.current;
    confirmingRef.current = confirming;
    if (was && !confirming) closeRef.current?.focus();
  }, [confirming]);

  const recording = phase === 'recording';
  const live = phase === 'ready' || recording;
  const inTake = recording || phase === 'stopping';
  const spotted = spottedList(tally);
  const shotsText = shots === 1 ? 'The label shot is' : `The ${shots} label shots are`;
  const status =
    phase === 'starting'
      ? 'Starting the camera…'
      : phase === 'paused'
        ? 'Paused while Domesday was in the background'
        : phase === 'stopping'
          ? 'Saving the clip…'
          : phase === 'done'
            ? 'Clip saved'
            : phase === 'failed'
              ? (problem ?? 'The camera is not available.')
              : recording
                ? `${bytes ? megabytes(bytes) : '0 MB'} so far`
                : (problem ?? 'Tap the red button to start');

  return createPortal(
    <div ref={rootRef} className="dms dms-cam live-cam" role="dialog" aria-modal="true" aria-label={`Film ${roomName}`} tabIndex={-1}>
      <video ref={videoRef} className="dms-cam__feed" autoPlay muted playsInline aria-hidden="true" />

      <div className="live-cam__regions" aria-hidden="true">
        {regions.map((r) => (
          <span key={r.key} className="dms-region" style={{ '--x': pct(r.rect.x), '--y': pct(r.rect.y), '--w': pct(r.rect.w), '--h': pct(r.rect.h) } as CSSProperties}>
            <i />
            <i />
            <i />
            <i />
            <span className="dms-region__read" style={r.rect.y + r.rect.h > 0.8 ? LABEL_ABOVE : undefined}>
              {r.label}
            </span>
          </span>
        ))}
      </div>
      {flash > 0 ? <span key={flash} className="live-cam__flash" aria-hidden="true" /> : null}

      <div className="live-cam__hud" inert={confirming}>
        <div className="live-cam__top">
          {recording ? <span className="dms-cam__rec">{UI_COPY.recordingNotice}</span> : <span />}
          {recording ? (
            <span className="dms-cam__meta live-cam__pill live-cam__timer" role="timer">
              {clock(elapsed)}
            </span>
          ) : null}
        </div>
        {live ? (
          <button type="button" className="live-cam__sweep" onClick={() => controls.current?.toggleSweep()}>
            <span className="dms-cam__meta live-cam__pill">{sweep === 1 ? 'Sweep 1 of 2 · shoulder height' : 'Sweep 2 of 2 · lower down'}</span>
            <span className="live-cam__sr">{sweep === 1 ? '. Switch to sweep 2' : '. Switch back to sweep 1'}</span>
          </button>
        ) : null}
        <div className="live-cam__guide" role="status">
          {prompt ? (
            <span key={prompt} className="dms-cam__guide">
              <Icon name={PROMPT_ICON[prompt]} />
              {UI_COPY[prompt]}
            </span>
          ) : null}
        </div>
        <div className="live-cam__spacer" />

        <div className="live-cam__info">
          {live && labels === 'loading' ? <span className="dms-cam__meta live-cam__pill live-cam__note">Loading live labels…</span> : null}
          {live && labels === 'off' ? <span className="dms-cam__meta live-cam__pill live-cam__note">Live labels are off</span> : null}
          {spotted.length ? (
            <ul className="live-cam__chips" aria-label="Spotted so far">
              {spotted.slice(0, MAX_CHIPS).map((x) => (
                <li key={`${x.categoryId}|${x.label}`}>
                  {x.count} × {x.label}
                </li>
              ))}
              {spotted.length > MAX_CHIPS ? <li>+{spotted.length - MAX_CHIPS} more</li> : null}
            </ul>
          ) : null}
          <span className="ui-capture live-cam__room">{roomName}</span>
          <span className="dms-cam__meta live-cam__status">{status}</span>
        </div>

        <div className="live-cam__controls">
          <button ref={closeRef} type="button" className="dms-cam__btn" onClick={() => controls.current?.requestClose()} aria-label="Close the camera">
            <Icon name="reject" />
          </button>
          <button
            type="button"
            className="dms-cam__shutter"
            aria-pressed={recording}
            aria-label={`${recording ? 'Stop' : 'Start'} recording ${roomName}`}
            disabled={!live}
            onClick={() => controls.current?.toggleRecording()}
          />
          <button
            type="button"
            className="dms-cam__btn live-cam__shot"
            onClick={() => controls.current?.takeLabelShot()}
            disabled={!live || shooting}
            aria-label={shots ? `Take a label shot. ${shots} taken` : 'Take a label shot'}
          >
            <Icon name="label-shot" />
            {shots ? (
              <span className="live-cam__badge" aria-hidden="true">
                {shots}
              </span>
            ) : null}
          </button>
        </div>
      </div>

      <span className="live-cam__sr" role="status">
        {said}
      </span>

      {confirming ? (
        <div className="live-cam__scrim">
          <div className="live-cam__sheet" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={textId}>
            <h2 id={titleId} className="ui-title-m">
              {inTake ? 'Discard this clip?' : 'Close the camera?'}
            </h2>
            <p id={textId} className="ui-body-s">
              {inTake ? `Filming stops and the clip is not saved.${shots ? ` ${shotsText} not saved either.` : ''}` : `${shotsText} not saved.`}
            </p>
            <div className="live-cam__actions">
              <Btn variant="primary" autoFocus onClick={() => setConfirming(false)}>
                {inTake ? 'Keep filming' : 'Back to the camera'}
              </Btn>
              <Btn
                variant="danger"
                onClick={() => {
                  setConfirming(false);
                  controls.current?.discard();
                }}
              >
                {inTake ? 'Discard the clip' : 'Close and discard'}
              </Btn>
            </div>
          </div>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
