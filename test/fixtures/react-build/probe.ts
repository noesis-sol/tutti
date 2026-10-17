// Prints which build of React and its reconciler this process loaded, for test/react-build.test.ts:
//
//   bun test/fixtures/react-build/probe.ts
//
// Prints {"reconciler":"production"|"development","react":"production"|"development"}. It works
// in a compiled binary too, where there is no require.cache to look in: the development reconciler
// is the one whose code records performance.measure() (Performance Tracks), and only React's
// development build has act.
const createReconciler: unknown = require("react-reconciler")
const react: { readonly act?: unknown } = require("react")

const build = (development: boolean) => (development ? "development" : "production")

console.log(
  JSON.stringify({
    reconciler: build(String(createReconciler).includes("performance.measure")),
    react: build(react.act !== undefined),
  }),
)
