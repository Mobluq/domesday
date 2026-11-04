import type { Role } from '@domesday/domain';
import { useEffect, useState, type ReactElement } from 'react';
import { Icon, type IconName } from './icons';

/** A short first-run walkthrough, written for the role of whoever is using this device. */

interface Slide {
  readonly icon: IconName;
  readonly title: string;
  readonly body: string;
}

const CAPTURE: readonly Slide[] = [
  { icon: 'walk', title: 'You film, Claude lists, a person checks', body: 'Walk each room with your phone. Domesday picks the clearest frames, Claude lists the assets it can see, and a reviewer checks every line before anything counts.' },
  { icon: 'camera', title: 'About a minute a room', body: 'Two slow sweeps: one at shoulder height, one lower down. Photograph nameplates and serial plates up close, so serials are read from the plate rather than guessed.' },
  { icon: 'phone', title: 'Guided capture for the walk', body: 'Big buttons, one room at a time. Lock the phone to it with Guided Access on iPhone or screen pinning on Android, and hand it to whoever does the walk.' },
  { icon: 'not-filmed', title: "Rooms you can't get into", body: "Skip them with a reason. Nothing in a skipped room is ever called missing; the report says the room wasn't filmed." },
];

const REVIEW: readonly Slide[] = [
  { icon: 'found', title: 'Every line waits for a person', body: 'Claude proposes what it saw, with the frame it saw it in. You accept, edit or reject each line. Lines Claude is sure about can be accepted together.' },
  { icon: 'edit', title: 'Fix what the AI got wrong', body: 'Relabel an item, redraw its box, or label something it missed. Your corrections are used at this site to read the next walks better. They never train a model.' },
  { icon: 'verified', title: 'Then approve the walk', body: 'When every line has a decision, approve it. If you filmed a room yourself, someone else approves its lines: the control auditors look for.' },
];

const FINANCE: readonly Slide[] = [
  { icon: 'moved', title: 'What changed since last time', body: "After a walk is approved you see what's new, moved, in worse condition or not seen since the previous walk." },
  { icon: 'books', title: 'Checked against your books', body: 'Import the fixed asset register once. Each walk is reconciled against it: found, found elsewhere, not seen, and assets that are not in the books.' },
  { icon: 'report', title: 'A report anyone can verify', body: "Issue the walk report and print it or save it as PDF. Its verification code lets anyone check it hasn't been changed since it was issued." },
];

const ADMIN: readonly Slide[] = [
  { icon: 'walk', title: 'A walk is how a site gets checked', body: 'Someone films each room on their phone, Claude lists what it sees, and a reviewer decides every line. Approved walks are compared and reconciled with the books.' },
  { icon: 'people', title: 'Set up rooms and people once', body: 'Site setup holds the rooms, the team and their roles, the separation rule and the fixed asset register. Each person picks their name on their own device.' },
  { icon: 'camera', title: 'Cameras between walks', body: "Link the CCTV cameras you already have. A camera check takes one still and says which recorded items it can see. Stills of spaces only, never people." },
];

export function slidesFor(role: Role | undefined): readonly Slide[] {
  if (role === 'site_manager') return CAPTURE;
  if (role === 'reviewer') return REVIEW;
  if (role === 'financial_controller' || role === 'internal_auditor') return FINANCE;
  if (role === 'facilities_manager') return [CAPTURE[0] as Slide, CAPTURE[2] as Slide, REVIEW[1] as Slide];
  return ADMIN;
}

const KEY = 'domesday.tour.v1.';

export function tourSeen(personId: string): boolean {
  try {
    return localStorage.getItem(KEY + personId) === '1';
  } catch {
    return true;
  }
}

export function markTourSeen(personId: string): void {
  try {
    localStorage.setItem(KEY + personId, '1');
  } catch {
    // The tour may show again next time; harmless.
  }
}

export function Tour({ role, name, onClose }: { role: Role | undefined; name: string | null; onClose: () => void }): ReactElement {
  const slides = slidesFor(role);
  const [i, setI] = useState(0);
  const slide = slides[i] as Slide;
  const last = i === slides.length - 1;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setI((n) => Math.min(slides.length - 1, n + 1));
      if (e.key === 'ArrowLeft') setI((n) => Math.max(0, n - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, slides.length]);
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      <div className="dialog tour">
        <div className="row row--between">
          <span className="ui-label">{name ? `WELCOME, ${name.split(' ')[0]?.toUpperCase()}` : 'WELCOME'}</span>
          <button type="button" className="linklike" onClick={onClose}>
            Skip
          </button>
        </div>
        <span className="tour__icon" aria-hidden="true">
          <Icon name={slide.icon} size={30} />
        </span>
        <h2 id="tour-title" className="ui-title-l" style={{ margin: 0 }}>
          {slide.title}
        </h2>
        <p className="ui-body" style={{ margin: 0 }}>
          {slide.body}
        </p>
        <div className="row row--between">
          <span className="tour__dots" aria-label={`${i + 1} of ${slides.length}`}>
            {slides.map((s, n) => (
              <i key={s.title} data-on={n === i || undefined} />
            ))}
          </span>
          <div className="row">
            {i > 0 ? (
              <button type="button" className="dms-btn dms-btn--quiet" onClick={() => setI(i - 1)}>
                Back
              </button>
            ) : null}
            <button type="button" className="dms-btn dms-btn--primary" onClick={() => (last ? onClose() : setI(i + 1))} autoFocus>
              {last ? 'Got it' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
