// The start question's spec side for tests: a repository nobody reads and no URL fetched, for those
// that don't choose a spec, and the spec field's actions doing nothing, for its commands.
import { Effect } from "effect"
import type { SpecAsk } from "../src/ui/questions.ts"
import type { SpecFieldActions } from "../src/ui/SpecField.tsx"

export const noSpecAsk: SpecAsk = {
  where: { repo: "/nowhere/tutti-test-repo", home: "" },
  checkUrl: () => Effect.succeed("this test fetches nothing"),
}

/** The spec field's actions, doing nothing; `now` says whether it browses, fetches or has a URL. */
export const fieldActions = (
  now: { readonly browsing?: boolean; readonly fetching?: boolean; readonly url?: boolean } = {},
): SpecFieldActions => {
  const nothing = () => {}
  return {
    browsingNow: () => now.browsing ?? false,
    fetchingNow: () => now.fetching ?? false,
    urlNow: () => now.url ?? false,
    listedNow: () => false,
    complete: nothing,
    step: nothing,
    take: nothing,
    browse: nothing,
    submit: nothing,
    stopFetch: nothing,
    browser: {
      move: nothing,
      up: nothing,
      enter: nothing,
      press: nothing,
      scroll: nothing,
      close: nothing,
    },
    leave: nothing,
  }
}
