import type { ConditionGrade, ConfidenceBand } from '@domesday/domain';
import { ConditionGrade as Grades } from '@domesday/domain';
import type { ButtonHTMLAttributes, CSSProperties, ReactElement, ReactNode } from 'react';
import type { Box } from '../data/types';
import { Icon, type IconName } from './icons';

// React versions of the Domesday Design System components. The markup and class names
// follow the design system's components.css, so the design system stays the source.

type BtnVariant = 'primary' | 'secondary' | 'quiet' | 'danger';

export function Btn({
  variant = 'secondary',
  capture,
  icon,
  kbd,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; capture?: boolean; icon?: IconName; kbd?: string }): ReactElement {
  const cls = ['dms-btn', `dms-btn--${variant}`, capture ? 'dms-btn--capture' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} {...rest}>
      {icon ? <Icon name={icon} /> : null}
      {children}
      {kbd ? <span className="dms-kbd">{kbd}</span> : null}
    </button>
  );
}

export type ChipStatus = 'confirmed' | 'not-seen' | 'moved' | 'new' | 'worse' | 'better' | 'unsafe' | 'not-filmed' | 'found-elsewhere' | 'unrecorded';

const CHIP: Record<ChipStatus, { icon: IconName; data: string }> = {
  confirmed: { icon: 'found', data: 'confirmed' },
  'not-seen': { icon: 'not-seen', data: 'not-seen' },
  moved: { icon: 'moved', data: 'moved' },
  new: { icon: 'new', data: 'new' },
  worse: { icon: 'worse', data: 'worse' },
  better: { icon: 'better', data: 'better' },
  unsafe: { icon: 'unsafe', data: 'unsafe' },
  'not-filmed': { icon: 'not-filmed', data: 'not-filmed' },
  'found-elsewhere': { icon: 'found-elsewhere', data: 'moved' },
  unrecorded: { icon: 'unrecorded', data: 'new' },
};

/** Status colour always travels with an icon and a word. */
export function Chip({ status, children, quiet }: { status: ChipStatus; children: ReactNode; quiet?: boolean }): ReactElement {
  const c = CHIP[status];
  return (
    <span className={quiet ? 'dms-chip dms-chip--quiet' : 'dms-chip'} data-status={c.data}>
      <Icon name={c.icon} />
      {children}
    </span>
  );
}

const BAND_TEXT: Record<ConfidenceBand, string> = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };

/** Confidence orders the review queue. It is never a verdict. */
export function Conf({ band, suffix }: { band: ConfidenceBand; suffix?: string }): ReactElement {
  return (
    <span className="dms-conf" data-band={band}>
      <span className="dms-conf__dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {BAND_TEXT[band]}
      {suffix ? ` · ${suffix}` : ''}
    </span>
  );
}

const GRADE_ATTR: Record<ConditionGrade, string> = { good: 'good', fair: 'fair', poor: 'poor', not_working_or_unsafe: 'unsafe' };

export function Cond({ grade, reason }: { grade: ConditionGrade; reason?: string | null }): ReactElement {
  return (
    <span className="dms-cond" data-grade={GRADE_ATTR[grade]}>
      <span className="dms-cond__bar" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="dms-cond__label">{Grades.label(grade)}</span>
      {reason ? <span className="dms-cond__reason">{reason}</span> : null}
    </span>
  );
}

/** The line number, struck through with the rubric approval stroke once a named person accepts it. */
export function LineNo({ no, approved, current, style }: { no: string; approved?: boolean; current?: boolean; style?: CSSProperties }): ReactElement {
  return (
    <span className="dms-lineno" data-approved={approved ? '' : undefined} style={current ? { color: 'var(--text)', ...style } : style}>
      {no}
    </span>
  );
}

