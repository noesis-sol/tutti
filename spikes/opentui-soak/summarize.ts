// Turns soak samples into Markdown for the report: a table per run and an ASCII chart of the
// physical footprint of every run, minute by minute.
//
//   bun spikes/opentui-soak/summarize.ts soak-600.jsonl soak-200.jsonl soak-unbounded.jsonl

import { basename } from "node:path"
import type { Sample } from "./memory.ts"

type Row = Sample & { ticks: number; frames: number; mounted: number; appended: number }
type Run = { name: string; rows: Row[]; end: string | undefined }

const MB = 2 ** 20
const mb = (n: number | undefined) => (n === undefined ? "–" : (n / MB).toFixed(0))

const load = async (path: string): Promise<Run> => {
  const lines = (await Bun.file(path).text()).split("\n").filter((l) => l !== "")
  const records = lines.map((l) => JSON.parse(l))
  return {
    name: basename(path, ".jsonl"),
    rows: records.filter((r) => r.minute !== undefined),
    end: records.find((r) => r.event === "end")?.reason,
  }
}

const runs = await Promise.all(process.argv.slice(2).map(load))

const table = (run: Run) => {
  const out = [
    `#### ${run.name}`,
    "",
    "| min | footprint | RSS | VM_ALLOCATE | Tag 240 | malloc | JS heap | mounted | appended | ticks | frames |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ]
  for (const r of run.rows) {
    out.push(
      `| ${r.minute} | ${mb(r.vmmap?.footprintBytes)} | ${mb(r.rssBytes)} | ${mb(r.vmmap?.regions.VM_ALLOCATE)} | ${mb(r.vmmap?.regions["Memory Tag 240"])} | ${mb(r.vmmap?.mallocDirtyBytes)} | ${mb(r.jscHeapBytes)} | ${r.mounted} | ${r.appended} | ${r.ticks} | ${r.frames} |`,
    )
  }
  out.push("", `Ended: ${run.end ?? "still running"}. Sizes in MB.`, "")
  return out.join("\n")
}

/** One column per minute, one row per 1/HEIGHT of the largest footprint; each run its own mark. */
const chart = (all: Run[], height = 16) => {
  const marks = ["1", "2", "3", "4", "5", "6", "7", "8", "9"]
  const max = Math.max(...all.flatMap((r) => r.rows.map((x) => x.vmmap?.footprintBytes ?? 0)))
  const minutes = Math.max(...all.map((r) => r.rows.length))
  const grid = Array.from({ length: height }, () => Array.from({ length: minutes }, () => " "))
  all.forEach((run, i) => {
    for (const r of run.rows) {
      const level = Math.round(((r.vmmap?.footprintBytes ?? 0) / max) * (height - 1))
      const row = grid[height - 1 - level]
      if (row !== undefined) row[r.minute] = marks[i] ?? "*"
    }
  })
  const lines = grid.map((row, i) => {
    const value = (max / MB) * ((height - 1 - i) / (height - 1))
    return `${value.toFixed(0).padStart(5)} MB |${row.join("")}`
  })
  lines.push(`         +${"-".repeat(minutes)}`, `          minutes 0..${minutes - 1}`)
  lines.push(...all.map((run, i) => `          ${marks[i] ?? "*"} = ${run.name}`))
  return ["```", ...lines, "```"].join("\n")
}

console.log(chart(runs))
console.log()
for (const run of runs) console.log(table(run))
