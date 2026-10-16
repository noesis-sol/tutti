// A minimal MCP server over stdio for spike.ts: answers initialize and tools/list (no tools), and
// ignores everything else. Enough for Claude Code to report it as connected.

const reply = (id: unknown, result: unknown) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)

let buffer = ""
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString()
  for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
    const line = buffer.slice(0, i).trim()
    buffer = buffer.slice(i + 1)
    if (line === "") continue
    const message = JSON.parse(line) as { id?: unknown; method?: string; params?: unknown }
    if (message.id === undefined) continue
    if (message.method === "initialize") {
      const params = message.params as { protocolVersion?: string } | undefined
      reply(message.id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "spike-passed-stdio", version: "0.0.0" },
      })
    } else if (message.method === "tools/list") {
      reply(message.id, { tools: [] })
    } else {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no" } })}\n`,
      )
    }
  }
})
