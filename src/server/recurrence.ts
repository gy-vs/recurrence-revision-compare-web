// Recurrence rule model, timezone-aware expansion, stable occurrence source keys
// and revision diffing. Occurrences are matched by a *source key* derived from
// the rule shape and a date-anchored ordinal, never by timestamp set difference.

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';
export type DstPolicy = 'earlier' | 'later';
export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

export interface RuleSegment {
  id: string;
  frequency: Frequency;
  interval: number;
  localTime: string; // HH:MM
  start: string; // YYYY-MM-DD inclusive
  until?: string; // YYYY-MM-DD inclusive
  count?: number; // max generated occurrences
  byWeekDay?: Weekday[]; // WEEKLY
  byMonthDay?: number[]; // MONTHLY
}

export type ExceptionKind = 'cancel' | 'cancelRange' | 'replace';

export interface ExceptionDef {
  id: string;
  kind: ExceptionKind;
  segmentId?: string;
  date: string; // target local date (cancelRange start)
  endDate?: string; // cancelRange inclusive end
  replacement?: { localDate: string; localTime: string };
}

export interface RuleDoc {
  timezone: string;
  dstPolicy?: DstPolicy;
  segments: RuleSegment[];
  exceptions: ExceptionDef[];
}

export interface OccurrenceSource {
  kind: 'segment' | 'exception';
  id: string;
}

export type DstResolution =
  | 'exact'
  | 'gap-earlier'
  | 'gap-later'
  | 'overlap-earlier'
  | 'overlap-later';

export interface Occurrence {
  key: string; // stable source key
  localDate: string;
  localTime: string;
  instant: string; // ISO-8601 UTC
  utcOffsetMinutes: number;
  dstResolution: DstResolution;
  source: OccurrenceSource;
}

export interface ExceptionResolution {
  exceptionId: string;
  kind: ExceptionKind;
  resolved: boolean;
  targetDate?: string;
  targetKey?: string;
  replacementKey?: string;
  reason?: string;
}

export interface Expansion {
  doc: RuleDoc;
  occurrences: Map<string, Occurrence>; // pre-window, post-exception
  windowed: Occurrence[]; // clipped to window, stable order
  resolutions: Map<string, ExceptionResolution>;
}

export type DiffType = 'added' | 'removed' | 'modified' | 'same';

export interface DiffItem {
  key: string;
  type: DiffType;
  old: Occurrence | null;
  next: Occurrence | null;
}

export interface ExceptionRow {
  id: string;
  kind: ExceptionKind;
  presence: 'both' | 'old-only' | 'new-only';
  old: ExceptionResolution | null;
  next: ExceptionResolution | null;
  status: 'unchanged' | 'retargeted' | 'orphaned' | 'added' | 'removed' | 'unresolved-both';
}

export interface DiffStats {
  same: number;
  added: number;
  removed: number;
  modified: number;
  total: number;
  exceptions: number;
  orphanedExceptions: number;
}

export interface DiffResult {
  items: DiffItem[];
  exceptions: ExceptionRow[];
  stats: DiffStats;
}

export class RuleValidationError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'RuleValidationError';
  }
}

// ---------------------------------------------------------------------------
// Local date helpers (naive wall-clock calendar, UTC only as a math substrate)
// ---------------------------------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;
const WEEKDAY_INDEX: Record<Weekday, number> = {SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6};
const WEEKDAYS: Weekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function parseYmd(value: string): {y: number; m: number; d: number; day: number} {
  const match = DATE_RE.exec(value);
  if (!match) throw new RuleValidationError(`invalid date '${value}', expected YYYY-MM-DD`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) throw new RuleValidationError(`invalid date '${value}'`);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (new Date(Date.UTC(y, m - 1, d)).getUTCDate() !== d) {
    throw new RuleValidationError(`invalid calendar date '${value}'`);
  }
  return {y, m, d, day};
}

