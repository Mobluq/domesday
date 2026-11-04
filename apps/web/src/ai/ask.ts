import { categoryName, categoryPlural, comparison, fmtDate, fmtDateTime, liveLines, lineNo, money, personName, reconciliation, registerEntry, roomName } from '../data/derive';
import type { AppData, WalkBundle } from '../data/store';
import type { Line, Site } from '../data/types';
import { currentAccessCode } from '../runtime/runtime';
import { changeProtocol, NO_CHANGES } from './changes';
import type { Runtime } from '../runtime/runtime';

/**
 * Ask Domesday: questions about the inventory, answered by Claude from a compact copy of what
 * the app already holds (the walk, the register, the comparison, follow-ups and camera checks).
 * On the website the answer streams from api/ask on the quick model, with the inventory as a
 * cached block; inside claude.ai it goes through the sample capability.
 */

export interface AskTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** Room for the inventory in one request: the server's limit, less a margin. */
const MAX_CONTEXT_CHARS = 360_000;
/** The artifact's sample capability takes a smaller prompt. */
const MAX_SAMPLE_CHARS = 60_000;

export function canAsk(rt: Runtime): boolean {
  return rt.mode === 'server' ? rt.ai : Boolean(rt.sample);
}

const dash = (v: string | number | null | undefined): string => (v === null || v === undefined || v === '' ? '-' : String(v));

function lineRow(site: Site, bundle: WalkBundle, l: Line): string {
  const reads = [l.tagCode ? `tag ${l.tagCode.value}` : '', l.serial ? `serial ${l.serial.value}` : '', l.make ? `make ${l.make.value}` : '', l.model ? `model ${l.model.value}` : ''].filter(Boolean).join(', ');
  return [
    `Line ${lineNo(bundle, l.id)}`,
    roomName(site, l.roomId),
    categoryName(site, l.categoryId),
    l.description,
    `qty ${l.quantity}`,
    `${l.condition.replace(/_/g, ' ')}${l.conditionReason ? ` (${l.conditionReason})` : ''}`,
    l.status === 'proposed' ? 'proposed, not checked by a person yet' : l.status,
    `confidence ${l.band}`,
    reads || '-',
    l.registerId ? `register ${l.registerId}` : '-',
    l.safety ? `SAFETY: ${l.safety}` : '',
  ]
    .filter((x) => x !== '')
    .join(' | ');
}

