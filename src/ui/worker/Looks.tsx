// The transcript's looks (§ 7.11 "Markdown"): the Markdown, output and error styles a worker
// view's and the Interview view's items are drawn in, made from the theme's roles in the
// renderer's native scene, and the context the items read them from.
import {
  BoxRenderable,
  type MarkdownOptions,
  SyntaxStyle,
  type TreeSitterClient,
} from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { createContext, useContext, useEffect, useMemo } from "react"
import { plainFg } from "../line.tsx"
import type { Role, Theme } from "../theme.ts"

/** The Markdown and code styles, from the theme's roles (§ 7.11 "Markdown"). */
export interface Looks {
  readonly theme: Theme
  readonly markdown: SyntaxStyle
  /** The Markdown's quotes and rules, drawn faint (markdownBlocks). */
  readonly blocks: NonNullable<MarkdownOptions["renderNode"]>
  /** A command's output, faint; and an error's, `needsYou`. */
  readonly output: SyntaxStyle
  readonly error: SyntaxStyle
  /** The Markdown's, the output's and the diffs' tree-sitter client, if not OpenTUI's shared one. */
  readonly highlighter: { readonly treeSitterClient?: TreeSitterClient }
}

export const LooksContext = createContext<Looks | null>(null)

/**
 * The tree-sitter client the transcript highlights with: OpenTUI's shared one when undefined. The
 * UI tests put OpenTUI's MockTreeSitterClient here, to resolve the highlighting when they capture a
 * frame rather than wait for tree-sitter's (test/render.ts).
 */
export const HighlighterContext = createContext<TreeSitterClient | undefined>(undefined)

/** The looks of the view the items are drawn in. */
export const useLooks = (): Looks => {
  const looks = useContext(LooksContext)
  if (looks === null) throw new Error("a transcript item is drawn outside its worker view")
  return looks
}

/** The longest a Markdown rule is drawn (§ 7.11 "Markdown"). */
export const ruleWidth = 40

/**
 * OpenTUI draws a quote's bar and a rule as box borders, in a colour with no attributes, and the
 * rule the whole width. This keeps its boxes, which it updates in place as the text streams, with
 * their borders off: a quote's draws a faint `│ ` on each of its lines, a rule's a faint `─` at
 * most `ruleWidth` long.
 */
const markdownBlocks = (theme: Theme): NonNullable<MarkdownOptions["renderNode"]> => {
  const faint = theme.styles.dim
  const fg = faint.fg ?? plainFg
  const renderNode: NonNullable<MarkdownOptions["renderNode"]> = (token, context) => {
    if (token.type !== "blockquote" && token.type !== "hr") return undefined
    const box = context.defaultRender()
    if (!(box instanceof BoxRenderable)) return box
    // No sides, not false: OpenTUI sets the colour of a quote it updates, which gives a box with
    // its border false all four.
    box.border = []
    if (token.type === "blockquote") {
      box.paddingLeft = 2
      box.renderAfter = function (buffer) {
        for (let y = 0; y < this.height; y++) {
          buffer.drawText("│", this.x, this.y + y, fg, undefined, faint.attributes)
        }
      }
    } else {
      box.maxWidth = ruleWidth
      box.renderAfter = function (buffer) {
        buffer.drawText("─".repeat(this.width), this.x, this.y, fg, undefined, faint.attributes)
      }
    }
    return box
  }
  // OpenTUI's flag for a renderNode that leaves the other blocks to it: the paragraphs stay
  // coalesced, with the blank lines between them.
  return Object.assign(renderNode, { codeBlockOnly: true })
}

/** The syntax styles of `theme`, made in the renderer's native scene and freed with it. */
export const useSyntaxStyles = (theme: Theme): Looks => {
  const renderer = useRenderer()
  const client = useContext(HighlighterContext)
  const looks = useMemo(() => {
    const role = (name: Role) => ({ fg: theme.rgba(name, "fg") })
    // A style with no role of its own is the terminal's text colour: OpenTUI's own is white.
    const plain = { fg: plainFg }
    const make = (styles: Parameters<typeof SyntaxStyle.fromStyles>[0]) =>
      SyntaxStyle.fromStyles(styles, renderer.nativeScene)
    return {
      theme,
      markdown: make({
        default: plain,
        "markup.heading.1": { ...role("heading1"), bold: true },
        "markup.heading.2": { ...role("heading2"), bold: true },
        // H3 and below: a heading's scope names its level, and no style falls back to another.
        ...Object.fromEntries(
          [3, 4, 5, 6].map((level) => [
            `markup.heading.${level}`,
            { ...role("heading3"), bold: true },
          ]),
        ),
        "markup.heading": { ...role("heading3"), bold: true },
        "markup.raw": role("code"),
        "markup.raw.block": role("code"),
        "markup.link": { ...plain, dim: true },
        "markup.link.label": role("link"),
        "markup.link.url": { ...plain, dim: true },
        "markup.strong": { ...plain, bold: true },
        "markup.italic": { ...plain, italic: true },
        "markup.quote": { ...plain, dim: true, italic: true },
        "markup.list": plain,
        conceal: { ...plain, dim: true },
      }),
      blocks: markdownBlocks(theme),
      output: make({ default: { ...plain, dim: true } }),
      error: make({ default: role("needsYou") }),
      highlighter: client === undefined ? {} : { treeSitterClient: client },
    }
  }, [renderer, theme, client])
  useEffect(
    () => () => {
      looks.markdown.destroy()
      looks.output.destroy()
      looks.error.destroy()
    },
    [looks],
  )
  return looks
}
