// A fake bd for test/feature-start-binary.test.ts: a bd that files and shows, its issues kept in
// FAKE_BD_DIR's issues.json, each call logged to its bd.log, one line each. It answers the commands
// src/services/Beads.ts runs, in bd's --json shapes (test/fixtures/bd/): create, show, list, ready,
// update, close, dep add and dep list; anything else, `[]`. The issues it files are demo-1, demo-2, …
// in order, a child of an epic `<epic>.<n>`, as bd numbers them.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

interface FakeIssue {
  id: string
  title: string
  status: string
  description: string
  acceptance_criteria: string
  notes: string
  issue_type: string
  priority: number
  parent?: string
  labels: Array<string>
  metadata: Record<string, unknown>
  created_at: string
  /** The issues it waits for, blocks links. */
  blocked_by: Array<string>
}

interface State {
  next: number
  /** The next child number by epic. */
  children: Record<string, number>
  issues: Array<FakeIssue>
}

const dir = process.env.FAKE_BD_DIR ?? "."
const stateFile = join(dir, "issues.json")
const args = process.argv.slice(2)
appendFileSync(join(dir, "bd.log"), `${args.join(" ")}\n`)

const state: State = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, "utf8"))
  : { next: 1, children: {}, issues: [] }
const save = () => writeFileSync(stateFile, JSON.stringify(state))

/** The value of `--name=value` among the arguments. */
const flag = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
/** Every value of `--name=value` among the arguments. */
const flags = (name: string): Array<string> =>
  args.filter((arg) => arg.startsWith(`--${name}=`)).map((arg) => arg.slice(name.length + 3))
/** The arguments that aren't flags, past the command's words. */
const words = args.filter((arg) => !arg.startsWith("--"))

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)

const find = (id: string) => state.issues.find((issue) => issue.id === id)

/** An issue as bd list and bd ready give it: its links as links. */
const listed = (issue: FakeIssue) => {
  const { blocked_by, ...fields } = issue
  return {
    ...fields,
    dependencies: [
      ...(issue.parent === undefined
        ? []
        : [{ issue_id: issue.id, depends_on_id: issue.parent, type: "parent-child" }]),
      ...blocked_by.map((on) => ({ issue_id: issue.id, depends_on_id: on, type: "blocks" })),
    ],
  }
}

/** An issue as bd show gives it: its links as the linked issues. */
const shown = (issue: FakeIssue) => {
  const { blocked_by, ...fields } = issue
  const linked = (id: string, type: string) => {
    const other = find(id)
    if (other === undefined) return []
    const { blocked_by: _, ...its } = other
    return [{ ...its, dependency_type: type }]
  }
  return {
    ...fields,
    dependencies: [
      ...(issue.parent === undefined ? [] : linked(issue.parent, "parent-child")),
      ...blocked_by.flatMap((on) => linked(on, "blocks")),
    ],
    dependents: state.issues
      .filter((other) => other.parent === issue.id || other.blocked_by.includes(issue.id))
      .flatMap((other) => {
        const { blocked_by: _, ...its } = other
        return [{ ...its, dependency_type: other.parent === issue.id ? "parent-child" : "blocks" }]
      }),
  }
}

/** Whether `issue` is under `epic`, at any depth. */
const under = (issue: FakeIssue, epic: string): boolean => {
  const parent = issue.parent === undefined ? undefined : find(issue.parent)
  return parent !== undefined && (parent.id === epic || under(parent, epic))
}

const missing = () => {
  print({ error: "no issues found matching the provided IDs" })
  process.exit(1)
}

const [command, sub] = words
switch (command) {
  case "create": {
    const parent = flag("parent")
    let id: string
    if (parent === undefined) {
      id = `demo-${state.next++}`
    } else {
      const n = (state.children[parent] ?? 0) + 1
      state.children[parent] = n
      id = `${parent}.${n}`
    }
    const issue: FakeIssue = {
      id,
      title: flag("title") ?? "",
      status: "open",
      description: flag("description") ?? "",
      acceptance_criteria: flag("acceptance") ?? "",
      notes: "",
      issue_type: flag("type") ?? "task",
      priority: Number(flag("priority") ?? "2"),
      ...(parent === undefined ? {} : { parent }),
      labels: (flag("labels") ?? "").split(",").filter((label) => label !== ""),
      metadata: JSON.parse(flag("metadata") ?? "{}"),
      created_at: new Date().toISOString(),
      blocked_by: flags("deps")
        .filter((dep) => dep.startsWith("blocked-by:"))
        .map((dep) => dep.slice("blocked-by:".length)),
    }
    state.issues.push(issue)
    save()
    const { blocked_by: _, ...fields } = issue
    print(fields)
    break
  }
  case "show": {
    const issue = sub === undefined ? undefined : find(sub)
    if (issue === undefined) missing()
    else print([shown(issue)])
    break
  }
  case "list": {
    const parent = flag("parent")
    const status = flag("status")
    const ids = flag("id")?.split(",")
    const labels = flags("label")
    print(
      state.issues
        .filter((issue) => args.includes("--all") || issue.status !== "closed")
        .filter((issue) => status === undefined || issue.status === status)
        .filter((issue) => parent === undefined || issue.parent === parent)
        .filter((issue) => ids === undefined || ids.includes(issue.id))
        .filter((issue) => labels.every((label) => issue.labels.includes(label)))
        .map(listed),
    )
    break
  }
  case "ready": {
    const parent = flag("parent")
    const excludeLabels = flag("exclude-label")?.split(",") ?? []
    const excludeTypes = flag("exclude-type")?.split(",") ?? []
    print(
      state.issues
        .filter((issue) => issue.status === "open" && issue.issue_type !== "epic")
        .filter((issue) => parent === undefined || under(issue, parent))
        .filter((issue) => !issue.labels.some((label) => excludeLabels.includes(label)))
        .filter((issue) => !excludeTypes.includes(issue.issue_type))
        .filter((issue) => issue.blocked_by.every((on) => find(on)?.status === "closed"))
        .map(listed),
    )
    break
  }
  case "update":
  case "close": {
    const issue = sub === undefined ? undefined : find(sub)
    if (issue === undefined) missing()
    else {
      if (command === "close") issue.status = "closed"
      if (args.includes("--claim")) issue.status = "in_progress"
      const status = flag("status")
      if (status !== undefined) issue.status = status
      const notes = flag("append-notes")
      if (notes !== undefined) issue.notes = `${issue.notes}\n${notes}`.trim()
      save()
      const { blocked_by: _, ...fields } = issue
      print([fields])
    }
    break
  }
  case "dep": {
    const [, , id, on] = words
    const issue = id === undefined ? undefined : find(id)
    if (sub === "add") {
      if (issue === undefined || on === undefined || find(on) === undefined) missing()
      else {
        issue.blocked_by.push(on)
        save()
        print({ issue_id: id, depends_on_id: on, status: "added", type: flag("type") ?? "blocks" })
      }
    } else if (sub === "list") {
      if (issue === undefined) missing()
      else print(flag("direction") === "up" ? shown(issue).dependents : shown(issue).dependencies)
    } else print([])
    break
  }
  default:
    print([])
}
