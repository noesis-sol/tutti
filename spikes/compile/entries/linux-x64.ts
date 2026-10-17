// The program with the linux-x64 Claude Code embedded (see ../program.tsx).
import binPath from "@anthropic-ai/claude-agent-sdk-linux-x64/claude" with { type: "file" }
import { run } from "../program.tsx"

await run(binPath)
