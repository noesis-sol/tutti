// Times as tutti writes them for people, in local time: the log's stamp, the event stream's
// RFC 3339 time, dates, `14:05`, the report's name and span, and a usage limit's reset. A time on
// another day than the one it is read against says its day, as orchestra's ResetLabel does: a
// seven-day limit's reset on Friday, or a five-hour one's after midnight, isn't read as today's.

/** `n` padded with zeros to `width` digits: `05`, `007`. */
export const pad = (n: number, width = 2): string => n.toString().padStart(width, "0")

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const
const months = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const

/** The local date at `millis`: `2026-10-17`. */
export const date = (millis: number): string => {
  const t = new Date(millis)
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
}

/** The local time at `millis` to the minute: `14:05`. */
export const clock = (millis: number): string => {
  const t = new Date(millis)
  return `${pad(t.getHours())}:${pad(t.getMinutes())}`
}

/** The local date and time at `millis` to the minute: `2026-10-17 14:05`. */
export const dateClock = (millis: number): string => `${date(millis)} ${clock(millis)}`

/** Whether `a` and `b` fall on the same local day. */
export const sameDay = (a: number, b: number): boolean => date(a) === date(b)

/** The local UTC offset at `t`: `+02:00`, `-05:00`, `+00:00`. */
const offset = (t: Date): string => {
  const minutes = -t.getTimezoneOffset()
  const sign = minutes < 0 ? "-" : "+"
  return `${sign}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`
}

/**
 * The local time at `millis` as the log dates its lines: `2026-10-17 09:05:03 +02:00`. The offset
 * tells apart the hour the clocks go back over, which comes twice.
 */
export const stamp = (millis: number): string => {
  const t = new Date(millis)
  return `${date(millis)} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())} ${offset(t)}`
}

/**
 * `t` in RFC 3339, in local time, as Go's RFC3339Nano gives it: the fraction of a second without
 * trailing zeros (none when it is 0), and `Z` for UTC.
 */
export const timestamp = (t: Date): string => {
  const ms = t.getMilliseconds()
  const fraction = ms === 0 ? "" : `.${pad(ms, 3).replace(/0+$/, "")}`
  const time = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`
  const zone = t.getTimezoneOffset() === 0 ? "Z" : offset(t)
  return `${date(t.getTime())}T${time}${fraction}${zone}`
}

/**
 * When a run started at `millis`, as its events' `run`, its lock's `started` and its store's: RFC
 * 3339 in local time, as each event's `time` is, so the two compare as strings.
 */
export const runStarted = (millis: number): string => timestamp(new Date(millis))

/**
 * When `at` is, read on the day of `now`: `14:05` that day, and with its weekday and date on
 * another, `Fri Oct 23 14:05`, as a usage limit's reset is shown.
 */
export const resetLabel = (at: number, now: number): string => {
  if (sameDay(at, now)) return clock(at)
  const t = new Date(at)
  return `${weekdays[t.getDay()]} ${months[t.getMonth()]} ${t.getDate()} ${clock(at)}`
}

/** `at` read after `from`: `01:40` on its day, `2026-10-18 01:40` on a later or earlier one. */
export const clockFrom = (at: number, from: number): string =>
  sameDay(at, from) ? clock(at) : dateClock(at)

/** The local span from `start` to `end`: `2026-10-17 09:05–10:30`, `2026-10-17 23:10–2026-10-18 01:40`. */
export const span = (start: number, end: number): string =>
  `${dateClock(start)}–${clockFrom(end, start)}`

/** The report's file name for a run started at `started`: `2026-10-17-090503.md`, local time. */
export const reportName = (started: number): string => {
  const t = new Date(started)
  return `${date(started)}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}.md`
}
