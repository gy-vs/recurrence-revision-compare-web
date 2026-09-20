import type {Response} from 'express';
import {diffRevisions, expand, validateDoc, validateWindow, type DiffResult, type RuleDoc} from './recurrence';

// A compare session pins BOTH sides at creation time; subsequent rule edits do
// not affect it. Results are produced as an append-only event log so clients
// can resume with Last-Event-ID.

export type CompareEvent =
  | {id: number; event: 'start'; data: unknown}
  | {id: number; event: 'progress'; data: unknown}
  | {id: number; event: 'item'; data: unknown}
  | {id: number; event: 'exception'; data: unknown}
  | {id: number; event: 'done'; data: unknown}
  | {id: number; event: 'error'; data: unknown};

export interface CompareSession {
  id: string;
  scheduleId: string;
  window: {from: string; to: string};
  sides: {old: {revision: number}; new: {revision: number}};
  events: CompareEvent[];
  done: boolean;
  error: string | null;
  result: DiffResult | null;
  createdAt: number;
  listeners: Set<Response>;
  heartbeat: NodeJS.Timeout;
}

const sessions = new Map<string, SessionWithTimer>();
const SESSION_TTL_MS = 30 * 60_000;
const FLUSH_DELAY_MS = 10;

type SessionWithTimer = CompareSession;

let counter = 0;
function newId(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export interface CompareRequest {
  scheduleId?: string;
  oldRevision?: number;
  newRevision?: number;
  from?: string;
  to?: string;
  // Optional inline rule documents (used by callers that already hold the
  // revision contents); otherwise documents are resolved through `resolveDoc`.
  oldDoc?: unknown;
  newDoc?: unknown;
}

export interface ResolvedRevision {
  revision: number;
  doc: RuleDoc;
}

// Batches expansion work so large windows stream partial results instead of
// blocking until completion.
export async function createCompareSession(
  req: CompareRequest,
  resolveDoc: (scheduleId: string, revision: number) => ResolvedRevision | null,
): Promise<CompareSession> {
  if (typeof req.scheduleId !== 'string' || !req.scheduleId) {
    throw badRequest('scheduleId required');
  }
  if (!Number.isInteger(req.oldRevision) || !Number.isInteger(req.newRevision)) {
    throw badRequest('oldRevision and newRevision must be integers');
  }
  const window = validateWindow(req.from, req.to);

  let oldRev: ResolvedRevision;
  let newRev: ResolvedRevision;
  try {
    oldRev = req.oldDoc
      ? {revision: req.oldRevision!, doc: validateDoc(req.oldDoc)}
      : mustResolve(resolveDoc, req.scheduleId, req.oldRevision!);
    newRev = req.newDoc
      ? {revision: req.newRevision!, doc: validateDoc(req.newDoc)}
      : mustResolve(resolveDoc, req.scheduleId, req.newRevision!);
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : 'invalid rule document');
  }

  const session: CompareSession = {
    id: newId('cmp'),
    scheduleId: req.scheduleId,
    window,
    sides: {old: {revision: oldRev.revision}, new: {revision: newRev.revision}},
    events: [],
    done: false,
    error: null,
    result: null,
    createdAt: Date.now(),
    listeners: new Set(),
    heartbeat: setInterval(() => {
      for (const res of session.listeners) {
        if (!res.writableEnded) res.write(': ping\n\n');
      }
    }, 15_000),
  };
  sessions.set(session.id, session);

  append(session, 'start', {
    sessionId: session.id,
    scheduleId: session.scheduleId,
    window: session.window,
    oldRevision: oldRev.revision,
    newRevision: newRev.revision,
    complete: false,
  });

  // Run on next ticks so the HTTP response / subscribers attach first.
  queueMicrotask(() => run(session, oldRev.doc, newRev.doc));
  return session;
}

function mustResolve(
  resolveDoc: (scheduleId: string, revision: number) => ResolvedRevision | null,
  scheduleId: string,
  revision: number,
): ResolvedRevision {
  const resolved = resolveDoc(scheduleId, revision);
  if (!resolved) throw badRequest(`revision ${revision} not found for '${scheduleId}'`);
  return resolved;
}

function badRequest(message: string): Error & {status?: number} {
  const error = new Error(message) as Error & {status?: number};
  error.status = 400;
  return error;
}

function append(session: CompareSession, event: CompareEvent['event'], data: unknown): CompareEvent {
  const entry: CompareEvent = {id: session.events.length + 1, event, data};
  session.events.push(entry);
  for (const res of session.listeners) {
    if (!res.writableEnded) res.write(`id: ${entry.id}\nevent: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`);
  }
  return entry;
}

const YIELD_EVERY = 200;

async function run(session: CompareSession, oldDoc: RuleDoc, newDoc: RuleDoc): Promise<void> {
  try {
    // Each side expands under ITS OWN timezone and DST policy.
    const oldExpansion = expand(oldDoc, session.window.from, session.window.to);
    await yieldToEventLoop();
    const newExpansion = expand(newDoc, session.window.from, session.window.to);
    await yieldToEventLoop();
    const result = diffRevisions(oldExpansion, newExpansion, session.window.from, session.window.to);
    session.result = result;

    let streamed = 0;
    for (const item of result.items) {
      append(session, 'item', {
        key: item.key,
        type: item.type,
        old: item.old ? occurrencePayload(item.old) : null,
        next: item.next ? occurrencePayload(item.next) : null,
      });
      streamed++;
      if (streamed % YIELD_EVERY === 0) {
        append(session, 'progress', partialStats(session, streamed, result.items.length));
        await yieldToEventLoop();
      }
    }

    for (const row of result.exceptions) {
      append(session, 'exception', row);
    }

    session.done = true;
    append(session, 'done', {
      complete: true,
      stats: result.stats,
      totalEvents: session.events.length,
    });
    finish(session);
  } catch (error) {
    session.error = error instanceof Error ? error.message : 'comparison failed';
    session.done = true;
    append(session, 'error', {complete: true, error: session.error});
    finish(session);
  }
}

function occurrencePayload(o: import('./recurrence').Occurrence) {
  return {
    key: o.key,
    localDate: o.localDate,
    localTime: o.localTime,
    instant: o.instant,
    utcOffsetMinutes: o.utcOffsetMinutes,
    dstResolution: o.dstResolution,
    source: o.source,
  };
}

function partialStats(session: CompareSession, streamed: number, totalItems: number) {
  return {
    complete: false,
    partial: true,
    streamed,
    totalItems,
    note: 'statistics are partial until the done event',
    scheduleId: session.scheduleId,
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, FLUSH_DELAY_MS));
}

function finish(session: CompareSession) {
  for (const res of session.listeners) {
    if (!res.writableEnded) res.end();
  }
  session.listeners.clear();
  setTimeout(() => {
    clearInterval(session.heartbeat);
    sessions.delete(session.id);
  }, SESSION_TTL_MS);
}

export function getSession(id: string): CompareSession | null {
  return sessions.get(id) ?? null;
}

// Attach an SSE response, replaying every event with id > lastEventId (resume).
export function attachStream(session: CompareSession, res: Response, lastEventId: number): () => void {
  for (const entry of session.events) {
    if (entry.id > lastEventId) {
      res.write(`id: ${entry.id}\nevent: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`);
    }
  }
  if (session.done) {
    res.end();
    return () => {};
  }
  session.listeners.add(res);
  return () => {
    session.listeners.delete(res);
  };
}
