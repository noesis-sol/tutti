// A child of spike.ts flags: says whether it inherited an open file of its parent.
//
//   bun spikes/bun-ffi/fds.ts <file>
//
// Compares every descriptor from 3 to 1023 with <file> by device and inode, and prints
// `inherited fd=<n>` for each that is the file, or `not-inherited`, then `open-fds <list>`.

import { fstatSync, statSync } from "node:fs"
import { cloexecOf } from "./libc.ts"

const path = process.argv[2]
if (path === undefined) throw new Error("usage: fds.ts <file>")
const want = statSync(path)
const open: Array<number> = []
const matches: Array<number> = []
for (let fd = 3; fd < 1024; fd++) {
  if (cloexecOf(fd) === "closed") continue
  open.push(fd)
  const st = fstatSync(fd)
  if (st.dev === want.dev && st.ino === want.ino) matches.push(fd)
}
console.log(
  matches.length > 0 ? matches.map((fd) => `inherited fd=${fd}`).join("\n") : "not-inherited",
)
console.log(`open-fds ${open.join(",")}`)
