// Memory samples: the process's own view (RSS, the JS heap) and, on macOS, vmmap's (the physical
// footprint and the malloc zones, where native allocations land).

import { heapStats } from "bun:jsc"
import { resolveRenderLib } from "@opentui/core"

export type VmmapSummary = {
  readonly footprintBytes: number
  readonly mallocAllocatedBytes: number
  /** Dirty plus swapped bytes of the malloc zones. */
  readonly mallocDirtyBytes: number
  /**
   * Dirty plus swapped (compressed) bytes per vmmap region type, for the types above 1 MB: what
   * each type adds to the physical footprint. Under memory pressure most of it is compressed, so
   * dirty alone undercounts.
   */
  readonly regions: Readonly<Record<string, number>>
}

const unit: Record<string, number> = { "": 1, B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }

export const parseSize = (text: string): number => {
  const m = /^([\d.]+)([BKMG]?)$/.exec(text.trim())
  if (m === null) return Number.NaN
  return Math.round(Number(m[1]) * (unit[m[2] ?? ""] ?? 1))
}

/** Parses `vmmap -summary`. Columns are split on two or more spaces, since names contain one. */
export const parseVmmap = (text: string): VmmapSummary | null => {
  const footprint = /^Physical footprint:\s+(\S+)/m.exec(text)
  if (footprint?.[1] === undefined) return null
  const lines = text.split("\n")
  const regions: Record<string, number> = {}
  const regionStart = lines.findIndex((l) => l.startsWith("REGION TYPE"))
  for (const line of lines.slice(regionStart + 2)) {
    if (line.startsWith("====")) break
    const cols = line.trim().split(/\s{2,}/)
    const [name, , , dirty, swapped] = cols
    if (name === undefined || dirty === undefined || swapped === undefined) continue
    const bytes = parseSize(dirty) + parseSize(swapped)
    if (bytes > 1024 ** 2) regions[name] = bytes
  }
  let mallocAllocatedBytes = 0
  let mallocDirtyBytes = 0
  const zoneStart = lines.findIndex((l) => l.startsWith("MALLOC ZONE"))
  if (zoneStart >= 0) {
    const zones: string[][] = []
    for (const line of lines.slice(zoneStart + 2)) {
      if (line.trim() === "" || line.startsWith("====")) {
        if (zones.length > 0 && line.trim() === "") break
        continue
      }
      zones.push(line.trim().split(/\s+/))
    }
    const total = zones.find((z) => z[0] === "TOTAL")
    for (const z of total === undefined ? zones : [total]) {
      // name virtual resident dirty swapped count allocated frag %frag regions
      mallocDirtyBytes += parseSize(z[3] ?? "") + parseSize(z[4] ?? "")
      mallocAllocatedBytes += parseSize(z[6] ?? "")
    }
  }
  return {
    footprintBytes: parseSize(footprint[1]),
    mallocAllocatedBytes,
    mallocDirtyBytes,
    regions,
  }
}

export const vmmap = async (pid: number): Promise<VmmapSummary | null> => {
  if (process.platform !== "darwin") return null
  const proc = Bun.spawn(["vmmap", "-summary", String(pid)], { stdout: "pipe", stderr: "ignore" })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  return parseVmmap(text)
}

export type Sample = {
  readonly minute: number
  readonly at: string
  readonly rssBytes: number
  readonly heapUsedBytes: number
  readonly heapTotalBytes: number
  readonly externalBytes: number
  readonly arrayBuffersBytes: number
  readonly jscHeapBytes: number
  readonly jscObjects: number
  readonly spanFeedAllocatorBytes: number
  /** Entries in the performance timeline: React's development build adds measures per render. */
  readonly performanceEntries: number
  readonly vmmap: VmmapSummary | null
}

export const sample = async (minute: number): Promise<Sample> => {
  const usage = process.memoryUsage()
  const jsc = heapStats()
  return {
    minute,
    at: new Date().toISOString(),
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
    jscHeapBytes: jsc.heapSize,
    jscObjects: jsc.objectCount,
    spanFeedAllocatorBytes: resolveRenderLib().getAllocatorStats().totalRequestedBytes,
    performanceEntries: performance.getEntries().length,
    vmmap: await vmmap(process.pid),
  }
}
