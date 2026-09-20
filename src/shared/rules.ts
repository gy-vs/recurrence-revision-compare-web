import {addDays, dayKey, diffDays, parseDay, wallToInstant} from './time';
import type {GapPolicy, OverlapPolicy} from './time';

export type {GapPolicy, OverlapPolicy} from './time';

export type Frequency = 'daily' | 'weekly';

export interface RuleSegment {
  id: string;
  startDate: string; // YYYY-MM-DD inclusive
  endDate?: string | null; // YYYY-MM-DD inclusive
  frequency: Frequency;
  interval: number; // >= 1
  byWeekday?: number[]; // 0=Sun..6=Sat, required/used for weekly
  startTime: string; // HH:MM wall time
}

export type ExceptionKind = 'include' | 'cancel';

export interface RuleException {
  id: string;
  kind: ExceptionKind;
  /** ISO instant; the wall time is rendered in the rule's zone. */
  date: string;
  time: string; // HH:MM
  reason?: string;
  /** include-only: stable source key of the occurrence this replaces, if any */
  replacesOccurrenceKey?: string | null;
  /** cancel-only: stable source key of the targeted series occurrence */
  targetOccurrenceKey?: string | null;
}

export interface RecurrenceRule {
  zone: string;
  gapPolicy: GapPolicy;
  overlapPolicy: OverlapPolicy;
  segments: RuleSegment[];
  exceptions: RuleException[];
}

export interface RuleRevision {
  scheduleId: string;
  revision: number;
  createdAt: string;
  note: string;
  rule: RecurrenceRule;
}

// ---- Stable source keys -------------------------------------------------
//
// Identity survives timezone edits and DST shifts because it is expressed in
// *wall calendar* coordinates, not timestamps. It does NOT survive frequency /
// interval / weekday changes — those are genuinely new occurrences, which then
// surface as delete+add instead of guessed "moves".

export function seriesKey(segment: Pick<RuleSegment, 'id' | 'frequency' | 'interval' | 'byWeekday' | 'startTime'>): string {
  const wd = [...(segment.byWeekday ?? [])].sort((a, b) => a - b).join('.');
  return `seg:${segment.id}|${segment.frequency}/${segment.interval}|[${wd}]|${segment.startTime}`;
}

export function occurrenceKey(series: string, ordinal: number): string {
  return `${series}#${ordinal}`;
}

export function includeKey(exceptionId: string): string {
  return `ex:${exceptionId}`;
}

// ---- Validation ---------------------------------------------------------

export function validateRule(rule: RecurrenceRule): string[] {
  const errors: string[] = [];
  if (typeof rule.zone !== 'string' || !rule.zone) errors.push('zone is required');
  else {
    try {
      new Intl.DateTimeFormat('en-US', {timeZone: rule.zone});
    } catch {
      errors.push(`unknown timezone: ${rule.zone}`);
    }
  }
  for (const policy of ['gapPolicy', 'overlapPolicy'] as const) {
    const ok = policy === 'gapPolicy'
      ? rule[policy] === 'shiftForward' || rule[policy] === 'shiftBack'
      : rule[policy] === 'earlier' || rule[policy] === 'later';
    if (!ok) errors.push(`${policy} invalid`);
  }
  if (!Array.isArray(rule.segments) || rule.segments.length === 0) errors.push('at least one segment required');
  const segIds = new Set<string>();
  for (const seg of rule.segments ?? []) {
    if (!seg.id || segIds.has(seg.id)) errors.push(`segment id must be unique: ${seg.id}`);
    segIds.add(seg.id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(seg.startDate)) errors.push(`segment ${seg.id}: bad startDate`);
    if (seg.endDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(seg.endDate)) errors.push(`segment ${seg.id}: bad endDate`);
    if (seg.endDate != null && seg.endDate < seg.startDate) errors.push(`segment ${seg.id}: endDate before startDate`);
    if (!Number.isInteger(seg.interval) || seg.interval < 1) errors.push(`segment ${seg.id}: interval must be >= 1`);
    if (!/^\d{2}:\d{2}$/.test(seg.startTime)) errors.push(`segment ${seg.id}: bad startTime`);
    if (seg.frequency === 'weekly') {
      const wd = seg.byWeekday ?? [];
      if (wd.length === 0 || wd.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        errors.push(`segment ${seg.id}: weekly needs weekdays 0..6`);
      }
    }
  }
  const exIds = new Set<string>();
  for (const ex of rule.exceptions ?? []) {
    if (!ex.id || exIds.has(ex.id)) errors.push(`exception id must be unique: ${ex.id}`);
    exIds.add(ex.id);
    if (ex.kind !== 'include' && ex.kind !== 'cancel') errors.push(`exception ${ex.id}: bad kind`);
    if (!/^\d{2}:\d{2}$/.test(ex.time)) errors.push(`exception ${ex.id}: bad time`);
    if (Number.isNaN(Date.parse(ex.date))) errors.push(`exception ${ex.id}: bad date`);
  }
  return errors;
}

