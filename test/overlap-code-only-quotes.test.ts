// A shell heredoc, an OCaml character and a Python f-string are read as what they are (tutti-mfij):
// an apostrophe in a heredoc's text opened a '…' quote, an OCaml '"' opened a string to the file's
// end, and the code in an f-string's {…} was left out with its text.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are source text with holes
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { codeIn } from "../src/run/codeText.ts"

/** The words of the code of text, in a file of that name. */
const words = (file: string, text: string): ReadonlySet<string> =>
  new Set(codeIn(file, text).match(/[A-Za-z_]\w*/g) ?? [])

/** Whether the code of text, in a file of that name, has each of `kept` and none of `left`. */
const reads = (file: string, text: string, kept: string, left: string) => {
  const found = words(file, text)
  for (const w of kept.split(" ")) expect([file, w, found.has(w)]).toEqual([file, w, true])
  for (const w of left.split(" ")) expect([file, w, found.has(w)]).toEqual([file, w, false])
}

describe("shell heredocs", () => {
  test("a heredoc's text is a string, its apostrophes and #s too; the code after it counts", () => {
    reads(
      "a.sh",
      "cat <<EOF | a # c1\nDon't stop # here\nEOF\nb 'x'\n",
      "cat a b",
      "Don t stop here c1 x",
    )
  })

  test("an unquoted heredoc keeps the code of $(…) and ${…}; a quoted one doesn't", () => {
    reads("a.sh", 'cat <<EOF\nit\'s $(a "q") ${b}\nEOF\nc', "a b c", "it s q")
    for (const open of ["'EOF'", '"EOF"', "\\EOF"]) {
      reads("a.sh", `cat <<${open}\nit's $(a) \${b}\nEOF\nc`, "cat c", "it s a b")
    }
  })

  test("<<- closes on a line of tabs and the delimiter; two heredocs on a line read in turn", () => {
    reads("a.sh", "f() {\n\tcat <<-END\n\tit's\n\tEND\n\ta\n}\n", "f cat a", "it s")
    reads("a.sh", "a <<X <<Y\nit's\nX\nthat's\nY\nb\n", "a b", "it s that")
  })

  test("a heredoc inside $(…) ends before the )", () => {
    reads("a.sh", 'v="$(cat <<EOF\nDon\'t\nEOF\n)" && a', "v cat a", "Don t")
  })

  test("<< with no line to close it, <<< and a shift are code", () => {
    reads("a.sh", "a <<EOF\nit\nb", "a EOF it b", "x")
    reads("a.sh", 'a <<< "x" && b $((1 << 2)) && c', "a b c", "x")
  })
})

describe("characters", () => {
  test("OCaml's and Haskell's '\"' is a character, not a string to the file's end", () => {
    reads("a.ml", "let a = '\"' in b '\\'' (c : 'a list) x' y'", "a b c list x y", "z")
    reads("a.hs", "a = '\"' : b x' 'c' -- c1", "a b x", "c c1")
  })
})

describe("Python f-strings", () => {
  test("the code in an f-string's {…} counts; its text and {{ … }} don't", () => {
    reads(
      "a.py",
      'f"x {a(\'q\')} {{y}} {b!r:>{c}}" + F\'z {d}\' + rf"\\w {e}" + "{n}"',
      "a b c d e",
      "x q y z w n",
    )
  })

  test("a triple-quoted f-string spans lines; a word ending in f is no prefix", () => {
    reads("a.py", 'f"""\nx {a({"k": b})}\n""" + of"y {z}"', "a b of", "x k y z")
  })
})

describe("reading any text", () => {
  const piece = fc.oneof(
    fc.string(),
    fc.constantFrom(
      ..."\" ' ` # ( ) { } \\ $ - \t \n".split(" "),
      "<<",
      "<<EOF",
      "<<-EOF",
      "<<'EOF'",
      "<<<",
      "EOF",
      "$(",
      "${",
      "{{",
      "}}",
      'f"',
      "rf'",
      'f"""',
      "'\"'",
      "merge",
    ),
  )
  const text = fc.array(piece, { maxLength: 40 }).map((pieces) => pieces.join(""))

  test("never throws, and never finds a word the text doesn't have", () => {
    fc.assert(
      fc.property(fc.constantFrom("sh", "bash", "py", "ml", "hs"), text, (extension, content) => {
        const all = new Set(content.match(/[A-Za-z_]\w*/g) ?? [])
        for (const w of words(`a.${extension}`, content)) expect(all.has(w)).toBe(true)
      }),
      { numRuns: 2000 },
    )
  })
})
