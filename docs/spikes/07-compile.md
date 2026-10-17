# Spike 07: the compiled binary, with Claude Code embedded

Ticket tutti-nrg.1.7, M0 spike (8) (spec § 14), for § 12 (builds, embedding Claude Code,
`--claude`) and § 4.13 (`tutti login`).

- **Code:** `spikes/compile/`.
  - `program.tsx` is the program that gets compiled. Its steps are `extract`, `version`, `auth`,
    `probe`, `turn`, `frame`, `tty-frame`, `login` and `all`, and each prints `RESULT <step> {...}`.
  - `entries/<target>.ts` imports one platform's `claude` as a file and passes its path to
    `program.tsx`.
  - `build.ts` compiles an entry: `bun spikes/compile/build.ts [--out <dir>] <target>... | host`.
    It runs `bun build --compile` in a temp folder of its own and reports the size, the time, the
    native packages embedded and what the compile left in its working folder.
  - `in-container.sh` installs another platform's packages, builds and runs, inside a Linux
    container with everything in a tmpfs (its header gives the `docker run` line).
- **Build command,** as `build.ts` runs it:
  `bun build --compile --target=bun-<target> --define process.env.NODE_ENV:"production" --no-compile-autoload-dotenv --no-compile-autoload-bunfig entries/<target>.ts --outfile <out>`.
- **Versions:** Bun 1.4.3, `@anthropic-ai/claude-agent-sdk` 0.3.301 with Claude Code 2.1.301,
  `@opentui/core` 0.6.6. macOS 26 arm64; Docker Desktop 29.6.2 (Linux x64 under Rosetta),
  2026-10-17.

## Summary

| Item | Result |
|---|---|
| The SDK README's recipe (`import … with { type: "file" }`, `extractFromBunfs`, `pathToClaudeCodeExecutable`) | **Works** on every platform built. One real `query()` turn ran on macOS arm64 (`PONG`, Claude Code 2.1.301 in `system/init`); the no-message probe ran on all six targets |
| Binary size | **337 MB** (darwin-arm64) to **379 MB** (linux-x64), about 250–268 MB of it Claude Code (§ 1) |
| Extraction | `/tmp/claude-<uid>/claude-agent-sdk-<hash>/` on macOS and `os.tmpdir()`'s equivalent on Linux. **1.8 s** the first time on macOS arm64, then **130–160 ms on every start**, because it reads and hashes the whole 250 MB each time. Nothing removes old versions (§ 2) |
| OpenTUI's native library | **Embedded by OpenTUI's own imports**: every installed `@opentui/core-<platform>` package goes in. Bun writes the one in use to `$TMPDIR/.bun-<uid>-<hash>.dylib` (or `.so`) and `dlopen`s it. One frame rendered on every target, in a test renderer and, on macOS, in a real terminal (§ 3) |
| musl | **Works, with one step OpenTUI doesn't take for itself:** it loads the glibc library unless `OPENTUI_LIBC=musl` is set, and on x64 Alpine that fails (§ 3.2) |
| Cross-compiling | **Works** both ways tried: linux-x64 built on macOS, and darwin-x64 built on Linux (which runs here under Rosetta). `bun install --os --cpu` is a better install than the README's `npm install --force` (§ 4) |
| `tutti login` | **`<extracted claude> auth login`**, run with the terminal inherited (§ 5) |
| `--claude`'s supported range | **The SDK enforces none.** The SDK names the Claude Code it ships with (2.1.301), and each Claude Code release lists the SDK versions it was tested with. Recommended: warn below 2.1.301, and above it once a release no longer lists the SDK (§ 6) |
| Defaults of a compiled binary | It **loads `.env` and `bunfig.toml` (with its `preload` code) from the folder it runs in**, unless built with `--no-compile-autoload-*`. `--compile` doesn't set `NODE_ENV` despite its help text (§ 7) |

## 1. Size

Built with `build.ts` (sizes in MB, 10⁶ bytes):

| Target | Built on | Binary | Claude Code in it | Ran on |
|---|---|---|---|---|
| darwin-arm64 | macOS arm64 | **337.4** | 250.5 | this Mac: every step, `turn` and `tty-frame` included |
| darwin-x64 | Linux arm64 (container) | **353.2** | 260.4 | this Mac under Rosetta (`arch -x86_64`) |
| linux-arm64 | Linux arm64 (container) | **376.8** | 267.2 | `oven/bun:1.4.3` (Debian) |
| linux-x64 | **macOS arm64** | **378.8** | 268.0 | `oven/bun:1.4.3`, amd64 under Rosetta |
| linux-arm64-musl | Linux arm64 (container) | **361.4** | 259.4 | `oven/bun:1.4.3-alpine` |
| linux-x64-musl | Linux x64 (container, Rosetta) | **366.0** | 261.6 | `oven/bun:1.4.3-alpine`; `alpine:3.24` with `libstdc++ libgcc` |

