import type { Role } from '@domesday/domain';
import { useState, type ReactElement } from 'react';
import { canRecognise, MODEL_LABEL } from '../capture/pipeline';
import { nowIso, money, plural } from '../data/derive';
import { importRegister, REGISTER_TEMPLATE, roomsFromLocations, type RegisterImport } from '../data/register-import';
import { clearEverything, createSite, makePerson, makeRoom, resetDemo, ROLE_OPTIONS, roleOption } from '../data/setup';
import { useData, usePersona, useToast } from '../data/store';
import type { Category, Person, Register, RegisterEntry, RoomDef, Site } from '../data/types';
import { saveFile } from '../runtime/media';
import type { Json } from '../runtime/types';
import { go } from '../route';
import { Btn, Note } from '../ui/bits';
import { Icon } from '../ui/icons';

/** Rooms most offices and branches have; one tap adds each. */
const ROOM_IDEAS = ['Reception', 'Boardroom', 'Open-plan office', 'Store room', 'Server room', 'Kitchen', 'Plant room', 'Training room'];

const CAPTURE_ROLES = ROLE_OPTIONS.filter((r) => r.role !== 'internal_auditor');

export interface ReadyRegister {
  readonly fileName: string;
  readonly entries: RegisterEntry[];
  readonly newRooms: RoomDef[];
}

type LocationChoice = 'new' | 'none' | string;

