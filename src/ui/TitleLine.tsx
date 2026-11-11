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
import { marks, separator } from "../text/marks.ts"
import { firstFitting } from "./fit.ts"
import { cut, Line, type Segment, type Segments, seg, separatorOf, widthOf } from "./line.tsx"
import { badgeGap, fieldGap, whereGap } from "./spacing.ts"
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
 * `BLOCKED`, `USAGE_LIMIT · resets 14:05`, and `· in 1h12m` after a hold the run waits for;
 * `PRESSURE · rising in 3m` for a hold waiting out its time, without its time once it is due; a
 * reset on another day than `now`'s with its weekday and date, `resets Fri Oct 23 14:05`. In a
 * narrow pane the usage is `usage 85% · resets 14:05` or `usage 85%`, and a hold its word.
 */
const bannerText = (
  banner: Exclude<Banner, { readonly _tag: "Windows" }>,
  now: number,
  form: Form,
): string => {
  const resets =
    banner.resetsAt === null ? "" : `${separator}resets ${resetLabel(banner.resetsAt, now)}`
  if (banner._tag === "Usage") {
    const percent = `usage ${Math.round(banner.utilization * 100)}%`
    if (form === "short") return percent
    if (form === "reset") return `${percent}${resets}`
    const of = banner.limit === undefined ? "" : ` of the ${banner.limit} limit`
    const overage = banner.overage === true ? `${separator}overage` : ""
    return `${percent}${of}${resets}${overage}`
  }
  if (form === "word") return banner.word
  if (banner.rising === true) {
    return banner.resetsAt !== null && banner.resetsAt > now
      ? `${banner.word}${separator}rising in ${countdown(banner.resetsAt, now)}`
      : banner.word
  }
  const left =
    banner.waiting === true && banner.resetsAt !== null && banner.resetsAt > now
      ? `${separator}in ${countdown(banner.resetsAt, now)}`
      : ""
  return `${banner.word}${resets}${left}`
}

/** How many cells a window's gauge has. */
const gaugeCells = 8

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

/** `━───────` for 17%: a cell for each eighth, to the nearest. */
export const gauge = (utilization: number): string => {
  const filled = Math.round(Math.min(1, utilization) * gaugeCells)
  return marks.gaugeFull.repeat(filled) + marks.gaugeEmpty.repeat(gaugeCells - filled)
}

/**
 * The account's windows at `now`, `quiet`: `Current usage ━───────  17% · This week 41%` in full,
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
          seg(fieldGap),
          seg(percent(first), quiet),
        ]
      : [seg(figure(first), quiet)]
  return [
    ...head,
    ...rest.flatMap((window) => [separatorOf(theme, quiet), seg(figure(window), quiet)]),
  ]
}

/**
 * A banner in its style: the usage `notice`, bold once the limit is reached, as the usage limit's
 * hold is; the account's windows `quiet`, a grey a step above faint; a hold waiting out its time,
 * what held the run passed (`PRESSURE · rising in 3m`), `notice`; any other hold, such as
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
        : banner.rising === true
          ? styles.deferred
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
  if (title.version !== "") left.push(seg(badgeGap), seg(title.version, styles.dim))
  if (badges?.keepAwake === true) left.push(seg(badgeGap), seg(" keep awake ", styles.keepAwake))
  if (badges !== null && badges.autoAnswer !== null) {
    left.push(seg(badgeGap), seg(` ${badges.autoAnswer} `, styles.autoAnswer))
  }
  // The notes after the pill and badges, each a badgeGap and the separator in.
  const note = `${badgeGap}${separator}`
  if (title.quitting !== null) left.push(seg(`${note}${title.quitting}`, styles.stop))
  else if (title.stopping) left.push(seg(`${note}stopping`, styles.stop))
  if (title.solo !== null) {
    left.push(
      title.solo.running
        ? seg(`${note}solo ${title.solo.ticket} running`, styles.picked)
        : seg(`${note}solo ${title.solo.ticket} next`, styles.deferred),
    )
  }
  if (title.shared > 0) {
    left.push(
      seg(
        `${note}shared with ${title.shared} run${title.shared === 1 ? "" : "s"}`,
        styles.deferred,
      ),
    )
  }
  const scoped =
    title.spec != null
      ? `${separator}spec ${title.spec}`
      : title.scope === null
        ? ""
        : `${separator}ticket ${title.scope}`
  // `began` is 0 until the run's first real view: no time since 1970 before it (tutti-0t8p).
  const time = runTime(title.began === 0 ? 0 : now - title.began)
  const where = `${title.branch === "" ? "" : `${title.branch}${separator}`}${time}${scoped}`
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
      .flatMap((segments, i) => (i === 0 ? segments : [seg(fieldGap), ...segments]))
  // With banners on the right the line ends a column short of the pane's edge, as the load line
  // under it starts a column in from its left (tutti-3j79).
  const inner = width - 1
  /** `head` and `side`, the banners, pushed to the right, or null if they don't fit. */
  const laid = (head: Segments, side: Segments): Segments | null => {
    if (side.length === 0) return widthOf(head) <= width ? head : null
    const gap = inner - widthOf(head) - widthOf(side)
    return gap >= fieldGap.length ? [...head, seg(" ".repeat(gap)), ...side] : null
  }
  const full = right("full", "full")
  const room =
    (full.length === 0 ? width : inner - widthOf(full) - fieldGap.length) -
    widthOf(left) -
    whereGap.length
  if (badges !== null) {
    yield room >= widthOf([seg(where)])
      ? laid([...left, seg(whereGap), seg(where, styles.dim)], full)
      : null
    return
  }
  if (room >= minWhere)
    yield laid([...left, seg(whereGap), ...cut([seg(where, styles.dim)], room)], full)
  for (const usageForm of ["full", "reset", "short", null] as const) {
    yield laid(left, right(usageForm, "full"))
  }
  if (holds.length === 0) {
    yield cut(left, width)
    return
  }
  for (const holdForm of ["full", "word"] as const) {
    const side = right(null, holdForm)
    const states = inner - widthOf(side) - fieldGap.length
    if (states >= widthOf(left.slice(0, 1))) {
      yield laid(cut(left, states), side) ?? []
      return
    }
  }
  yield cut([...left.slice(0, 1), seg(fieldGap), ...right(null, "word")], inner)
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
