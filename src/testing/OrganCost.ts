// The OrganCost test layer: the live service, which keeps its total in memory, over the captured
// Log, so a test can read the ORGAN lines.
import { Layer } from "effect"
import { OrganCost } from "../organs/OrganCost.ts"
import type { Log } from "../run/log.ts"
import { layer as logLayer } from "./Log.ts"

/** OrganCost, with the captured Log it writes to. */
export const layer = (): Layer.Layer<OrganCost | Log> =>
  OrganCost.layer.pipe(Layer.provideMerge(logLayer()))
