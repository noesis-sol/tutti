// The dashboard's title line (§ 7.2, § 7.11), under a blank line: the tutti pill, the version, the
// ` keep awake ` badge while the keep-awake command holds the machine awake, the ` auto-answer ` pill with
// --auto-answer, and whether the run is quitting (what it waits for) or stopping, or has a solo ticket running or next,
// and how many other runs share the machine; then, faint, the branch, the run's time and a scoped run's ticket; and on the right tutti's
// banners, the usage (or, short of a limit, the account's windows) and the holds. A narrow pane
// drops the keep-awake badge first, then the auto-answer pill, then the branch and the time, then shortens the usage, and keeps the holds'
// words longest.
import { Duration } from "effect"
import { formatDuration } from "../project/configFile.ts"
import { resetLabel } from "../run/localTime.ts"
import { type Banner, countdown, type TitleView, type UsageWindow } from "../run/runView.ts"
import { firstFitting } from "./fit.ts"
import { cut, Line, type Segment, type Segments, seg, widthOf } from "./line.tsx"
import { marks } from "./marks.ts"
import type { Theme } from "./theme.ts"
import { useNow, useRunViewPart, useTheme } from "./useRunView.ts"

/** The run's time to the second, on the title line and in the summary: `2m5s`, `45s`, `1h12m`. */
export const runTime = (millis: number): string => {
  const seconds = Math.floor(Math.max(0, millis) / 1000)
  return seconds === 0 ? "0s" : formatDuration(Duration.seconds(seconds))
}

/** The narrowest the branch and the time are shown, cut. */
const minWhere = 8

/**
 * How much of a banner shows: the usage `full`, with only its `reset`, or `short`, its percentage
 * alone; a hold `full`, or its `word` alone.
 */
type Form = "full" | "reset" | "short" | "word"

/**
 * A banner's words at `now`: `usage 85% of the five-hour limit · resets 14:05 · overage`,
 * `BLOCKED`, `USAGE_LIMIT · resets 14:05`, and `· in 1h12m` after a hold the run waits for; a
 * reset on another day than `now`'s with its weekday and date, `resets Fri Oct 23 14:05`. In a
 * narrow pane the usage is `usage 85% · resets 14:05` or `usage 85%`, and a hold its word.
 */
const bannerText = (
  banner: Exclude<Banner, { readonly _tag: "Windows" }>,
  now: number,
  form: Form,
): string => {
  const resets = banner.resetsAt === null ? "" : ` · resets ${resetLabel(banner.resetsAt, now)}`
  if (banner._tag === "Usage") {
    const percent = `usage ${Math.round(banner.utilization * 100)}%`
    if (form === "short") return percent
    if (form === "reset") return `${percent}${resets}`
    const of = banner.limit === undefined ? "" : ` of the ${banner.limit} limit`
    const overage = banner.overage === true ? " · overage" : ""
    return `${percent}${of}${resets}${overage}`
  }
  if (form === "word") return banner.word
  const left =
    banner.waiting === true && banner.resetsAt !== null && banner.resetsAt > now
      ? ` · in ${countdown(banner.resetsAt, now)}`
      : ""
  return `${banner.word}${resets}${left}`
}

/** How many cells a window's gauge has. */
const gaugeCells = 10

/**
 * A window's name as the title line says it, in Claude Desktop's words: `Current usage` for
 * `five_hour`, `This week` for `seven_day`, and a model's weekly window with the model's name,
 * `This week (Opus)` for `seven_day_opus`. Any other name is the SDK's, its underscores spaces.
 */
export const windowLabel = (name: string): string => {
  if (name === "five_hour") return "Current usage"
  if (name === "seven_day") return "This week"
  const model = /^seven_day_(.+)$/.exec(name)?.[1]
  if (model !== undefined) {
    return `This week (${model.charAt(0).toUpperCase()}${model.slice(1).replaceAll("_", " ")})`
  }
  return name.replaceAll("_", " ")
}

