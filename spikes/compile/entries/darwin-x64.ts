// The program with the darwin-x64 Claude Code embedded (see ../program.tsx).
import binPath from "@anthropic-ai/claude-agent-sdk-darwin-x64/claude" with { type: "file" }
import { run } from "../program.tsx"

await run(binPath)
