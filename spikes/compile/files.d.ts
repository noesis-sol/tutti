// The platform packages' `claude`, imported as a file: Bun gives its path (in $bunfs once compiled).
declare module "@anthropic-ai/claude-agent-sdk-*/claude" {
  const path: string
  export default path
}
