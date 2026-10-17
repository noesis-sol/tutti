// The musl builds' first import (§ 12 "The musl builds"): OpenTUI doesn't detect musl, and loads
// its glibc library unless OPENTUI_LIBC says otherwise. Imports are evaluated before the importing
// module's body, so this has to be a module of its own, imported before any that loads OpenTUI.
process.env.OPENTUI_LIBC ??= "musl"
