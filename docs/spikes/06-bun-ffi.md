# Spike 06: `flock`, `O_CLOEXEC`, `openat` and SIGUSR1 in Bun

Ticket tutti-nrg.1.6, M0 spike (7) (spec § 14), for § 9.1 (the symlink guard), § 9.2 (the run
lock) and § 7.4 (signals).

- **Script:** `spikes/bun-ffi/spike.ts`, with `libc.ts` (the bindings), `holder.ts` (takes the
  lock in a child), `sig-child.ts` (reports signals), `fds.ts` (lists what a child inherited) and
  `helper.c` (for the `cc` comparison). Run it with
  `bun spikes/bun-ffi/spike.ts constants|flags|lock|openat|cc|signals|all [--compiled]`.
  `--compiled` builds the children with `bun build --compile` first and runs those, as tutti
  will ship. Each check prints `PASS`, `FAIL` or `INFO`; the script exits 1 on any `FAIL`.
- **Linux** was run in Docker, with the worktree mounted read-only:
  `docker run --rm --platform linux/arm64 -v "$PWD":/src:ro -w /src oven/bun:1.4.3 bun spikes/bun-ffi/spike.ts all`.
- **Versions:** Bun 1.4.3, `effect` and `@effect/platform-bun` 4.0.5, 2026-10-16.

| Platform | Where | Result |
|---|---|---|
| macOS 26.6.2 arm64 | this machine, from source and `--compiled` | all checks pass |
| Linux arm64, glibc | `oven/bun:1.4.3` (Debian), Docker Desktop 29.6.2, kernel 6.12.76-linuxkit; from source and `--compiled` | all checks pass |
| Linux arm64, musl | `oven/bun:1.4.3-alpine` | all checks pass |
| Linux x86_64, glibc | `oven/bun:1.4.3` with `--platform linux/amd64`, **under Rosetta** (`VirtualApple` CPU) | all checks pass; `openat2` is `ENOSYS` under Rosetta (§ 2.4) |
| Linux x86_64, native | not available | the constants come from the kernel headers and matched `node:fs`'s under Rosetta |
| macOS x86_64 | not available | darwin's constants and symbols are the same on both architectures; only the variadic fix (§ 2.2) is arm64's |

## Summary

| Item | Result |
|---|---|
| `flock(LOCK_EX\|LOCK_NB)` through `bun:ffi` | **Works** on macOS and Linux. A second process gets `EWOULDBLOCK` (35 on darwin, 11 on Linux) |
| `kill -9` of the holder | **Releases the lock**, on every platform |
| A child spawned by `Bun.spawn`, `node:child_process` or `effect/process` `ChildProcess` | **Doesn't inherit the descriptor**, and doesn't keep the lock after the holder's `kill -9` |
| The open flags Bun uses | **`O_CLOEXEC` on every open**: `fs.openSync`, `fs/promises`' `open`, `createWriteStream`. strace on Linux: `openat(AT_FDCWD, p, O_RDWR\|O_CREAT\|O_APPEND\|O_LARGEFILE\|O_CLOEXEC, 0666)` for `"a+"` |
| Bun's spawners and descriptors without `FD_CLOEXEC` | **Closed in the child anyway.** Only a plain fork and exec (libc `system()`, the control) passes one on, and that child then keeps the lock |
| `openat` with `O_NOFOLLOW` per component, through `bun:ffi` | **Works.** A symlink as the last component: `ELOOP`; as any earlier component: `ENOTDIR`; on both systems |
| `bun:ffi` or a native helper | **`bun:ffi`** (`dlopen` of libc). The one trap: on darwin arm64 the variadic `mode` of `open`/`openat` needs five (or six) padding arguments, or it is garbage (§ 2.2) |
| SIGUSR1 to a `process.on` handler | **Delivered**, on macOS and Linux, from source and compiled. Bun doesn't take it for an inspector. The SIGUSR2 fallback isn't needed (it works too) |
| SIGTSTP with a handler | **Ignored**: the handler runs and the process isn't stopped. Without a handler it is stopped |
| darwin and Linux differences | The libc path, the errno function, and most `O_*` and `E*` values. Linux's `O_NOFOLLOW` and `O_DIRECTORY` also **differ between x86_64 and arm64** (§ 4) |

## 1. The run lock: `flock` and `O_CLOEXEC`

### 1.1 `flock` across processes

`bun spikes/bun-ffi/spike.ts lock` starts `holder.ts`, which opens `tutti.lock` with libc
`open(O_RDWR|O_CREAT|O_CLOEXEC, 0644)` and takes `flock(fd, LOCK_EX|LOCK_NB)`. Then:

