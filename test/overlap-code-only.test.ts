// A function is mentioned by a file's code, not its comments, strings or documents (tutti-gr4z.2):
// a ticket naming Beads.respond met any file importing Beads with a log string saying "bd human
// respond", and was held back behind a ticket that changed neither file.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { codeExtensions, codeIn } from "../src/run/codeText.ts"
import { mentionsIn } from "../src/run/overlap.ts"

/** The words of the code of text, in a file of that name. */
const words = (file: string, text: string): ReadonlySet<string> =>
  new Set(codeIn(file, text).match(/[A-Za-z_]\w*/g) ?? [])

/** Whether the code of text, in a file of that name, has each of `kept` and none of `left`. */
const reads = (file: string, text: string, kept: string, left: string) => {
  const found = words(file, text)
  for (const w of kept.split(" ")) expect([file, w, found.has(w)]).toEqual([file, w, true])
  for (const w of left.split(" ")) expect([file, w, found.has(w)]).toEqual([file, w, false])
}

describe("mentionsIn", () => {
  const beads = 'import { Beads } from "./Beads.ts"\n'

  test("a function named in a log string or a comment is not mentioned; code using it is", () => {
    const mentions = mentionsIn(
      new Map([
        ["src/run/carry.ts", `${beads}log("run bd human respond")\n// respond here\n`],
        ["src/run/work.ts", `${beads}/* Beads.respond */ const s = 'respond'`],
        ["src/run/asked.ts", `${beads}yield* Beads.respond(id)\n`],
      ]),
    )
    expect(mentions("src/run/carry.ts", "Beads.respond")).toBe(false)
    expect(mentions("src/run/work.ts", "Beads.respond")).toBe(false)
    expect(mentions("src/run/asked.ts", "Beads.respond")).toBe(true)
    expect(mentions("src/run/carry.ts", "Beads")).toBe(true)
  })

  test("the code inside ${…} in a template literal counts; its text doesn't", () => {
    const mentions = mentionsIn(
      new Map([["a.ts", "const line = `respond to ${Beads.respond(`id ${merge()}`)} now`"]]),
    )
    expect(mentions("a.ts", "Beads.respond")).toBe(true)
    expect(mentions("a.ts", "merge")).toBe(true)
    expect(mentions("a.ts", "now")).toBe(false)
  })

  test("a document and a data file mention nothing", () => {
    const mentions = mentionsIn(
      new Map([
        ["README.md", "Call `Beads.respond` from asked.ts."],
        ["data/calls.json", '{ "Beads": "respond" }'],
        ["Makefile", "Beads respond"],
      ]),
    )
    expect(mentions("README.md", "Beads.respond")).toBe(false)
    expect(mentions("data/calls.json", "Beads.respond")).toBe(false)
    expect(mentions("Makefile", "Beads")).toBe(false)
  })

  test("an extension with no family keeps all its words", () => {
    const mentions = mentionsIn(
      new Map([["src/App.vue", '<p>{{ "Beads" }}</p> <!-- respond --> // merge']]),
    )
    expect(mentions("src/App.vue", "Beads.respond")).toBe(true)
    expect(mentions("src/App.vue", "merge")).toBe(true)
    expect(codeIn("App.svelte", "don't 'x'")).toBe("don't 'x'")
  })
})