/** Choose a CSV, see what was read, decide what each unknown location becomes, then use it. */
export function RegisterImporter({
  rooms,
  categories,
  onUse,
  useLabel = 'Use this register',
}: {
  rooms: readonly RoomDef[];
  categories: readonly Category[];
  onUse: (r: ReadyRegister) => void | Promise<void>;
  useLabel?: string;
}): ReactElement {
  const { rt } = useData();
  const { say } = useToast();
  const [file, setFile] = useState<{ name: string; result: RegisterImport } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, LocationChoice>>({});
  const [busy, setBusy] = useState(false);

  const read = async (f: File): Promise<void> => {
    setError(null);
    if (/\.(xlsx|xls|numbers|ods)$/i.test(f.name)) {
      setError('Save the sheet as CSV first. In Excel: File, Save As, then "CSV UTF-8". In Google Sheets: File, Download, CSV.');
      return;
    }
    if (f.size > 5 * 1024 * 1024) {
      setError('That file is over 5 MB. Export just the asset rows as CSV.');
      return;
    }
    const r = importRegister(await f.text(), { rooms, categories });
    if (!r.ok) {
      setFile(null);
      setError(r.message);
      return;
    }
    setFile({ name: f.name, result: r.value });
    setChoices(Object.fromEntries(r.value.newLocations.map((l) => [l.label, 'new'])));
  };

  const use = async (): Promise<void> => {
    if (!file) return;
    const newLabels = file.result.newLocations.filter((l) => choices[l.label] === 'new').map((l) => l.label);
    const newRooms = roomsFromLocations(newLabels, rooms);
    const byLabel = new Map<string, string | null>();
    newLabels.forEach((label, i) => byLabel.set(label, newRooms[i]?.id ?? null));
    for (const l of file.result.newLocations) {
      const c = choices[l.label];
      if (c && c !== 'new' && c !== 'none') byLabel.set(l.label, c);
    }
    const entries = file.result.entries.map((e) => (e.roomId || !byLabel.has(e.locationLabel) ? e : { ...e, roomId: byLabel.get(e.locationLabel) ?? null }));
    setBusy(true);
    try {
      await onUse({ fileName: file.name, entries, newRooms });
      setFile(null);
    } finally {
      setBusy(false);
    }
  };

  const catName = (id: string | null): string => (id ? (categories.find((c) => c.id === id)?.name ?? id) : 'Not recognised');
  const roomLabel = (e: RegisterEntry): string => (e.roomId ? (rooms.find((r) => r.id === e.roomId)?.name ?? e.locationLabel) : e.locationLabel);

  return (
    <div className="stack-m">
      {!file ? (
        <div className="row">
          <label className="dms-btn dms-btn--primary" style={{ position: 'relative' }}>
            <Icon name="upload" />
            Choose the register (CSV)
            <input
              id="register-file"
              type="file"
              accept=".csv,text/csv,text/plain,.xlsx,.xls"
              style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void read(f);
              }}
            />
          </label>
          <Btn
            variant="quiet"
            icon="download"
            onClick={async () => {
              const r = await saveFile(rt, 'domesday-register-template.csv', REGISTER_TEMPLATE, 'text/csv');
              if (r === 'unavailable') say("This view can't save files. The columns are: Asset ID, Description, Category, Location, Quantity, Cost, Net book value, Acquired, Tag code, Serial number.", 'error');
            }}
          >
            Get the template
          </Btn>
        </div>
      ) : null}
      {error ? (
        <Note tone="warn" icon="info">
          {error}
        </Note>
      ) : null}
      {file ? (
        <div className="stack-m">
          <div className="stack-xs">
            <span className="ui-body-strong">
              {file.name}: {plural(file.result.entries.length, 'line', 'lines')}
              {file.result.totalCostKobo ? `, ${money(file.result.totalCostKobo)} at cost` : ''}
            </span>
            <span className="ui-body-s muted">
              Read from{' '}
              {Object.entries(file.result.columns)
                .map(([, h]) => `"${h}"`)
                .join(', ')}
              .
            </span>
          </div>
          {file.result.warnings.length ? (
            <Note tone="warn" icon="info">
              {file.result.warnings.join(' ')}
            </Note>
          ) : null}
          {file.result.newLocations.length ? (
            <div className="stack-s">
              <h3 className="ui-title-s">
                {plural(file.result.newLocations.length, 'location is', 'locations are')} not {rooms.length ? 'a room yet' : 'set up yet'}
              </h3>
              <div className="table-wrap">
                <table className="table" style={{ minWidth: 480 }}>
                  <thead>
                    <tr>
                      <th scope="col">In the register</th>
                      <th scope="col" className="num">
                        Lines
                      </th>
                      <th scope="col">Becomes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {file.result.newLocations.map((l) => (
                      <tr key={l.label}>
                        <td>{l.label}</td>
                        <td className="num">{l.lines}</td>
                        <td>
                          <select
                            className="select"
                            aria-label={`What ${l.label} becomes`}
                            value={choices[l.label] ?? 'new'}
                            onChange={(e) => setChoices((c) => ({ ...c, [l.label]: e.target.value }))}
                            style={{ minHeight: 36, paddingBlock: 4 }}
                          >
                            <option value="new">A new room called "{l.label}"</option>
                            {rooms.map((r) => (
                              <option key={r.id} value={r.id}>
                                Part of {r.name}
                              </option>
                            ))}
                            <option value="none">Leave without a room</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
          <div className="stack-s">
            <h3 className="ui-title-s">First lines, as read</h3>
            <div className="table-wrap">
              <table className="table" style={{ minWidth: 620 }}>
                <thead>
                  <tr>
                    <th scope="col">Asset</th>
                    <th scope="col">Description</th>
                    <th scope="col">Category</th>
                    <th scope="col">Location</th>
                    <th scope="col" className="num">
                      Qty
                    </th>
                    <th scope="col" className="num">
                      Cost
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {file.result.entries.slice(0, 6).map((e) => (
                    <tr key={e.registerId}>
                      <td className="is-data">{e.registerId}</td>
                      <td>{e.description}</td>
                      <td className={e.categoryId ? '' : 'muted'}>{catName(e.categoryId)}</td>
                      <td>{roomLabel(e)}</td>
                      <td className="num">{e.quantity}</td>
                      <td className="num">{money(e.costKobo)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="row">
            <Btn variant="primary" icon="books" disabled={busy} onClick={() => void use()}>
              {busy ? 'Saving…' : useLabel}
            </Btn>
            <Btn variant="quiet" onClick={() => setFile(null)}>
              Choose another file
            </Btn>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RoomAdder({ taken, onAdd }: { taken: readonly RoomDef[]; onAdd: (r: RoomDef) => void }): ReactElement {
  const [name, setName] = useState('');
  const [floor, setFloor] = useState('');
  const add = (n: string, f: string): void => {
    if (!n.trim()) return;
    onAdd(
      makeRoom(
        n,
        f,
        taken.map((r) => r.id),
      ),
    );
  };
  const ideas = ROOM_IDEAS.filter((i) => !taken.some((r) => r.name.toLowerCase() === i.toLowerCase()));
  return (
    <div className="stack-s">
      <form
        className="room-adder"
        onSubmit={(e) => {
          e.preventDefault();
          add(name, floor);
          setName('');
        }}
      >
        <label className="field">
          <span>Room or area</span>
          <input id="room-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Server room" autoComplete="off" />
        </label>
        <label className="field">
          <span>Floor</span>
          <input id="room-floor" className="input" value={floor} onChange={(e) => setFloor(e.target.value)} placeholder="Floor 2" autoComplete="off" />
        </label>
        <Btn type="submit" icon="plus" disabled={!name.trim()}>
          Add
        </Btn>
      </form>
      {ideas.length ? (
        <div className="row" style={{ gap: 6 }}>
          <span className="ui-body-s muted">Quick add:</span>
          {ideas.map((i) => (
            <button key={i} type="button" className="idea" onClick={() => add(i, floor)}>
              <Icon name="plus" size={14} />
              {i}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PersonAdder({ taken, onAdd }: { taken: readonly Person[]; onAdd: (p: Person) => void }): ReactElement {
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('reviewer');
  return (
    <form
      className="room-adder"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onAdd(
          makePerson(
            name,
            role,
            taken.map((p) => p.id),
          ),
        );
        setName('');
      }}
    >
      <label className="field">
        <span>Name</span>
        <input id="person-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" autoComplete="off" />
      </label>
      <label className="field">
        <span>Role</span>
        <select id="person-role" className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {ROLE_OPTIONS.map((r) => (
            <option key={r.role} value={r.role}>
              {r.label}: {r.duty.toLowerCase()}
            </option>
          ))}
        </select>
      </label>
      <Btn type="submit" icon="plus" disabled={!name.trim()}>
        Add
      </Btn>
    </form>
  );
}

const STEPS = ['Your site', 'Rooms', 'Team and rules', 'Register', 'Check and create'] as const;

/** First run for a buyer: their site, rooms, team and register, in five short steps. */
export function SetupWizard({ onCancel, categories }: { onCancel: () => void; categories: readonly Category[] }): ReactElement {
  const { rt } = useData();
  const { setPersonId } = usePersona();
  const { say } = useToast();
  const [step, setStep] = useState(0);
  const [siteName, setSiteName] = useState('');
  const [city, setCity] = useState('Lagos');
  const [you, setYou] = useState('');
  const [yourRole, setYourRole] = useState<Role>('facilities_manager');
  const [rooms, setRooms] = useState<RoomDef[]>([]);
  const [team, setTeam] = useState<Person[]>([]);
  const [separation, setSeparation] = useState(true);
  const [threshold, setThreshold] = useState('100,000');
  const [register, setRegister] = useState<ReadyRegister | null>(null);
  const [busy, setBusy] = useState(false);

  const me = you.trim() ? makePerson(you, yourRole, []) : null;
  const people = me ? [me, ...team.filter((p) => p.id !== me.id)] : team;
  const allRooms = [...rooms, ...(register?.newRooms ?? [])];
  const reviewers = people.filter((p) => p.role === 'reviewer' || p.role === 'financial_controller');
  const canNext = step === 0 ? Boolean(siteName.trim() && you.trim()) : step === 1 ? rooms.length > 0 || true : true;

  const create = async (): Promise<void> => {
    if (!me) return;
    if (!allRooms.length) {
      say('Add at least one room first.', 'error');
      setStep(1);
      return;
    }
    setBusy(true);
    try {
      const kobo = Math.round(Number(threshold.replace(/[^\d.]/g, '')) * 100);
      await createSite(rt, {
        name: siteName,
        city,
        rooms: allRooms,
        people: people.map((p, i) => (i === 0 ? p : { ...p, id: people.slice(0, i).some((q) => q.id === p.id) ? `${p.id}-${i}` : p.id })),
        register: register ? { fileName: register.fileName, entries: register.entries } : null,
        thresholdKobo: Number.isFinite(kobo) && kobo > 0 ? kobo : null,
        separationRule: separation,
        by: me.id,
      });
      setPersonId(me.id);
      say(`${siteName.trim()} is set up. Film the first room when you're ready.`);
      go('walks');
    } catch (e) {
      say(`Couldn't create the site: ${String((e as Error).message ?? e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page page--narrow">
      <div className="stack-l" style={{ paddingBlock: '32px 64px' }}>
        <div className="stack-s">
          <p className="kicker">
            Set up your site · step {step + 1} of {STEPS.length}
          </p>
          <ol className="steps" aria-label="Setup steps">
            {STEPS.map((s, i) => (
              <li key={s} aria-current={i === step ? 'step' : undefined} data-done={i < step || undefined}>
                <button type="button" disabled={i > step} onClick={() => setStep(i)}>
                  <span className="steps__n">{i < step ? <Icon name="found" size={14} /> : i + 1}</span>
                  <span className="steps__t">{s}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>

        {step === 0 ? (
          <section className="stack-m" aria-label="Your site">
            <h1 className="display-m">Which site are you checking?</h1>
            <p className="ui-body muted">One office, branch, hotel or school. You can add more sites later.</p>
            <div className="form-grid">
              <label className="field">
                <span>Site name</span>
                <input id="setup-site" className="input" value={siteName} onChange={(e) => setSiteName(e.target.value)} placeholder="Ikeja branch" autoFocus />
              </label>
              <label className="field">
                <span>City</span>
                <input id="setup-city" className="input" value={city} onChange={(e) => setCity(e.target.value)} />
              </label>
              <label className="field">
                <span>Your name</span>
                <input id="setup-you" className="input" value={you} onChange={(e) => setYou(e.target.value)} placeholder="Ifeoma Nwosu" autoComplete="name" />
              </label>
              <label className="field">
                <span>Your role</span>
                <select id="setup-role" className="select" value={yourRole} onChange={(e) => setYourRole(e.target.value as Role)}>
                  {CAPTURE_ROLES.map((r) => (
                    <option key={r.role} value={r.role}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>
        ) : null}

        {step === 1 ? (
          <section className="stack-m" aria-label="Rooms">
            <h1 className="display-m">Which rooms hold assets?</h1>
            <p className="ui-body muted">Each room is filmed in about a minute on a walk. Add them in the order you'd walk them. If your register lists locations, you can turn those into rooms in the next-but-one step.</p>
            <RoomAdder taken={rooms} onAdd={(r) => setRooms((rs) => [...rs, r])} />
            {rooms.length ? (
              <ul className="chips-list" aria-label="Rooms added">
                {rooms.map((r) => (
                  <li key={r.id}>
                    <span>
                      {r.name} <span className="muted">· {r.floor}</span>
                    </span>
                    <button type="button" aria-label={`Remove ${r.name}`} onClick={() => setRooms((rs) => rs.filter((x) => x.id !== r.id))}>
                      <Icon name="reject" size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ui-body-s muted">No rooms yet.</p>
            )}
          </section>
        ) : null}

        {step === 2 ? (
          <section className="stack-m" aria-label="Team and rules">
            <h1 className="display-m">Who films, who checks?</h1>
            <p className="ui-body muted">Each person uses their own phone or laptop and picks their name. A walk needs someone to film and someone else to check what was found.</p>
            <ul className="people-list" aria-label="Team">
              {people.map((p, i) => (
                <li key={`${p.id}-${i}`}>
                  <span className="avatar" aria-hidden="true">
                    {p.initials}
                  </span>
                  <span className="stack-xs" style={{ flex: 1 }}>
                    <span className="ui-body-strong">
                      {p.name}
                      {i === 0 ? ' (you)' : ''}
                    </span>
                    <span className="ui-body-s muted">
                      {p.roleLabel} · {p.duty.toLowerCase()}
                    </span>
                  </span>
                  {i > 0 ? (
                    <button type="button" className="icon-btn" aria-label={`Remove ${p.name}`} onClick={() => setTeam((t) => t.filter((x) => x !== p))}>
                      <Icon name="reject" size={16} />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            <PersonAdder taken={people} onAdd={(p) => setTeam((t) => [...t, p])} />
            <div className="panel panel--tight stack-m">
              <label className="check">
                <input type="checkbox" checked={separation} onChange={(e) => setSeparation(e.target.checked)} />
                <span className="stack-xs">
                  <span className="ui-body-strong">Whoever films a room can't approve its lines</span>
                  <span className="ui-body-s muted">Recommended. It is the control auditors look for.</span>
                </span>
              </label>
              {separation && reviewers.length === 0 ? (
                <Note tone="warn" icon="people">
                  Add a reviewer or a financial controller, or nobody will be able to approve what you film.
                </Note>
              ) : null}
              <label className="field" style={{ maxWidth: 280 }}>
                <span>Capitalisation threshold (₦)</span>
                <input id="setup-threshold" className="input is-data" inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
              </label>
              <span className="ui-body-s muted">Assets found above this value that aren't in the books are flagged for the register.</span>
            </div>
          </section>
        ) : null}

        {step === 3 ? (
          <section className="stack-m" aria-label="Register">
            <h1 className="display-m">Add your fixed asset register</h1>
            <p className="ui-body muted">
              Optional, and you can do it later. With the register, each walk is reconciled against the books: what was found, what wasn't seen, and what isn't recorded. Export it from
              Excel, Sage or your ERP as CSV.
            </p>
            {register ? (
              <Note tone="ok" icon="found">
                {register.fileName}: {plural(register.entries.length, 'line', 'lines')} ready
                {register.newRooms.length ? `, and ${plural(register.newRooms.length, 'new room', 'new rooms')} from its locations` : ''}.{' '}
                <button type="button" className="linklike" onClick={() => setRegister(null)}>
                  Use a different file
                </button>
              </Note>
            ) : (
              <RegisterImporter rooms={rooms} categories={categories} onUse={(r) => setRegister(r)} />
            )}
          </section>
        ) : null}

        {step === 4 ? (
          <section className="stack-m" aria-label="Check and create">
            <h1 className="display-m">Ready to create {siteName.trim() || 'your site'}</h1>
            <dl className="summary-list">
              <div>
                <dt>Site</dt>
                <dd>
                  {siteName.trim()}, {city.trim()}
                </dd>
              </div>
              <div>
                <dt>Rooms</dt>
                <dd>{allRooms.length ? allRooms.map((r) => r.name).join(', ') : <span className="muted">None yet. Go back and add one.</span>}</dd>
              </div>
              <div>
                <dt>Team</dt>
                <dd>{people.map((p) => `${p.name} (${p.roleLabel.toLowerCase()})`).join(', ')}</dd>
              </div>
              <div>
                <dt>Rules</dt>
                <dd>
                  {separation ? 'Filmer and approver must differ' : 'Anyone can approve'}; threshold ₦{threshold}
                </dd>
              </div>
              <div>
                <dt>Register</dt>
                <dd>{register ? `${register.fileName}, ${plural(register.entries.length, 'line', 'lines')}` : 'Not yet. Add it from Site setup any time.'}</dd>
              </div>
            </dl>
            <Note icon="shield">
              Everyone who opens this copy of Domesday sees this site. Footage is fingerprinted when it's filmed, faces and screens are blurred before frames are kept, and nothing is
              shared outside the people you add.
            </Note>
          </section>
        ) : null}

        <div className="row">
          {step > 0 ? (
            <Btn variant="quiet" icon="back" onClick={() => setStep((s) => s - 1)}>
              Back
            </Btn>
          ) : (
            <Btn variant="quiet" icon="back" onClick={onCancel}>
              Cancel
            </Btn>
          )}
          {step < STEPS.length - 1 ? (
            <Btn variant="primary" icon="next" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>
              {step === 3 && !register ? 'Skip for now' : 'Next'}
            </Btn>
          ) : (
            <Btn variant="primary" icon="found" disabled={busy || !allRooms.length} onClick={() => void create()}>
              {busy ? 'Creating…' : 'Create the site'}
            </Btn>
          )}
        </div>
      </div>
    </main>
  );
}

function referenced(data: ReturnType<typeof useData>, personId: string): boolean {
  const cur = data.current;
  if (!cur) return false;
  if (cur.walk.capturedBy.includes(personId) || cur.walk.approvedBy === personId) return true;
  for (const v of cur.rooms.values()) if (v.filmedBy === personId) return true;
  return cur.lines.some((l) => l.decision?.by === personId);
}

/** Site setup: rooms, people, rules, the register and cameras, for whoever runs the site. */
export function SitePage(): ReactElement {
  const data = useData();
  const { site, rt, register, current } = data;
  const { personId } = usePersona();
  const { say } = useToast();
  const [name, setName] = useState(site?.name ?? '');
  const [city, setCity] = useState(site?.city ?? '');
  const [threshold, setThreshold] = useState(site?.thresholdKobo ? String(Math.round(site.thresholdKobo / 100)) : '');
  const [editing, setEditing] = useState<string | null>(null);
  const [roomDraft, setRoomDraft] = useState({ name: '', floor: '' });
  const [confirm, setConfirm] = useState<'reset' | 'clear' | null>(null);
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(false);
  if (!site) return <main className="page" />;

  const update = async (patch: Partial<Site>, message: string): Promise<void> => {
    await rt.db.doc('site/main').update(patch as unknown as Json);
    say(message);
  };
  const walkOpen = current && current.walk.status !== 'approved';
  const addRooms = async (rs: readonly RoomDef[]): Promise<void> => {
    await rt.db.doc('site/main').update({ rooms: [...site.rooms, ...rs] } as unknown as Json);
    if (current && walkOpen) {
      const at = nowIso();
      for (const r of rs)
        await rt.db
          .doc(`walks/${current.walk.id}/rooms/${r.id}`)
          .set({ roomId: r.id, status: 'not_started', skipReason: null, filmedBy: null, filmedAt: null, clip: null, frames: [], labelShots: [], analysis: { status: 'idle' }, updatedAt: at });
    }
  };
  const roomInUse = (roomId: string): boolean => {
    const v = current?.rooms.get(roomId);
    return Boolean(v && v.status !== 'not_started') || Boolean(current?.lines.some((l) => l.roomId === roomId)) || Boolean(register?.lines.some((l) => l.roomId === roomId));
  };
  const totalCost = register?.lines.reduce((s, l) => s + (l.costKobo ?? 0), 0) ?? 0;

  return (
    <main className="page">
      <div className="page-head">
        <div className="page-head__text">
          <p className="kicker">{site.name} · Site setup</p>
          <h1 className="display-m">Site setup</h1>
          <p className="ui-body muted">Rooms, people, rules and the books this site is checked against. Changes apply for everyone straight away.</p>
        </div>
      </div>

      <div className="settings">
        <section className="panel stack-m" aria-labelledby="s-site">
          <h2 id="s-site" className="ui-title-m">
            Site
          </h2>
          <div className="form-grid">
            <label className="field">
              <span>Name</span>
              <input id="site-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>City</span>
              <input id="site-city" className="input" value={city} onChange={(e) => setCity(e.target.value)} />
            </label>
          </div>
          <div>
            <Btn disabled={!name.trim() || (name === site.name && city === site.city)} onClick={() => void update({ name: name.trim(), city: city.trim() }, 'Site details saved')}>
              Save
            </Btn>
          </div>
        </section>

        <section className="panel stack-m" aria-labelledby="s-rooms">
          <div className="row row--between">
            <h2 id="s-rooms" className="ui-title-m">
              Rooms
            </h2>
            <span className="ui-body-s muted">{plural(site.rooms.length, 'room', 'rooms')}</span>
          </div>
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 520 }}>
              <thead>
                <tr>
                  <th scope="col">Room</th>
                  <th scope="col">Floor</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {site.rooms.map((r) =>
                  editing === r.id ? (
                    <tr key={r.id}>
                      <td>
                        <input className="input" aria-label="Room name" value={roomDraft.name} onChange={(e) => setRoomDraft((d) => ({ ...d, name: e.target.value }))} />
                      </td>
                      <td>
                        <input className="input" aria-label="Floor" value={roomDraft.floor} onChange={(e) => setRoomDraft((d) => ({ ...d, floor: e.target.value }))} />
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <Btn
                          variant="primary"
                          disabled={!roomDraft.name.trim()}
                          onClick={async () => {
                            await update({ rooms: site.rooms.map((x) => (x.id === r.id ? { ...x, name: roomDraft.name.trim(), floor: roomDraft.floor.trim() || 'Floor not set' } : x)) }, 'Room saved');
                            setEditing(null);
                          }}
                        >
                          Save
                        </Btn>
                        <Btn variant="quiet" onClick={() => setEditing(null)}>
                          Cancel
                        </Btn>
                      </td>
                    </tr>
                  ) : (
                    <tr key={r.id}>
                      <td className="ui-body-strong">{r.name}</td>
                      <td>{r.floor}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <Btn
                          variant="quiet"
                          icon="edit"
                          style={{ minHeight: 36 }}
                          onClick={() => {
                            setEditing(r.id);
                            setRoomDraft({ name: r.name, floor: r.floor });
                          }}
                        >
                          Rename
                        </Btn>
                        <Btn
                          variant="quiet"
                          icon="reject"
                          style={{ minHeight: 36 }}
                          disabled={roomInUse(r.id) || site.rooms.length === 1}
                          title={roomInUse(r.id) ? 'Filmed on this walk or in the register, so it stays' : undefined}
                          onClick={async () => {
                            await update({ rooms: site.rooms.filter((x) => x.id !== r.id), cameras: (site.cameras ?? []).filter((c) => c.roomId !== r.id) }, `${r.name} removed`);
                            if (current) await rt.db.doc(`walks/${current.walk.id}/rooms/${r.id}`).delete();
                          }}
                        >
                          Remove
                        </Btn>
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
          <RoomAdder
            taken={site.rooms}
            onAdd={(r) => {
              void addRooms([r]).then(() => say(`${r.name} added${walkOpen ? ' to this walk' : ''}`));
            }}
          />
        </section>

        <section className="panel stack-m" aria-labelledby="s-people">
          <h2 id="s-people" className="ui-title-m">
            People
          </h2>
          <ul className="people-list">
            {site.people.map((p) => (
              <li key={p.id}>
                <span className="avatar" aria-hidden="true">
                  {p.initials}
                </span>
                <span className="stack-xs" style={{ flex: 1 }}>
                  <span className="ui-body-strong">
                    {p.name}
                    {p.id === personId ? ' (this device)' : ''}
                  </span>
                  <span className="ui-body-s muted">{p.duty}</span>
                </span>
                <select
                  className="select"
                  aria-label={`Role of ${p.name}`}
                  value={p.role}
                  style={{ width: 'auto', minHeight: 36, paddingBlock: 4 }}
                  onChange={(e) => {
                    const opt = roleOption(e.target.value as Role);
                    void update({ people: site.people.map((x) => (x.id === p.id ? { ...x, role: opt.role, roleLabel: opt.label, duty: opt.duty } : x)) }, `${p.name} is now ${opt.label.toLowerCase()}`);
                  }}
                >
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r.role} value={r.role}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove ${p.name}`}
                  disabled={p.id === personId || referenced(data, p.id)}
                  title={p.id === personId ? "You can't remove yourself" : referenced(data, p.id) ? 'Has records on this walk' : undefined}
                  onClick={() => void update({ people: site.people.filter((x) => x.id !== p.id) }, `${p.name} removed`)}
                >
                  <Icon name="reject" size={16} />
                </button>
              </li>
            ))}
          </ul>
          <PersonAdder taken={site.people} onAdd={(p) => void update({ people: [...site.people, p] }, `${p.name} added. They pick their name on their own device.`)} />
        </section>

        <section className="panel stack-m" aria-labelledby="s-rules">
          <h2 id="s-rules" className="ui-title-m">
            Rules
          </h2>
          <label className="check">
            <input type="checkbox" checked={site.separationRule} onChange={(e) => void update({ separationRule: e.target.checked }, e.target.checked ? 'Filmer and approver must now differ' : 'Anyone can now approve')} />
            <span className="stack-xs">
              <span className="ui-body-strong">Whoever films a room can't approve its lines</span>
              <span className="ui-body-s muted">Recommended. It is the control auditors look for.</span>
            </span>
          </label>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label className="field" style={{ maxWidth: 260 }}>
              <span>Capitalisation threshold (₦)</span>
              <input id="site-threshold" className="input is-data" inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="100000" />
            </label>
            <Btn
              onClick={() => {
                const n = Math.round(Number(threshold.replace(/[^\d.]/g, '')) * 100);
                void update({ thresholdKobo: Number.isFinite(n) && n > 0 ? n : null }, 'Threshold saved');
              }}
            >
              Save
            </Btn>
          </div>
        </section>

        <section className="panel stack-m" aria-labelledby="s-register">
          <h2 id="s-register" className="ui-title-m">
            Fixed asset register
          </h2>
          {register ? (
            <p className="ui-body">
              {register.fileName}: {plural(register.lines.length, 'line', 'lines')}
              {totalCost ? `, ${money(totalCost)} at cost` : ''}. Imported {register.importedAt.slice(0, 10)}.
            </p>
          ) : (
            <p className="ui-body muted">No register yet. Without one, walks are compared with each other but not with the books.</p>
          )}
          {register && !replacing ? (
            <div>
              <Btn icon="upload" onClick={() => setReplacing(true)}>
                Replace with a newer export
              </Btn>
            </div>
          ) : (
            <RegisterImporter
              rooms={site.rooms}
              categories={site.categories}
              useLabel={register ? 'Replace the register' : 'Use this register'}
              onUse={async (r) => {
                if (r.newRooms.length) await addRooms(r.newRooms);
                const reg: Register = { importedAt: nowIso(), importedBy: personId, fileName: r.fileName, lines: r.entries };
                await rt.db.doc('register/main').set(reg as unknown as Json);
                await rt.db.doc('site/main').update({ registerImportedAt: nowIso().slice(0, 10) } as unknown as Json);
                say(`Register saved: ${plural(r.entries.length, 'line', 'lines')}${r.newRooms.length ? `, ${plural(r.newRooms.length, 'room', 'rooms')} added` : ''}`);
                setReplacing(false);
              }}
            />
          )}
        </section>

        <section className="panel stack-m" aria-labelledby="s-connections">
          <h2 id="s-connections" className="ui-title-m">
            Recognition and cameras
          </h2>
          <div className="stack-s">
            <span className="ui-body">
              <strong>Recognition:</strong>{' '}
              {canRecognise(rt) ? `connected (${MODEL_LABEL}). Each filmed room is read by Claude and every line waits for a person.` : 'not connected in this view. Rooms are still filmed, fingerprinted and kept, and recognition runs once it is connected.'}
            </span>
            <span className="ui-body">
              <strong>Cameras:</strong> {plural((site.cameras ?? []).length, 'camera', 'cameras')} linked.{' '}
              <a href="#cameras">Manage cameras</a>
            </span>
          </div>
        </section>

        <section className="panel stack-m" aria-labelledby="s-copy">
          <h2 id="s-copy" className="ui-title-m">
            This copy of Domesday
          </h2>
          {confirm ? (
            <div className="stack-s">
              <Note tone="warn" icon="info">
                {confirm === 'reset'
                  ? 'This puts the demo back to the start: everything filmed and decided, issued reports, labels and camera checks are removed for everyone.'
                  : `This removes ${site.name}, its walks, register, reports and frames for everyone, and takes you back to setup. It can't be undone.`}
              </Note>
              <div className="row">
                <Btn
                  variant="danger"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      if (confirm === 'reset') {
                        await resetDemo(rt, site);
                        say('Demo reset to the start');
                        go('walks');
                      } else {
                        await clearEverything(rt, site);
                        say('Cleared. Set up your site, or load the demo again.');
                      }
                      setConfirm(null);
                    } catch (e) {
                      say(`That didn't work: ${String((e as Error).message ?? e)}`, 'error');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? 'Working…' : confirm === 'reset' ? 'Reset the demo' : 'Clear everything'}
                </Btn>
                <Btn variant="quiet" onClick={() => setConfirm(null)}>
                  Keep it
                </Btn>
              </div>
            </div>
          ) : (
            <div className="row">
              {site.demo ? (
                <Btn icon="refresh" onClick={() => setConfirm('reset')}>
                  Start the demo again
                </Btn>
              ) : null}
              <Btn variant="quiet" icon="reject" onClick={() => setConfirm('clear')}>
                {site.demo ? 'Clear the demo and set up my own site' : 'Clear everything'}
              </Btn>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
