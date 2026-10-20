# tutti

Runs Claude Code workers on a Beads backlog, one git worktree per ticket.

## Install

The recommended install is a release archive: one binary, with its Claude Code embedded, from the
repository's GitHub Releases.

### npm, for development and agents

```sh
bunx @noesis-sol/tutti --version
```

The npm package `@noesis-sol/tutti` is not the recommended install. It is there for development
and for agents that run tutti through `bunx`. It needs Bun 1.3.14 or later on `PATH`, and installs
Claude Code and OpenTUI's native library for its platform from npm. Its `tutti` is a shell launcher
that runs the bundled tutti with Bun, reading neither the `.env` files nor a `bunfig.toml` of the
folder it runs in, so a project's `ANTHROPIC_API_KEY` in `.env` doesn't reach tutti or its workers.

On Alpine and other musl systems the dashboard needs `OPENTUI_LIBC=musl` set: OpenTUI loads its
glibc library otherwise.
