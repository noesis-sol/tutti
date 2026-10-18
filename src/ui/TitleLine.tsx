// The dashboard's title line (§ 7.2, § 7.11), under a blank line: the tutti pill, the version, and
// whether the run is stopping or has a solo ticket running or next; then, faint, the branch, the
// run's time and a scoped run's ticket; and on the right tutti's banners, the usage and the holds.
// The states come first, so a narrow pane cuts the branch and the time, then drops them.
import { runTime } from "../print/summary.ts"
import { type Banner, clock, countdown, type TitleView } from "../run/runView.ts"
import { cut, Line, type Segment, type Segments, seg, widthOf } from "./line.tsx"
import type { Theme } from "./theme.ts"
import { useNow, useRunView, useTheme } from "./useRunView.ts"

/** The narrowest the branch and the time are shown, cut. */
const minWhere = 8

/**
 * A banner's words at `now`: `usage 85% of the five-hour limit · resets 14:05 · overage`,
 * `BLOCKED`, `USAGE_LIMIT · resets 14:05`, and `· in 1h12m` after a hold the run waits for.
 */
const bannerText = (banner: Banner, now: number): string => {
  const resets = banner.resetsAt === null ? "" : ` · resets ${clock(banner.resetsAt)}`
  if (banner._tag === "Usage") {
    const of = banner.limit === undefined ? "" : ` of the ${banner.limit} limit`
    const overage = banner.overage === true ? " · overage" : ""
    return `usage ${Math.round(banner.utilization * 100)}%${of}${resets}${overage}`
  }
  const left =
    banner.waiting === true && banner.resetsAt !== null && banner.resetsAt > now
      ? ` · in ${countdown(banner.resetsAt, now)}`
      : ""
  return `${banner.word}${resets}${left}`
}

/**
 * A banner in its style: the usage `notice`, bold once the limit is reached, as the usage limit's
 * hold is; any other hold, such as `BLOCKED`, `needsYou` bold.
 */
const bannerSegment = (banner: Banner, theme: Theme, now: number) => {
  const { styles } = theme
  const style =
    banner._tag === "Usage"
      ? banner.utilization >= 1
        ? styles.testing
        : styles.deferred
      : banner.word === "USAGE_LIMIT"
        ? styles.testing
        : styles.stop
  return seg(bannerText(banner, now), style)
}

/** The title line's segments `width` columns wide, the run's time taken at `now`. */
export const titleSegments = (
  title: TitleView,
  banners: ReadonlyArray<Banner>,
  now: number,
  theme: Theme,
  width: number,
): Segments => {
  const { styles } = theme
  const left: Array<Segment> = [seg(" tutti ", styles.title)]
  if (title.version !== "") left.push(seg(" "), seg(title.version, styles.dim))
  if (title.stopping) left.push(seg("  · stopping", styles.stop))
  if (title.solo !== null) {
    left.push(
      title.solo.running
        ? seg(`  · solo ${title.solo.ticket} running`, styles.picked)
        : seg(`  · solo ${title.solo.ticket} next`, styles.deferred),
    )
  }
  const scoped = title.scope === null ? "" : ` · ticket ${title.scope}`
  const where = `${title.branch === "" ? "" : `${title.branch} · `}${runTime(now - title.began)}${scoped}`
  const right: Segments = banners.flatMap((banner, i) =>
    i === 0 ? [bannerSegment(banner, theme, now)] : [seg("  "), bannerSegment(banner, theme, now)],
  )
  const rightWidth = right.length === 0 ? 0 : widthOf(right) + 2
  const room = width - widthOf(left) - 3 - rightWidth
  const head: Segments =
    room >= minWhere ? [...left, seg("   "), ...cut([seg(where, styles.dim)], room)] : left
  const gap = width - widthOf(head) - widthOf(right)
  if (right.length === 0) return cut(head, width)
  if (gap >= 2) return [...head, seg(" ".repeat(gap)), ...right]
  return cut([...head, seg("  "), ...right], width)
}

/** The title line, a blank line above it. */
export const TitleLine = ({ width }: { readonly width: number }) => {
  const view = useRunView()
  const theme = useTheme()
  const now = useNow()
  return (
    <box flexDirection="column" height={2} flexShrink={0}>
      <Line segments={[]} />
      <Line segments={titleSegments(view.title, view.banners, now, theme, width)} />
    </box>
  )
}
