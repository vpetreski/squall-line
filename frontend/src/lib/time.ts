/** Times are shown in the origin's time zone (the zone the departure was given in), checkpoint-local on demand. */

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${zone}|${JSON.stringify(options)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", ...options });
    cache.set(key, f);
  }
  return f;
}

function parts(date: Date, zone: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of formatter(zone, options).formatToParts(date)) out[p.type] = p.value;
  return out;
}

const asDate = (when: string | Date | number): Date => (when instanceof Date ? when : new Date(when));

/** "Wed 04 Nov 14:05" */
export function dayTime(when: string | Date | number, zone: string): string {
  const p = parts(asDate(when), zone, {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${p.weekday} ${p.day} ${p.month} ${p.hour}:${p.minute}`;
}

/** "Wed 14:05" */
export function weekdayClock(when: string | Date | number, zone: string): string {
  const p = parts(asDate(when), zone, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return `${p.weekday} ${p.hour}:${p.minute}`;
}

/** "14:05" */
export function clock(when: string | Date | number, zone: string): string {
  const p = parts(asDate(when), zone, { hour: "2-digit", minute: "2-digit" });
  return `${p.hour}:${p.minute}`;
}

/** "CST", or "GMT-5" where the locale has no abbreviation. */
export function zoneName(when: string | Date | number, zone: string): string {
  return parts(asDate(when), zone, { timeZoneName: "short" }).timeZoneName ?? zone;
}

/** "26 h 24 m", "45 m" */
export function duration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} m`;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")} m`;
}

const WALL: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
};

/** An instant as wall time in `zone`, in the format of an `<input type="datetime-local">` ("2026-11-04T08:00"). */
export function wallTime(when: string | Date | number, zone: string): string {
  const p = parts(asDate(when), zone, WALL);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** The next quarter hour, at least a minute away, as wall time in `zone`. */
export function nextQuarterHour(zone: string, now: Date = new Date()): string {
  return wallTime(Math.ceil((now.getTime() + 60_000) / 900_000) * 900_000, zone);
}

/** Minutes east of UTC that `zone` is at `instant`. */
export function offsetMinutes(instant: number, zone: string): number {
  const p = parts(new Date(instant), zone, { ...WALL, second: "2-digit" });
  const wall = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return Math.round((wall - Math.floor(instant / 1000) * 1000) / 60_000);
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Wall time in `zone` as an ISO time with its offset: "2026-11-04T08:00" in America/Chicago is
 * "2026-11-04T08:00-06:00". On the night of a clock change, a wall time that is skipped or repeated gets one of
 * the two offsets in force that night.
 */
export function withOffset(local: string, zone: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.slice(0, 16));
  if (!m) throw new RangeError(`Not a wall time: ${local}`);
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let offset = offsetMinutes(wall, zone);
  offset = offsetMinutes(wall - offset * 60_000, zone);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${local.slice(0, 16)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export const browserZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