function ymdFromDays(days: number): string {
  const t = new Date(days * 86_400_000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

function daysFromYmd(value: string): number {
  const {y, m, d} = parseYmd(value);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

function weekdayOfDays(days: number): number {
  // 1970-01-01 was Thursday (4)
  return ((days + 4) % 7 + 7) % 7;
}

// ---------------------------------------------------------------------------
// Wall time -> instant with explicit DST gap/overlap policy (Intl based)
// ---------------------------------------------------------------------------

const offsetFormatterCache = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(timezone: string): Intl.DateTimeFormat {
  let f = offsetFormatterCache.get(timezone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    } catch {
      throw new RuleValidationError(`unknown timezone '${timezone}'`);
    }
    offsetFormatterCache.set(timezone, f);
  }
  return f;
}

function wallParts(timezone: string, instant: number) {
  const parts = offsetFormatter(timezone).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find(p => p.type === type)!.value);
  let hour = get('hour');
  if (hour === 24) hour = 0; // some ICU builds emit 24:xx for midnight
  return {y: get('year'), m: get('month'), d: get('day'), hour, minute: get('minute')};
}

function offsetMinutesAt(timezone: string, instant: number): number {
  const p = wallParts(timezone, instant);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute);
  return Math.round((asUtc - instant) / 60_000);
}

function wallEquals(p: ReturnType<typeof wallParts>, y: number, m: number, d: number, h: number, mi: number) {
  return p.y === y && p.m === m && p.d === d && p.hour === h && p.minute === mi;
}

export interface WallResolution {
  instant: number;
  utcOffsetMinutes: number;
  resolution: DstResolution;
}

