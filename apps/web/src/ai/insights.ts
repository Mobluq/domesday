import { approvedLines, categoryName, comparison, liveLines, money, plural, reconciliation, roomName, walkProgress } from '../data/derive';
import type { AppData } from '../data/store';
import type { ViewId } from '../route';

/**
 * What Domesday has noticed, worked out on the device from the walk and the books (no model
 * call, so it costs nothing and shows instantly). Each insight can hand a question to Ask
 * Domesday or open the screen where it's dealt with.
 */

export type InsightTone = 'critical' | 'warning' | 'info' | 'good';

export interface Insight {
  readonly id: string;
  readonly tone: InsightTone;
  readonly title: string;
  readonly body: string;
  readonly go?: { readonly view: ViewId; readonly label: string };
  readonly ask?: string;
}

const RANK: Record<InsightTone, number> = { critical: 0, warning: 1, info: 2, good: 3 };

export function insightsFor(data: AppData): Insight[] {
  const { site, current, previous, register } = data;
  if (!site || !current) return [];
  const out: Insight[] = [];
  const live = liveLines(current);
  const progress = walkProgress(site, current);
  const approved = current.walk.status === 'approved';

  const unsafe = live.filter((l) => l.condition === 'not_working_or_unsafe' || l.safety);
  if (unsafe.length) {
    const first = unsafe[0];
    out.push({
      id: 'safety',
      tone: 'critical',
      title: `${plural(unsafe.length, 'safety issue', 'safety issues')} on this walk`,
      body: first ? `${categoryName(site, first.categoryId)} in ${roomName(site, first.roomId)}: ${first.safety ?? first.conditionReason}${unsafe.length > 1 ? `, and ${unsafe.length - 1} more` : ''}.` : '',
      ask: 'Which assets are unsafe or not working, and where are they?',
      go: { view: 'review', label: 'Review them' },
    });
  }

  if (register) {
    const recon = reconciliation(site, register, current);
    const notSeen = recon.items.filter((i) => i.status === 'not_seen');
    if (notSeen.length && (approved || approvedLines(current).length > 0)) {
      out.push({
        id: 'not-seen',
        tone: 'warning',
        title: `${money(recon.notSeenValueKobo)} in the books not seen${approved ? '' : ' so far'}`,
        body: `${plural(notSeen.length, 'register line', 'register lines')} in rooms that were filmed. Not seen isn't missing: an investigation decides.`,
        ask: "What wasn't seen on this walk, and what's it worth?",
        go: { view: 'reconcile', label: 'Reconcile' },
      });
    }
    const unrecorded = recon.items.filter((i) => i.status === 'unrecorded');
    if (unrecorded.length) {
      out.push({
        id: 'unrecorded',
        tone: 'info',
        title: `${plural(unrecorded.length, 'asset', 'assets')} found that aren't in the books`,
        body: 'Worth adding to the fixed asset register, especially anything above the capitalisation threshold.',
        ask: "Which assets did we find that aren't in the register?",
        go: { view: 'reconcile', label: 'See them' },
      });
    }
  } else {
    out.push({ id: 'register', tone: 'info', title: 'No register yet', body: 'Import the fixed asset register to reconcile each walk with the books.', go: { view: 'site', label: 'Import it' } });
  }

  if (approved && previous) {
    const cmp = comparison(site, current, previous);
    const worse = cmp.items.filter((c) => c.status === 'condition_worse').length;
    const moved = cmp.items.filter((c) => c.status === 'moved').length;
    if (worse || moved) {
      out.push({
        id: 'changes',
        tone: 'info',
        title: `${[worse ? plural(worse, 'asset in worse condition', 'assets in worse condition') : '', moved ? plural(moved, 'asset moved', 'assets moved') : ''].filter(Boolean).join(', ')}`,
        body: 'Since the last walk. Moves can update the register; worse condition can go on the maintenance list.',
        ask: 'What changed since the last walk?',
        go: { view: 'compare', label: 'Compare' },
      });
    }
  }

  const lowWaiting = live.filter((l) => l.status === 'proposed' && l.band === 'low').length;
  const waiting = live.filter((l) => l.status === 'proposed').length;
  if (waiting && !approved) {
    out.push({
      id: 'review',
      tone: lowWaiting ? 'warning' : 'info',
      title: `${plural(waiting, 'line waits', 'lines wait')} for a person`,
      body: lowWaiting ? `${plural(lowWaiting, 'line', 'lines')} Claude was unsure about. Those need a look one by one.` : 'Claude is confident about these; they can be accepted together from Review.',
      go: { view: 'review', label: 'Review' },
    });
  }

  if (progress.notStarted && !approved) {
    out.push({
      id: 'rooms',
      tone: 'info',
      title: `${plural(progress.notStarted, 'room', 'rooms')} still to film`,
      body: `About a minute each. ${site.rooms
        .filter((r) => (current.rooms.get(r.id)?.status ?? 'not_started') === 'not_started')
        .slice(0, 3)
        .map((r) => r.name)
        .join(', ')}${progress.notStarted > 3 ? ' and more' : ''}.`,
      go: { view: 'capture', label: 'Film' },
    });
  }

  if (!out.length) {
    const prevCount = previous ? approvedLines(previous).length : 0;
    out.push({ id: 'calm', tone: 'good', title: 'Nothing needs you right now', body: prevCount ? `The last approved walk had ${plural(prevCount, 'line', 'lines')}. Start the next walk when it's due.` : 'Film the first room to get started.' });
  }

  return out.sort((a, b) => RANK[a.tone] - RANK[b.tone]).slice(0, 4);
}
