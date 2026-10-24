// The OrganCost test layer: the live service, which keeps its total in memory, over the captured
// Log, so a test can read the ORGAN lines. The test layers whose calls cost (Organs, UsageProbe)
// share the one their scenario has, as the run's organs and probe do (main.ts).
import { Effect, Layer, Option } from "effect"
import { OrganCost } from "../organs/OrganCost.ts"
import type { Log } from "../run/log.ts"
import { layer as logLayer } from "./Log.ts"

/** OrganCost, with the captured Log it writes to. */
export const layer = (): Layer.Layer<OrganCost | Log> =>
  OrganCost.layer.pipe(Layer.provideMerge(logLayer()))

/**
 * The OrganCost already in the context the layer is built in, where there is one, or a new one over
 * the Log: a probe's and an organ's costs add up in one total, as a run's do.
 */
export const shared: Layer.Layer<OrganCost, never, Log> = Layer.unwrap(
  Effect.map(
    Effect.serviceOption(OrganCost),
    Option.match({
      onNone: () => OrganCost.layer,
      onSome: (costs) => Layer.succeed(OrganCost, costs),
    }),
  ),
)