export function resolveWallTime(
  timezone: string,
  date: string,
  time: string,
  policy: DstPolicy = 'earlier',
): WallResolution {
  const {y, m, d} = parseYmd(date);
  const tm = TIME_RE.exec(time);
  if (!tm) throw new RuleValidationError(`invalid localTime '${time}', expected HH:MM`);
  const hour = Number(tm[1]);
  const minute = Number(tm[2]);
  if (hour > 23 || minute > 59) throw new RuleValidationError(`invalid localTime '${time}'`);

  const wallUtc = Date.UTC(y, m - 1, d, hour, minute);

  // Sample offsets across a 56h window around the wall time. Every DST
  // transition lands in this span, so the distinct offset set contains exactly
  // the offsets needed to interpret this wall time.
  const offsets = new Set<number>();
  for (let k = -13; k <= 14; k++) {
    offsets.add(offsetMinutesAt(timezone, wallUtc + k * 2 * 3_600_000));
  }
  // An offset interprets the wall time if formatting the result reproduces it.
  const matches = [...offsets]
    .map(off => {
      const instant = wallUtc - off * 60_000;
      const p = wallParts(timezone, instant);
      return wallEquals(p, y, m, d, hour, minute) ? {instant, off} : null;
    })
    .filter((v): v is {instant: number; off: number} => v !== null)
    .sort((a, b) => a.instant - b.instant);

  if (matches.length === 1) {
    return {instant: matches[0].instant, utcOffsetMinutes: matches[0].off, resolution: 'exact'};
  }
  if (matches.length >= 2) {
    // Fall-back overlap: the same wall time exists twice.
    const [earlier, later] = [matches[0], matches[matches.length - 1]];
    return policy === 'earlier'
      ? {instant: earlier.instant, utcOffsetMinutes: earlier.off, resolution: 'overlap-earlier'}
      : {instant: later.instant, utcOffsetMinutes: later.off, resolution: 'overlap-later'};
  }

  // Spring-forward gap: no offset reproduces the wall time; bracket it with the
  // larger (later-side) and smaller (earlier-side) observed offsets.
  const sorted = [...offsets].sort((a, b) => b - a);
  const larger = sorted[0];
  const smaller = sorted[sorted.length - 1];
  return policy === 'earlier'
    ? {instant: wallUtc - larger * 60_000, utcOffsetMinutes: larger, resolution: 'gap-earlier'}
    : {instant: wallUtc - smaller * 60_000, utcOffsetMinutes: smaller, resolution: 'gap-later'};
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateDoc(doc: unknown): RuleDoc {
  if (!doc || typeof doc !== 'object') throw new RuleValidationError('rule document must be an object');
  const d = doc as Partial<RuleDoc>;
  if (typeof d.timezone !== 'string' || !d.timezone) throw new RuleValidationError('timezone required');
  // throws for unknown zone
  offsetFormatter(d.timezone);
  if (d.dstPolicy && d.dstPolicy !== 'earlier' && d.dstPolicy !== 'later') {
    throw new RuleValidationError("dstPolicy must be 'earlier' or 'later'");
  }
  if (!Array.isArray(d.segments) || d.segments.length === 0) {
    throw new RuleValidationError('segments required');
  }
  const seen = new Set<string>();
  for (const seg of d.segments) validateSegment(seg, seen);
  if (!Array.isArray(d.exceptions)) throw new RuleValidationError('exceptions must be an array');
  const exIds = new Set<string>();
  for (const ex of d.exceptions) validateException(ex, exIds, d.segments);
  return doc as RuleDoc;
}

function validateSegment(seg: RuleSegment, seen: Set<string>) {
  if (!seg || typeof seg !== 'object') throw new RuleValidationError('segment must be an object');
  if (typeof seg.id !== 'string' || !seg.id) throw new RuleValidationError('segment id required');
  if (seen.has(seg.id)) throw new RuleValidationError(`duplicate segment id '${seg.id}'`);
  seen.add(seg.id);
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(seg.frequency)) {
    throw new RuleValidationError(`segment '${seg.id}': bad frequency`);
  }
  if (!Number.isInteger(seg.interval) || seg.interval < 1) {
    throw new RuleValidationError(`segment '${seg.id}': interval must be a positive integer`);
  }
  if (!TIME_RE.test(seg.localTime ?? '')) {
    throw new RuleValidationError(`segment '${seg.id}': localTime must be HH:MM`);
  }
  parseYmd(seg.start);
  if (seg.until) {
    parseYmd(seg.until);
    if (daysFromYmd(seg.until) < daysFromYmd(seg.start)) {
      throw new RuleValidationError(`segment '${seg.id}': until before start`);
    }
  }
  if (seg.count !== undefined && (!Number.isInteger(seg.count) || seg.count < 1)) {
    throw new RuleValidationError(`segment '${seg.id}': count must be a positive integer`);
  }
  if (seg.frequency === 'WEEKLY' && seg.byWeekDay) {
    if (!Array.isArray(seg.byWeekDay) || seg.byWeekDay.some(w => !(w in WEEKDAY_INDEX))) {
      throw new RuleValidationError(`segment '${seg.id}': bad byWeekDay`);
    }
  }
  if (seg.frequency === 'MONTHLY' && seg.byMonthDay) {
    if (!Array.isArray(seg.byMonthDay) || seg.byMonthDay.some(d2 => !Number.isInteger(d2) || d2 < 1 || d2 > 31)) {
      throw new RuleValidationError(`segment '${seg.id}': bad byMonthDay`);
    }
  }
}

function validateException(ex: ExceptionDef, ids: Set<string>, segments: RuleSegment[]) {
  if (!ex || typeof ex !== 'object') throw new RuleValidationError('exception must be an object');
  if (typeof ex.id !== 'string' || !ex.id) throw new RuleValidationError('exception id required');
  if (ids.has(ex.id)) throw new RuleValidationError(`duplicate exception id '${ex.id}'`);
  ids.add(ex.id);
  if (!['cancel', 'cancelRange', 'replace'].includes(ex.kind)) {
    throw new RuleValidationError(`exception '${ex.id}': bad kind`);
  }
  parseYmd(ex.date);
  if (ex.kind === 'cancelRange') {
    if (!ex.endDate) throw new RuleValidationError(`exception '${ex.id}': endDate required for cancelRange`);
    parseYmd(ex.endDate);
    if (daysFromYmd(ex.endDate) < daysFromYmd(ex.date)) {
      throw new RuleValidationError(`exception '${ex.id}': endDate before date`);
    }
  }
  // segmentId is allowed to dangle: a segment may have been renamed/split in
  // a later revision and the exception's locatability is decided at expansion.
  if (ex.kind === 'replace') {
    if (!ex.replacement || !ex.replacement.localDate || !TIME_RE.test(ex.replacement.localTime ?? '')) {
      throw new RuleValidationError(`exception '${ex.id}': replacement localDate/localTime required`);
    }
    parseYmd(ex.replacement.localDate);
  }
}