The rest of each binary is Bun's runtime for the target (70.5 MB on darwin-arm64), about 4.4–5.3 MB
per embedded OpenTUI library, and about 12 MB of bundled JavaScript and assets. Compressed, the
release archive will be smaller. The SDK's own `manifest.zst.json` puts the zstd-compressed Claude
Code at 84 MB for darwin-arm64, against 250 MB raw. Compiles take 1–2 s, or 7–10 s the first time
for a cross target, while Bun downloads that target's runtime.

A linux-x64 build from a tree with four OpenTUI packages installed (two darwin, two linux) embedded
all four. `@opentui/core` picks its library with a literal dynamic `import()` per platform, and Bun
bundles every one it can resolve. Install only the target's packages (§ 4), or a binary carries other
platforms' libraries too.

## 2. Extraction

`extractFromBunfs` (from `@anthropic-ai/claude-agent-sdk/extract`) reads the embedded file and
takes the first 16 hex digits of its sha256. It writes the file to
`<tmp>/claude-<uid>/claude-agent-sdk-<hash>/<name>`, mode 755. It first checks that
`<tmp>/claude-<uid>` is a directory the user owns, and tightens it to 0700. `<tmp>` is `/tmp` on
macOS (not `$TMPDIR`) and `os.tmpdir()` elsewhere, and `CLAUDE_CODE_TMPDIR` overrides it. The
hash is the platform's checksum in the SDK's `manifest.json` (`1f04c69e1c24e4d0` for darwin-arm64).
The write goes to a temp name and is renamed into place, so concurrent starts are safe. When the
file already exists, it is used as it is.

| Platform | First start (writes 250–268 MB) | Every later start |
|---|---|---|
| macOS arm64 (APFS) | 1.8 s | 130–160 ms |
| Linux arm64, tmpfs | 0.26–0.44 s | 150–210 ms |
| Linux x64 under Rosetta, tmpfs | 1.2–1.6 s | 1.0–1.1 s |
| macOS x64 under Rosetta | 1.6 s | 0.9 s |

- **The later starts still cost the hash.** `extractFromBunfs` reads and hashes the whole embedded
  file on every call, even when the extracted file is already there. tutti can call it once per run
  (not per worker), and off the startup path.
- **The name keeps Bun's hash.** Bun names the embedded file `claude-<hash>.`, ending in a dot,
  since `claude` has no extension. The SDK decides how to spawn by the extension and spawns this
  one directly, which works.
