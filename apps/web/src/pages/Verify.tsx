import { UI_COPY, formatVerificationCode, normaliseVerificationCode } from '@domesday/domain';
import { useState, type ReactElement } from 'react';
import { fmtDate, fmtDateTime, personName } from '../data/derive';
import { useData } from '../data/store';
import type { ReportRecord } from '../data/types';
import { Btn, Label, Note } from '../ui/bits';
import { Icon } from '../ui/icons';
import { codeForText, reportText } from './Report';

type Outcome =
  | { kind: 'match'; record: ReportRecord; via: 'code' | 'file' }
  | { kind: 'unknown'; code: string }
  | { kind: 'mismatch'; printed: string | null; computed: string; record: ReportRecord | null }
  | { kind: 'invalid'; message: string };

/** DMS-086: confirm a report is genuine and unchanged, without seeing what it contains. */
export function VerifyPage(): ReactElement {
  const { rt, site } = useData();
  const [input, setInput] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);

  const lookup = async (code: string): Promise<ReportRecord | null> => {
    const snap = await rt.db.doc(`reports/${code}`).get();
    return snap.exists ? (snap.data() as unknown as ReportRecord) : null;
  };

  const checkCode = async (): Promise<void> => {
    const code = normaliseVerificationCode(input);
    if (!code) {
      setOutcome({ kind: 'invalid', message: 'A code is 12 letters and digits, like 7F3A K29Q 0C4E.' });
      return;
    }
    setBusy(true);
    try {
      const record = await lookup(code);
      setOutcome(record ? { kind: 'match', record, via: 'code' } : { kind: 'unknown', code });
    } finally {
      setBusy(false);
    }
  };

  const checkFile = async (file: File): Promise<void> => {
    setBusy(true);
    try {
      const doc = new DOMParser().parseFromString(await file.text(), 'text/html');
      const root = doc.getElementById('dms-report');
      if (!root) {
        setOutcome({ kind: 'invalid', message: 'This file is not a Domesday report.' });
        return;
      }
      const printed = normaliseVerificationCode(root.getAttribute('data-code') ?? '');
      const { code } = await codeForText(reportText(root));
      const record = await lookup(code);
      if (record && (!printed || printed === code)) setOutcome({ kind: 'match', record, via: 'file' });
      else setOutcome({ kind: 'mismatch', printed, computed: code, record: printed ? await lookup(printed) : null });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page page--narrow">
      <div className="stack-l" style={{ paddingBlock: '40px 64px' }}>
        <div className="stack-s">
          <Label>VERIFY A REPORT</Label>
          <h1 className="display-m">Is this report genuine and unchanged?</h1>
          <p className="ui-body muted">
            Enter the code printed on the cover, or check a downloaded report file. The check never shows what the report says, only whether it is the one that was issued.
          </p>
        </div>

        <form
          className="panel stack-m"
          onSubmit={(e) => {
            e.preventDefault();
            void checkCode();
          }}
        >
          <label className="field">
            <span>Verification code</span>
            <input
              id="verify-code"
              className="input"
              style={{ fontFamily: 'var(--font-mono)', fontSize: 20, letterSpacing: '0.06em', textTransform: 'uppercase' }}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="7F3A K29Q 0C4E"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="row">
            <Btn variant="primary" type="submit" icon="verified" disabled={busy || !input.trim()}>
              Check the code
            </Btn>
            <label className="dms-btn dms-btn--secondary" style={{ position: 'relative' }}>
              <Icon name="report" />
              Check a report file
              <input
                id="verify-file"
                type="file"
                accept=".html,text/html"
                style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void checkFile(f);
                }}
              />
            </label>
          </div>
        </form>

        {outcome?.kind === 'match' ? (
          <section className="panel stack-s" style={{ borderColor: 'var(--confirmed-mark)' }} aria-live="polite">
            <span className="dms-chip" data-status="confirmed">
              <Icon name="verified" />
              {UI_COPY.verificationMatches}
            </span>
            <span className="ui-title-m">{outcome.record.title}</span>
            <span className="ui-body-s muted">
              Report {outcome.record.number} · code <span className="data-s">{formatVerificationCode(outcome.record.code)}</span> · issued {fmtDateTime(outcome.record.issuedAt)} by{' '}
              {personName(site, outcome.record.issuedBy)} · {outcome.record.pages} pages.
              {outcome.via === 'file' ? ' Every word of the file matches the issued report.' : ''}
            </span>
          </section>
        ) : null}
        {outcome?.kind === 'unknown' ? (
          <Note tone="warn" icon="info">
            No report with code {formatVerificationCode(outcome.code)} was issued here. Check the code for typing mistakes, or ask whoever sent the report.
          </Note>
        ) : null}
        {outcome?.kind === 'mismatch' ? (
          <section className="panel stack-s" style={{ borderColor: 'var(--unsafe-mark)' }} aria-live="polite">
            <span className="dms-chip" data-status="unsafe">
              <Icon name="unsafe" />
              {UI_COPY.verificationDoesNotMatch}
            </span>
            <span className="ui-body">
              {outcome.printed ? `The file says ${formatVerificationCode(outcome.printed)}, but its text gives ${formatVerificationCode(outcome.computed)}.` : `Its text gives ${formatVerificationCode(outcome.computed)}, which matches no issued report.`} Something in
              the report was changed after it was issued.
            </span>
            {outcome.record ? (
              <span className="ui-body-s muted">
                The issued report {outcome.record.number}, {outcome.record.title.toLowerCase().includes('walk') ? outcome.record.title : ''}, was issued {fmtDate(outcome.record.issuedAt)}. Ask for a fresh copy.
              </span>
            ) : null}
          </section>
        ) : null}
        {outcome?.kind === 'invalid' ? <Note tone="warn" icon="info">{outcome.message}</Note> : null}
      </div>
    </main>
  );
}
