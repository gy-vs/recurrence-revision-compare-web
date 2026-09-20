import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {FlaskConical, GitCompareArrows, Save} from 'lucide-react';

type Summary = {id: string; name: string; revision: number};
type RevisionMeta = {revision: number; updatedAt: string; author: string; note: string};
type RevisionRow = RevisionMeta & {content: string};

type DstResolution = 'exact' | 'gap-earlier' | 'gap-later' | 'overlap-earlier' | 'overlap-later';
type OccurrencePayload = {
  key: string;
  localDate: string;
  localTime: string;
  instant: string;
  utcOffsetMinutes: number;
  dstResolution: DstResolution;
  source: {kind: 'segment' | 'exception'; id: string};
};
type DiffType = 'added' | 'removed' | 'modified' | 'same';
type DiffItem = {key: string; type: DiffType; old: OccurrencePayload | null; next: OccurrencePayload | null};
type ExceptionStatus = 'unchanged' | 'retargeted' | 'orphaned' | 'added' | 'removed' | 'unresolved-both';
type ExceptionRow = {
  id: string;
  kind: 'cancel' | 'cancelRange' | 'replace';
  presence: 'both' | 'old-only' | 'new-only';
  old: {resolved: boolean; targetDate?: string; targetKey?: string; reason?: string} | null;
  next: {resolved: boolean; targetDate?: string; targetKey?: string; reason?: string} | null;
  status: ExceptionStatus;
};
type Stats = {
  same: number; added: number; removed: number; modified: number; total: number;
  exceptions: number; orphanedExceptions: number;
};

type CompareState = {
  sessionId: string;
  oldRevision: number;
  newRevision: number;
  items: DiffItem[];
  exceptions: ExceptionRow[];
  stats: Stats | null;
  partial: boolean;
  error: string | null;
};

const FILTERS: {key: DiffType; label: string; className: string}[] = [
  {key: 'added', label: 'Added', className: 'f-add'},
  {key: 'removed', label: 'Removed', className: 'f-rm'},
  {key: 'modified', label: 'Time changed', className: 'f-mod'},
  {key: 'same', label: 'Unchanged', className: 'f-same'},
];