| Step | Result, every platform |
|---|---|
| The holder takes the lock | `held fd=4 fdflags=cloexec` |
| A second process tries | refused: `flock` returns -1 with `EWOULDBLOCK` |
| `kill -9` of the holder, then a second process tries | held |

`flock` itself isn't variadic and has the same name and `LOCK_*` values everywhere (`LOCK_EX` 2,
`LOCK_NB` 4, `LOCK_UN` 8). Bun has no `flock` of its own: `node:fs` and the `Bun` global have
nothing with "lock" in its name.

### 1.2 Whether children inherit it

For each way of opening the file, the holder takes the lock, spawns `sleep 300` with each
spawner, prints the child's PID, and is then killed with `kill -9`. A fresh process then tries
the lock while the `sleep` is still alive. Same result on macOS, Linux arm64 (glibc and musl),
Linux x86_64 under Rosetta, and with compiled children on macOS and Linux arm64:

| Open | `Bun.spawn` | `node:child_process` | `effect/process` (detached) | libc `system()` |
|---|---|---|---|---|
| libc `open` with `O_CLOEXEC` | free | free | free | free |
| libc `open` **without** `O_CLOEXEC` | free | free | free | **still held** |
| `fs.openSync(p, "a+")` | free | free | free | free |

`effect/process` under Bun is `@effect/platform-bun`'s `BunChildProcessSpawner`, which is
`@effect/platform-node-shared`'s `NodeChildProcessSpawner`, so it is `node:child_process.spawn` in
Bun's implementation underneath.

`bun spikes/bun-ffi/spike.ts flags` checks the same thing from inside the child: `fds.ts`
compares each of its descriptors 3 to 1023 with the file by device and inode. With one descriptor
on the file opened with `O_CLOEXEC` and one without, a child of `Bun.spawn`,
`node:child_process.spawn` or `effect/process` (attached or detached) has **neither**. Its only
descriptors above 2 are Bun's own (3 on macOS; 3 and 4 on Linux arm64).

So Bun's spawners close every descriptor except stdio in the child, whatever its flags. The
libc `system()` control shows the test would catch a leak: there, the descriptor without
`O_CLOEXEC` goes to the shell and on to `sleep`, which keeps the lock after the holder's
`kill -9`. A plain fork and exec is what a native addon, or a library calling `posix_spawn`
through FFI, would do. `O_CLOEXEC` remains what makes the lock safe against those, as § 9.2 has
it.

### 1.3 The flags Bun itself uses

`fcntl(F_GETFD)` and `fcntl(F_GETFL)` on files Bun opened (`flags` scenario):

| Opened with | `FD_CLOEXEC` | `F_GETFL`, darwin | `F_GETFL`, Linux arm64 | `F_GETFL`, Linux x86_64 |
|---|---|---|---|---|
| `fs.openSync(p, "r")` | set | `0x0` | `0x20000` | `0x8000` |
| `fs.openSync(p, "w")` | set | `0x10001` | `0x20001` | `0x8001` |
| `fs.openSync(p, "a+")` | set | `0xa` | `0x20402` | `0x8402` |
| `fs.openSync(p, O_RDWR\|O_CREAT)` | set | `0x2` | `0x20002` | `0x8002` |
| `fs/promises` `open(p, "a+")` | set | `0xa` | `0x20402` | `0x8402` |
| `fs.createWriteStream(p)` | set | `0x1` | `0x20001` | `0x8001` |
| libc `open(O_RDWR)` (the control) | **not set** | `0x2` | `0x20002` | `0x8002` |

`0x20000` (arm64) and `0x8000` (x86_64) are `O_LARGEFILE`, which the Linux kernel adds for 64-bit
processes. darwin's `0x10000` is not an open flag but a kernel-private status bit. `F_GETFL` doesn't report
`O_CLOEXEC`; `F_GETFD` does.

strace (Linux arm64, `strace -f -e trace=openat`) shows that Bun passes `O_CLOEXEC` to the
`openat` call itself rather than setting it afterwards with `fcntl`, so there is no window in
which a fork could inherit it:

```
openat(AT_FDCWD, "/tmp/x", O_RDONLY|O_LARGEFILE|O_CLOEXEC) = 5
openat(AT_FDCWD, "/tmp/x", O_WRONLY|O_CREAT|O_TRUNC|O_LARGEFILE|O_CLOEXEC, 0666) = 6
openat(AT_FDCWD, "/tmp/x", O_RDWR|O_CREAT|O_APPEND|O_LARGEFILE|O_CLOEXEC, 0666) = 7
openat(AT_FDCWD, "/tmp/y", O_RDWR|O_CREAT|O_LARGEFILE|O_CLOEXEC, 0666) = 8
```

