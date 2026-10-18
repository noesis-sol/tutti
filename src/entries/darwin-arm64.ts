// tutti compiled for bun-darwin-arm64 (§ 12): its `bun build --compile` starts here. It embeds
// that platform's Claude Code, which src/agent/claudeBinary.ts extracts and sessions run.
import claude from "@anthropic-ai/claude-agent-sdk-darwin-arm64/claude" with { type: "file" }
import { embed } from "../agent/claudeBinary.ts"
import { main } from "../main.ts"

embed(claude, "darwin-arm64")
main()