export default function App() {
  const [items, setItems] = useState<Summary[]>([]);
  const [selected, setSelected] = useState('alpha');
  const [revisions, setRevisions] = useState<RevisionMeta[]>([]);
  const [row, setRow] = useState<RevisionRow | null>(null);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('Ready');

  const [oldRev, setOldRev] = useState(1);
  const [newRev, setNewRev] = useState(2);
  const [from, setFrom] = useState('2026-01-01');
  const [to, setTo] = useState('2026-03-31');
  const [compare, setCompare] = useState<CompareState | null>(null);
  const [filters, setFilters] = useState<Set<DiffType>>(new Set(['added', 'removed', 'modified']));
  const [showExceptions, setShowExceptions] = useState(true);

  const textRef = useRef<HTMLTextAreaElement>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    fetch('/api/schedules').then(r => r.json()).then((list: Summary[]) => setItems(list));
  }, []);

  useEffect(() => {
    let alive = true;
    setStatus('Loading');
    fetch(`/api/schedules/${selected}/revisions`).then(r => r.json()).then((list: RevisionMeta[]) => {
      if (!alive) return;
      setRevisions(list);
      const head = list[list.length - 1];
      setNewRev(head.revision);
      setOldRev(Math.max(1, head.revision - 1));
    });
    fetch(`/api/schedules/${selected}`).then(r => r.json()).then((value: RevisionRow) => {
      if (!alive) return;
      setRow(value);
      setDraft(value.content);
      setStatus(`Loaded revision ${value.revision}`);
    });
    return () => {
      alive = false;
    };
  }, [selected]);

  async function loadRevision(rev: number) {
    setStatus(`Loading revision ${rev}`);
    const value: RevisionRow = await fetch(`/api/schedules/${selected}/revisions/${rev}`).then(r => r.json());
    setRow(value);
    setDraft(value.content);
    setStatus(`Viewing revision ${rev}`);
  }

  async function save() {
    if (!row) return;
    let doc: unknown;
    try {
      doc = JSON.parse(draft);
    } catch {
      setStatus('Invalid JSON');
      return;
    }
    setStatus('Saving');
    const response = await fetch(`/api/schedules/${selected}`, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({doc, revision: row.revision, note: `Revision ${row.revision + 1}`}),
    });
    const value = await response.json();
    if (!response.ok) {
      setStatus(response.status === 409 ? 'Revision conflict' : `Save failed: ${value.message ?? ''}`);
      return;
    }
    setRow(value);
    setDraft(value.content);
    setRevisions(list => [...list, {revision: value.revision, updatedAt: value.updatedAt, author: value.author, note: value.note}]);
    setNewRev(value.revision);
    setStatus(`Saved as revision ${value.revision}`);
  }

  async function analyze() {
    if (!row) return;
    setStatus('Analyzing');
    const response = await fetch(`/api/schedules/${selected}/analyze`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({doc: safeParse(draft)}),
    });
    const value = await response.json();
    setStatus(response.ok ? `Segments ${value.segmentCount}, exceptions ${value.exceptionCount}` : `Invalid: ${value.message ?? ''}`);
  }

  // Jump from an occurrence back to the rule field or exception that produced it.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const pendingJumpRef = useRef<null | (() => void)>(null);
  useEffect(() => {
    pendingJumpRef.current?.();
  }, [draft]);

  const jumpWithLoad = useCallback(async (side: 'old' | 'new', occ: OccurrencePayload) => {
    const targetRev = side === 'old' ? oldRev : newRev;
    const doSelect = (text: string) => selectProvenance(text, occ, textRef.current);
    if (row?.revision === targetRev) {
      doSelect(draftRef.current);
      return;
    }
    setStatus(`Jumping to revision ${targetRev}`);
    const value: RevisionRow = await fetch(`/api/schedules/${selected}/revisions/${targetRev}`).then(r => r.json());
    setRow(value);
    setDraft(value.content);
    pendingJumpRef.current = () => {
      doSelect(value.content);
      pendingJumpRef.current = null;
    };
  }, [oldRev, newRev, row, selected]);

  async function startCompare() {
    esRef.current?.close();
    setCompare({
      sessionId: '',
      oldRevision: oldRev,
      newRevision: newRev,
      items: [],
      exceptions: [],
      stats: null,
      partial: true,
      error: null,
    });
    setStatus('Creating compare session');
    const response = await fetch(`/api/schedules/${selected}/compare`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({oldRevision: oldRev, newRevision: newRev, from, to}),
    });
    const created = await response.json();
    if (!response.ok) {
      setCompare(state => state ? {...state, partial: false, error: created.message ?? 'failed'} : state);
      setStatus(`Compare failed: ${created.message ?? ''}`);
      return;
    }
    setStatus('Streaming differences');
    openStream(created.sessionId, created);
  }

  function openStream(sessionId: string, created: {oldRevision: number; newRevision: number}) {
    const itemMap = new Map<string, DiffItem>();
    const exMap = new Map<string, ExceptionRow>();
    const es = new EventSource(`/api/compare/${sessionId}/stream`);
    esRef.current = es;

    const flush = (partial: boolean) => {
      setCompare({
        sessionId,
        oldRevision: created.oldRevision,
        newRevision: created.newRevision,
        items: [...itemMap.values()],
        exceptions: [...exMap.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
        stats: null,
        partial,
        error: null,
      });
    };

    es.addEventListener('item', event => {
      const item = JSON.parse((event as MessageEvent).data) as DiffItem;
      const existing = itemMap.get(item.key);
      if (existing) {
        itemMap.set(item.key, item);
      } else {
        itemMap.set(item.key, item);
      }
      flush(true);
    });
    es.addEventListener('exception', event => {
      const ex = JSON.parse((event as MessageEvent).data) as ExceptionRow;
      exMap.set(ex.id, ex);
      flush(true);
    });
    es.addEventListener('done', event => {
      const data = JSON.parse((event as MessageEvent).data) as {stats: Stats};
      setCompare({
        sessionId,
        oldRevision: created.oldRevision,
        newRevision: created.newRevision,
        items: [...itemMap.values()],
        exceptions: [...exMap.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
        stats: data.stats,
        partial: false,
        error: null,
      });
      setStatus('Comparison complete');
      es.close();
    });
    es.addEventListener('error', event => {
      // Network errors trigger native reconnect with Last-Event-ID automatically;
      // a server-side 'error' event carries data and closes the stream.
      const data = (event as MessageEvent).data;
      if (data) {
        const parsed = JSON.parse(data) as {error: string};
        setCompare(state => state ? {...state, partial: false, error: parsed.error} : state);
        setStatus(`Comparison error: ${parsed.error}`);
        es.close();
      }
    });
  }

  useEffect(() => () => esRef.current?.close(), []);

  const visibleItems = useMemo(
    () => (compare ? compare.items.filter(i => filters.has(i.type)) : []),
    [compare, filters],
  );
  const liveStats = useMemo(() => {
    if (compare?.stats) return {stats: compare.stats, partial: false};
    if (!compare) return null;
    const acc: Stats = {same: 0, added: 0, removed: 0, modified: 0, total: compare.items.length, exceptions: compare.exceptions.length, orphanedExceptions: 0};
    for (const i of compare.items) acc[i.type]++;
    for (const e of compare.exceptions) if (e.status === 'orphaned') acc.orphanedExceptions++;
    return {stats: acc, partial: true};
  }, [compare]);

  function toggleFilter(key: DiffType) {
    setFilters(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <main className="shell">
      <header className="topbar">
        <GitCompareArrows size={20}/>
        <strong>Recurrence Rule Studio</strong>
        <small>Revision occurrence diff</small>
      </header>
      <section className="workspace">
        <aside className="pane">
          <h2>Rules</h2>
          <div className="list">
            {items.map(item => (
              <button className={item.id === selected ? 'active' : ''} onClick={() => setSelected(item.id)} key={item.id}>
                {item.name}
                <br/><small>Revision {item.revision}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="pane">
          <div className="toolbar">
            <label className="revpick">
              View revision
              <select value={row?.revision ?? ''} onChange={e => loadRevision(Number(e.target.value))}>
                {revisions.map(r => <option value={r.revision} key={r.revision}>r{r.revision} — {r.note}</option>)}
              </select>
            </label>
            <button className="primary" onClick={save}><Save size={15}/>Save as new revision</button>
            <button onClick={analyze}><FlaskConical size={15}/>Validate</button>
            <span className="status">{status}</span>
          </div>
          <textarea
            ref={textRef}
            aria-label="Rule document JSON"
            spellCheck={false}
            value={draft}
            onChange={event => setDraft(event.target.value)}
          />
          <p className="hint">
            Segments and exceptions carry stable ids. Occurrences are matched by rule shape + epoch-anchored
            ordinal, not by timestamp. Click a source link in the diff to jump back here.
          </p>
        </section>

        <aside className="pane diff-pane">
          <h2>Compare revisions</h2>
          <div className="compare-form">
            <label>Old <select value={oldRev} onChange={e => setOldRev(Number(e.target.value))}>
              {revisions.map(r => <option value={r.revision} key={r.revision}>r{r.revision}</option>)}
            </select></label>
            <label>New <select value={newRev} onChange={e => setNewRev(Number(e.target.value))}>
              {revisions.map(r => <option value={r.revision} key={r.revision}>r{r.revision}</option>)}
            </select></label>
            <label>From <input type="date" value={from} onChange={e => setFrom(e.target.value)}/></label>
            <label>To <input type="date" value={to} onChange={e => setTo(e.target.value)}/></label>
            <button className="primary" onClick={startCompare}>Compare</button>
          </div>

          {compare && (
            <>
              <div className="stream-state">
                <span className={compare.partial ? 'badge partial' : 'badge complete'}>
                  {compare.error ? 'failed' : compare.partial ? 'streaming · partial' : 'complete'}
                </span>
                <span>r{compare.oldRevision} → r{compare.newRevision} · {compare.items.length} occurrences loaded</span>
              </div>

              {liveStats && (
                <div className="stats">
                  {FILTERS.map(f => (
                    <button
                      key={f.key}
                      className={`stat ${f.className} ${filters.has(f.key) ? 'on' : 'off'}`}
                      onClick={() => toggleFilter(f.key)}
                    >
                      <b>{liveStats.stats[f.key]}</b>{f.label}
                    </button>
                  ))}
                  <div className={`stat note ${liveStats.partial ? 'partial' : ''}`}>
                    {liveStats.partial ? 'Counts partial until stream completes' : 'Final counts'}
                  </div>
                </div>
              )}

              <div className="filter-row">
                <label className="ex-toggle">
                  <input type="checkbox" checked={showExceptions} onChange={e => setShowExceptions(e.target.checked)}/>
                  Exceptions ({compare.exceptions.length}
                  {liveStats && liveStats.stats.orphanedExceptions > 0 ? `, ${liveStats.stats.orphanedExceptions} orphaned` : ''})
                </label>
              </div>

              {compare.error && <div className="error-box">{compare.error}</div>}

              {showExceptions && compare.exceptions.length > 0 && (
                <section className="ex-section">
                  <h3>Exceptions under the new rule</h3>
                  {compare.exceptions.map(ex => (
                    <div className={`ex-row ex-${ex.status}`} key={ex.id}>
                      <div className="ex-head">
                        <span className="ex-id">{ex.id}</span>
                        <span className="ex-kind">{ex.kind}</span>
                        <span className={`badge ex-status`}>{ex.status}</span>
                      </div>
                      <div className="ex-bodies">
                        <ExceptionSide label="old" side={ex.old}/>
                        <ExceptionSide label="new" side={ex.next}/>
                      </div>
                    </div>
                  ))}
                </section>
              )}

              <section className="occ-section">
                <h3>Occurrences ({visibleItems.length})</h3>
                {visibleItems.map(item => (
                  <article className={`occ occ-${item.type}`} key={item.key}>
                    <div className="occ-head">
                      <span className={`badge diff-${item.type}`}>
                        {item.type === 'modified' ? 'time changed' : item.type}
                      </span>
                      <span className="occ-date">{(item.old ?? item.next)!.localDate}</span>
                      {(item.old?.dstResolution !== 'exact' || item.next?.dstResolution !== 'exact') && (
                        <span className="dst" title="Daylight saving adjustment applied">
                          dst: {item.old && item.old.dstResolution !== 'exact' ? item.old.dstResolution : item.next?.dstResolution}
                        </span>
                      )}
                    </div>
                    <div className="occ-bodies">
                      <OccurrenceSide label={`r${compare.oldRevision}`} side="old" occ={item.old} onJump={jumpWithLoad}/>
                      <OccurrenceSide label={`r${compare.newRevision}`} side="new" occ={item.next} onJump={jumpWithLoad}/>
                    </div>
                  </article>
                ))}
                {visibleItems.length === 0 && <p className="hint">No occurrences match the active filters yet.</p>}
              </section>
            </>
          )}
          {!compare && <p className="hint">Pin two revisions and a time window, then Compare. The session fixes both sides.</p>}
        </aside>
      </section>
    </main>
  );
}

function ExceptionSide({label, side}: {label: string; side: ExceptionRow['old']}) {
  return (
    <div className={`side ${side?.resolved ? 'resolved' : side ? 'unresolved' : 'missing'}`}>
      <small>{label}</small>
      {side ? (
        side.resolved
          ? <span>→ {side.targetKey}</span>
          : <span className="warn">unlocated: {side.reason}</span>
      ) : <span className="muted">absent</span>}
    </div>
  );
}

function OccurrenceSide({
  label, side, occ, onJump,
}: {
  label: string;
  side: 'old' | 'new';
  occ: OccurrencePayload | null;
  onJump: (side: 'old' | 'new', occ: OccurrencePayload) => void;
}) {
  if (!occ) {
    return <div className="side missing"><small>{label}</small><span className="muted">—</span></div>;
  }
  return (
    <div className="side">
      <small>{label}</small>
      <span className="wall">{occ.localDate} {occ.localTime}</span>
      <span className="instant" title={occ.instant}>UTC {occ.instant.replace('.000Z', 'Z')}</span>
      <button className="source-link" onClick={() => onJump(side, occ)} title="Jump to producing rule field or exception">
        {occ.source.kind === 'segment' ? 'rule field' : 'exception'}: {occ.source.id}
      </button>
    </div>
  );
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Locate the producing segment/exception in the JSON text and select the
// relevant field. time-changed occurrences highlight localTime; added/removed
// anchor on the segment definition; exception provenance selects the object.
function selectProvenance(text: string, occ: OccurrencePayload, area: HTMLTextAreaElement | null) {
  if (!area) return;
  const targetId = occ.source.id;
  const idAt = findObjectWithId(text, targetId);
  if (idAt < 0) return;
  let field: string | null = null;
  if (occ.source.kind === 'segment') {
    field = occ.dstResolution !== 'exact' ? 'localTime' : 'localTime';
  }
  const selectAt = field ? findFieldInObject(text, idAt, field) : idAt;
  const pos = selectAt >= 0 ? selectAt : idAt;
  area.focus();
  area.setSelectionRange(pos, pos + (field ? field.length : targetId.length + 2));
  const before = text.slice(0, pos);
  const line = before.split('\n').length - 1;
  const lineHeight = Number.parseFloat(getComputedStyle(area).lineHeight || '21') || 21;
  area.scrollTop = Math.max(0, line * lineHeight - area.clientHeight / 2);
}

function findObjectWithId(text: string, id: string): number {
  const needle = `"id"`;
  const idNeedle = JSON.stringify(id);
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return -1;
    const colon = text.indexOf(':', at + needle.length);
    const valStart = text.indexOf(idNeedle, colon);
    if (valStart < 0 || valStart > colon + 40) return -1;
    // ensure no comma/brace between colon and value (same property)
    if (!/^\s*$/.test(text.slice(colon + 1, valStart))) {
      from = at + needle.length;
      continue;
    }
    return at;
  }
}

function findFieldInObject(text: string, from: number, field: string): number {
  const open = text.lastIndexOf('{', from);
  if (open < 0) return -1;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return -1;
    }
  }
  const needle = `"${field}"`;
  const at = text.indexOf(needle, open);
  const close = text.indexOf('}', open);
  return at >= 0 && at < close ? at : -1;
}