On macOS, `dtruss` needs SIP turned off, so only `fcntl` was checked there: `FD_CLOEXEC` is set
on every open.

Bun's own descriptors (event loop and the like) are `FD_CLOEXEC` on macOS (fd 3) and on Linux
arm64 (3 and 4). Under Rosetta on x86_64, fds 3 to 8 were not; that is likely Rosetta's doing, and
it doesn't matter to children of Bun's spawners, which close them.

### 1.4 Recommendation for the run lock

Either open works. The simplest is `fs.openSync(lockPath, "a+", 0o644)` (or `"r+"` after creating
it), which gets `O_CLOEXEC` from Bun on both systems and avoids the variadic `open` (§ 2.2), then
`flock` through `bun:ffi` on that descriptor, and `ftruncateSync`/`writeSync` for the JSON. A
test asserts `FD_CLOEXEC` with `fcntl(F_GETFD)`, so a Bun upgrade that dropped it would fail the
check. Calling libc `open` with an explicit `O_CLOEXEC` works as well, if the binding handles § 2.2.

## 2. The symlink guard: `openat` with `O_NOFOLLOW`

### 2.1 Per-component `openat`

`openBeneath(rootFd, relative, flags, mode)` in `spikes/bun-ffi/libc.ts`:

1. refuses an absolute path and any empty, `.` or `..` component before calling anything;
2. opens each directory component with `openat(dir, part, O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)`,
   closing the previous one;
3. opens the last component with `openat(dir, name, flags|O_NOFOLLOW|O_CLOEXEC, mode)`.

The worktree's root is opened with `open(root, O_RDONLY|O_DIRECTORY|O_CLOEXEC)`: the root itself
may be reached through a symlink, only what lies below it is guarded. Each step holds the
directory open, so swapping a folder for a link between steps doesn't help an attacker.

Results (`openat` scenario), identical on macOS and all three Linux runs:

| Path under the root | What it is | Result |
|---|---|---|
| `.tutti/run/check.log` | plain | opened, written, `FD_CLOEXEC` set |
| `.tutti/run/out-file` | the last component is a link to a file outside | `ELOOP` |
| `.tutti/run/out-dir/secret` | a middle component is a link to a folder outside | `ENOTDIR` |
| `.tutti/linked-run/check.log` | a middle component is a link inside the tree | `ENOTDIR` |
| `linked-tutti/run/check.log` | the first component is a link | `ENOTDIR` |
| `.tutti/run/../run/check.log` | a `..` component | refused before any call |
| `/etc/passwd` | absolute | refused before any call |
| `.tutti/run/attention/req-1.json`, `O_CREAT\|O_EXCL`, mode 0600 | new | created, mode 600 |
| the same again | exists | `EEXIST` |

A link mid-path gives `ENOTDIR`, not `ELOOP`, on both systems: `O_DIRECTORY|O_NOFOLLOW` on a
symlink fails the directory test first. tutti's error should name the component that failed
either way (the binding knows which `openat` it was on).

Nothing outside the root was touched.

### 2.2 The variadic `mode` on darwin arm64

`open` and `openat` are variadic: `int openat(int, const char *, int, ...)`. `bun:ffi` has no
variadic calls, so the mode is declared as a fourth fixed argument. On Linux (x86_64 and arm64),
variadic integers travel in the same registers as fixed ones and that works (so they do on darwin
x86_64, by the System V ABI, though no Intel Mac was available to run it).
**On darwin arm64, Apple's ABI puts variadic arguments on the stack**, so `openat` reads the mode
from whatever is there:

```
INFO openat declared without padding, mode 0600 asked five times: got 140, 140, 140, 140, 140   (darwin arm64)
PASS openat declared without padding, mode 0600 asked five times: got 600, 600, 600, 600, 600   (Linux)
```

