import {
  expandRule,
  includeKey,
  type ExpandedOccurrence,
  type ExpandedRule,
  type RecurrenceRule,
  type RuleRevision,
} from './rules';
import {addDays, type GapPolicy, type OverlapPolicy} from './time';

export type DiffType = 'added' | 'deleted' | 'timeChanged';
export type ExceptionStatus = 'located' | 'moved' | 'replaced' | 'missing' | 'orphaned';

export interface OccurrenceSide {
  ts: number;
  timeLocal: string;
  dateLocal: string;
  zone: string;
  origin: ExpandedOccurrence['origin'];
  status: ExpandedOccurrence['status'];
  canceled: boolean;
  fromException: boolean;
}

export interface DiffEntry {
  type: DiffType;
  key: string; // stable source key
  series: string;
  left?: OccurrenceSide;
  right?: OccurrenceSide;
  deltaMs?: number; // timeChanged only
}

export interface ExceptionReportItem {
  exceptionId: string;
  kind: 'include' | 'cancel';
  status: ExceptionStatus;
  targetKey?: string;
  leftOrigin: ExpandedOccurrence['origin'];
  rightOrigin?: ExpandedOccurrence['origin'];
  detail: string;
}

export interface DiffStats {
  added: number;
  deleted: number;
  timeChanged: number;
  unchanged: number;
  exceptions: Record<ExceptionStatus, number>;
}

export interface RevisionRef {
  scheduleId: string;
  revision: number;
}

export interface CompareWindow {
  rangeStart: string; // ISO instant inclusive
  rangeEnd: string; // ISO instant exclusive
}

export interface CompareInputs extends CompareWindow {
  left: RuleRevision; // pinned snapshot
  right: RuleRevision; // pinned snapshot
}

interface StreamEvents {
  onEntrySlots?: (slotDay: string, entries: DiffEntry[]) => void;
  onProgress?: (stats: Partial<DiffStats>, processedSlots: number, totalSlots: number) => void;
  onExceptions?: (items: ExceptionReportItem[]) => void;
  shouldCancel?: () => boolean;
}

const emptyStats = (): DiffStats => ({
  added: 0, deleted: 0, timeChanged: 0, unchanged: 0,
  exceptions: {located: 0, moved: 0, replaced: 0, missing: 0, orphaned: 0},
});

function toSide(exp: ExpandedRule, occ: ExpandedOccurrence): OccurrenceSide {
  return {
    ts: occ.ts,
    timeLocal: occ.timeLocal,
    dateLocal: occ.dateLocal,
    zone: exp.rule.zone,
    origin: occ.origin,
    status: occ.status,
    canceled: occ.canceled,
    fromException: !!occ.fromException,
  };
}

/**
 * Compare two pinned revisions.
 *
 * Matching is by *stable source key* (series identity + wall ordinal, or
 * exception id) — never by timestamp set difference. A timezone-only edit
 * therefore shows up as `timeChanged` (same keys, shifted instants), while an
 * interval/frequency edit changes the series identity so unmatched items are
 * reported plainly as delete + add without guessing a pairing.
 */
