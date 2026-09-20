import express from 'express';
import {fileURLToPath} from 'node:url';
import type {RuleDoc} from './recurrence.js';
import {validateDoc} from './recurrence.js';
import {attachStream, createCompareSession, getSession} from './compare.js';

interface RevisionRow {
  revision: number;
  content: string; // serialized RuleDoc JSON
  updatedAt: string;
  author: string;
  note: string;
}

interface RecordRow {
  id: string;
  name: string;
  revisions: RevisionRow[];
}

const current = (row: RecordRow): RevisionRow => row.revisions[row.revisions.length - 1];

function seedDoc(partial: Partial<RuleDoc> & Pick<RuleDoc, 'timezone' | 'segments'>): string {
  return JSON.stringify({dstPolicy: 'earlier', exceptions: [], ...partial});
}

// Revision 1: New York daily stand-up at 09:00 + nightly job at 21:00,
// with a single-instance cancellation, a moved occurrence and a summer break.
const alphaRev1 = seedDoc({
  timezone: 'America/New_York',
  segments: [
    {id: 'standup', frequency: 'DAILY', interval: 1, localTime: '09:00', start: '2026-01-01'},
    {id: 'nightly', frequency: 'DAILY', interval: 1, localTime: '21:00', start: '2026-01-01'},
  ],
  exceptions: [
    {id: 'cancel-holiday', kind: 'cancel', segmentId: 'standup', date: '2026-02-09'},
    {
      id: 'move-jan20',
      kind: 'replace',
      segmentId: 'standup',
      date: '2026-01-20',
      replacement: {localDate: '2026-01-21', localTime: '11:00'},
    },
    {id: 'summer-break', kind: 'cancelRange', segmentId: 'standup', date: '2026-07-01', endDate: '2026-08-15'},
  ],
});

// Revision 2: timezone-only change New York -> Chicago (same wall-clock rule).
const alphaRev2 = seedDoc({
  timezone: 'America/Chicago',
  segments: [
    {id: 'standup', frequency: 'DAILY', interval: 1, localTime: '09:00', start: '2026-01-01'},
    {id: 'nightly', frequency: 'DAILY', interval: 1, localTime: '21:00', start: '2026-01-01'},
  ],
  exceptions: [
    {id: 'cancel-holiday', kind: 'cancel', segmentId: 'standup', date: '2026-02-09'},
    {
      id: 'move-jan20',
      kind: 'replace',
      segmentId: 'standup',
      date: '2026-01-20',
      replacement: {localDate: '2026-01-21', localTime: '11:00'},
    },
    {id: 'summer-break', kind: 'cancelRange', segmentId: 'standup', date: '2026-07-01', endDate: '2026-08-15'},
  ],
});

// Revision 3: stand-up cadence changes to every 2 days; old cancellation now
// lands on a day the rule no longer generates -> exception becomes orphaned.
const alphaRev3 = seedDoc({
  timezone: 'America/New_York',
  segments: [
    {id: 'standup', frequency: 'DAILY', interval: 2, localTime: '09:00', start: '2026-01-01'},
    {id: 'nightly', frequency: 'DAILY', interval: 1, localTime: '21:00', start: '2026-01-01'},
  ],
  exceptions: [
    {id: 'cancel-holiday', kind: 'cancel', segmentId: 'standup', date: '2026-02-09'},
    {
      id: 'move-jan20',
      kind: 'replace',
      segmentId: 'standup',
      date: '2026-01-20',
      replacement: {localDate: '2026-01-21', localTime: '11:00'},
    },
    {id: 'summer-break', kind: 'cancelRange', segmentId: 'standup', date: '2026-07-01', endDate: '2026-08-15'},
  ],
});

// Revision 4: rule segmented into two same-shape segments (keys survive),
// the moved occurrence goes to a different day, and a bigger winter window is
// cancelled instead of the summer break.
const alphaRev4 = seedDoc({
  timezone: 'America/New_York',
  segments: [
    {id: 'standup-h1', frequency: 'DAILY', interval: 1, localTime: '09:00', start: '2026-01-01', until: '2026-06-30'},
    {id: 'standup-h2', frequency: 'DAILY', interval: 1, localTime: '09:00', start: '2026-07-01'},
    {id: 'nightly', frequency: 'DAILY', interval: 1, localTime: '21:00', start: '2026-01-01'},
  ],
  exceptions: [
    {id: 'cancel-holiday', kind: 'cancel', segmentId: 'standup-h1', date: '2026-02-09'},
    {
      id: 'move-jan20',
      kind: 'replace',
      segmentId: 'standup-h1',
      date: '2026-01-20',
      replacement: {localDate: '2026-01-22', localTime: '10:30'},
    },
    {id: 'winter-close', kind: 'cancelRange', segmentId: 'standup-h2', date: '2026-12-15', endDate: '2027-01-15'},
  ],
});

