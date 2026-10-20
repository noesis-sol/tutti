// The npm bundle's first import (src/npm.ts, § 12 npm): the bundle is one for every platform, so
// where the musl builds set OPENTUI_LIBC (src/entries/musl.ts), it detects musl at run time.
// OpenTUI doesn't, and loads its glibc library unless OPENTUI_LIBC says otherwise, which on x64
// Alpine fails. Imports are evaluated before the importing module's body, so this has to be a
// module of its own, imported before any that loads OpenTUI.
import { onMusl } from "./musl.ts"

if (onMusl()) process.env.OPENTUI_LIBC ??= "musl"
