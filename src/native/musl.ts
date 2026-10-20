// Whether this is Linux on musl, as the Agent SDK reads it: Node's process report gives glibc's
// version on glibc (header.glibcVersionRuntime), and leaves it out on musl. Bun's report does the
// same. It imports nothing, so the npm bundle's entry can read it before any module loads OpenTUI
// (./detectMusl.ts).

/** Whether `report`, process.report.getReport()'s on `platform`, is a musl Linux's. */
export const muslReport = (platform: string, report: unknown): boolean => {
  if (platform !== "linux") return false
  const header = (report as { header?: { glibcVersionRuntime?: unknown } } | undefined)?.header
  return header?.glibcVersionRuntime === undefined
}

/** Whether this process runs on a musl Linux. */
export const onMusl = (): boolean =>
  muslReport(
    process.platform,
    process.platform === "linux" ? process.report?.getReport() : undefined,
  )