export function compareRevisions(inputs: CompareInputs, events: StreamEvents = {}): DiffStats {
  const rangeStart = Date.parse(inputs.rangeStart);
  const rangeEnd = Date.parse(inputs.rangeEnd);
  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd <= rangeStart) {
    throw new Error('invalid_window');
  }

  const left = expandRule(inputs.left.rule, {rangeStart, rangeEnd, shouldCancel: events.shouldCancel});
  const right = expandRule(inputs.right.rule, {rangeStart, rangeEnd, shouldCancel: events.shouldCancel});

  const leftByKey = new Map(left.occurrences.map((o) => [o.key, o]));
  const rightByKey = new Map(right.occurrences.map((o) => [o.key, o]));
  const leftInc = new Map(left.includes.map((o) => [o.key, o]));
  const rightInc = new Map(right.includes.map((o) => [o.key, o]));

  // Bucket entries by a wall-calendar slot so emission order is independent of
  // zones and of the UTC window alignment.
  const slots = new Map<string, DiffEntry[]>();
  const pushSlot = (day: string, entry: DiffEntry) => {
    const bucket = slots.get(day);
    if (bucket) bucket.push(entry);
    else slots.set(day, [entry]);
  };
  const pushEntry = (day: string, entry: DiffEntry) => pushSlot(day, entry);

  const stats = emptyStats();
  const note = (entry: DiffEntry) => {
    stats[entry.type] += 1;
    return entry;
  };

  const effective = (o: ExpandedOccurrence | undefined) => !!o && !o.canceled;

  // ---- series occurrences (key-based) ----
  for (const [key, lo] of leftByKey) {
    const ro = rightByKey.get(key);
    if (!ro) {
      if (effective(lo)) pushEntry(lo.slotDay, note({type: 'deleted', key, series: lo.series, left: toSide(left, lo)}));
      continue;
    }
    if (effective(lo) && effective(ro)) {
      if (lo.ts !== ro.ts) {
        pushEntry(lo.slotDay, note({
          type: 'timeChanged', key, series: lo.series,
          left: toSide(left, lo), right: toSide(right, ro), deltaMs: ro.ts - lo.ts,
        }));
      } else {
        stats.unchanged += 1;
      }
    } else if (effective(lo) && ro.canceled) {
      pushEntry(lo.slotDay, note({type: 'deleted', key, series: lo.series, left: toSide(left, lo), right: toSide(right, ro)}));
    } else if (lo.canceled && effective(ro)) {
      pushEntry(ro.slotDay, note({type: 'added', key, series: ro.series, left: toSide(left, lo), right: toSide(right, ro)}));
    }
    // canceled on both sides: exception report handles replacement.
  }
  for (const [key, ro] of rightByKey) {
    if (leftByKey.has(key)) continue;
    if (effective(ro)) pushEntry(ro.slotDay, note({type: 'added', key, series: ro.series, right: toSide(right, ro)}));
  }

  // ---- include exceptions (id-based) ----
  for (const [key, lo] of leftInc) {
    const ro = rightInc.get(key);
    if (!ro) {
      pushEntry(lo.slotDay, note({type: 'deleted', key, series: lo.series, left: toSide(left, lo)}));
    } else if (lo.ts !== ro.ts) {
      pushEntry(lo.slotDay, note({
        type: 'timeChanged', key, series: lo.series,
        left: toSide(left, lo), right: toSide(right, ro), deltaMs: ro.ts - lo.ts,
      }));
    } else {
      stats.unchanged += 1;
    }
  }
  for (const [key, ro] of rightInc) {
    if (leftInc.has(key)) continue;
    pushEntry(ro.slotDay, note({type: 'added', key, series: ro.series, right: toSide(right, ro)}));
  }

  // ---- exception locatability under the new rule ----
  const report = buildExceptionReport(inputs.left.rule, inputs.right.rule, left, right);
  for (const item of report) stats.exceptions[item.status] += 1;

  // ---- deterministic, stable emission order ----
  const allDays = [...slots.keys()].sort();
  const totalSlots = allDays.length;
  let processed = 0;
  const partial = emptyStats();
  for (const day of allDays) {
    if (events.shouldCancel?.()) throw new Error('aborted');
    const bucket = slots.get(day)!;
    bucket.sort((a, b) => {
      const ta = a.left?.ts ?? a.right!.ts;
      const tb = b.left?.ts ?? b.right!.ts;
      return ta - tb || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    });
    for (const e of bucket) partial[e.type] += 1;
    events.onEntrySlots?.(day, bucket);
    processed += 1;
    events.onProgress?.({...partial, exceptions: {...partial.exceptions}}, processed, totalSlots);
  }
  events.onExceptions?.(report);
  return stats;
}

// helper type trick to keep the parameter name in the signature above readable
function CompareWindowsSafe<T>(t: T): T {
  return t;
}

function findException(rule: RecurrenceRule, id: string) {
  const index = rule.exceptions.findIndex((e) => e.id === id);
  return index < 0 ? null : {ex: rule.exceptions[index], index};
}

