import type { CSSProperties, ReactElement } from 'react';

// The Domesday line icon set (24px grid, stroked) from the design system, plus a few
// interface glyphs. Paths only; colour comes from currentColor.
const PATHS = {
  'not-seen': <circle cx="12" cy="12" r="7" strokeDasharray="3.2 2.6" />,
  moved: <path d="M4 12h14M13.5 7.5 18 12l-4.5 4.5" />,
  new: <path d="M12 5v14M5 12h14" />,
  worse: <path d="M6 9.5l6 6 6-6" />,
  better: <path d="M6 14.5l6-6 6 6" />,
  unsafe: (
    <>
      <path d="M12 4.5 20.5 19.5h-17z" />
      <path d="M12 10v4.2M12 16.9v.2" />
    </>
  ),
  'not-filmed': (
    <>
      <rect x="4.5" y="4.5" width="15" height="15" rx="1" />
      <path d="M4.5 11 11 4.5M4.5 17.5 17.5 4.5M10 19.5l9.5-9.5M16.5 19.5l3-3" />
    </>
  ),
  found: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  'found-elsewhere': (
    <>
      <path d="M11 5H5v14h14v-6" />
      <path d="M14 5h5v5M19 5l-8 8" />
    </>
  ),
  unrecorded: (
    <>
      <rect x="4.5" y="4.5" width="15" height="15" rx="1" />
      <path d="M12 8.5v7M8.5 12h7" />
    </>
  ),
  'label-shot': (
    <>
      <path d="M4.5 8.5v-4h4M15.5 4.5h4v4M19.5 15.5v4h-4M8.5 19.5h-4v-4" />
      <path d="M8 10.5h8M8 13.5h5" />
    </>
  ),
  fingerprint: (
    <>
      <path d="M5.5 10a6.5 6.5 0 0 1 13 0" />
      <path d="M8 19.5c-.9-2.2-1.4-4.6-1.4-7a5.4 5.4 0 0 1 10.8 0c0 1.3-.1 2.6-.3 3.8" />
      <path d="M12 19.5c-.8-2.1-1.1-4.3-1.1-6.9a1.1 1.1 0 0 1 2.2 0c0 2.6.4 4.8 1.3 6.9" />
    </>
  ),
  walk: (
    <>
      <circle cx="6" cy="18" r="1.8" />
      <circle cx="18" cy="6" r="1.8" />
      <path d="M7.8 18H13a3 3 0 0 0 0-6h-2a3 3 0 0 1 0-6h5.2" />
    </>
  ),
  room: (
    <>
      <path d="M10 19.5H4.5v-15h15v15H14" />
      <path d="M10 19.5a4 4 0 0 1 4-4" />
    </>
  ),
  investigate: (
    <>
      <circle cx="10.5" cy="10.5" r="5.5" />
      <path d="M14.6 14.6 19.5 19.5" />
    </>
  ),
  reject: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  merge: (
    <>
      <path d="M6 4.5v3a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4v-3" />
      <path d="M12 11.5v8M9 16.5l3 3 3-3" />
    </>
  ),
  split: <path d="M12 19.5v-8M12 11.5 6.5 6M12 11.5 17.5 6M6.5 10V6h4M17.5 10V6h-4" />,
  record: <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />,
  microphone: (
    <>
      <rect x="9" y="3.5" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  verified: (
    <>
      <path d="M8 3.5h8L20.5 8v8L16 20.5H8L3.5 16V8z" />
      <path d="M8.5 12.2l2.4 2.4 4.6-5" />
    </>
  ),
  clip: (
    <>
      <rect x="3.5" y="6.5" width="12" height="11" rx="1.5" />
      <path d="M15.5 10.5l5-3v9l-5-3" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15.5v-10M7.5 10 12 5.5l4.5 4.5" />
      <path d="M5 19.5h14" />
    </>
  ),
  download: (
    <>
      <path d="M12 5.5v10M7.5 11 12 15.5l4.5-4.5" />
      <path d="M5 19.5h14" />
    </>
  ),
  message: <path d="M5 19l1.2-3.5A7.5 7.5 0 1 1 9 18z" />,
  keyboard: (
    <>
      <rect x="3.5" y="6.5" width="17" height="11" rx="1.5" />
      <path d="M7 10h.01M10 10h.01M13 10h.01M16.5 10h.01M8 14h8" />
    </>
  ),
  back: <path d="M14.5 6l-6 6 6 6" />,
  next: <path d="M9.5 6l6 6-6 6" />,
  down: <path d="M7 10l5 5 5-5" />,
  edit: (
    <>
      <path d="M5 19h4L19 9l-4-4L5 15z" />
      <path d="M13 7l4 4" />
    </>
  ),
  camera: (
    <>
      <path d="M4.5 8.5h3l1.5-2.5h6l1.5 2.5h3v10h-15z" />
      <circle cx="12" cy="13" r="3.2" />
    </>
  ),
  image: (
    <>
      <rect x="4.5" y="5.5" width="15" height="13" rx="1.5" />
      <path d="M4.5 15.5l4-4 4 4 2.5-2.5 4.5 4.5" />
      <circle cx="15.5" cy="9.5" r="1.3" />
    </>
  ),
  phone: (
    <>
      <rect x="7" y="3.5" width="10" height="17" rx="2" />
      <path d="M11 17.5h2" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="1.5" />
      <path d="M15.5 8.5v-3h-11v11h4" />
    </>
  ),
  play: <path d="M8 5.5v13l10.5-6.5z" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="1" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M7 12h10" />,
  refresh: (
    <>
      <path d="M19 12a7 7 0 1 1-2.05-4.95" />
      <path d="M19 5v4h-4" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="9" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M15 6.5a3 3 0 0 1 0 5.6M17.5 19a5.5 5.5 0 0 0-2.4-4.5" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.5l7 3v5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9v-5z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  report: (
    <>
      <path d="M7 3.5h7l4 4v13H7z" />
      <path d="M14 3.5v4h4M9.5 12h6M9.5 15h6M9.5 18h4" />
    </>
  ),
  books: (
    <>
      <path d="M5 5.5h5v13H5zM10 5.5h4v13h-4z" />
      <path d="M14.5 6.2l3.8-1 3.2 12.5-3.8 1z" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size, label, style }: { name: IconName; size?: number; label?: string; style?: CSSProperties }): ReactElement {
  return (
    <svg
      className="dms-icon"
      viewBox="0 0 24 24"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={size ? { width: size, height: size, ...style } : style}
    >
      {PATHS[name]}
    </svg>
  );
}
