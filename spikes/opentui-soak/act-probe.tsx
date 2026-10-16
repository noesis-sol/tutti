// testRender's dispose() unmounts the React root from the renderer's "destroy" event, outside
// act(), so React warns on every dispose. This tries the ways around it.
//
//   bun spikes/opentui-soak/act-probe.tsx dispose|act-dispose|act-env-off

import { testRender } from "@opentui/react/test-utils"
import { act } from "react"

const which = process.argv[2] ?? "dispose"
const setup = await testRender(<text>hello</text>, { width: 20, height: 5 })
await setup.flush()
if (which === "act-dispose") {
  await act(async () => {
    await setup.dispose()
  })
} else if (which === "act-env-off") {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
  await setup.dispose()
} else {
  await setup.dispose()
}
console.error(`-- ${which}: done`)