- **The first exec of a new binary is slow on macOS.** The first `--version` of a freshly built
  binary took 2.3 s on arm64 (the system's first-launch check) and 32 s under Rosetta (translation),
  then 10 ms and 26 ms after that. A first `tutti` run after an update pays this once.
- **Nothing removes old extractions.** Each Claude Code version leaves 250–268 MB under
  `/tmp/claude-<uid>/`. macOS cleans `/tmp` at reboot, but a Linux machine without a tmpfs `/tmp`
  never does. tutti should remove other `claude-agent-sdk-*` folders of its own there (tutti-nrg.63).
- **The extracted file can be swapped.** Once extracted, the file is trusted on its name alone, and
  the folder is the user's own. Only the user could swap it, so this is no new exposure.

## 3. OpenTUI's native library

### 3.1 Embedding

Nothing beyond the SDK recipe was needed. `@opentui/core`'s Bun build resolves its library with
`await import("@opentui/core-<platform>-<arch>")`, and each platform package's `index.bun.js` does
`import("./libopentui.dylib", { with: { type: "file" } })`, so `bun build --compile` embeds it. At
`dlopen`, Bun writes the embedded library out to `$TMPDIR/.bun-<uid>-<hash>.dylib` (`/tmp` in the
containers). The name is content-addressed, and the file stays after the process ends, so a second
run reuses it.

| Step | Result, every target |
|---|---|
| `frame`: `createTestRenderer` from `@opentui/core/testing` and `@opentui/react`'s `createRoot`, one `renderOnce()`, `captureCharFrame()` | the bordered box and its text, 60×5. `NODE_ENV` is `production` inside the binary (the `--define`) |
| `tty-frame` (macOS arm64, in a pseudo-terminal from `script`): `createCliRenderer`, render, wait 500 ms, `destroy()` | the box drawn at the terminal's width, then a clean exit (744 ms) |

The library was loaded in 34–220 ms (`loadMs`).

### 3.2 musl

OpenTUI chooses `@opentui/core-linux-<arch>-musl` only when `OPENTUI_LIBC=musl` is set: it doesn't
detect musl. Without the variable, a musl binary loads the glibc library:

- on **x64 Alpine** that fails: `Failed to open library "/tmp/.bun-0-….so": Error loading shared
  library ld-linux-x86-64.so.2`;
- on arm64 Alpine (`oven/bun:1.4.3-alpine`) the glibc library happened to load and render. That is
  not something to rely on.

So `entries/linux-*-musl.ts` sets `process.env.OPENTUI_LIBC ??= "musl"` before OpenTUI's module is
evaluated, and the musl library then loads on both architectures. In tutti, the musl build's entry
must do the same in a module evaluated before any OpenTUI import. The variable is inherited by
workers, which is harmless.

A bare `alpine:latest` also needs `apk add libstdc++ libgcc` for Bun's musl runtime itself
(`Error relocating …: __cxa_bad_typeid: symbol not found` without them). Claude Code's musl binary
needed nothing more for `--version` and the probe. So OpenTUI's musl artifact does prove out
(§ 12's condition), with these two notes.

## 4. Cross-compiling

`bun build --compile --target=bun-<other>` needs the target's packages present in `node_modules`:
`@anthropic-ai/claude-agent-sdk-<target>` (for the `claude` import, or the build fails to
resolve it) and `@opentui/core-<target>` (or the binary builds but fails at render). Both declare
`os` and `cpu`, so a normal install skips them. Two ways were tried:

| Install | Result |
|---|---|
| `npm install @anthropic-ai/claude-agent-sdk-linux-x64@0.3.301 @opentui/core-linux-x64@0.6.6 --force --no-save`, in a tree `bun install` made (§ 12's way) | **Works** (40 s, mostly the 268 MB download). It adds the two packages and leaves the rest, with no `package-lock.json`. But **a second such install removes the first one's packages**: npm prunes what isn't in `package.json`. Name every package in one command. The versions must be given by hand, and npm doesn't check them against `bun.lock` |
| `bun install --frozen-lockfile --os=linux --cpu=arm64` | **Works** (about 55 s), and the better way. It installs that platform's glibc and musl packages from `bun.lock`, with its integrity hashes, in place of the host's, and leaves `bun.lock` unchanged. `--os=darwin --cpu=x64` installs only `darwin-x64` |

Results:

- **linux-x64 built on macOS arm64** ran in a linux/amd64 container.
- **darwin-x64 built in a Linux container** ran here under Rosetta. `codesign -dv` shows an
  ad-hoc signature (`Identifier=bun`), so Bun signs a Mach-O even when it builds it on Linux.
- Bun downloads the target's runtime on the first cross build; no setup is needed.
- **Not checked: darwin-arm64 built on Linux.** Apple Silicon refuses unsigned or badly signed
  code, so this matters if the release workflow builds every target on one Linux runner. The run was
  cut short by the machine's full disk, then by Docker hanging. Until it is checked, build darwin
  targets on a macOS runner (tutti-nrg.62).

`bun build --compile` left a 70 MB `.<hash>-00000000.bun-build` in its working folder on every
build, byte-identical to the `bun` executable (tutti-nrg.21). `build.ts` builds in a temp folder
and removes it.

## 5. `tutti login`

The embedded Claude Code has an `auth` command:

```
claude auth login [--claudeai | --console] [--email <email>] [--sso]   # --claudeai is the default
claude auth status [--json | --text]                                    # --json is the default
claude auth logout
```

**`tutti login` runs `<extracted claude> auth login`** with stdin, stdout and stderr inherited
(`program.tsx`'s `login` step). Run in a terminal in a linux-x64 container (`docker run -t`, so the
machine's own login wasn't touched), it printed `Opening browser to sign in…`, then `If the
browser didn't open, visit: https://claude.com/cai/oauth/authorize?…`, then `Paste code here if
prompted >`, and waited. `claude /login` is the same login from inside an interactive session.
`--console` logs in to the Anthropic Console for API billing; `tutti login` needn't offer it,
given § 15.2.

`claude auth status --json` gives `{ loggedIn, authMethod, apiProvider, subscriptionType, … }`,
with the email and organisation, and exits 1 when logged out (`loggedIn: false`,
`authMethod: "none"`). The probe (§ 4.13) tells the same apart: logged out,
`initializationResult().account` had no email and no `subscriptionType`, only
`apiProvider: "firstParty"`.

## 6. `--claude`: the supported range

The SDK checks no version: `pathToClaudeCodeExecutable` runs whatever it is given. What it states:

- `package.json` has `"claudeCodeVersion": "2.1.301"`, the Claude Code its platform packages carry.
  The SDK sets `CLAUDE_AGENT_SDK_VERSION=0.3.301` in the child's environment.
- Each Claude Code release's `manifest.json` has `sdkCompat.testedWrapperVersions`, the SDK
  versions that Claude Code was tested with: up to 30 recent ones before it. Claude Code 2.1.302
  lists 0.3.269 to 0.3.301 (30 versions), 2.1.301 lists 0.3.267 to 0.3.285 (19), and 2.1.285
  lists 0.3.245 to 0.3.282 (30).
  So a newer Claude Code is tested with older SDKs, never the reverse.
- `sdk.d.ts` names minimum Claude Code versions for some features: 2.1.248, 2.1.261
  (`pluginDelivery: "initialize"`) and 2.1.268 (`pending_permission_requests` in the initialize
  response, which § 4.8 relies on).
- Claude Code can refuse to start a session with `cli_version_too_old` (an
  `SDKStartupFailureReason`) when it is below a minimum that Anthropic sets.

**Recommended range for tutti's warning:** from `claudeCodeVersion` (2.1.301), read from the SDK's
`package.json` at build time, up to the last Claude Code release whose manifest lists the SDK's
version. The upper end can't be known when tutti is built. A practical rule: warn when the version
is below `claudeCodeVersion`, or more than about 30 patch releases above it. `--claude
~/.local/bin/claude` (2.1.302) ran `--version` and the probe correctly through the compiled binary.

## 7. A compiled binary's defaults

Checked with a five-line program compiled three ways and run in a folder holding a `.env`
(`SPIKE_FOO=from-dotenv`) and a `bunfig.toml` with `preload = ["./pre.ts"]`:

| Built with | `.env` read | `bunfig.toml`'s preload run | `process.env.NODE_ENV` | Minified |
|---|---|---|---|---|
| `--compile` | **yes** | **yes** | `development` | no |
| `--compile --define process.env.NODE_ENV:"production"` | **yes** | **yes** | `production` | no |
| `--compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig` | no | no | `development` | no |

- **Autoload.** By default, a compiled tutti would read the `.env` of whatever project it runs in,
  so an `ANTHROPIC_API_KEY` there would reach tutti and its workers (§ 4.13's billing). It would also
  run any `preload` script a `bunfig.toml` there names. tutti must be built with
  `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`, which § 12 doesn't say
  (tutti-nrg.58). `tsconfig.json` autoload is off by default.
- **`NODE_ENV`.** `bun build --help` says `--compile` "Implies --production", but the binary
  neither sets `NODE_ENV` nor minifies. § 3.1's `--define` remains what selects React's production
  build. It works: the `frame` step reports `production`.
- **A full disk** shows up from a darwin target only as `Error writing standalone module graph: Io`.
  From a Linux target it is `ENOSPC`. A build needs room for the output and the 70 MB
  `.bun-build`.

## 8. For the spec and the M8 tickets

No step of § 12's recipe failed. The follow-up tickets:

- tutti-nrg.58: § 12 should list `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`
  among the build flags (§ 7).
- tutti-nrg.59: § 12's musl clause. The musl build sets `OPENTUI_LIBC=musl` before OpenTUI loads,
  and needs `libstdc++` and `libgcc` installed (§ 3.2).
- tutti-nrg.60: § 12's cross-compile install should be `bun install --frozen-lockfile --os --cpu`
  in place of `npm install --force`, one platform per build (§ 4).
- tutti-nrg.61: § 4.13's "M0 confirms the exact command" is `claude auth login` (§ 5), and § 12's
  supported range should be as § 6 recommends.
- tutti-nrg.62: check that darwin-arm64 built on Linux runs, before tutti-nrg.10.2 relies on it
  (§ 4).
- tutti-nrg.63 (after tutti-nrg.10.1): call `extractFromBunfs` once per run, and remove stale
  `claude-agent-sdk-*` extractions (§ 2).
