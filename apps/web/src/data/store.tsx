import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { connectRuntime, type Runtime } from '../runtime/runtime';
import type { DocSnap, Json, QuerySnap } from '../runtime/types';
import type { CameraCheck, Correction, Followup, Line, MatchAnswer, Person, PersonId, Register, ReportRecord, RoomVisit, Site, Walk } from './types';

export interface WalkBundle {
  readonly walk: Walk;
  readonly rooms: ReadonlyMap<string, RoomVisit>;
  /** Every line of the walk, oldest first. A line's number is its position in this list. */
  readonly lines: readonly Line[];
  readonly matches: readonly MatchAnswer[];
  readonly followups: readonly Followup[];
}

export interface AppData {
  readonly rt: Runtime;
  readonly site: Site | null;
  readonly register: Register | null;
  readonly current: WalkBundle | null;
  readonly previous: WalkBundle | null;
  readonly reports: readonly ReportRecord[];
  /** Camera checks, newest first. */
  readonly cameraChecks: readonly CameraCheck[];
  /** Reviewers' corrections of the recogniser, newest first. */
  readonly corrections: readonly Correction[];
  /** False until the first answer from the store for the site. */
  readonly loaded: boolean;
}

const DataContext = createContext<AppData | null>(null);

function docData<T>(snap: DocSnap): T | null {
  return snap.exists ? (snap.data() as unknown as T) : null;
}

function listData<T>(snap: QuerySnap, withId = false): T[] {
  return snap.docs.filter((d) => d.exists).map((d) => (withId ? ({ id: d.id, ...(d.data() as Json) } as unknown as T) : (d.data() as unknown as T)));
}

function normaliseRoom(r: RoomVisit): RoomVisit {
  return { ...r, frames: r.frames ?? [], labelShots: r.labelShots ?? [], analysis: r.analysis ?? { status: 'idle' } };
}

function normaliseLine(l: Line): Line {
  return { ...l, evidence: l.evidence ?? [], history: l.history ?? [], notes: l.notes ?? [], version: l.version ?? 1 };
}

function sortLines(lines: Line[]): Line[] {
  return lines.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
}

interface BundleParts {
  walk: Walk | null;
  rooms: RoomVisit[] | null;
  lines: Line[] | null;
  matches: MatchAnswer[] | null;
  followups: Followup[] | null;
}

const EMPTY_PARTS: BundleParts = { walk: null, rooms: null, lines: null, matches: null, followups: null };

function useWalkBundle(rt: Runtime | null, walkId: string | null | undefined): WalkBundle | null {
  const [parts, setParts] = useState<BundleParts>(EMPTY_PARTS);
  useEffect(() => {
    setParts(EMPTY_PARTS);
    if (!rt || !walkId) return undefined;
    const base = `walks/${walkId}`;
    const set = <K extends keyof BundleParts>(key: K) => (value: BundleParts[K]) => setParts((p) => ({ ...p, [key]: value }));
    const unsubs = [
      rt.db.doc(base).onSnapshot((s) => set('walk')(docData<Walk>(s))),
      rt.db.collection(`${base}/rooms`).onSnapshot((s) => set('rooms')(listData<RoomVisit>(s).map(normaliseRoom))),
      rt.db.collection(`${base}/lines`).onSnapshot((s) => set('lines')(sortLines(listData<Line>(s).map(normaliseLine)))),
      rt.db.collection(`${base}/matches`).onSnapshot((s) => set('matches')(listData<MatchAnswer>(s))),
      rt.db.collection(`${base}/followups`).onSnapshot((s) => set('followups')(listData<Followup>(s, true))),
    ];
    return () => unsubs.forEach((u) => u());
  }, [rt, walkId]);
  return useMemo(() => {
    if (!parts.walk) return null;
    return {
      walk: { ...parts.walk, events: parts.walk.events ?? [], capturedBy: parts.walk.capturedBy ?? [] },
      rooms: new Map((parts.rooms ?? []).map((r) => [r.roomId, r])),
      lines: parts.lines ?? [],
      matches: parts.matches ?? [],
      followups: parts.followups ?? [],
    };
  }, [parts]);
}

