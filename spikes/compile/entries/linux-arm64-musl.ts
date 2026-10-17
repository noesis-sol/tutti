// The program with the linux-arm64-musl Claude Code embedded (see ../program.tsx).
import binPath from "@anthropic-ai/claude-agent-sdk-linux-arm64-musl/claude" with { type: "file" }
import { run } from "../program.tsx"

// OpenTUI doesn't detect musl: it loads its glibc library unless OPENTUI_LIBC says otherwise.
// program.tsx imports OpenTUI only once a step needs it, after this line.
process.env.OPENTUI_LIBC ??= "musl"

await run(binPath)