export interface Region {
  readonly box: Box;
  readonly read?: string;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * How a frame sits in a 4:3 (or other) evidence box with object-fit: cover, centred on the
 * item when there is one, and where each region lands in the box. Keeps the corner ticks
 * on the item even when a portrait phone frame is cropped into a landscape box.
 */
export function coverLayout(imageAspect: number, boxAspect: number, focus: Box | null) {
  const wide = imageAspect >= boxAspect;
  const r = wide ? imageAspect / boxAspect : boxAspect / imageAspect;
  let p = 0.5;
  if (focus && r > 1.0001) {
    const c = wide ? focus[0] + focus[2] / 2 : focus[1] + focus[3] / 2;
    p = clamp((c * r - 0.5) / (r - 1), 0, 1);
  }
  const place = (b: Box): { x: number; y: number; w: number; h: number } | null => {
    let [x, y, w, h] = b;
    if (wide) {
      x = x * r - (r - 1) * p;
      w = w * r;
    } else {
      y = y * r - (r - 1) * p;
      h = h * r;
    }
    const x0 = clamp(x, 0, 1);
    const y0 = clamp(y, 0, 1);
    const x1 = clamp(x + w, 0, 1);
    const y1 = clamp(y + h, 0, 1);
    if (x1 - x0 < 0.02 || y1 - y0 < 0.02) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
  return { objectPosition: wide ? `${(p * 100).toFixed(1)}% 50%` : `50% ${(p * 100).toFixed(1)}%`, place };
}

export function EvidenceFrame({
  src,
  alt,
  imageW,
  imageH,
  regions = [],
  tc,
  tag,
  aspect = 4 / 3,
  onClick,
}: {
  src: string | null;
  alt: string;
  imageW?: number;
  imageH?: number;
  regions?: readonly Region[];
  tc?: string;
  tag?: string;
  aspect?: number;
  onClick?: () => void;
}): ReactElement {
  const layout = coverLayout(imageW && imageH ? imageW / imageH : aspect, aspect, regions[0]?.box ?? null);
  const body = (
    <>
      {src ? <img src={src} alt={alt} loading="lazy" style={{ objectPosition: layout.objectPosition }} /> : <span className="frame-missing">Frame not available</span>}
      {regions.map((r, i) => {
        const p = layout.place(r.box);
        if (!p) return null;
        const low = p.y + p.h > 0.78;
        return (
          <span
            key={i}
            className="dms-region"
            style={{ '--x': `${p.x * 100}%`, '--y': `${p.y * 100}%`, '--w': `${p.w * 100}%`, '--h': `${p.h * 100}%` } as CSSProperties}
          >
            <i />
            <i />
            <i />
            <i />
            {r.read ? (
              <span className="dms-region__read" style={low ? { top: 'auto', bottom: 'calc(100% + 6px)' } : undefined}>
                {r.read}
              </span>
            ) : null}
          </span>
        );
      })}
      {tag ? (
        <span className="dms-frame__tag">
          <Icon name="label-shot" />
          {tag}
        </span>
      ) : null}
      {tc ? <span className="dms-frame__tc">{tc}</span> : null}
    </>
  );
  const style: CSSProperties = { aspectRatio: String(aspect), margin: 0 };
  if (onClick) {
    return (
      <button type="button" className="dms-frame frame-button" style={style} onClick={onClick} aria-label={`Open frame: ${alt}`}>
        {body}
      </button>
    );
  }
  return (
    <figure className="dms-frame" style={style}>
      {body}
    </figure>
  );
}

/** The clip's SHA-256 as a 16-column field of cells: a print you can recognise at a glance. */
export function Fingerprint({ hex, label = 'Visual fingerprint of the clip' }: { hex: string; label?: string }): ReactElement {
  const cells: number[] = [];
  for (let i = 0; i < 64 && i < hex.length; i += 1) cells.push(parseInt(hex[i] ?? '0', 16) / 15);
  return (
    <span className="dms-fp" role="img" aria-label={label}>
      {cells.map((o, i) => (
        <i key={i} style={{ opacity: (0.12 + o * 0.88).toFixed(2) }} />
      ))}
    </span>
  );
}

export function Prov({ rows }: { rows: readonly (readonly [string, ReactNode])[] }): ReactElement {
  return (
    <dl className="dms-prov">
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Avatar({ initials, label, size = 36 }: { initials: string; label: string; size?: number }): ReactElement {
  return (
    <span className="avatar" aria-label={label} title={label} style={{ width: size, height: size }}>
      {initials}
    </span>
  );
}

export function Bar({ value, total, label }: { value: number; total: number; label?: string }): ReactElement {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <span className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={value} aria-label={label}>
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

export function Label({ children, style }: { children: ReactNode; style?: CSSProperties }): ReactElement {
  return (
    <span className="ui-label" style={{ color: 'var(--text-secondary)', ...style }}>
      {children}
    </span>
  );
}

export function Note({ children, tone = 'plain', icon }: { children: ReactNode; tone?: 'plain' | 'warn' | 'ok'; icon?: IconName }): ReactElement {
  return (
    <div className={`note note--${tone}`} role={tone === 'warn' ? 'status' : undefined}>
      {icon ? <Icon name={icon} /> : null}
      <div>{children}</div>
    </div>
  );
}