/** `━━────────` for 17%: a cell for each tenth, to the nearest. */
export const gauge = (utilization: number): string => {
  const filled = Math.round(Math.min(1, utilization) * gaugeCells)
  return marks.gaugeFull.repeat(filled) + marks.gaugeEmpty.repeat(gaugeCells - filled)
}

/**
 * The account's windows at `now`, `quiet`: `Current usage ━━────────  17% · This week 41%` in full,
 * the first with its gauge, two spaces before its figure; in a narrow pane the tighter window first
 * and no gauge, `This week 41% · Current usage 17%`, then the tighter alone. A window whose reset
 * has passed is left out: its figure is gone with it, until an event gives the next.
 */
const windowSegments = (
  all: ReadonlyArray<UsageWindow>,
  theme: Theme,
  now: number,
  form: Form,
): Segments => {
  const { quiet } = theme.styles
  const current = all.filter((window) => window.resetsAt === null || window.resetsAt > now)
  const percent = (window: UsageWindow) => `${Math.round(window.utilization * 100)}%`
  const figure = (window: UsageWindow) => `${windowLabel(window.name)} ${percent(window)}`
  const [first, ...rest] =
    form === "full"
      ? current
      : [...current]
          .sort((a, b) => b.utilization - a.utilization)
          .slice(0, form === "short" ? 1 : undefined)
  if (first === undefined) return []
  const head =
    form === "full"
      ? [
          seg(`${windowLabel(first.name)} `, quiet),
          seg(gauge(first.utilization), quiet),
          seg("  "),
          seg(percent(first), quiet),
        ]
      : [seg(figure(first), quiet)]
  return [...head, ...rest.flatMap((window) => [seg(" · ", quiet), seg(figure(window), quiet)])]
}

/**
 * A banner in its style: the usage `notice`, bold once the limit is reached, as the usage limit's
 * hold is; the account's windows `quiet`, a grey a step above faint; any other hold, such as
 * `BLOCKED`, `needsYou` bold.
 */
const bannerSegments = (banner: Banner, theme: Theme, now: number, form: Form): Segments => {
  if (banner._tag === "Windows") return windowSegments(banner.windows, theme, now, form)
  const { styles } = theme
  const style =
    banner._tag === "Usage"
      ? banner.utilization >= 1
        ? styles.testing
        : styles.deferred
      : banner.word === "USAGE_LIMIT"
        ? styles.testing
        : styles.stop
  return [seg(bannerText(banner, now, form), style)]
}

/**
 * The title line's segments `width` columns wide, the run's time taken at `now`. A pane too narrow
 * for all of it gives up the least needed first: the keep-awake badge, then the auto-answer pill; then
 * the branch and the time,
 * cut then dropped; then the usage banner, shortened then dropped; then the states, cut from their
 * end; then what the holds say beyond their words. A hold's word is cut only where the pill and the
 * words alone are wider.
 */
export const titleSegments = (
  title: TitleView,
  banners: ReadonlyArray<Banner>,
  now: number,
  theme: Theme,
  width: number,
): Segments => {
  // The badges say nothing that changes during the run, so they give way first: each is shown only
  // where the whole line fits with it, nothing cut or shortened. The auto-answer pill, which says
  // that tutti answers for you, outlasts the keep-awake badge.
  const autoAnswer = title.autoAnswer
  const forms = function* () {
    if (title.keepAwake || autoAnswer !== null) {
      yield* titleForms(title, banners, now, theme, width, {
        keepAwake: title.keepAwake,
        autoAnswer,
      })
    }
    if (title.keepAwake && autoAnswer !== null) {
      yield* titleForms(title, banners, now, theme, width, { keepAwake: false, autoAnswer })
    }
    yield* titleForms(title, banners, now, theme, width, null)
  }
  return firstFitting(forms(), (line) => line !== null) ?? []
}

/**
 * The title line's forms `width` columns wide, fullest first, null for one that doesn't fit; the
 * last always does. With `badges`, those it gives after the version, the ` keep awake ` badge and
 * the ` auto-answer ` pill, and only the whole line.
 */