function buildExceptionReport(
  leftRule: RecurrenceRule,
  rightRule: RecurrenceRule,
  left: ExpandedRule,
  right: ExpandedRule,
): ExceptionReportItem[] {
  const items: ExceptionReportItem[] = [];
  const rightRawKeys = new Set(right.occurrences.map((o) => o.key));
  const rightCanceledKeys = new Set(right.cancels.map((c) => c.targetKey));
  const rightCancelByTarget = new Map(right.cancels.map((c) => [c.targetKey, c]));
  const rightIncludeByTs = new Map(right.includes.map((o) => [o.ts, o]));
  const leftIncludeByTs = new Map(left.includes.map((o) => [o.ts, o]));

  leftRule.exceptions.forEach((ex, i) => {
    const leftOrigin = {kind: 'exception' as const, path: `exceptions[${i}]`, exceptionId: ex.id};
    const found = findException(rightRule, ex.id);

    if (ex.kind === 'include') {
      const leftTs = Date.parse(ex.date);
      if (found) {
        const rightTs = Date.parse(found.ex.date);
        const moved = rightTs !== leftTs;
        items.push({
          exceptionId: ex.id, kind: 'include',
          status: moved ? 'moved' : 'located',
          leftOrigin,
          rightOrigin: {kind: 'exception', path: `exceptions[${found.index}]`, exceptionId: ex.id},
          detail: moved ? 'exception kept, time changed under the new rule' : 'exception present in both revisions',
        });
      } else {
        const sameTime = Number.isFinite(leftTs) ? rightIncludeByTs.get(leftTs) : undefined;
        items.push({
          exceptionId: ex.id, kind: 'include',
          status: sameTime ? 'replaced' : 'missing',
          leftOrigin,
          rightOrigin: sameTime?.origin,
          detail: sameTime
            ? 'old one-off removed; a different exception at the same time replaces it'
            : 'one-off exception no longer present under the new rule',
        });
      }
      return;
    }

    // cancel exception
    const target = ex.targetOccurrenceKey;
    if (found) {
      items.push({
        exceptionId: ex.id, kind: 'cancel', status: 'located', targetKey: target ?? undefined,
        leftOrigin,
        rightOrigin: {kind: 'exception', path: `exceptions[${found.index}]`, exceptionId: ex.id},
        detail: 'cancel exception present in both revisions',
      });
      return;
    }
    if (!target) {
      items.push({exceptionId: ex.id, kind: 'cancel', status: 'missing', leftOrigin,
        detail: 'cancel removed and carried no target key'});
      return;
    }
    if (!rightRawKeys.has(target)) {
      items.push({exceptionId: ex.id, kind: 'cancel', status: 'orphaned', targetKey: target, leftOrigin,
        detail: 'targeted occurrence does not exist under the new rule (series/frequency changed); cancel dangles'});
      return;
    }
    const replacement = rightCancelByTarget.get(target);
    if (rightCanceledKeys.has(target) && replacement) {
      items.push({exceptionId: ex.id, kind: 'cancel', status: 'replaced', targetKey: target,
        leftOrigin, rightOrigin: replacement.origin,
        detail: `target still suppressed, now by exception ${replacement.key}`});
      return;
    }
    items.push({exceptionId: ex.id, kind: 'cancel', status: 'missing', targetKey: target, leftOrigin,
      detail: 'cancel removed and the targeted occurrence fires again under the new rule'});
  });

  // New (right-only) cancels whose target dangles are surfaced too, so the
  // editor can flag rules that carry broken exceptions even without a left
  // counterpart.
  rightRule.exceptions.forEach((ex, i) => {
    if (ex.kind !== 'cancel' || !ex.targetOccurrenceKey) return;
    if (findException(leftRule, ex.id)) return;
    if (!rightRawKeys.has(ex.targetOccurrenceKey)) {
      items.push({
        exceptionId: ex.id, kind: 'cancel', status: 'orphaned',
        targetKey: ex.targetOccurrenceKey,
        leftOrigin: {kind: 'exception', path: `exceptions[${i}]`, exceptionId: ex.id},
        detail: 'new cancel exception targets an occurrence that the new rule never produces',
      });
    }
  });

  void leftIncludeByTs;
  return items;
}

export function describePolicies(rule: RecurrenceRule): {gap: GapPolicy; overlap: OverlapPolicy; zone: string} {
  return {gap: rule.gapPolicy, overlap: rule.overlapPolicy, zone: rule.zone};
}

export function enumerateSlotDays(rangeStart: string, rangeEnd: string): string[] {
  // Slot enumeration is only used by callers wanting a full calendar axis.
  const start = new Date(rangeStart);
  const end = new Date(rangeEnd);
  const days: string[] = [];
  let cur = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const guard = new Date(cur);
  guard.setUTCMonth(guard.getUTCMonth() + 1);
  void guard;
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  const pad = (n: number) => String(n).padStart(2, '0');
  while (Date.UTC(y, m, 1) <= end.getTime()) {
    days.push(`${y}-${pad(m + 1)}`);
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  return days;
}

export const __testing = {addDays, emptyStats, includeKey};