The fix, used by `libc.ts`: on darwin arm64, declare five `i64` padding arguments after `flags`
(six after `open`'s `flags`) so that they fill registers x3 to x7, and pass the mode as the ninth
argument, which the ABI puts in the first stack slot, where `va_arg` reads it. Created files then
get the mode asked for (`600` above). `fcntl` is also variadic, but `F_GETFD`, `F_GETFL` and
`F_SETFD` are fine: the first two take no third argument, and only `F_SETFD`, which tutti doesn't
need, does.

### 2.3 `bun:ffi` or a native helper

| Option | Finding |
|---|---|
| `bun:ffi` `dlopen` of libc | Works on all five runs, from source and compiled. One code path, no build step. Needs the constant table (§ 4) and the darwin arm64 padding (§ 2.2) |
| `bun:ffi` `cc` (TinyCC compiling `helper.c` at run time) | Gets the variadic call right on macOS (`600, 600, 600`), but **fails on Linux**: `tcc: error: library 'c' not found` in both the Debian and Alpine images, which have no libc development files. It needs a C toolchain's files on the user's machine |
| A prebuilt native helper (a small C library or executable per target) | Not built: it would need compiling, signing and embedding for four targets, for four calls `bun:ffi` makes directly |

**Recommendation: `bun:ffi`.** Settle § 9.1's "through `bun:ffi` or a small native helper" as
`bun:ffi`.

### 2.4 Kernel alternatives, for the record

Each system also has a one-call way to refuse links, checked by the spike but not recommended
over the per-component walk, which is the same code on both systems:

| Call | Plain path | Link inside the tree | Link out of the tree | `..` out |
|---|---|---|---|---|
| darwin `open(path, O_NOFOLLOW_ANY)` (`0x20000000`) | opened | `ELOOP` | — | — |
| darwin `openat(root, path, O_RESOLVE_BENEATH)` (`0x1000`) | opened | **opened** | `ENOTCAPABLE` (107) | `ENOTCAPABLE` |
| Linux `openat2(root, path, RESOLVE_NO_SYMLINKS\|RESOLVE_BENEATH)` via `syscall(437, …)` | opened | `ELOOP` | `ELOOP` | `EXDEV` |

`openat2` needs Linux 5.6 and has no glibc wrapper; under Rosetta it returned `ENOSYS` (38), and a
seccomp profile written before it existed may refuse it too. `O_RESOLVE_BENEATH` matches § 9.1's wording ("refuses
to follow a link out of the worktree") most closely, but is darwin-only.

### 2.5 errno

errno is read through a function returning its address: `__error` on darwin, `__errno_location`
on glibc and musl. Read right after the failing call, before any other FFI call, it was right in
every case above (`ELOOP`, `ENOTDIR`, `EEXIST`, `EWOULDBLOCK`).

## 3. Signals

`bun spikes/bun-ffi/spike.ts signals` starts `sig-child.ts`, which installs `process.on` handlers
for SIGUSR1, SIGUSR2 and SIGTSTP, then sends each from the parent with `process.kill`. The same
results on macOS and Linux arm64, from source and compiled, and on Alpine and x86_64 from source:

| Signal | With a `process.on` handler | With no handler |
|---|---|---|
| SIGUSR1 | the handler runs; the process keeps running (state `S`); a second SIGUSR1 later runs it again | the process ends, killed by SIGUSR1 |
| SIGUSR2 | the handler runs; the process keeps running | the process ends, killed by SIGUSR2 |
| SIGTSTP | the handler runs; the process **is not stopped** (state `S`) | the process is stopped (state `T`) |

So Bun delivers SIGUSR1 to a handler and doesn't reserve it for an inspector, as Node does.
SIGUSR2 works the same way. With no handler, SIGUSR1 kills: tutti should install its handler
before it writes its PID anywhere a user might read it (the lock file, the startup line).

**A caveat for testing SIGTSTP.** The kernel discards SIGTSTP sent to a process in an *orphaned*
process group, handler or not. A process started without a terminal (from an agent's shell, as
here, or as a container's PID 1) and its children are in one. A first run, with the child in the
spike's group, showed SIGTSTP not stopping even `sleep` without a handler. `sig-child.ts` therefore
calls `setpgid(0, 0)` through `bun:ffi` first, which puts it in a group of its own whose parent is
in another group of the same session, as a job in a terminal is. tutti run from a terminal is in
such a group. A test of tutti's SIGTSTP handling has to set up the same, or it passes vacuously.

## 4. What differs between darwin and Linux

### 4.1 Libraries and symbols

| | darwin | Linux glibc | Linux musl |
|---|---|---|---|
| Library to `dlopen` | `/usr/lib/libSystem.B.dylib` (in the dyld shared cache; no file on disk is needed) | `libc.so.6` | `libc.so.6` also works: musl's loader maps any `libc.so*` name to itself. Its real name is `libc.musl-<arch>.so.1` |
| errno | `__error()` | `__errno_location()` | `__errno_location()` |
| `flock`, `open`, `openat`, `close`, `fcntl`, `setpgid`, `system` | same names | same names | same names |
| Variadic `mode` | on the stack on arm64: pad (§ 2.2) | in registers | in registers |

### 4.2 Constants

From darwin's `<sys/fcntl.h>` and `<sys/errno.h>` (checked against the macOS 26 SDK) and Linux's
`<asm-generic/fcntl.h>` with the arm64 and x86 overrides. The spike checks every value that
`node:fs`'s `constants` and `node:os`'s `constants.errno` also have, and they matched on every
platform run.

| Constant | darwin | Linux x86_64 | Linux arm64 |
|---|---|---|---|
| `O_RDONLY`, `O_WRONLY`, `O_RDWR` | 0, 1, 2 | 0, 1, 2 | 0, 1, 2 |
| `O_CREAT` | `0x200` | `0x40` | `0x40` |
| `O_EXCL` | `0x800` | `0x80` | `0x80` |
| `O_TRUNC` | `0x400` | `0x200` | `0x200` |
| `O_APPEND` | `0x8` | `0x400` | `0x400` |
| `O_NOFOLLOW` | `0x100` | `0x20000` | **`0x8000`** |
| `O_DIRECTORY` | `0x100000` | `0x10000` | **`0x4000`** |
| `O_CLOEXEC` | `0x1000000` | `0x80000` | `0x80000` |
| `O_NOFOLLOW_ANY` | `0x20000000` | — | — |
| `O_RESOLVE_BENEATH` | `0x1000` | — (`openat2`'s `RESOLVE_BENEATH` is `0x08`) | — |
| `AT_FDCWD` | -2 | -100 | -100 |
| `F_GETFD`, `F_GETFL`, `FD_CLOEXEC` | 1, 3, 1 | 1, 3, 1 | 1, 3, 1 |
| `LOCK_EX`, `LOCK_NB`, `LOCK_UN` | 2, 4, 8 | 2, 4, 8 | 2, 4, 8 |
| `EWOULDBLOCK` (= `EAGAIN`) | 35 | 11 | 11 |
| `ELOOP` | 62 | 40 | 40 |
| `ENOENT`, `EEXIST`, `ENOTDIR`, `EXDEV` | 2, 17, 20, 18 | 2, 17, 20, 18 | 2, 17, 20, 18 |
| `ENOTCAPABLE` | 107 | — | — |

`node:fs`'s `constants` has every `O_*` above except `O_CLOEXEC` and `AT_FDCWD`, and `node:os`'s
`constants.errno` has every errno. Taking those from Bun and keeping only `O_CLOEXEC`, `AT_FDCWD`
and the darwin-only flags in a table would cover the arm64/x86_64 split for free.

## 5. For tutti-nrg.2.8 (the libc bindings)

- Bind with `bun:ffi` `dlopen`; `spikes/bun-ffi/libc.ts` is a starting point.
- The constants differ **per platform and architecture**, not just per OS (§ 4.2): a single
  "linux" table is wrong on one of x86_64 and arm64. Prefer `node:fs`/`node:os` constants where
  they exist.
- On darwin arm64, pad `open`/`openat` so that the mode goes on the stack (§ 2.2), and test the
  created file's mode: without the padding, an `O_CREAT|O_EXCL` attention file gets mode `140`
  instead of `600`, silently.
- Pass paths as `Buffer.from(path + "\0")` to a `ptr` argument.
- Read errno immediately after the failing call.
- For the run lock, `fs.openSync` already sets `O_CLOEXEC` (§ 1.4).
- A test that a child doesn't inherit the lock must use a spawner that would pass descriptors on
  (libc `system()`, as `holder.ts libc-system` does) as its control, since Bun's spawners close
  everything anyway (§ 1.2).

## 6. The spec

No contradiction with the spec was found: § 9.2's `flock` through `bun:ffi` with `O_CLOEXEC`, § 9.1's
per-component `openat` with `O_NOFOLLOW`, and § 7.4's SIGUSR1 handler and SIGTSTP handler all work
as written. When the spec is revised after M0, it can:

- settle § 9.1's "through `bun:ffi` or a small native helper" as `bun:ffi` (§ 2.3);
- drop SIGUSR2 as a fallback in § 7.4 and Appendix A, since SIGUSR1 works (or keep it as an alias);
- note in § 9.2 that Bun's spawners close every non-stdio descriptor in children, so `O_CLOEXEC`
  guards against other ways of starting processes.
