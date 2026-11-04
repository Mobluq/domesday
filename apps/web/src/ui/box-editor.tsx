import { useRef, useState, type CSSProperties, type PointerEvent, type ReactElement } from 'react';
import type { Box } from '../data/types';

/**
 * Draw a box on a frame: press, drag, release. The whole image is shown (no cropping), so
 * the box is exactly where the person drew it, as fractions of the image.
 */
export function BoxEditor({ src, w, h, value, onChange, label }: { src: string; w: number; h: number; value: Box | null; onChange: (b: Box) => void; label: string }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Box | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  const at = (e: PointerEvent<HTMLDivElement>): { x: number; y: number } => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const toBox = (a: { x: number; y: number }, b: { x: number; y: number }): Box => {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const round = (n: number): number => Math.round(n * 1000) / 1000;
    return [round(x), round(y), round(Math.abs(a.x - b.x)), round(Math.abs(a.y - b.y))];
  };

  const shown = draft ?? value;
  return (
    <div className="box-editor">
      <div
        ref={ref}
        className="box-editor__canvas"
        style={{ aspectRatio: `${w} / ${h}` }}
        role="application"
        aria-label={label}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          start.current = at(e);
          setDraft([start.current.x, start.current.y, 0, 0]);
        }}
        onPointerMove={(e) => {
          if (start.current) setDraft(toBox(start.current, at(e)));
        }}
        onPointerUp={(e) => {
          if (!start.current) return;
          const b = toBox(start.current, at(e));
          start.current = null;
          setDraft(null);
          if (b[2] > 0.02 && b[3] > 0.02) onChange(b);
        }}
        onPointerCancel={() => {
          start.current = null;
          setDraft(null);
        }}
      >
        <img src={src} alt="" draggable={false} />
        {shown ? (
          <span className="dms-region" style={{ '--x': `${shown[0] * 100}%`, '--y': `${shown[1] * 100}%`, '--w': `${shown[2] * 100}%`, '--h': `${shown[3] * 100}%` } as CSSProperties}>
            <i />
            <i />
            <i />
            <i />
          </span>
        ) : null}
      </div>
      <span className="ui-body-s muted">{shown ? 'Drag again to redraw the box.' : 'Press and drag around the item.'}</span>
    </div>
  );
}