/** The inventory as plain text, most useful sections first, trimmed to fit. */
export function buildInventoryContext(data: AppData, limit = MAX_CONTEXT_CHARS): string {
  const { site, register, current, previous, cameraChecks, reports } = data;
  if (!site) return 'No site is set up yet.';
  const sections: { title: string; body: string[] }[] = [];

  const rooms = site.rooms.map((r) => `${r.name} (${r.floor})`).join('; ');
  sections.push({
    title: 'SITE',
    body: [
      `${site.name}, ${site.city}. Money in naira (₦).${site.thresholdKobo ? ` Capitalisation threshold ${money(site.thresholdKobo)}.` : ''} The person who films a room ${site.separationRule ? "can't" : 'can'} approve its lines.`,
      `Rooms (${site.rooms.length}): ${rooms || 'none yet'}.`,
      `People: ${site.people.map((p) => `${p.name} (${p.roleLabel})`).join('; ')}.`,
      `Cameras: ${(site.cameras ?? []).length ? (site.cameras ?? []).map((c) => `${c.name} on ${roomName(site, c.roomId)}`).join('; ') : 'none linked'}.`,
    ],
  });

  if (current) {
    const w = current.walk;
    const status = w.status === 'approved' ? `approved by ${personName(site, w.approvedBy)} on ${fmtDateTime(w.approvedAt)}` : w.startedAt ? `in progress (${w.status.replace(/_/g, ' ')})` : 'not started';
    const roomLines = site.rooms.map((r) => {
      const v = current.rooms.get(r.id);
      if (!v || v.status === 'not_started') return `${r.name}: not filmed yet`;
      if (v.status === 'skipped') return `${r.name}: skipped (${v.skipReason ?? 'no reason'})`;
      const n = current.lines.filter((l) => l.roomId === r.id && (l.status === 'proposed' || l.status === 'accepted')).length;
      return `${r.name}: filmed by ${personName(site, v.filmedBy)} ${fmtDateTime(v.filmedAt)}, ${n} lines${v.analysis.status !== 'done' ? `, recognition ${v.analysis.status}` : ''}`;
    });
    sections.push({ title: `THIS WALK: ${w.label}, ${status}${w.startedAt ? `, started ${fmtDateTime(w.startedAt)}` : ''}`, body: roomLines });
    const live = liveLines(current);
    sections.push({
      title: 'ASSET LINES ON THIS WALK (line | room | category | description | quantity | condition | decision | confidence | readings | register)',
      body: live.length ? live.map((l) => lineRow(site, current, l)) : ['No lines yet.'],
    });
  }

  if (current && previous && current.walk.status === 'approved') {
    const cmp = comparison(site, current, previous);
    const before = new Map(previous.lines.map((l) => [l.id, l]));
    const after = new Map(current.lines.map((l) => [l.id, l]));
    const rows = cmp.items
      .filter((c) => c.status !== 'unchanged')
      .map((c) => {
        const l = (c.afterLineId ? after.get(c.afterLineId) : undefined) ?? (c.beforeLineId ? before.get(c.beforeLineId) : undefined);
        const name = l ? `${categoryName(site, l.categoryId)} (${l.description})` : 'an asset';
        const reg = registerEntry(register, l?.registerId);
        const value = reg?.bookValueKobo ? `, book value ${money(reg.bookValueKobo)}` : '';
        switch (c.status) {
          case 'not_seen':
            return `Not seen on this walk: ${name} in ${roomName(site, l?.roomId)}${c.quantityDelta ? `, ${Math.abs(c.quantityDelta)} fewer than before` : ''}${value}`;
          case 'moved':
            return `Moved: ${name} from ${roomName(site, c.from?.roomId)} to ${roomName(site, c.to?.roomId)}`;
          case 'new':
            return `New since last walk: ${name} in ${roomName(site, l?.roomId)}${c.quantityDelta ? ` (${c.quantityAfter}, was ${c.quantityBefore})` : ''}`;
          case 'condition_worse':
            return `Worse condition: ${name} in ${roomName(site, l?.roomId)}`;
          case 'condition_better':
            return `Better condition: ${name} in ${roomName(site, l?.roomId)}`;
          case 'room_not_filmed':
            return `Room not filmed this time: ${name} in ${roomName(site, l?.roomId)}`;
          default:
            return `${c.status.replace(/_/g, ' ')}: ${name}`;
        }
      });
    sections.push({ title: `CHANGES SINCE THE WALK OF ${fmtDate(previous.walk.startedAt).toUpperCase()} (${cmp.changeCount} changes, ${cmp.unchangedCount} unchanged)`, body: rows.length ? rows : ['No changes.'] });
  }

  if (current && register) {
    const r = reconciliation(site, register, current);
    const provisional = current.walk.status === 'approved' ? '' : ' (provisional: only lines a person has accepted so far)';
    const lines = new Map(current.lines.map((l) => [l.id, l]));
    const body = [
      `Found: ${r.counts.found ?? 0}; found in another room: ${r.counts.found_elsewhere ?? 0}; not seen: ${r.counts.not_seen ?? 0} (book value ${money(r.notSeenValueKobo)}); not in the books: ${r.counts.unrecorded ?? 0}; in rooms not filmed: ${r.counts.room_not_filmed ?? 0}.`,
      ...r.items
        .filter((i) => i.status !== 'found')
        .map((i) => {
          const reg = registerEntry(register, i.registerId);
          const l = i.lineId ? lines.get(i.lineId) : undefined;
          const what = reg ? `${reg.registerId} ${reg.description}` : l ? `Line ${lineNo(current, l.id)} ${l.description}` : 'an item';
          const label = i.status === 'not_seen' ? 'Not seen' : i.status === 'found_elsewhere' ? 'Found in another room' : i.status === 'unrecorded' ? 'Not in the books' : i.status === 'room_not_filmed' ? 'Room not filmed' : i.status;
          const where = i.status === 'found_elsewhere' && l ? `, in the books at ${reg?.locationLabel ?? '-'}, seen in ${roomName(site, l.roomId)}` : reg ? `, in the books at ${reg.locationLabel}` : l ? `, seen in ${roomName(site, l.roomId)}` : '';
          const value = i.valueKobo ? `, value ${money(i.valueKobo)}` : '';
          return `${label}: ${what}${i.partOfGroup ? ` (${i.notSeenQuantity} of ${i.quantityInBooks})` : ''}${where}${value}`;
        }),
    ];
    sections.push({ title: `RECONCILIATION WITH THE REGISTER${provisional}`, body });
  }

  if (register) {
    const total = register.lines.reduce((s, l) => s + (l.costKobo ?? 0), 0);
    sections.push({
      title: `FIXED ASSET REGISTER: ${register.fileName}, ${register.lines.length} lines, ${money(total)} at cost (id | description | category | location | quantity | cost | net book value | acquired | tag | serial)`,
      body: register.lines.map((l) =>
        [l.registerId, l.description, l.categoryId ? categoryName(site, l.categoryId) : '-', l.locationLabel, l.quantity, money(l.costKobo) || '-', money(l.bookValueKobo) || '-', dash(l.acquired), dash(l.tagCode), dash(l.serial)].join(' | '),
      ),
    });
  }

  if (current?.followups.length) {
    sections.push({
      title: 'FOLLOW-UPS',
      body: current.followups.map((f) => `${f.kind}: ${f.title}, ${f.status}${f.owner ? `, owner ${personName(site, f.owner)}` : ''}${f.due ? `, due ${f.due}` : ''}${f.note ? ` (${f.note})` : ''}`),
    });
  }

  const latest = new Map<string, (typeof cameraChecks)[number]>();
  for (const c of cameraChecks) if (c.status === 'done' && !latest.has(c.cameraId)) latest.set(c.cameraId, c);
  if (latest.size) {
    sections.push({
      title: 'LATEST CAMERA CHECKS (a camera can only say visible or not visible from where it hangs)',
      body: [...latest.values()].map((c) => {
        const cam = (site.cameras ?? []).find((x) => x.id === c.cameraId);
        const vis = c.sightings.filter((s) => s.status === 'visible').map((s) => s.description);
        const not = c.sightings.filter((s) => s.status === 'not_visible').map((s) => s.description);
        return `${cam?.name ?? c.cameraId} on ${roomName(site, c.roomId)}, ${fmtDateTime(c.capturedAt)}: visible: ${vis.join('; ') || 'nothing recorded'}; not visible: ${not.join('; ') || 'none'}`;
      }),
    });
  }

  if (reports.length) {
    sections.push({ title: 'ISSUED REPORTS', body: reports.map((r) => `${r.number}, code ${r.code}, issued ${fmtDateTime(r.issuedAt)} by ${personName(site, r.issuedBy)}`) });
  }

  if (previous) {
    const approved = previous.lines.filter((l) => l.status === 'accepted');
    sections.push({
      title: `LAST WALK, ${fmtDate(previous.walk.startedAt)}: approved lines (line | room | category | description | quantity | condition)`,
      body: approved.map((l) => [`Line ${lineNo(previous, l.id)}`, roomName(site, l.roomId), categoryName(site, l.categoryId), l.description, `qty ${l.quantity}`, l.condition.replace(/_/g, ' ')].join(' | ')),
    });
  }

  // Assemble, dropping whole sections from the end when the inventory is too large.
  const render = (s: { title: string; body: string[] }): string => `${s.title}\n${s.body.join('\n')}`;
  let out = '';
  for (const s of sections) {
    const block = render(s);
    if (out.length + block.length + 2 > limit) {
      const room = limit - out.length - 200;
      if (room > 2000) out += `\n\n${block.slice(0, room)}\n(cut short: the rest of this section is not included)`;
      break;
    }
    out += `${out ? '\n\n' : ''}${block}`;
  }
  return out;
}

