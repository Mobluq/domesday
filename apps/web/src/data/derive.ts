import {
  compareWalks,
  reconcileWithRegister,
  type ComparableLine,
  type CompareWalksResult,
  type ReconcileResult,
  type RegisterLine,
} from '@domesday/domain';
import type { WalkBundle } from './store';
import type { Frame, Line, PersonId, Register, RoomVisit, Site } from './types';

const LAGOS = 'Africa/Lagos';
const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: LAGOS });
const shortDateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: LAGOS });
const dayMonthFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: LAGOS });
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: LAGOS });
const secFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: LAGOS });

export const fmtDate = (iso: string | null | undefined): string => (iso ? dateFmt.format(new Date(iso)) : '');
export const fmtShortDate = (iso: string | null | undefined): string => (iso ? shortDateFmt.format(new Date(iso)) : '');
export const fmtDayMonth = (iso: string | null | undefined): string => (iso ? dayMonthFmt.format(new Date(iso)) : '');
export const fmtTime = (iso: string | null | undefined): string => (iso ? timeFmt.format(new Date(iso)) : '');
export const fmtTimeSec = (iso: string | null | undefined): string => (iso ? secFmt.format(new Date(iso)) : '');
export const fmtDateTime = (iso: string | null | undefined): string => (iso ? `${fmtDate(iso)}, ${fmtTime(iso)}` : '');