function* titleForms(
  title: TitleView,
  banners: ReadonlyArray<Banner>,
  now: number,
  theme: Theme,
  width: number,
  badges: { readonly keepAwake: boolean; readonly autoAnswer: string | null } | null,
): Generator<Segments | null> {
  const { styles } = theme
  const left: Array<Segment> = [seg(" Tutti ", styles.title)]
  if (title.version !== "") left.push(seg(" "), seg(title.version, styles.dim))
  if (badges?.keepAwake === true) left.push(seg(" "), seg(" keep awake ", styles.keepAwake))
  if (badges !== null && badges.autoAnswer !== null) {
    left.push(seg(" "), seg(` ${badges.autoAnswer} `, styles.autoAnswer))
  }
  if (title.quitting !== null) left.push(seg(`  · ${title.quitting}`, styles.stop))
  else if (title.stopping) left.push(seg("  · stopping", styles.stop))
  if (title.solo !== null) {
    left.push(
      title.solo.running
        ? seg(`  · solo ${title.solo.ticket} running`, styles.picked)
        : seg(`  · solo ${title.solo.ticket} next`, styles.deferred),
    )
  }
  if (title.shared > 0) {
    left.push(
      seg(`  · shared with ${title.shared} run${title.shared === 1 ? "" : "s"}`, styles.deferred),
    )
  }
  const scoped =
    title.spec != null
      ? ` · spec ${title.spec}`
      : title.scope === null
        ? ""
        : ` · ticket ${title.scope}`
  const where = `${title.branch === "" ? "" : `${title.branch} · `}${runTime(now - title.began)}${scoped}`
  const usage = banners.filter((banner) => banner._tag !== "Hold")
  const holds = banners.filter((banner) => banner._tag === "Hold")
  /**
   * The banners on the right, the usage (or the windows) in `usageForm` or left out, the holds in
   * `holdForm`.
   */
  const right = (usageForm: Form | null, holdForm: Form): Segments =>
    [
      ...(usageForm === null
        ? []
        : usage.map((banner) => bannerSegments(banner, theme, now, usageForm))),
      ...holds.map((banner) => bannerSegments(banner, theme, now, holdForm)),
    ]
      .filter((segments) => segments.length > 0)
      .flatMap((segments, i) => (i === 0 ? segments : [seg("  "), ...segments]))
  /** `head` and `side`, the banners, pushed to the right edge, or null if they don't fit. */
  const laid = (head: Segments, side: Segments): Segments | null => {
    if (side.length === 0) return widthOf(head) <= width ? head : null
    const gap = width - widthOf(head) - widthOf(side)
    return gap >= 2 ? [...head, seg(" ".repeat(gap)), ...side] : null
  }
  const full = right("full", "full")
  const room = width - widthOf(left) - 3 - (full.length === 0 ? 0 : widthOf(full) + 2)
  if (badges !== null) {
    yield room >= widthOf([seg(where)])
      ? laid([...left, seg("   "), seg(where, styles.dim)], full)
      : null
    return
  }
  if (room >= minWhere)
    yield laid([...left, seg("   "), ...cut([seg(where, styles.dim)], room)], full)
  for (const usageForm of ["full", "reset", "short", null] as const) {
    yield laid(left, right(usageForm, "full"))
  }
  if (holds.length === 0) {
    yield cut(left, width)
    return
  }
  for (const holdForm of ["full", "word"] as const) {
    const side = right(null, holdForm)
    const states = width - widthOf(side) - 2
    if (states >= widthOf(left.slice(0, 1))) {
      yield laid(cut(left, states), side) ?? []
      return
    }
  }
  yield cut([...left.slice(0, 1), seg("  "), ...right(null, "word")], width)
}

/** The title line, a blank line above it. */
export const TitleLine = ({ width }: { readonly width: number }) => {
  const title = useRunViewPart((view) => view.title)
  const banners = useRunViewPart((view) => view.banners)
  const theme = useTheme()
  const now = useNow()
  return (
    <box flexDirection="column" height={2} flexShrink={0}>
      <Line segments={[]} />
      <Line segments={titleSegments(title, banners, now, theme, width)} />
    </box>
  )
}