export function askInstructions(data: AppData, personLabel: string | null, canChange = false): string {
  const site = data.site?.name ?? 'this site';
  return `You are the inventory assistant inside Domesday, a fixed asset register built from walk-through video. You answer questions${personLabel ? ` from ${personLabel}` : ''} about ${site}, using only the inventory below.

How to answer:
- Lead with the answer in one short sentence. Add a few "-" bullets only when they help, such as a list of items or totals by room.
- Quote counts, values and dates exactly as given. Add them up when asked and give the total.
- Refer to things the way the inventory does: "Line 014", room names, register IDs such as FA-0412, naira as ₦380,000.
- Never say an asset is missing, lost or stolen. Say "not seen on this walk". A room that was skipped is "not filmed", and an investigation decides the rest.
- A line marked "proposed" hasn't been checked by a person yet: say so when it matters.
- If the inventory doesn't answer the question, say so plainly and point to where in Domesday to look: Capture, Review, Comparison, Reconciliation, Report, Cameras or Site setup.
- Don't advise on accounting treatment or write-offs; suggest the finance team.
- British English. Plain sentences and "-" bullets only: no headings, tables or bold.

Today is ${fmtDate(new Date().toISOString())}.

${canChange && data.site ? changeProtocol(data.site) : NO_CHANGES}

INVENTORY
${buildInventoryContext(data)}`;
}

