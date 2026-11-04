const offsetFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Prague",
  timeZoneName: "longOffset",
});

function pragueOffset(utcMs: number) {
  const name = offsetFormat.formatToParts(utcMs).find((part) => part.type === "timeZoneName")?.value;
  return !name || name === "GMT" ? "+00:00" : name.slice(3);
}

function offsetMinutes(offset: string) {
  const sign = offset.startsWith("-") ? -1 : 1;
  const [hours = 0, minutes = 0] = offset.slice(1).split(":").map(Number);
  return sign * (hours * 60 + minutes);
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Today's date in Prague as `YYYY-MM-DD`. */
export function pragueToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(now);
}

/**
 * Parse an IS date like "Po 2. 11. 2026 08:25" or "1. 11. 2026" (weekday optional).
 * Returns an ISO datetime with the Europe/Prague offset, or a plain `YYYY-MM-DD` when IS gives no time.
 */
export function parseIsDate(text: string) {
  const match = /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(text);
  if (!match) return null;
  const [, day, month, year, hour, minute] = match.map(Number) as number[];
  if (match[4] === undefined) return `${year}-${pad(month!)}-${pad(day!)}`;
  return pragueIso(year!, month!, day!, hour!, minute!);
}

/**
 * Parse a date from the mail list: "dnes 9:15", "včera 18:02", or "Po 3. 11." without a year, which is taken
 * as the latest such date that isn't in the future. Returns null for anything else.
 */
export function parseMailDate(text: string, now = new Date()) {
  const [year, month, day] = pragueToday(now).split("-").map(Number) as [number, number, number];
  const relative = /^(dnes|včera)\s+(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (relative) {
    // Date.UTC rolls day 0 back into the previous month, and the previous year in January.
    const date = new Date(Date.UTC(year, month - 1, day - (relative[1] === "včera" ? 1 : 0)));
    return pragueIso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), Number(relative[2]), Number(relative[3]));
  }
  const withYear = parseIsDate(text);
  if (withYear) return withYear;
  const dayMonth = /(\d{1,2})\.\s*(\d{1,2})\.\s*$/.exec(text);
  if (!dayMonth) return null;
  const [, d, m] = dayMonth.map(Number) as [number, number, number];
  const isFuture = m > month || (m === month && d > day);
  return `${isFuture ? year - 1 : year}-${pad(m)}-${pad(d)}`;
}

/** Add the Europe/Prague offset to a local ISO time like "2026-09-11T17:03:41" (as the File Manager API gives). */
export function parseLocalIso(text: string | null) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(text ?? "");
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number) as number[];
  return pragueIso(year!, month!, day!, hour!, minute!);
}

function pragueIso(year: number, month: number, day: number, hour: number, minute: number) {
  // Two passes settle the offset across DST changes.
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = pragueOffset(guess - offsetMinutes(pragueOffset(guess)) * 60_000);
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}${offset}`;
}
