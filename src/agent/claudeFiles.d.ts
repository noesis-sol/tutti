// The SDK's files that claudeBinary.ts and the compiled builds' entries import, which its package
// doesn't export to TypeScript: its package.json (Bun resolves it all the same), and each platform
// package's `claude`, imported as a file (Bun gives its path, in $bunfs once compiled).
declare module "@anthropic-ai/claude-agent-sdk/package.json" {
  /** The Claude Code the SDK's platform packages carry. */
  export const claudeCodeVersion: string
  const pkg: { readonly version: string; readonly claudeCodeVersion: string }
  export default pkg
}

declare module "@anthropic-ai/claude-agent-sdk-*/claude" {
  const path: string
  export default path
}