// ---------------------------------------------------------------------------
// Stable source keys
//
// Keyed by rule SHAPE fingerprint plus an epoch-anchored ordinal, so:
//   - changing only timezone / localTime keeps keys (time change, not delete+add)
//   - changing frequency or interval changes fingerprint/ordinal -> delete+add
//   - splitting or renaming same-shape segments keeps keys
// ---------------------------------------------------------------------------

const EPOCH_MONTH_INDEX = 0; // 1970-01

// Occurrence line identity:
//   shape (frequency/interval/by*) + phase (start position in the shape grid)
//   + wall time + epoch-anchored ordinal.
//
//   - timezone-only edits leave localTime untouched -> key survives
//   - localTime edits are relinked in the diff pass -> shown as time change
//   - interval/frequency/by* edits change shape -> delete + add (no guessing)
//   - splitting a same-shape rule produces aligned pieces -> same phase, match
//   - independent same-shape segments (standup vs nightly) differ in phase or
//     wall time, so they can never collide
function segmentPhase(seg: RuleSegment): string {
  const days = daysFromYmd(seg.start);
  switch (seg.frequency) {
    case 'DAILY':
      return String(((days % seg.interval) + seg.interval) % seg.interval);
    case 'WEEKLY': {
      const monday = days - ((weekdayOfDays(days) + 6) % 7);
      return String(((Math.floor(monday / 7) % seg.interval) + seg.interval) % seg.interval);
    }
    case 'MONTHLY': {
      const {y, m} = parseYmd(seg.start);
      const monthIndex = y * 12 + (m - 1) - EPOCH_MONTH_INDEX;
      return String(((monthIndex % seg.interval) + seg.interval) % seg.interval);
    }
  }
}

function segmentSignature(seg: RuleSegment, localDate: string): string {
  const phase = segmentPhase(seg);
  const days = daysFromYmd(localDate);
  switch (seg.frequency) {
    case 'DAILY':
      return `DAILY${seg.interval}/p${phase}@${seg.localTime}|${Math.floor(days / seg.interval)}`;
    case 'WEEKLY': {
      const wd = weekdayOfDays(days);
      const daysList = seg.byWeekDay && seg.byWeekDay.length
        ? seg.byWeekDay.map(w => WEEKDAY_INDEX[w]).sort((a, b) => a - b)
        : [wd];
      const slot = daysList.indexOf(wd);
      const monday = days - ((wd + 6) % 7);
      return `WEEKLY${seg.interval}[${daysList.join(',')}]/p${phase}@${seg.localTime}|${Math.floor(monday / 7 / seg.interval)}|${slot}`;
    } case 'MONTHLY': {
      const {y, m, d} = parseYmd(localDate);
      const daysList = seg.byMonthDay && seg.byMonthDay.length ? seg.byMonthDay.slice().sort((a, b) => a - b) : [d];
      const slot = daysList.indexOf(d);
      return `MONTHLY${seg.interval}[${daysList.join(',')}]/p${phase}@${seg.localTime}|${Math.floor((y * 12 + (m - 1) - EPOCH_MONTH_INDEX) / seg.interval)}|${slot}`;
    }
  }
}