// ---- Expansion ----------------------------------------------------------

export interface Origin {
  kind: 'segment' | 'exception';
  path: string; // e.g. segments[2].startTime / exceptions[1].date
  segmentId?: string;
  exceptionId?: string;
}

export interface ExpandedOccurrence {
  key: string; // stable source key
  series: string; // series key, or include key for added instances
  ordinal: number;
  ts: number; // resolved instant
  timeLocal: string; // HH:MM wall time as configured
  dateLocal: string; // YYYY-MM-DD wall date actually observed in the rule zone
  slotDay: string; // wall date used for ordered, window-independent diffing
  origin: Origin;
  canceled: boolean;
  fromException?: boolean;
  status: 'ok' | 'gap' | 'overlap';
}

export interface RawCancel {
  key: string; // exception id
  targetKey: string; // stable occurrence key targeted
  ts: number;
  origin: Origin;
}

export interface ExpandedRule {
  rule: RecurrenceRule;
  occurrences: ExpandedOccurrence[]; // raw series, with `canceled` flags applied
  includes: ExpandedOccurrence[]; // extra instances from include exceptions
  cancels: RawCancel[]; // cancel exceptions, including those that matched nothing
  unmatchedCancels: RawCancel[];
}

export const EXPANSION_LIMIT = 200_000;

function parseHHMM(time: string): [number, number] {
  const [h, m] = time.split(':').map(Number);
  return [h, m];
}

function weekdayOf(key: string): number {
  const [y, m, d] = parseDay(key);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Wall dates on which the segment fires, with the ordinal counted from segment start. */
function segmentDates(seg: RuleSegment, fromDay: string, throughDay: string): Array<{day: string; ordinal: number}> {
  const out: Array<{day: string; ordinal: number}> = [];
  let ordinal = 0;
  let day = seg.startDate;
  if (seg.frequency === 'daily') {
    if (day < fromDay) {
      const skip = Math.floor(diffDays(seg.startDate, fromDay) / seg.interval);
      ordinal = skip;
      day = addDays(seg.startDate, skip * seg.interval);
    }
    for (;;) {
      if (day >= fromDay) out.push({day, ordinal});
      ordinal += 1;
      day = addDays(day, seg.interval);
      if (day > throughDay) break;
    }
  } else {
    const days = [...(seg.byWeekday ?? [])].sort((a, b) => a - b);
    let cur = seg.startDate < fromDay ? fromDay : seg.startDate;
    cur = addDays(cur, -((weekdayOf(cur) + 7 - days[0]) % 7));
    while (cur <= throughDay) {
      for (const wd of days) {
        const day = addDays(cur, (wd - weekdayOf(cur) + 7) % 7);
        if (day < seg.startDate || day < fromDay || day > throughDay) continue;
        const weekIndex = Math.floor(diffDays(seg.startDate, day) / 7);
        out.push({day, ordinal: weekIndex * 7 + wd});
      }
      cur = addDays(cur, 7 * seg.interval);
    }
    out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.ordinal - b.ordinal));
  }
  return out;
}

export interface ExpandOptions {
  rangeStart: number; // inclusive instant
  rangeEnd: number; // exclusive instant
  shouldCancel?: () => boolean;
}

