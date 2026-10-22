// The npm package's bundle (§ 12 npm): scripts/build-npm.sh builds it from here. It runs on every
// platform bunx does, so it detects musl before anything loads OpenTUI; the SDK's Claude Code is
// its platform package's, which the SDK finds itself. It marks tutti as the npm package, which
// tutti update leaves to the package manager, and whose runs don't check for a newer release.
import "./native/detectMusl.ts"
import { markNpmBundle } from "./cli/version.ts"
import { main } from "./main.ts"

markNpmBundle()
main()