export type AskResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string; readonly text: string };

/** Ask a question; onText receives the whole answer so far as it streams in. */
export async function ask(rt: Runtime, system: string, turns: readonly AskTurn[], onText: (text: string) => void, signal: AbortSignal): Promise<AskResult> {
  if (rt.mode === 'server') {
    let text = '';
    try {
      const code = currentAccessCode();
      const res = await fetch('./api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(code ? { 'x-domesday-code': code } : {}) },
        body: JSON.stringify({ system, messages: turns }),
        signal,
      });
      if (!res.ok || !res.body) {
        const p = (await res.json().catch(() => null)) as { message?: string } | null;
        return { ok: false, message: p?.message ?? `The server answered ${res.status}.`, text: '' };
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        onText(text);
      }
      text += decoder.decode();
      return { ok: true, text };
    } catch (e) {
      if (signal.aborted) return { ok: true, text };
      return { ok: false, message: (e as Error).message || "Couldn't reach the assistant.", text };
    }
  }
  if (!rt.sample) return { ok: false, message: 'Domesday AI is not connected in this view.', text: '' };
  // The artifact's sample takes one prompt: the inventory, the conversation, then the question.
  const history = turns.map((t) => `${t.role === 'user' ? 'QUESTION' : 'YOUR ANSWER'}: ${t.content}`).join('\n\n');
  let prompt = `${system}\n\nCONVERSATION\n${history}\n\nAnswer the last QUESTION.`;
  if (prompt.length > MAX_SAMPLE_CHARS) prompt = `${system.slice(0, MAX_SAMPLE_CHARS - history.length - 400)}\n(inventory cut short)\n\nCONVERSATION\n${history}\n\nAnswer the last QUESTION.`;
  let text = '';
  try {
    const r = await rt.sample(prompt, {
      modelTier: 'quick',
      cache: false,
      signal,
      onText: ({ text: t }) => {
        text = t;
        onText(t);
      },
    });
    return { ok: true, text: r.text || text };
  } catch (e) {
    if (signal.aborted) return { ok: true, text };
    const err = e as { code?: string; message?: string; text?: string };
    return { ok: false, message: err.code === 'rate_limited' ? 'Claude is busy. Try again in a minute.' : err.message || "Couldn't get an answer.", text: err.text ?? text };
  }
}

/** Questions worth one tap, chosen from what this site has. */
export function suggestions(data: AppData): string[] {
  const { site, current, previous, register } = data;
  if (!site) return [];
  const out: string[] = [];
  const approved = current?.walk.status === 'approved';
  if (approved && register) out.push("What wasn't seen on this walk, and what's it worth?");
  else if (current) out.push("Which rooms haven't been filmed yet?");
  const grouped = current?.lines.find((l) => l.kind === 'counted_group' && l.status !== 'rejected');
  out.push(`How many ${grouped ? categoryPlural(site, grouped.categoryId) : 'chairs'} are there, and where?`);
  out.push('Which assets are in poor condition or unsafe?');
  if (register) {
    const room = site.rooms.find((r) => register.lines.some((l) => l.roomId === r.id));
    if (room) out.push(`What's the book value of everything in ${room.name}?`);
    out.push("Which assets we found aren't in the register?");
  }
  if (approved && previous) out.push('What changed since the last walk?');
  return out.slice(0, 5);
}