/** "00:12.4" */
export function timecode(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

export function duration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function megabytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

const nairaFmt = new Intl.NumberFormat('en-NG', { maximumFractionDigits: 0 });
/** ₦380,000 */
export const money = (kobo: number | null | undefined): string => (kobo === null || kobo === undefined ? '' : `₦${nairaFmt.format(Math.round(kobo / 100))}`);
/** 380,000 (for columns already labelled ₦) */
export const amount = (kobo: number | null | undefined): string => (kobo === null || kobo === undefined ? '' : nairaFmt.format(Math.round(kobo / 100)));

export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function nowIso(): string {
  return new Date().toISOString();
}

export function personName(site: Site | null, id: PersonId | null | undefined): string {
  if (!id) return '';
  return site?.people.find((p) => p.id === id)?.name ?? id;
}

export function firstName(site: Site | null, id: PersonId | null | undefined): string {
  return personName(site, id).split(' ')[0] ?? '';
}

export function roomName(site: Site | null, roomId: string | null | undefined): string {
  if (!roomId) return '';
  return site?.rooms.find((r) => r.id === roomId)?.name ?? roomId;
}

export function categoryName(site: Site | null, id: string | null | undefined): string {
  if (!id) return '';
  return site?.categories.find((c) => c.id === id)?.name ?? id;
}

export function categoryPlural(site: Site | null, id: string): string {
  return site?.categories.find((c) => c.id === id)?.plural ?? `${categoryName(site, id).toLowerCase()}s`;
}

/** The line's number on its walk, "014". */
export function lineNo(bundle: WalkBundle | null, lineId: string): string {
  const i = bundle ? bundle.lines.findIndex((l) => l.id === lineId) : -1;
  return String(i + 1).padStart(3, '0');
}

export const isOpen = (l: Line): boolean => l.status === 'proposed';
export const isApproved = (l: Line): boolean => l.status === 'accepted';
/** Lines that still stand: proposed or accepted (not rejected, merged away or split). */
export const isLive = (l: Line): boolean => l.status === 'proposed' || l.status === 'accepted';

export function liveLines(bundle: WalkBundle | null): Line[] {
  return bundle ? bundle.lines.filter(isLive) : [];
}

export function approvedLines(bundle: WalkBundle | null): Line[] {
  return bundle ? bundle.lines.filter(isApproved) : [];
}

/** A line's title: "Split air conditioner" or "Training chairs × 24". */
export function lineTitle(site: Site | null, l: Line): string {
  const name = categoryName(site, l.categoryId);
  return l.kind === 'counted_group' ? `${name} × ${l.quantity}` : name;
}

export interface FrameHit {
  readonly frame: Frame;
  readonly room: RoomVisit;
}

/** Every frame and label shot of a walk, by id. */
export function framesOf(bundle: WalkBundle | null): Map<string, FrameHit> {
  const map = new Map<string, FrameHit>();
  if (!bundle) return map;
  for (const room of bundle.rooms.values()) {
    for (const f of [...room.frames, ...room.labelShots]) map.set(f.id, { frame: f, room });
  }
  return map;
}

export interface WalkProgress {
  readonly total: number;
  readonly filmed: number;
  readonly skipped: number;
  readonly notStarted: number;
  readonly analysing: number;
  readonly waiting: number;
}

export function walkProgress(site: Site | null, bundle: WalkBundle | null): WalkProgress {
  const rooms = site?.rooms ?? [];
  let filmed = 0;
  let skipped = 0;
  let analysing = 0;
  let waiting = 0;
  for (const r of rooms) {
    const v = bundle?.rooms.get(r.id);
    if (v?.status === 'filmed') filmed += 1;
    if (v?.status === 'skipped') skipped += 1;
    if (v?.analysis.status === 'running') analysing += 1;
    if (v?.analysis.status === 'waiting' || v?.analysis.status === 'failed') waiting += 1;
  }
  return { total: rooms.length, filmed, skipped, notStarted: rooms.length - filmed - skipped, analysing, waiting };
}

export function filmedRoomIds(bundle: WalkBundle | null): string[] {
  return bundle ? [...bundle.rooms.values()].filter((r) => r.status === 'filmed').map((r) => r.roomId) : [];
}

function comparable(siteId: string, l: Line): ComparableLine {
  return {
    lineId: l.id,
    assetId: null,
    siteId,
    roomId: l.roomId,
    categoryId: l.categoryId,
    kind: l.kind,
    quantity: l.quantity,
    condition: l.condition,
    tagCode: l.tagCode?.value ?? null,
    serial: l.serial?.value ?? null,
    appearance: null,
    position: null,
  };
}

export function comparison(site: Site, current: WalkBundle, previous: WalkBundle): CompareWalksResult {
  return compareWalks({
    before: approvedLines(previous).map((l) => comparable(site.id, l)),
    after: approvedLines(current).map((l) => comparable(site.id, l)),
    filmedRoomIds: filmedRoomIds(current),
  });
}

export function registerLines(site: Site, register: Register | null): RegisterLine[] {
  return (register?.lines ?? []).map((r) => ({
    registerId: r.registerId,
    description: r.description,
    categoryId: r.categoryId,
    siteId: site.id,
    roomId: r.roomId,
    locationLabel: r.locationLabel,
    tagCode: r.tagCode,
    serial: r.serial,
    quantity: r.quantity,
    bookValueKobo: r.bookValueKobo,
  }));
}

export function reconciliation(site: Site, register: Register | null, current: WalkBundle): ReconcileResult {
  return reconcileWithRegister({
    register: registerLines(site, register),
    lines: approvedLines(current).map((l) => ({
      lineId: l.id,
      siteId: site.id,
      roomId: l.roomId,
      categoryId: l.categoryId,
      description: l.description,
      quantity: l.quantity,
      tagCode: l.tagCode?.value ?? null,
      serial: l.serial?.value ?? null,
    })),
    filmedRoomIds: filmedRoomIds(current),
    decisions: current.matches.map((m) => ({ registerId: m.registerId, lineId: m.lineId, decision: m.decision })),
    categoryName: (id) => categoryName(site, id),
    roomName: (id) => roomName(site, id),
  });
}

/** The register line a previous-walk line belongs to (demo history keeps the link). */
export function registerEntry(register: Register | null, registerId: string | null | undefined) {
  if (!register || !registerId) return null;
  return register.lines.find((r) => r.registerId === registerId) ?? null;
}

export function walkDateLabel(bundle: WalkBundle | null): string {
  const iso = bundle?.walk.startedAt;
  return iso ? fmtDate(iso) : 'not started';
}
