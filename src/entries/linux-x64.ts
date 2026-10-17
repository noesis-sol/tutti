// tutti compiled for bun-linux-x64 (§ 12): its `bun build --compile` starts here. It embeds
// that platform's Claude Code, which src/agent/claudeBinary.ts extracts and sessions run.
import claude from "@anthropic-ai/claude-agent-sdk-linux-x64/claude" with { type: "file" }
import { embed } from "../agent/claudeBinary.ts"
import { main } from "../main.ts"

embed(claude)
main()
