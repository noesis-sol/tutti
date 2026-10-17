// The program with the darwin-arm64 Claude Code embedded (see ../program.tsx).
import binPath from "@anthropic-ai/claude-agent-sdk-darwin-arm64/claude" with { type: "file" }
import { run } from "../program.tsx"

await run(binPath)
