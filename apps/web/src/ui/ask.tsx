import { Fragment, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { ask, askInstructions, canAsk, suggestions, type AskTurn } from '../ai/ask';
import { useData, usePersona } from '../data/store';
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

/**
 * Ask Domesday: a question box over the whole inventory. It opens from the corner of any
 * screen, answers in a second or two, and keeps the conversation while you move around.
 */
export function AskDomesday({ hideLauncher }: { hideLauncher?: boolean }): ReactElement | null {
  const data = useData();
  const { person } = usePersona();
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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
  }, [turns, answer, error]);

  if (!data.site) return null;
  const available = canAsk(data.rt);
  const busy = answer !== null;

  const send = async (q: string): Promise<void> => {
    const question = q.trim();
    if (!question || busy || !available) return;
    const next: AskTurn[] = [...turns, { role: 'user', content: question }];
    setTurns(next);
    setDraft('');
    setError(null);
    setAnswer('');
    const controller = new AbortController();
    ctl.current = controller;
    const system = askInstructions(data, person ? `${person.name} (${person.roleLabel})` : null);
    const r = await ask(data.rt, system, next, setAnswer, controller.signal);
    ctl.current = null;
    setAnswer(null);
    if (r.text.trim()) setTurns((ts) => [...ts, { role: 'assistant', content: r.text.trim() }]);
    if (!r.ok) setError(r.message);
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

  return (
    <section className="ask" role="dialog" aria-label="Ask about the inventory">
      <header className="ask__head">
        <div className="stack-xs" style={{ minWidth: 0 }}>
          <span className="ui-title-s">Ask about the inventory</span>
          <span className="ui-body-s muted">{data.site.name} · answers from the walks and the register</span>
        </div>
        <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
          {turns.length ? (
            <button
              type="button"
              className="ask__icon-btn"
              onClick={() => {
                ctl.current?.abort();
                setTurns([]);
                setError(null);
                setAnswer(null);
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

      <div className="ask__body" aria-live="polite">
        {!available ? (
          <p className="ui-body muted">Questions need Claude, which isn't connected in this view. On the website, it uses the Anthropic key set in Vercel.</p>
        ) : turns.length === 0 ? (
          <div className="stack-m">
            <p className="ui-body muted">Ask anything about what's on this site: counts, rooms, condition, values, what changed and what the books say.</p>
            <div className="ask__ideas">
              {suggestions(data).map((s) => (
                <button key={s} type="button" className="ask__idea" onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {turns.map((t, i) =>
          t.role === 'user' ? (
            <p key={i} className="ask__q">
              {t.content}
            </p>
          ) : (
            <div key={i} className="ask__a">
              <Answer text={t.content} />
            </div>
          ),
        )}
        {answer !== null ? (
          <div className="ask__a" data-streaming>
            {answer ? <Answer text={answer} /> : <span className="ask__dots" aria-label="Thinking" />}
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
          placeholder={available ? 'How many chairs are in the training room?' : 'Not connected'}
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
