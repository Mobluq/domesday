import type { CSSProperties, ReactElement } from 'react';
import { categoryName, lineNo } from '../data/derive';
import type { WalkBundle } from '../data/store';
import type { Box, Line, Site } from '../data/types';
import { urlFor } from '../runtime/media';
import { go } from '../route';

/**
 * The wall: every asset this site has on record, as a tight grid of its own photographs, in
 * walking order (after Xiloteca Trevigiana's wall of wood specimens, Awwwards). Lines seen on
 * this walk are in colour; what the last walk saw and this one hasn't yet is grey; rooms with
 * nothing yet are blank. The wall fills in as the walk goes on.
 */

type TileState = 'seen' | 'last' | 'blank';

interface AssetTile {
  readonly kind: 'asset';
  readonly key: string;
  readonly state: TileState;
  readonly style: CSSProperties;
  readonly caption: string;
  readonly roomId: string;
}

interface RoomTile {
  readonly kind: 'room';
  readonly key: string;
  readonly no: string;
  readonly name: string;
  readonly word: string;
  readonly roomId: string;
}

type Tile = AssetTile | RoomTile;

const GRADE: Record<string, string> = { good: 'good', fair: 'fair', poor: 'poor', not_working_or_unsafe: 'not working or unsafe' };

/** Crop a frame to a line's evidence box, filling a square tile without stretching. */
function crop(url: string, box: Box | null | undefined, fw: number, fh: number): CSSProperties {
  if (!box) return { backgroundImage: `url("${url}")`, backgroundSize: 'cover', backgroundPosition: 'center' };
  const pad = 0.18;
  const [bx, by, bw, bh] = box;
  const w = Math.min(1, bw * (1 + pad * 2));
  const h = Math.min(1, bh * (1 + pad * 2));
  const cx = bx + bw / 2;
  const cy = by + bh / 2;
  // Scale the frame so the padded box covers the tile (tile = 1 x 1).
  const s = Math.max(1 / (w * fw), 1 / (h * fh));
  const iw = fw * s;
  const ih = fh * s;
  const px = iw > 1 ? Math.min(100, Math.max(0, ((cx * iw - 0.5) / (iw - 1)) * 100)) : 50;
  const py = ih > 1 ? Math.min(100, Math.max(0, ((cy * ih - 0.5) / (ih - 1)) * 100)) : 50;
  return { backgroundImage: `url("${url}")`, backgroundSize: `${(iw * 100).toFixed(1)}% ${(ih * 100).toFixed(1)}%`, backgroundPosition: `${px.toFixed(1)}% ${py.toFixed(1)}%` };
}

function assetTiles(site: Site, bundle: WalkBundle, lines: readonly Line[], state: TileState, roomId: string): AssetTile[] {
  const visit = bundle.rooms.get(roomId);
  const room = site.rooms.find((r) => r.id === roomId);
  return lines.map((l) => {
    const ev = l.evidence[0];
    const frame = ev ? visit?.frames.find((f) => f.id === ev.frameId) : undefined;
    const url = frame ? urlFor(frame.ref) : null;
    const fallback = room?.sample?.poster ?? null;
    const style = url ? crop(url, ev?.box, frame?.w ?? 4, frame?.h ?? 3) : fallback ? { backgroundImage: `url("${fallback}")`, backgroundSize: 'cover', backgroundPosition: 'center' } : {};
    const what = `${categoryName(site, l.categoryId)}${l.quantity > 1 ? ` (${l.quantity})` : ''}, ${GRADE[l.condition ?? ''] ?? 'condition not set'}`;
    return {
      kind: 'asset' as const,
      key: `${state}-${l.id}`,
      state: url || fallback ? state : 'blank',
      style,
      caption: state === 'seen' ? `Line ${lineNo(bundle, l.id)} · ${what}` : `Last walk · ${what}`,
      roomId,
    };
  });
}

export function buildWall(site: Site, current: WalkBundle, previous: WalkBundle | null, running: (roomId: string) => boolean = () => false): Tile[] {
  const tiles: Tile[] = [];
  site.rooms.forEach((r, i) => {
    const visit = current.rooms.get(r.id);
    const now = current.lines.filter((l) => l.roomId === r.id && (l.status === 'proposed' || l.status === 'accepted'));
    const before = previous ? previous.lines.filter((l) => l.roomId === r.id && l.status === 'accepted') : [];
    const word = running(r.id)
      ? 'Being read now'
      : visit?.status === 'skipped'
        ? 'Skipped'
        : now.length
          ? `${now.length} seen`
          : visit?.status === 'filmed'
            ? 'Filmed, not read yet'
            : before.length
              ? `${before.length} last walk`
              : 'Not filmed yet';
    tiles.push({ kind: 'room', key: `room-${r.id}`, no: String(i + 1).padStart(2, '0'), name: r.name, word, roomId: r.id });
    const assets = now.length ? assetTiles(site, current, now, 'seen', r.id) : previous && before.length ? assetTiles(site, previous, before, 'last', r.id) : [];
    // A room with no photographs at all keeps just its room tile rather than a row of blanks.
    if (assets.some((a) => a.state !== 'blank')) tiles.push(...assets);
  });
  return tiles;
}

interface WallProps {
  readonly site: Site;
  readonly current: WalkBundle;
  readonly previous: WalkBundle | null;
  /** A room whose footage is being read right now. */
  readonly running?: (roomId: string) => boolean;
  /** A filmed room that is waiting for recognition and can be read from here. */
  readonly runnable?: (roomId: string) => boolean;
  readonly onRun?: (roomId: string) => void;
}

export function Wall({ site, current, previous, running, runnable, onRun }: WallProps): ReactElement {
  const tiles = buildWall(site, current, previous, running);
  const cols = Math.max(7, Math.min(18, Math.round(Math.sqrt(tiles.length * 2.6))));
  return (
    <div className="wall" style={{ '--cols': cols } as CSSProperties}>
      {tiles.map((t) =>
        t.kind === 'room' ? (
          <div key={t.key} className="wall__room" data-running={running?.(t.roomId) || undefined}>
            <button type="button" className="wall__roombtn" onClick={() => go('capture')} aria-label={`${t.name}: ${t.word}`}>
              <span className="wall__no">{t.no}</span>
              <span className="wall__name">{t.name}</span>
              <span className="wall__word">{t.word}</span>
            </button>
            {runnable?.(t.roomId) && onRun ? (
              <button type="button" className="linklike wall__run" onClick={() => onRun(t.roomId)}>
                Read it now
              </button>
            ) : null}
          </div>
        ) : (
          <button key={t.key} type="button" className="wall__tile" data-s={t.state} style={t.style} onClick={() => go(t.state === 'seen' ? 'review' : 'capture')} aria-label={t.caption} title={t.caption}>
            <span className="wall__cap" aria-hidden="true">
              {t.caption}
            </span>
          </button>
        ),
      )}
    </div>
  );
}
