// Timezone helpers built on Intl (full ICU in Node/browsers), no external tz deps.
// Offsets are milliseconds that must be *added* to UTC to get wall-clock time.

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(zone, fmt);
  }
  return fmt;
}

export type WallParts = { year: number; month: number; day: number; hour: number; minute: number };

export function wallPartsAt(zone: string, instantMs: number): WallParts {
  const parts = formatter(zone).formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return {year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute')};
}

/** Offset of `zone` at the given instant: wallTime = utc + offset. */
export function zoneOffsetMs(zone: string, instantMs: number): number {
  const w = wallPartsAt(zone, instantMs);
  const wallUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, 0);
  return wallUtc - instantMs;
}

export type GapPolicy = 'shiftForward' | 'shiftBack';
export type OverlapPolicy = 'earlier' | 'later';
export type WallResolution = {ts: number; mode: 'normal' | 'gap' | 'overlap'};

function sameWall(zone: string, ts: number, y: number, mo: number, d: number, h: number, mi: number) {
  const w = wallPartsAt(zone, ts);
  return w.year === y && w.month === mo && w.day === d && w.hour === h && w.minute === mi;
}

/**
 * Resolve a wall-clock time in `zone` to an instant.
 * DST gaps are skipped forward/back per `gap`; ambiguous overlap times pick
 * the earlier/later instant per `overlap`.
 */
export function wallToInstant(
  zone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  gap: GapPolicy,
  overlap: OverlapPolicy,
): WallResolution {
  const labelUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Two-pass fixed point for plain offset changes.
  const o1 = zoneOffsetMs(zone, labelUtc);
  let ts = labelUtc - o1;
  const o2 = zoneOffsetMs(zone, ts);
  if (o2 !== o1) ts = labelUtc - o2;

  const oBefore = zoneOffsetMs(zone, labelUtc - 12 * 3600_000);
  const oAfter = zoneOffsetMs(zone, labelUtc + 12 * 3600_000);
  if (oBefore === oAfter) return {ts, mode: 'normal'};

  const cBefore = labelUtc - oBefore;
  const cAfter = labelUtc - oAfter;
  const beforeOk = sameWall(zone, cBefore, year, month, day, hour, minute);
  const afterOk = sameWall(zone, cAfter, year, month, day, hour, minute);

  if (beforeOk && afterOk) {
    const earlier = Math.min(cBefore, cAfter);
    const later = Math.max(cBefore, cAfter);
    return {ts: overlap === 'later' ? later : earlier, mode: 'overlap'};
  }
  if (!beforeOk && !afterOk) {
    // Nonexistent local time (spring-forward gap).
    const earlier = Math.min(cBefore, cAfter);
    const later = Math.max(cBefore, cAfter);
    return {ts: gap === 'shiftBack' ? earlier : later, mode: 'gap'};
  }
  // Exactly one candidate renders the requested wall time: unambiguous.
  return {ts: beforeOk ? cBefore : cAfter, mode: 'normal'};
}

// ---- Plain local calendar dates (YYYY-MM-DD), no zone attached ----

export function dayKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseDay(key: string): [number, number, number] {
  const [y, m, d] = key.split('-').map(Number);
  return [y, m, d];
}

export function addDays(key: string, days: number): string {
  const [y, m, d] = parseDay(key);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dayKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function diffDays(a: string, b: string): number {
  const [ay, am, ad] = parseDay(a);
  const [by, bm, bd] = parseDay(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400_000);
}

/** Wall calendar date observed in `zone` at an instant. */
export function zoneDayAt(zone: string, instantMs: number): string {
  const w = wallPartsAt(zone, instantMs);
  return dayKey(w.year, w.month, w.day);
}

export function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