export function DataProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }): ReactElement {
  const [rt, setRt] = useState<Runtime | null>(null);
  const [site, setSite] = useState<Site | null | undefined>(undefined);
  const [register, setRegister] = useState<Register | null>(null);
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [cameraChecks, setCameraChecks] = useState<CameraCheck[]>([]);
  const [corrections, setCorrections] = useState<Correction[]>([]);

  useEffect(() => {
    let live = true;
    void connectRuntime().then((r) => {
      if (live) setRt(r);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!rt) return undefined;
    const unsubs = [
      rt.db.doc('site/main').onSnapshot((s) => setSite(docData<Site>(s))),
      rt.db.doc('register/main').onSnapshot((s) => setRegister(docData<Register>(s))),
      rt.db.collection('reports').onSnapshot((s) => setReports(listData<ReportRecord>(s))),
      rt.db.collection('corrections').onSnapshot((s) => setCorrections(listData<Correction>(s).sort((a, b) => (a.at < b.at ? 1 : -1)))),
      rt.db.collection('camera-checks').onSnapshot((s) => setCameraChecks(listData<CameraCheck>(s).sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1)))),
    ];
    return () => unsubs.forEach((u) => u());
  }, [rt]);

  const current = useWalkBundle(rt, site?.currentWalkId);
  const previous = useWalkBundle(rt, site?.previousWalkId);

  const value = useMemo<AppData | null>(
    () => (rt ? { rt, site: site ?? null, register, current, previous, reports, cameraChecks, corrections, loaded: site !== undefined } : null),
    [rt, site, register, current, previous, reports, cameraChecks, corrections],
  );
  if (!value) return <>{fallback}</>;
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): AppData {
  const v = useContext(DataContext);
  if (!v) throw new Error('useData outside DataProvider');
  return v;
}

// Demo roles: who is using this device. Remembered per device; never shared.

const PERSONA_KEY = 'domesday.persona';

interface PersonaContextValue {
  readonly personId: PersonId;
  readonly person: Person | null;
  setPersonId(id: PersonId): void;
}

const PersonaContext = createContext<PersonaContextValue | null>(null);

function initialPersona(): PersonId {
  try {
    const saved = localStorage.getItem(PERSONA_KEY);
    if (saved) return saved;
  } catch {
    // ignore
  }
  return window.matchMedia?.('(max-width: 720px)').matches ? 'tolu' : 'chinedu';
}

export function PersonaProvider({ children }: { children: ReactNode }): ReactElement {
  const { site } = useData();
  const [personId, setId] = useState<PersonId>(initialPersona);
  const setPersonId = useCallback((id: PersonId) => {
    setId(id);
    try {
      localStorage.setItem(PERSONA_KEY, id);
    } catch {
      // ignore
    }
  }, []);
  const person = site?.people.find((p) => p.id === personId) ?? null;
  const value = useMemo(() => ({ personId, person, setPersonId }), [personId, person, setPersonId]);
  return <PersonaContext.Provider value={value}>{children}</PersonaContext.Provider>;
}

export function usePersona(): PersonaContextValue {
  const v = useContext(PersonaContext);
  if (!v) throw new Error('usePersona outside PersonaProvider');
  return v;
}

// Short confirmations after an action ("Line 014 accepted").

interface Toast {
  readonly id: number;
  readonly text: string;
  readonly tone: 'ok' | 'error';
}

interface ToastContextValue {
  readonly toasts: readonly Toast[];
  say(text: string, tone?: 'ok' | 'error'): void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const say = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => {
    const id = next.current++;
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 6000 : 3200);
  }, []);
  const value = useMemo(() => ({ toasts, say }), [toasts, say]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast(): ToastContextValue {
  const v = useContext(ToastContext);
  if (!v) throw new Error('useToast outside ToastProvider');
  return v;
}
