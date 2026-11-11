// The disk hold: the free disk where the worktrees go, as each reading of the machine's load takes
// it (load.ts), under diskFloor holds the run, no ticket starting or resuming, until it is back at
// diskClear. Through a night the worktrees, those set aside for review, the transcripts and the
// event log grow, and a disk that fills fails the tickets one after another (GIT_FAILED,
// STATE_UNWRITABLE): held, the workers running go on and merge, and nothing new takes more space.
// The thresholds are load.ts's, beside its others; the gate is diskGate.ts.

import { type Line, line, Tag, tagged } from "../core/log.ts"
import { type DiskFree, diskClear, diskFloor } from "./load.ts"
import { gb } from "./processes.ts"

/** The word of the disk hold, on the dashboard's title line while it holds. */
export const holdWord = "DISK"

/**
 * Whether `free` bytes are too little: under diskFloor while the hold is off, under diskClear while
 * it is `held`, so that it lifts only with a margin.
 */
export const diskLow = (held: boolean, free: number): boolean =>
  free < (held ? diskClear : diskFloor)

/** `bytes` in GB, to a tenth: `4.2 GB`. */
export const gigabytes = (bytes: number): string =>
  `${(Math.floor((bytes / gb) * 10) / 10).toFixed(1)} GB`

/**
 * HOLD: DISK: `4.2 GB free in /work, where the worktrees go, under 5.0 GB: no ticket starts until
 * 7.0 GB are free`, as the hold begins.
 */
export const holdLine = (disk: DiskFree): Line =>
  tagged(
    Tag.hold,
  )`${holdWord}: ${gigabytes(disk.free)} free in ${disk.where}, where the worktrees go, under ${gigabytes(diskFloor)}: no ticket starts until ${gigabytes(diskClear)} are free`

/** The hold lifted: `disk hold lifted: 7.3 GB free in /work, where the worktrees go`. */
export const liftedLine = (disk: DiskFree): Line =>
  line`disk hold lifted: ${gigabytes(disk.free)} free in ${disk.where}, where the worktrees go`