const rows: RecordRow[] = [
  {
    id: 'alpha',
    name: 'Primary occurrence sets',
    revisions: [
      {revision: 1, content: alphaRev1, updatedAt: new Date(0).toISOString(), author: 'ada', note: 'Initial daily rules'},
      {revision: 2, content: alphaRev2, updatedAt: new Date(1000).toISOString(), author: 'ada', note: 'Move team to Chicago time'},
      {revision: 3, content: alphaRev3, updatedAt: new Date(2000).toISOString(), author: 'grace', note: 'Stand-up every two days'},
      {revision: 4, content: alphaRev4, updatedAt: new Date(3000).toISOString(), author: 'grace', note: 'Split halves, retarget exception'},
    ],
  },
  {
    id: 'beta',
    name: 'Weekly review series',
    revisions: [
      {
        revision: 1,
        content: seedDoc({
          timezone: 'Europe/Berlin',
          segments: [
            {id: 'review', frequency: 'WEEKLY', interval: 1, localTime: '14:00', start: '2026-01-05', byWeekDay: ['MO']},
            {id: 'billing', frequency: 'MONTHLY', interval: 1, localTime: '06:00', start: '2026-01-01', byMonthDay: [1, 15]},
          ],
          exceptions: [],
        }),
        updatedAt: new Date(0).toISOString(),
        author: 'linus',
        note: 'Weekly review and bi-monthly billing',
      },
    ],
  },
];

export function createApp() {
  const app = express();
  app.use(express.json({limit: '1mb'}));

  app.get('/api/bootstrap', (_req, res) => res.json({family: 'recurrence-rule', count: rows.length}));

  app.get('/api/schedules', (_req, res) =>
    res.json(rows.map(row => ({id: row.id, name: row.name, revision: current(row).revision}))));

  app.get('/api/schedules/:id/revisions', (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    res.json(row.revisions.map(r => ({revision: r.revision, updatedAt: r.updatedAt, author: r.author, note: r.note})));
  });

  app.get('/api/schedules/:id/revisions/:rev', (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    const rev = Number(req.params.rev);
    const found = row.revisions.find(r => r.revision === rev);
    if (!found) return res.status(404).json({error: 'not_found', available: row.revisions.map(r => r.revision)});
    res.set('ETag', `"${found.revision}"`).json({id: row.id, name: row.name, ...found});
  });

  app.get('/api/schedules/:id', (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    const head = current(row);
    res.set('ETag', `"${head.revision}"`).json({id: row.id, name: row.name, ...head});
  });

  app.put('/api/schedules/:id', (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    const head = current(row);
    if (req.body.revision !== head.revision) {
      return res.status(409).json({error: 'revision_conflict', current: {id: row.id, name: row.name, ...head}});
    }
    let doc: RuleDoc;
    try {
      doc = validateDoc(req.body.doc ?? JSON.parse(String(req.body.content ?? '')));
    } catch (error) {
      return res.status(400).json({error: 'invalid_rule', message: error instanceof Error ? error.message : String(error)});
    }
    const next: RevisionRow = {
      revision: head.revision + 1,
      content: JSON.stringify(doc),
      updatedAt: new Date().toISOString(),
      author: String(req.body.author ?? 'you'),
      note: String(req.body.note ?? `Revision ${head.revision + 1}`),
    };
    row.revisions.push(next);
    res.json({id: row.id, name: row.name, ...next});
  });

  app.post('/api/schedules/:id/analyze', async (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    const head = current(row);
    let doc: RuleDoc;
    try {
      doc = validateDoc(req.body.doc ?? JSON.parse(String(req.body.content ?? head.content)));
    } catch (error) {
      return res.status(400).json({error: 'invalid_rule', message: error instanceof Error ? error.message : String(error)});
    }
    await new Promise(resolve => setTimeout(resolve, req.params.id === 'alpha' ? 30 : 10));
    res.json({
      id: row.id,
      revision: head.revision,
      segmentCount: doc.segments.length,
      exceptionCount: doc.exceptions.length,
      diagnostics: [],
    });
  });

  const resolveDoc = (scheduleId: string, revision: number) => {
    const row = rows.find(value => value.id === scheduleId);
    if (!row) return null;
    const found = row.revisions.find(r => r.revision === revision);
    if (!found) return null;
    return {revision: found.revision, doc: JSON.parse(found.content) as RuleDoc};
  };

  // Create a comparison session; both revisions are pinned here.
  app.post('/api/schedules/:id/compare', async (req, res) => {
    try {
      const session = await createCompareSession(
        {
          scheduleId: req.params.id,
          oldRevision: req.body.oldRevision,
          newRevision: req.body.newRevision,
          from: req.body.from,
          to: req.body.to,
        },
        resolveDoc,
      );
      res.status(201).json({
        sessionId: session.id,
        streamUrl: `/api/compare/${session.id}/stream`,
        oldRevision: session.sides.old.revision,
        newRevision: session.sides.new.revision,
        window: session.window,
      });
    } catch (error) {
      const status = (error as {status?: number}).status ?? 500;
      if (status >= 500) throw error;
      res.status(status).json({error: 'bad_request', message: error instanceof Error ? error.message : String(error)});
    }
  });

  // SSE stream, resumable with Last-Event-ID (native EventSource reconnect).
  app.get('/api/compare/:sessionId/stream', (req, res) => {
    const session = getSession(req.params.sessionId);
    if (!session) return res.status(404).json({error: 'session_not_found'});
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const header = req.headers['last-event-id'] ?? (req.query.lastEventId as string | undefined);
    const lastEventId = Math.max(0, Number(header) || 0);
    const detach = attachStream(session, res, lastEventId);

    const close = () => {
      detach();
      res.end();
    };
    req.on('close', close);
    req.on('aborted', close);
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