/**
 * Expand one revision under its OWN zone and DST policies.
 *
 * We scan wall-calendar days a margin around the UTC window so occurrences on
 * the first/last day (whose UTC instant may cross the boundary) are handled.
 */
export function expandRule(rule: RecurrenceRule, opts: ExpandOptions): ExpandedRule {
  const marginDays = 2;
  const startDay = dayKey(
    new Date(opts.rangeStart).getUTCFullYear(),
    new Date(opts.rangeStart).getUTCMonth() + 1,
    new Date(opts.rangeStart).getUTCDate(),
  );
  const endDay = dayKey(
    new Date(opts.rangeEnd).getUTCFullYear(),
    new Date(opts.rangeEnd).getUTCMonth() + 1,
    new Date(opts.rangeEnd).getUTCDate(),
  );
  const fromDay = addDays(startDay, -marginDays);
  const throughDay = addDays(endDay, marginDays);

  const occurrences: ExpandedOccurrence[] = [];
  let count = 0;
  for (const seg of rule.segments) {
    const segEnd = seg.endDate ?? '9999-12-31';
    const scanStart = seg.startDate > fromDay ? seg.startDate : fromDay;
    const scanEnd = segEnd < throughDay ? segEnd : throughDay;
    if (scanStart > scanEnd) continue;
    const series = seriesKey(seg);
    const [h, mi] = parseHHMM(seg.startTime);
    for (const {day, ordinal} of segmentDates(seg, scanStart, scanEnd)) {
      if (++count > EXPANSION_LIMIT) throw new Error('expansion_limit_exceeded');
      if (opts.shouldCancel?.()) throw new Error('aborted');
      const [y, mo, d] = parseDay(day);
      const resolved = wallToInstant(y, mo, d, h, mi, rule.zone, rule.gapPolicy, rule.overlapPolicy);
      if (resolved.ts < opts.rangeStart || resolved.ts >= opts.rangeEnd) continue;
      occurrences.push({
        key: occurrenceKey(series, ordinal),
        series,
        ordinal,
        ts: resolved.ts,
        timeLocal: seg.startTime,
        dateLocal: day,
        slotDay: day,
        origin: {kind: 'segment', path: `segments[${seg.id}].startTime`, segmentId: seg.id},
        canceled: false,
        status: resolved.mode === 'normal' ? 'ok' : resolved.mode,
      });
    }
  }

  const includes: ExpandedOccurrence[] = [];
  const cancels: RawCancel[] = [];
  for (let i = 0; i < rule.exceptions.length; i++) {
    const ex = rule.exceptions[i];
    const instant = Date.parse(ex.date);
    if (Number.isNaN(instant)) continue;
    const origin: Origin = {kind: 'exception', path: `exceptions[${i}]`, exceptionId: ex.id};
    if (ex.kind === 'include') {
      if (instant < opts.rangeStart || instant >= opts.rangeEnd) continue;
      // Render the wall date of the instant in this rule's own zone (identity
      // of an include is the exception id, so the key is stable regardless).
      const w = new Intl.DateTimeFormat('en-US', {
        timeZone: rule.zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date(instant));
      const get = (t: string) => Number(w.find((p) => p.type === t)!.value);
      includes.push({
        key: includeKey(ex.id),
        series: includeKey(ex.id),
        ordinal: 0,
        ts: instant,
        timeLocal: ex.time,
        dateLocal: dayKey(get('year'), get('month'), get('day')),
        slotDay: dayKey(get('year'), get('month'), get('day')),
        origin,
        canceled: false,
        fromException: true,
        status: 'ok',
      });
    } else if (ex.targetOccurrenceKey) {
      cancels.push({key: ex.id, targetKey: ex.targetOccurrenceKey, ts: instant, origin});
    }
  }

  const canceledKeys = new Set(cancels.map((c) => c.targetKey));
  const matched = new Set<string>();
  for (const occ of occurrences) {
    if (canceledKeys.has(occ.key)) {
      occ.canceled = true;
      matched.add(occ.key);
    }
  }
  const unmatchedCancels = cancels.filter((c) => !matched.has(c.targetKey));

  return {rule, occurrences, includes, cancels, unmatchedCancels};
}
