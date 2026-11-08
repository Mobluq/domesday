import { Fragment, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { ask, askInstructions, canAsk, suggestions, type AskTurn } from '../ai/ask';
import { applyChange, describeChange, resolveChanges, splitAnswer, type ResolvedChange } from '../ai/changes';
import { canLabel } from '../data/actions';
import { useData, usePersona, useToast } from '../data/store';
import { Icon } from './icons';
import { Orb } from './orb';

/** Ask from anywhere: opens the panel and, given a question, asks it straight away. */
export function openAsk(question?: string): void {
  window.dispatchEvent(new CustomEvent('domesday:ask', { detail: { question: question ?? null } }));
}

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
 * Ask Domesday AI: questions about the whole inventory, answered as a transcript (Q. and A.,
 * the way the survey recorded its answers). It opens from the top bar on any screen and keeps
 * the conversation while you move around. With permission it can propose changes, which happen
 * only when the person taps Apply.
 */
export function AskDomesday(): ReactElement | null {
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
  const [queued, setQueued] = useState<string | null>(null);
  const sendRef = useRef<(q: string) => void>(() => undefined);
  const ctl = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setAllow(readPerm(personId)), [personId]);
  // Other screens hand questions over ("Ask about this").
  useEffect(() => {
    const onAsk = (e: Event): void => {
      const q = (e as CustomEvent<{ question: string | null }>).detail?.question ?? null;
      setOpen(true);
      if (q) setQueued(q);
    };
    window.addEventListener('domesday:ask', onAsk);
    return () => window.removeEventListener('domesday:ask', onAsk);
  }, []);
  useEffect(() => {
    if (queued && open) {
      sendRef.current(queued);
      setQueued(null);
    }
  }, [queued, open]);
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

  sendRef.current = (q: string) => void send(q);

  const apply = async (key: string, change: ResolvedChange): Promise<void> => {
    setCards((c) => ({ ...c, [key]: { state: 'busy' } }));
    const r = await applyChange(change, data, personId);
    setCards((c) => ({ ...c, [key]: { state: r.ok ? 'done' : 'refused', message: r.message } }));
    if (r.ok) {
      notes.current.push(r.message);
      say(r.message);
    }
  };

  if (!open) return null;

  const site = data.site;
  const current = data.current;

  return (
    <section className="ask" role="dialog" aria-label="Ask about the inventory">
      <header className="ask__head">
        <div className="stack-xs" style={{ minWidth: 0, flex: 1 }}>
          <h2 className="ask__title">
            <Orb size={22} thinking={busy} />
            Ask Domesday AI
          </h2>
          <p className="ask__sub">{busy ? 'Reading the walk and the register…' : `${site.name}. Answers come from the walks and the register.`}</p>
        </div>
        <div className="ask__tools">
          {turns.length ? (
            <button
              type="button"
              className="linklike"
              onClick={() => {
                ctl.current?.abort();
                setTurns([]);
                setProposals({});
                setCards({});
                setError(null);
                setAnswer(null);
                notes.current = [];
              }}
              title="Start a new conversation"
            >
              New
            </button>
          ) : null}
          <button type="button" className="linklike" onClick={() => setOpen(false)} aria-label="Close">
            Close
          </button>
        </div>
      </header>

      {available ? (
        <label className="ask__perm" data-on={canChange || undefined}>
          <input type="checkbox" role="switch" checked={canChange} disabled={!roleMayChange} onChange={(e) => setPermission(e.target.checked)} />
          <span className="stack-xs">
            <span className="ui-body-strong">Let it make changes</span>
            <span className="ui-body-s muted">
              {roleMayChange
                ? canChange
                  ? 'It can propose edits, decisions, follow-ups and rooms. Nothing changes until you tap Apply.'
                  : 'Off: it only answers.'
                : `${person?.roleLabel ?? 'Your role'} can't make changes here. A reviewer or administrator can.`}
            </span>
          </span>
        </label>
      ) : null}

      <div className="ask__body" aria-live="polite">
        {!available ? (
          <p className="ui-body muted">Domesday AI isn't connected in this view. On the website, it uses the Anthropic key set in Vercel.</p>
        ) : turns.length === 0 ? (
          <div className="stack-m">
            <div className="ask__empty">
              <Orb size={34} thinking={busy} />
              <p className="ui-body muted">
                Ask about anything on this site: counts, rooms, condition, values, what changed and what the books say.
                {canChange ? ' You can also ask it to fix a line, reject a duplicate, open an investigation or add a room.' : ''}
              </p>
            </div>
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
              <div key={i} className="ask__q">
                <span className="ask__tag" aria-hidden="true">
                  Q.
                </span>
                <p>{t.shown ?? t.content}</p>
              </div>
            );
          }
          const { display } = splitAnswer(t.content);
          const proposal = proposals[i];
          const pending = proposal ? proposal.changes.filter((_, j) => (cards[`${i}:${j}`]?.state ?? 'idle') === 'idle') : [];
          return (
            <div key={i} className="ask__a">
              <span className="ask__tag" aria-hidden="true">
                A.
                <Orb size={14} />
              </span>
              <div className="ask__text">
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
                            <div className="row" style={{ gap: 16 }}>
                              <button type="button" className="dms-btn dms-btn--primary ask__apply" onClick={() => void apply(key, c)}>
                                Apply
                              </button>
                              <button type="button" className="linklike" onClick={() => setCards((cs) => ({ ...cs, [key]: { state: 'skipped' } }))}>
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
            </div>
          );
        })}
        {answer !== null ? (
          <div className="ask__a" data-streaming>
            <span className="ask__tag" aria-hidden="true">
              A.
              <Orb size={14} thinking />
            </span>
            <div className="ask__text">{splitAnswer(answer).display ? <Answer text={splitAnswer(answer).display} /> : <p className="ask__wait">Reading the records…</p>}</div>
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
        <label className="sr-only" htmlFor="ask-input">
          Your question
        </label>
        <textarea
          ref={inputRef}
          id="ask-input"
          className="ask__input"
          rows={1}
          value={draft}
          disabled={!available}
          placeholder={available ? (canChange ? 'Ask, or ask for a change' : 'How many chairs are in the training room?') : 'Not connected'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            }
          }}
        />
        {busy ? (
          <button type="button" className="dms-btn dms-btn--secondary ask__send" onClick={() => ctl.current?.abort()}>
            Stop
          </button>
        ) : (
          <button type="submit" className="dms-btn dms-btn--primary ask__send" disabled={!draft.trim() || !available}>
            Ask
          </button>
        )}
      </form>
      <p className="ask__foot">Domesday AI can make mistakes. Check the line it names before acting on it.</p>
    </section>
  );
}
