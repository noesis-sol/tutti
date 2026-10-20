// The npm package's bundle (§ 12 npm): scripts/build-npm.sh builds it from here. It runs on every
// platform bunx does, so it detects musl before anything loads OpenTUI; the SDK's Claude Code is
// its platform package's, which the SDK finds itself.
import "./native/detectMusl.ts"
import { main } from "./main.ts"

main()
