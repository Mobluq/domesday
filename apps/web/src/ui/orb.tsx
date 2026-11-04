import type { CSSProperties, ReactElement } from 'react';

/**
 * The mark for anything Claude does in Domesday: a small lit sphere. It turns slowly at rest
 * and quickens while Claude is thinking. Decorative unless given a label.
 */
export function Orb({ size = 28, thinking = false, label }: { size?: number; thinking?: boolean; label?: string }): ReactElement {
  return (
    <span
      className="orb"
      data-thinking={thinking || undefined}
      style={{ '--orb-size': `${size}px` } as CSSProperties}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <i />
    </span>
  );
}

/** Ask Domesday from anywhere: opens the panel and, given a question, asks it straight away. */
export function openAsk(question?: string): void {
  window.dispatchEvent(new CustomEvent('domesday:ask', { detail: { question: question ?? null } }));
}
