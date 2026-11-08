import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Hallmark, Wordmark } from './brand';
import type { Maquette } from './maquette';

/** Real lines from the demo site's approved walk of 3 October, Room 204. */
const SAMPLE = [
  { n: '001', item: 'Bed, king size', short: 'Bed', ref: 'FA-1075', qty: 1 },
  { n: '002', item: 'Armchair, upholstered', short: 'Armchair', ref: 'FA-1078', qty: 1 },
  { n: '003', item: 'Television, Sony 43-inch', short: 'Television', ref: 'FA-1043', qty: 1 },
  { n: '004', item: 'Framed print', short: 'Framed print', ref: 'FA-1081', qty: 1 },
  { n: '005', item: 'Bedside lamps', short: 'Bedside lamps', ref: 'FA-1102', qty: 2 },
] as const;

/** The scale model of Room 204, loaded only on this screen; it stays empty without WebGL. */
function RoomModel({ active, onActive }: { active: number | null; onActive: (i: number | null) => void }): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<(HTMLButtonElement | null)[]>([]);
  const model = useRef<Maquette | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (__ARTIFACT__) {
      setFailed(true);
      return undefined;
    }
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    void import('./maquette')
      .then(({ mountMaquette }) => {
        if (cancelled || !host.current) return;
        const m = mountMaquette(
          host.current,
          labels.current.filter((x): x is HTMLButtonElement => Boolean(x)),
          reduced,
        );
        if (!m) setFailed(true);
        model.current = m;
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
      model.current?.dispose();
      model.current = null;
    };
  }, []);
  useEffect(() => model.current?.highlight(active), [active]);
  if (failed) return <></>;
  return (
    <div className="model" ref={host} role="img" aria-label="A scale model of Room 204 with its five register lines numbered">
      {SAMPLE.map((l, i) => (
        <button
          key={l.n}
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          className="model__tag"
          ref={(el) => {
            labels.current[i] = el;
          }}
          onPointerEnter={() => onActive(i)}
          onPointerLeave={() => onActive(null)}
        >
          <span className="model__n">{l.n}</span>
          <span className="model__name">{l.short}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The screen before the app (access code, first run): Room 204 as a scale model with its
 * register entry, beside the one thing to do. Hovering a line lights up the piece, and the
 * other way round.
 */
export function Gate({ children }: { children: ReactNode }): ReactElement {
  const [active, setActive] = useState<number | null>(null);
  return (
    <main className="gate">
      <section className="gate__folio" aria-label="About Domesday">
        <span className="gate__brand">
          <Hallmark size={28} />
          <Wordmark height={20} />
        </span>
        <div className="gate__pitch">
          <p className="gate__title">Know what's in every room.</p>
          <p className="gate__lead">Film each room on a phone. Claude lists what it sees, a person checks every line, and each walk is reconciled with your fixed asset register.</p>
        </div>
        <RoomModel active={active} onActive={setActive} />
        <figure className="gate__entry">
          <figcaption>
            <span>Room 204, walk of 3 October 2026</span>
            <span className="muted">From the demo site</span>
          </figcaption>
          <ol>
            {SAMPLE.map((l, i) => (
              <li key={l.n} data-on={active === i || undefined} onPointerEnter={() => setActive(i)} onPointerLeave={() => setActive(null)}>
                <span className="dms-lineno" data-approved="">
                  {l.n}
                </span>
                <span className="gate__item">{l.item}</span>
                <span className="gate__ref">{l.ref}</span>
                <span className="gate__qty">{l.qty}</span>
                <span className="gate__cond">Good</span>
              </li>
            ))}
          </ol>
          <p className="gate__sign">Filmed by Tolu Adeyemi. Every line approved by Chinedu Okafor.</p>
        </figure>
      </section>
      <section className="gate__panel">
        <span className="gate__brand gate__brand--panel">
          <Hallmark size={26} />
          <Wordmark height={18} />
        </span>
        {children}
      </section>
    </main>
  );
}
