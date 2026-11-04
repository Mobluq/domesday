import { Fragment, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { ask, askInstructions, canAsk, suggestions, type AskTurn } from '../ai/ask';
import { applyChange, describeChange, resolveChanges, splitAnswer, type ResolvedChange } from '../ai/changes';
import { canLabel } from '../data/actions';
import { useData, usePersona, useToast } from '../data/store';
import { Icon } from './icons';

/** Line numbers and register IDs stand out in answers, as they do everywhere else. */
function withRefs(text: string): ReactNode[] {
  const parts = text.replace(/\*\*(.+?)\*\*/g, '$1').split(/(\bLines? \d{3}(?:(?:, | and )\d{3})*\b|\b[A-Z]{2,4}-\d{3,5}\b)/g);
  return parts.map((p, i) => (i % 2 === 1 ? <span key={i} className="ask__ref">{p}</span> : <Fragment key={i}>{p}</Fragment>));
}

function Answer({ text }: { text: string }): ReactElement {
  const blocks: ReactElement[] = [];
  let list: string[] = [];
  const flush = (key: number): void => {
    if (!list.length) return;
    blocks.push(
      <ul key={`l${key}`}>
        {list.map((li, i) => (
          <li key={i}>{withRefs(li)}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  text.split('\n').forEach((raw, i) => {
    const line = raw.trimEnd();
    const bullet = /^\s*(?:[-•*]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) list.push(bullet[1] ?? '');
    else {
      flush(i);
      if (line.trim()) blocks.push(<p key={`p${i}`}>{withRefs(line.replace(/^#+\s*/, ''))}</p>);
    }
  });
  flush(-1);
  return <>{blocks}</>;
}

interface Turn extends AskTurn {
  /** What the person typed, when the text sent to Claude carries more (notes about applied changes). */
  readonly shown?: string;
}

interface Proposal {
  readonly changes: readonly ResolvedChange[];
  readonly problems: readonly string[];
}

type CardState = { readonly state: 'idle' | 'busy' | 'done' | 'refused' | 'skipped'; readonly message?: string };

const PERM_KEY = 'domesday.ask.changes.';

function readPerm(personId: string): boolean {
  try {
    return localStorage.getItem(PERM_KEY + personId) === '1';
  } catch {
    return false;
  }
}

/**
 * Ask Domesday: a question box over the whole inventory. It opens from the corner of any
 * screen, answers in a second or two, and keeps the conversation while you move around. With
 * permission, it can also propose changes, which happen only when the person taps Apply.
 */
export function AskDomesday({ hideLauncher }: { hideLauncher?: boolean }): ReactElement | null {
  const data = useData();
  const { person, personId } = usePersona();
  const { say } = useToast();
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [proposals, setProposals] = useState<Record<number, Proposal>>({});
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [draft, setDraft] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allow, setAllow] = useState(() => readPerm(personId));
  const notes = useRef<string[]>([]);
  const ctl = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setAllow(readPerm(personId)), [personId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [turns, answer, error, cards]);

  if (!data.site) return null;
  const available = canAsk(data.rt);
  const busy = answer !== null;
  const roleMayChange = canLabel(data.site, personId);
  const canChange = roleMayChange && allow;

  const setPermission = (on: boolean): void => {
    setAllow(on);
    try {
      localStorage.setItem(PERM_KEY + personId, on ? '1' : '0');
    } catch {
      // It lasts for this page load.
    }
  };

  const send = async (q: string): Promise<void> => {
    const question = q.trim();
    if (!question || busy || !available) return;
    const note = notes.current.length ? `\n\n(Since your last answer I applied: ${notes.current.join('; ')}.)` : '';
    notes.current = [];
    const next: Turn[] = [...turns, { role: 'user', content: question + note, shown: question }];
    setTurns(next);
    setDraft('');
    setError(null);
    setAnswer('');
    const controller = new AbortController();
    ctl.current = controller;
    const system = askInstructions(data, person ? `${person.name} (${person.roleLabel})` : null, canChange);
    const r = await ask(
      data.rt,
      system,
      next.map((t) => ({ role: t.role, content: t.content })),
      setAnswer,
      controller.signal,
    );
    ctl.current = null;
    setAnswer(null);
    const text = r.text.trim();
    if (text) {
      const index = next.length;
      setTurns((ts) => [...ts, { role: 'assistant', content: text }]);
      const { raw, broken } = splitAnswer(text);
      if (raw && canChange) setProposals((p) => ({ ...p, [index]: resolveChanges(raw, data) }));
      else if (broken && canChange) setProposals((p) => ({ ...p, [index]: { changes: [], problems: ["The proposed changes couldn't be read. Ask again."] } }));
    }
    if (!r.ok) setError(r.message);
  };

  const apply = async (key: string, change: ResolvedChange): Promise<void> => {
    setCards((c) => ({ ...c, [key]: { state: 'busy' } }));
    const r = await applyChange(change, data, personId);
    setCards((c) => ({ ...c, [key]: { state: r.ok ? 'done' : 'refused', message: r.message } }));
    if (r.ok) {
      notes.current.push(r.message);
      say(r.message);
    }
  };

  if (!open) {
    if (hideLauncher) return null;
    return (
      <button type="button" className="ask-launch" onClick={() => setOpen(true)} aria-label="Ask about the inventory" title="Ask about the inventory (Ctrl K)">
        <Icon name="message" size={20} />
        <span>Ask</span>
      </button>
    );
  }

  const site = data.site;
  const current = data.current;

  return (
    <section className="ask" role="dialog" aria-label="Ask about the inventory">
      <header className="ask__head">
        <div className="stack-xs" style={{ minWidth: 0 }}>
          <span className="ui-title-s">Ask about the inventory</span>
          <span className="ui-body-s muted">{site.name} · answers from the walks and the register</span>
        </div>
        <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
          {turns.length ? (
            <button
              type="button"
              className="ask__icon-btn"
              onClick={() => {
                ctl.current?.abort();
                setTurns([]);
                setProposals({});
                setCards({});
                setError(null);
                setAnswer(null);
                notes.current = [];
              }}
              aria-label="Start a new conversation"
              title="New conversation"
            >
              <Icon name="refresh" size={18} />
            </button>
          ) : null}
          <button type="button" className="ask__icon-btn" onClick={() => setOpen(false)} aria-label="Close">
            <Icon name="reject" size={18} />
          </button>
        </div>
      </header>

      {available ? (
        <label className="ask__perm" data-on={canChange || undefined}>
          <input type="checkbox" role="switch" checked={canChange} disabled={!roleMayChange} onChange={(e) => setPermission(e.target.checked)} />
          <span className="stack-xs">
            <span className="ui-body-strong">Let the assistant make changes</span>
            <span className="ui-body-s muted">
              {roleMayChange
                ? canChange
                  ? 'It proposes edits, decisions, follow-ups and rooms. Nothing happens until you tap Apply.'
                  : 'Off: it only answers.'
                : `${person?.roleLabel ?? 'Your role'} can't make changes here. A reviewer or administrator can.`}
            </span>
          </span>
        </label>
      ) : null}

      <div className="ask__body" aria-live="polite">
        {!available ? (
          <p className="ui-body muted">Questions need Claude, which isn't connected in this view. On the website, it uses the Anthropic key set in Vercel.</p>
        ) : turns.length === 0 ? (
          <div className="stack-m">
            <p className="ui-body muted">
              Ask anything about what's on this site: counts, rooms, condition, values, what changed and what the books say.
              {canChange ? ' You can also ask it to fix a line, reject a duplicate, open an investigation or add a room.' : ''}
            </p>
            <div className="ask__ideas">
              {[...suggestions(data), ...(canChange ? ['Open an investigation for everything not seen, owned by the site manager, due in a week'] : [])].slice(0, 6).map((s) => (
                <button key={s} type="button" className="ask__idea" onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {turns.map((t, i) => {
          if (t.role === 'user') {
            return (
              <p key={i} className="ask__q">
                {t.shown ?? t.content}
              </p>
            );
          }
          const { display } = splitAnswer(t.content);
          const proposal = proposals[i];
          const pending = proposal ? proposal.changes.filter((_, j) => (cards[`${i}:${j}`]?.state ?? 'idle') === 'idle') : [];
          return (
            <div key={i} className="ask__a">
              <Answer text={display} />
              {proposal && current ? (
                <div className="ask__changes">
                  {proposal.changes.map((c, j) => {
                    const key = `${i}:${j}`;
                    const st = cards[key] ?? { state: 'idle' as const };
                    const d = describeChange(c, site, current);
                    return (
                      <div key={key} className="ask__change" data-state={st.state}>
                        <span className="ui-body-strong">{d.title}</span>
                        {d.detail ? <span className="ui-body-s">{d.detail}</span> : null}
                        {st.state === 'idle' ? (
                          <div className="row" style={{ gap: 8 }}>
                            <button type="button" className="dms-btn dms-btn--primary ask__apply" onClick={() => void apply(key, c)}>
                              Apply
                            </button>
                            <button type="button" className="dms-btn dms-btn--quiet ask__apply" onClick={() => setCards((cs) => ({ ...cs, [key]: { state: 'skipped' } }))}>
                              Skip
                            </button>
                          </div>
                        ) : st.state === 'busy' ? (
                          <span className="ui-body-s muted">Applying…</span>
                        ) : st.state === 'done' ? (
                          <span className="ask__status ask__status--ok">
                            <Icon name="found" size={16} /> {st.message}
                          </span>
                        ) : st.state === 'refused' ? (
                          <span className="ask__status ask__status--no">{st.message}</span>
                        ) : (
                          <span className="ui-body-s muted">Skipped</span>
                        )}
                      </div>
                    );
                  })}
                  {pending.length > 1 ? (
                    <button
                      type="button"
                      className="dms-btn dms-btn--secondary ask__apply"
                      onClick={async () => {
                        for (const [j, c] of proposal.changes.entries()) {
                          const key = `${i}:${j}`;
                          if ((cards[key]?.state ?? 'idle') === 'idle') await apply(key, c);
                        }
                      }}
                    >
                      Apply all {pending.length}
                    </button>
                  ) : null}
                  {proposal.problems.length ? <p className="ask__problem">Not proposed: {proposal.problems.join(' ')}</p> : null}
                </div>
              ) : null}
            </div>
          );
        })}
        {answer !== null ? (
          <div className="ask__a" data-streaming>
            {splitAnswer(answer).display ? <Answer text={splitAnswer(answer).display} /> : <span className="ask__dots" aria-label="Thinking" />}
          </div>
        ) : null}
        {error ? <p className="ask__error">{error}</p> : null}
        <div ref={endRef} />
      </div>

      <form
        className="ask__form"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <textarea
          ref={inputRef}
          id="ask-input"
          className="ask__input"
          rows={1}
          value={draft}
          disabled={!available}
          placeholder={available ? (canChange ? 'Ask, or ask for a change' : 'How many chairs are in the training room?') : 'Not connected'}
          aria-label="Your question"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            }
          }}
        />
        {busy ? (
          <button type="button" className="ask__send" onClick={() => ctl.current?.abort()} aria-label="Stop the answer">
            <Icon name="stop" size={18} />
          </button>
        ) : (
          <button type="submit" className="ask__send" disabled={!draft.trim() || !available} aria-label="Ask">
            <Icon name="next" size={18} />
          </button>
        )}
      </form>
      <p className="ask__foot">Claude can make mistakes. Check the line it names before acting on it.</p>
    </section>
  );
}