function occurrenceKey(seg: RuleSegment, localDate: string): string {
  return `occ|${segmentSignature(seg, localDate)}`;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const MAX_OCCURRENCES = 200_000;
// How far past the comparison window a count-bounded / replacement segment may
// generate, so exception targets beyond the window are still locatable.
const EXTRA_HORIZON_DAYS = 366 * 5;

// Finite generation bounds: explicit `until` wins; otherwise `count` allows a
// bounded look beyond the window; otherwise generation stops at the window end
// so open-ended rules never expand forever (and a shape change past the window
// is never guessed into it).
function resolveEnd(seg: RuleSegment, horizonDays: number): number {
  if (seg.until) return daysFromYmd(seg.until);
  if (seg.count !== undefined) return Math.max(horizonDays, horizonDays + EXTRA_HORIZON_DAYS);
  return horizonDays;
}

function* generateDates(seg: RuleSegment, horizonDays: number): Generator<string> {
  const start = daysFromYmd(seg.start);
  const end = resolveEnd(seg, horizonDays);
  let emitted = 0;
  const underCap = () => emitted < (seg.count ?? Number.POSITIVE_INFINITY);
  const inBounds = (d: number) => d >= start && d <= end;

  if (seg.frequency === 'DAILY') {
    for (let d = start; inBounds(d) && underCap(); d += seg.interval) {
      emitted++;
      yield ymdFromDays(d);
    }
    return;
  }

  if (seg.frequency === 'WEEKLY') {
    const wdStart = weekdayOfDays(start);
    const monday0 = start - ((wdStart + 6) % 7);
    const slots = seg.byWeekDay && seg.byWeekDay.length
      ? seg.byWeekDay.map(w => WEEKDAY_INDEX[w]).sort((a, b) => a - b)
      : [wdStart];
    for (let k = 0; ; k++) {
      const weekBase = monday0 + k * seg.interval * 7;
      if (weekBase > end + 7) return;
      for (const wd of slots) {
        const d = weekBase + ((wd + 6) % 7); // Monday offset
        if (inBounds(d) && underCap()) {
          emitted++;
          yield ymdFromDays(d);
        }
      }
      if (emitted >= (seg.count ?? Number.POSITIVE_INFINITY)) return;
      if (k > MAX_OCCURRENCES) throw new RuleValidationError(`segment '${seg.id}': expansion exceeds ${MAX_OCCURRENCES} occurrences`);
    }
  }

  // MONTHLY
  const startParts = parseYmd(seg.start);
  const monthStart = startParts.y * 12 + (startParts.m - 1);
  const endParts = parseYmd(ymdFromDays(end));
  for (let k = 0; ; k++) {
    const monthIndex = monthStart + k * seg.interval;
    if (monthIndex > endParts.y * 12 + (endParts.m - 1)) return;
    const y = Math.floor(monthIndex / 12);
    const mo = (monthIndex % 12 + 12) % 12 + 1;
    const days = seg.byMonthDay && seg.byMonthDay.length ? seg.byMonthDay.slice().sort((a, b) => a - b) : [startParts.d];
    for (const dom of days) {
      const d = daysFromYmdSafe(y, mo, dom);
      if (d === null) continue; // e.g. Feb 31
      if (inBounds(d) && underCap()) {
        emitted++;
        yield ymdFromDays(d);
      }
    }
    if (emitted >= (seg.count ?? Number.POSITIVE_INFINITY)) return;
    if (k > MAX_OCCURRENCES) throw new RuleValidationError(`segment '${seg.id}': expansion exceeds ${MAX_OCCURRENCES} occurrences`);
  }
}

function daysFromYmdSafe(y: number, m: number, dom: number): number | null {
  const dt = new Date(Date.UTC(y, m - 1, dom));
  if (dt.getUTCMonth() !== m - 1) return null;
  return Math.floor(dt.getTime() / 86_400_000);
}

// ---------------------------------------------------------------------------
// Expansion + exceptions
// ---------------------------------------------------------------------------

export function validateWindow(from: unknown, to: unknown): {from: string; to: string} {
  if (typeof from !== 'string' || !DATE_RE.test(from)) throw new RuleValidationError('from must be YYYY-MM-DD');
  if (typeof to !== 'string' || !DATE_RE.test(to)) throw new RuleValidationError('to must be YYYY-MM-DD');
  parseYmd(from);
  parseYmd(to);
  if (daysFromYmd(to as string) < daysFromYmd(from as string)) {
    throw new RuleValidationError('window end before start');
  }
  if (daysFromYmd(to as string) - daysFromYmd(from as string) > 366 * 20) {
    throw new RuleValidationError('window exceeds 20 years');
  }
  return {from: from as string, to: to as string};
}

export function expand(docInput: unknown, windowFrom: string, windowTo: string): Expansion {
  const doc = validateDoc(docInput);
  const wFrom = daysFromYmd(windowFrom);
  const wTo = daysFromYmd(windowTo);
  if (wTo < wFrom) throw new RuleValidationError('window end before start');
  const horizon = wTo + EXTRA_HORIZON_DAYS;
  const policy = doc.dstPolicy ?? 'earlier';

  // Raw occurrences keyed by stable key; first segment (document order) wins.
  const raw = new Map<string, Occurrence>();
  const byDate = new Map<string, Occurrence>();
  let total = 0;
  for (const seg of doc.segments) {
    for (const localDate of generateDates(seg, horizon)) {
      total++;
      if (total > MAX_OCCURRENCES) throw new RuleValidationError(`expansion exceeds ${MAX_OCCURRENCES} occurrences`);
      const key = occurrenceKey(seg, localDate);
      if (raw.has(key)) continue;
      const wr = resolveWallTime(doc.timezone, localDate, seg.localTime, policy);
      const occ: Occurrence = {
        key,
        localDate,
        localTime: seg.localTime,
        instant: new Date(wr.instant).toISOString(),
        utcOffsetMinutes: wr.utcOffsetMinutes,
        dstResolution: wr.resolution,
        source: {kind: 'segment', id: seg.id},
      };
      raw.set(key, occ);
      byDate.set(`${seg.id}|${localDate}`, occ);
    }
  }

  // Resolve an exception's target segment on a given date. Exact segment id
  // wins; when the referenced id no longer exists (segment renamed/split) the
  // exception is retargeted onto whatever still generates on that date. A
  // cadence change that no longer lands on the date resolves to nothing, which
  // marks the exception orphaned downstream.
  const findTarget = (ex: ExceptionDef): Occurrence | undefined => {
    if (ex.segmentId) {
      const exact = byDate.get(`${ex.segmentId}|${ex.date}`);
      if (exact) return exact;
      if (doc.segments.some(s => s.id === ex.segmentId)) return undefined; // id exists, just not on that date
    } else {
      for (const seg of doc.segments) {
        const hit = byDate.get(`${seg.id}|${ex.date}`);
        if (hit) return hit;
      }
      return undefined;
    }
    // Referenced segment id is gone: retarget onto any line on the same date.
    for (const occ of raw.values()) {
      if (occ.source.kind === 'segment' && occ.localDate === ex.date) return occ;
    }
    return undefined;
  };

  // Segments a (possibly range) exception applies to: exact id, or every
  // segment when the referenced id was removed by a split/rename.
  const candidateSegments = (ex: ExceptionDef): RuleSegment[] => {
    if (!ex.segmentId) return doc.segments;
    if (doc.segments.some(s => s.id === ex.segmentId)) {
      return doc.segments.filter(s => s.id === ex.segmentId);
    }
    return doc.segments;
  };

  const resolutions = new Map<string, ExceptionResolution>();
  const removedKeys = new Set<string>();

  for (const ex of doc.exceptions) {
    if (ex.kind === 'cancel' || ex.kind === 'replace') {
      const target = findTarget(ex);
      const resolution: ExceptionResolution = {
        exceptionId: ex.id,
        kind: ex.kind,
        resolved: Boolean(target),
        targetDate: ex.date,
        targetKey: target?.key,
        reason: target ? undefined : `no occurrence generated on ${ex.date}${ex.segmentId ? ` by segment '${ex.segmentId}'` : ''}`,
      };
      if (target) removedKeys.add(target.key);

      if (ex.kind === 'replace' && ex.replacement) {
        const key = `occ|exc:replace:${ex.id}`;
        const wr = resolveWallTime(doc.timezone, ex.replacement.localDate, ex.replacement.localTime, policy);
        raw.set(key, {
          key,
          localDate: ex.replacement.localDate,
          localTime: ex.replacement.localTime,
          instant: new Date(wr.instant).toISOString(),
          utcOffsetMinutes: wr.utcOffsetMinutes,
          dstResolution: wr.resolution,
          source: {kind: 'exception', id: ex.id},
        });
        resolution.replacementKey = key;
      }
      resolutions.set(ex.id, resolution);
      continue;
    }

    // cancelRange: cancel every candidate segment occurrence in [date, endDate].
    const rangeStart = daysFromYmd(ex.date);
    const rangeEnd = daysFromYmd(ex.endDate!);
    const allowedIds = new Set(candidateSegments(ex).map(s => s.id));
    let hitCount = 0;
    let firstKey: string | undefined;
    for (const occ of raw.values()) {
      if (removedKeys.has(occ.key) || occ.source.kind !== 'segment') continue;
      if (!allowedIds.has(occ.source.id)) continue;
      const d = daysFromYmd(occ.localDate);
      if (d >= rangeStart && d <= rangeEnd) {
        removedKeys.add(occ.key);
        hitCount++;
        firstKey ??= occ.key;
      }
    }
    resolutions.set(ex.id, {
      exceptionId: ex.id,
      kind: 'cancelRange',
      resolved: hitCount > 0,
      targetDate: ex.date,
      targetKey: firstKey,
      reason: hitCount ? undefined : `no occurrences in range ${ex.date}..${ex.endDate}`,
    });
  }

  const occurrences = new Map<string, Occurrence>();
  for (const [key, occ] of raw) {
    if (!removedKeys.has(key)) occurrences.set(key, occ);
  }

  const windowed = [...occurrences.values()]
    .filter(o => {
      const d = daysFromYmd(o.localDate);
      return d >= wFrom && d <= wTo;
    })
    .sort(compareOccurrences);

  return {doc, occurrences, windowed, resolutions};
}

function compareOccurrences(a: Occurrence, b: Occurrence): number {
  if (a.instant !== b.instant) return a.instant < b.instant ? -1 : 1;
  if (a.localDate !== b.localDate) return a.localDate < b.localDate ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function pushMap<K>(map: Map<K, string[]>, bucket: K, value: string): void {
  const list = map.get(bucket);
  if (list) list.push(value);
  else map.set(bucket, [value]);
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export function diffRevisions(
  oldExpansion: Expansion,
  newExpansion: Expansion,
  windowFrom: string,
  windowTo: string,
): DiffResult {
  // Occurrence diffing is clipped to the requested window; exception
  // resolutions below are still taken from the full expansions.
  const clip = (exp: Expansion) => new Map(exp.windowed.map(o => [o.key, o]));
  const oldWindow = clip(oldExpansion);
  const newWindow = clip(newExpansion);
  const keys = new Set<string>([...oldWindow.keys(), ...newWindow.keys()]);

  // Relink pass: when ONLY localTime changes, the wall-time-aware key differs
  // but the occurrence is the same line (shape + phase survive). Group segment
  // keys by shape+phase, stripping both wall time and ordinal; within a group
  // the localTime multiset must agree except for a single one-to-one rename,
  // otherwise the change is ambiguous and nothing is guessed (those items stay
  // added + removed, matching the "frequency change = delete+add" policy).
  const segmentKey = (key: string) => /^occ\|(DAILY|WEEKLY|MONTHLY)\d/.test(key);
  const groupOf = (key: string) => {
    const head = key.split('@')[0]; // drop '@HH:MM|ordinal[|slot]'
    return head;
  };
  const timeOf = (key: string) => /@(\d{2}:\d{2})/.exec(key)![1];
  const oldGroups = new Map<string, string[]>();
  const newGroups = new Map<string, string[]>();
  for (const k of oldWindow.keys()) {
    if (segmentKey(k)) pushMap(oldGroups, groupOf(k), k);
  }
  for (const k of newWindow.keys()) {
    if (segmentKey(k)) pushMap(newGroups, groupOf(k), k);
  }
  const relinkOld = new Map<string, string>(); // real old key -> real new key
  const relinkNew = new Map<string, string>(); // real new key -> real old key
  for (const [group, oldKeys] of oldGroups) {
    const newKeys = newGroups.get(group) ?? [];
    if (oldKeys.length !== newKeys.length) continue;
    // The unchanged wall times must match key-for-key; only one time may differ.
    const oldByTime = new Map<string, string[]>();
    const newByTime = new Map<string, string[]>();
    for (const k of oldKeys) pushMap(oldByTime, timeOf(k), k);
    for (const k of newKeys) pushMap(newByTime, timeOf(k), k);
    const oldOnlyTimes = [...oldByTime.keys()].filter(t => !newByTime.has(t));
    const newOnlyTimes = [...newByTime.keys()].filter(t => !oldByTime.has(t));
    if (oldOnlyTimes.length !== 1 || newOnlyTimes.length !== 1) continue;
    const oldCandidates = oldByTime.get(oldOnlyTimes[0])!;
    const newCandidates = newByTime.get(newOnlyTimes[0])!;
    // Pair candidates on the same ordinal (and weekday/month slot if present).
    for (const ok of oldCandidates) {
      // Match on ordinal (+ weekday/month slot), i.e. everything after '@HH:MM'.
      const tail = (k: string) => k.slice(k.indexOf('@') + 6);
      const nk = newCandidates.find(c => tail(c) === tail(ok));
      if (nk) {
        relinkOld.set(ok, nk);
        relinkNew.set(nk, ok);
      }
    }
  }

  const items: DiffItem[] = [];
  for (const key of keys) {
    let o = oldWindow.get(key) ?? null;
    let n = newWindow.get(key) ?? null;
    // LocalTime-only rename: fill the counterpart through the relink map.
    // Iterate only on the new-side key so each pair is emitted once.
    if (o && !n && relinkOld.has(key)) continue;
    if (n && !o && relinkNew.has(key)) {
      o = oldWindow.get(relinkNew.get(key)!) ?? null;
    }
    let type: DiffType;
    if (o && n) type = o.instant === n.instant ? 'same' : 'modified';
    else if (n) type = 'added';
    else type = 'removed';
    items.push({key, type, old: o, next: n});
  }
  // Stable order: earliest instant on either side, then key.
  items.sort((a, b) => {
    const ta = a.old?.instant ?? a.next!.instant;
    const tb = b.old?.instant ?? b.next!.instant;
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  const oldDoc = oldExpansion.doc;
  const newDoc = newExpansion.doc;
  const exIds = new Set<string>([...oldDoc.exceptions.map(e => e.id), ...newDoc.exceptions.map(e => e.id)]);
  const exceptions: ExceptionRow[] = [];
  for (const id of [...exIds].sort()) {
    const oldDef = oldDoc.exceptions.find(e => e.id === id);
    const newDef = newDoc.exceptions.find(e => e.id === id);
    const oldRes = oldExpansion.resolutions.get(id) ?? null;
    const newRes = newExpansion.resolutions.get(id) ?? null;
    let status: ExceptionRow['status'];
    if (oldDef && newDef) {
      const defChanged = JSON.stringify(oldDef) !== JSON.stringify(newDef);
      if (oldRes?.resolved && !newRes?.resolved) status = 'orphaned';
      else if (!oldRes?.resolved && !newRes?.resolved) status = 'unresolved-both';
      else if (oldRes?.targetKey !== newRes?.targetKey || defChanged) status = 'retargeted';
      else status = 'unchanged';
    } else if (newDef) {
      status = 'added';
    } else {
      status = 'removed';
    }
    exceptions.push({
      id,
      kind: (newDef ?? oldDef)!.kind,
      presence: oldDef && newDef ? 'both' : oldDef ? 'old-only' : 'new-only',
      old: oldRes,
      next: newRes,
      status,
    });
  }

  const stats: DiffStats = {
    same: items.filter(i => i.type === 'same').length,
    added: items.filter(i => i.type === 'added').length,
    removed: items.filter(i => i.type === 'removed').length,
    modified: items.filter(i => i.type === 'modified').length,
    total: items.length,
    exceptions: exceptions.length,
    orphanedExceptions: exceptions.filter(e => e.status === 'orphaned').length,
  };
  return {items, exceptions, stats};
}