describe("each family's comments and strings", () => {
  test("JavaScript and TypeScript", () => {
    reads(
      "a.ts",
      [
        "a(\"x \\\" y\", 'p \\' q') // c1",
        "/* c2 */ b(`t ${d({ k: e })} u`)",
        "const r = /re\"[/']/g; f(1 / g / h)",
        "return /ret/.test(i)",
        "const j = `${`${k}`}`",
      ].join("\n"),
      "a b d k e r f g h i test j",
      "x y p q c1 c2 t u re ret",
    )
  })

  test("Go, with raw strings and runes", () => {
    reads(
      "a.go",
      "a(\"x \\\" y\") // c1\nb(`raw \" p`, '\"', '\\'') /* c2 */ c()",
      "a b c",
      "x y raw p c1 c2",
    )
  })

  test("Rust, with raw strings, characters and lifetimes", () => {
    reads(
      "a.rs",
      [
        "fn a<'b>(x: &'b str) { let q = '\"'; }",
        'let s = r#"raw " t"#; let u = r"v"; e("w \\" z")',
        "/* c1 /* c2 */ c3 */ f() // c4",
      ].join("\n"),
      "a b x str q s u e f",
      "raw t v w z c1 c2 c3 c4",
    )
  })

  test("C, Java, Kotlin, Swift, Dart and PHP", () => {
    reads("a.c", "a(\"x\", 'y'); /* c1 */ b(); // c2", "a b", "x y c1 c2")
    reads("A.java", 'a("""\n  text " q\n  """); b("s")', "a b", "text q s")
    reads("a.kt", 'a("x ${b(c)} y") /* c1 /* c2 */ c3 */', "a b c", "x y c1 c2 c3")
    reads("a.swift", 'a("x \\(b(c)) y") // c1', "a b c", "x y c1")
    reads("a.dart", 'a(\'x ${b} y\', """z""")', "a b", "x y z")
    reads("a.php", "a('x'); # c1\n// c2\nb(\"y\")", "a b", "x y c1 c2")
  })

  test("Python, Ruby, Elixir and the shell", () => {
    reads("a.py", 'a("x \\" y") # c1\nb("""doc " d\n""", \'\'\'t\'\'\')', "a b", "x y c1 doc d t")
    reads("a.rb", 'a("x #{b("q")} y") # c1\nc(\'z\')', "a b c", "x y q c1 z")
    reads("a.ex", 'a("x #{b} y") # c1\nc(~s(p), """\nz\n""")', "a b c", "x y c1 z")
    reads("a.sh", 'a "x $(b "q") ${#arr[@]} y" # c1\nc \'z\' $#', "a b arr c", "x q y c1 z")
  })

  test("Erlang, Haskell and OCaml", () => {
    reads("a.erl", "a(\"x\", 'atom'). % c1", "a atom", "x c1")
    reads("a.hs", 'a x\' = b "y" -- c1\n{- c2 {- c3 -} c4 -} c', "a x b c", "y c1 c2 c3 c4")
    reads("a.ml", 'let a = b "x" (* c1 (* c2 *) c3 *) c', "a b c", "x c1 c2 c3")
  })

  test("holes nested however deep don't overflow the stack", () => {
    const deep = `${"`${".repeat(100_000)}a${"}`".repeat(100_000)}`
    expect(words("a.ts", deep)).toEqual(new Set(["a"]))
  })
})

describe("reading any text", () => {
  const extensions = [...codeExtensions, "vue", "md", "json", ""]
  // Text made mostly of what starts and ends comments, strings and holes, and words.
  const piece = fc.oneof(
    fc.string(),
    fc.constantFrom(
      ..."\" ' ` / * # % - ( ) { } [ ] \\ $ r b x \n".split(" "),
      "//",
      "/*",
      "*/",
      "${",
      "#{",
      "$(",
      "\\(",
      '"""',
      "'''",
      'r#"',
      '"#',
      "(*",
      "*)",
      "{-",
      "-}",
      "--",
      "merge",
      "Beads.respond",
      "'a'",
      "\\n",
    ),
  )
  const text = fc.array(piece, { maxLength: 40 }).map((pieces) => pieces.join(""))

  test("never throws, and never finds a word the text doesn't have", () => {
    fc.assert(
      fc.property(fc.constantFrom(...extensions), text, (extension, content) => {
        const file = extension === "" ? "Makefile" : `src/file.${extension}`
        const all = new Set(content.match(/[A-Za-z_]\w*/g) ?? [])
        for (const w of words(file, content)) expect(all.has(w)).toBe(true)
        const mentions = mentionsIn(new Map([[file, content]]))
        mentions(file, "Beads.respond")
      }),
      { numRuns: 2000 },
    )
  })
})
