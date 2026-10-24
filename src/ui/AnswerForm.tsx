// The answer form (Box.Form, § 4.5, § 7.3): Answer in view in the worker view's panel opens it over
// the view for what a card can't hold, a question request's questions or an elicitation's fields
// (answerForm.ts). Each question's options are rows, `( )` one to pick or `[ ]` several, with Other
// and a line to type your own; an elicitation's fields are lines to type in, a yes/no, or options.
// The focused row has the selector (`>`), and a line to type in has the cursor.
//
// The keys, in the box layer: `↑`/`↓`, `Tab`/`Shift+Tab` move between the rows and the buttons;
// `Space` or `Enter` picks the focused option (a line to type in passes Enter on to the next row),
// `1`–`9` pick an option of the focused question; `Enter` on a button presses it: Answer (Choose)
// or Accept with the fields' content, else Deny or Decline. A field still missing a value is named
// under the buttons and focused. `Esc` closes the form. A click picks a row or presses a button.
//
// The answer names the request the form was opened for; one no longer open closes the form, with
// the toast for an answer that came too late.
import { type InputRenderable, RGBA, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { ShownRequest } from "../run/runView.ts"
import {
  answerOf,
  buttonLabels,
  type Field,
  type Form,
  formOf,
  initialValues,
  pick,
  type Row,
  refusalOf,
  rowsOf,
  typeIn,
  typesAt,
  type Value,
} from "./answerForm.ts"
import { staleToast, useSendAnswer } from "./attentionKeys.ts"
import { clickable } from "./click.ts"
import { hintSegments } from "./Hint.tsx"
import { useInput, useLayer } from "./keys.ts"
import { cut, Line, plainFg, roleLook, type Segments, seg, styled } from "./line.tsx"
import { Backdrop } from "./Modal.tsx"
import type { Theme } from "./theme.ts"
import { useKeyState } from "./useKeyState.ts"
import { useRunViewPart, useTheme } from "./useRunView.ts"

/** The widest the form gets, its frame included. */
export const formWidth = 72

/** The id of row `index`'s renderable, to scroll it into view. */
const rowId = (index: number): string => `form-row-${index}`

/** The form's hint: its keys. */
const formKeys = [
  { keys: "↑↓", does: "move" },
  { keys: "Space", does: "pick" },
  { keys: "Enter", does: "pick or press" },
  { keys: "Esc", does: "cancel" },
]

/** An option row's mark: `(•)` picked of one, `[x]` of several. */
const markOf = (field: Field, picked: boolean): string =>
  field._tag === "Choice" && !field.multi ? (picked ? "(•)" : "( )") : picked ? "[x]" : "[ ]"

/** A field's lines above its rows: its title (a question's header before it), its description. */
const titleLines = (field: Field, theme: Theme): ReadonlyArray<Segments> => {
  if (field._tag === "Toggle") return []
  const { form } = theme
  const required = field._tag === "Text" && field.required ? [seg(" *", form.error)] : []
  return [
    [
      ...(field._tag === "Choice" && field.header !== undefined
        ? [seg(field.header, form.description), seg("  ")]
        : []),
      seg(field.title, form.fieldTitle),
      ...required,
    ],
    ...(field.description === undefined ? [] : [[seg(field.description, form.description)]]),
  ]
}

/** The text of option row `option` of `field`: the option, Other, a Toggle's title. */
const rowText = (field: Field, value: Value, option: number, theme: Theme): Segments => {
  const { form } = theme
  const picked =
    field._tag === "Toggle" ? value.on : field._tag === "Choice" && value.picked.includes(option)
  const mark = seg(`${markOf(field, picked)} `, picked ? form.selectedMark : form.option)
  const label = picked ? form.selected : form.option
  switch (field._tag) {
    case "Toggle":
      return [
        mark,
        seg(field.title, label),
        ...(field.description === undefined
          ? []
          : [seg(` — ${field.description}`, form.description)]),
      ]
    case "Text":
      return []
    case "Choice": {
      const at = field.options[option]
      if (at === undefined) return [mark, seg("Other: ", label)]
      return [
        mark,
        seg(at.label, label),
        ...(at.description === undefined ? [] : [seg(` — ${at.description}`, form.description)]),
      ]
    }
  }
}

/** The form for `request`, `width` wide inside its frame. */
const FormBody = ({
  request,
  form,
  close,
}: {
  readonly request: ShownRequest
  readonly form: Form
  readonly close: () => void
}) => {
  const theme = useTheme()
  const { width, height } = useTerminalDimensions()
  const answer = useSendAnswer()
  const [values, setValues, valuesNow] = useKeyState<ReadonlyArray<Value>>(() =>
    initialValues(request, form),
  )
  const rows = useMemo(() => rowsOf(form), [form])
  // The focus: a row, or past them the two buttons. Key state, so keys arriving together each see
  // the one before them.
  const [focus, setFocusState, at] = useKeyState(() => 0)
  const [missing, setMissing] = useState<string | null>(null)
  const scroll = useRef<ScrollBoxRenderable>(null)
  const last = rows.length + 1
  // The lines to type in, by row: the focus moves to and from them at once, so that a key read
  // with the one moving it goes where it now is, not where it was before React draws it.
  const inputs = useRef(new Map<number, InputRenderable>())
  const setFocus = (to: number) => {
    const row = Math.min(Math.max(to, 0), last)
    setFocusState(() => row)
    for (const [each, input] of inputs.current) if (each !== row && input.focused) input.blur()
    inputs.current.get(row)?.focus()
  }
  useEffect(() => {
    if (focus < rows.length) scroll.current?.scrollChildIntoView(rowId(focus))
  }, [focus, rows.length])

  const update = (field: number, change: (value: Value) => Value) => {
    setValues((now) => now.map((each, i) => (i === field ? change(each) : each)))
    setMissing(null)
  }
  const pickRow = (row: Row) => {
    const field = form.fields[row.field]
    if (field !== undefined) update(row.field, (value) => pick(field, value, row.option))
  }
  const send = () => {
    const outcome = answerOf(form, valuesNow())
    if (outcome._tag === "Missing") {
      setMissing(outcome.message)
      setFocus(rows.findIndex((row) => row.field === outcome.field))
      return
    }
    close()
    answer(request, outcome.answer)
  }
  const refuse = () => {
    close()
    answer(request, refusalOf(form))
  }
  const press = (index: number) => {
    if (index === rows.length) return send()
    if (index === rows.length + 1) return refuse()
    const row = rows[index]
    if (row === undefined) return
    if (typesAt(form, row)) setFocus(index + 1)
    else pickRow(row)
  }
  const number = (n: number) => () => {
    const row = rows[at()]
    const field = row === undefined ? undefined : form.fields[row.field]
    if (row === undefined || field?._tag !== "Choice" || n > field.options.length) return
    const to = rows.findIndex((each) => each.field === row.field && each.option === n - 1)
    setFocus(to)
    pickRow({ field: row.field, option: n - 1 })
  }
  useLayer(
    "box",
    [
      ...["down", "tab"].map((key) => ({ key, run: () => setFocus(at() + 1) })),
      ...["up", "shift+tab"].map((key) => ({ key, run: () => setFocus(at() - 1) })),
      ...["return", "enter"].map((key) => ({ key, run: () => press(at()) })),
      {
        key: "space",
        run: () => {
          const row = rows[at()]
          if (row === undefined) press(at())
          else if (!typesAt(form, row)) pickRow(row)
        },
      },
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ key: String(n), run: number(n) })),
    ],
    "Form",
  )

  const { form: looks } = theme
  const frame = roleLook(theme, "needsYou")
  const outer = Math.max(Math.min(width - 4, formWidth), 16)
  const inner = outer - 4
  // The body's lines: each field's title lines and rows, a blank line between fields.
  const tall = form.fields.reduce(
    (sum, field, i) => sum + (i === 0 ? 0 : 1) + titleLines(field, theme).length,
    rows.length,
  )
  const room = Math.max(height - 2 - 6, 1)
  const bodyHeight = Math.min(Math.max(tall, 1), room)
  const boxHeight = bodyHeight + 6
  const [sendLabel, refuseLabel] = buttonLabels(form)
  const button = (label: string, index: number) => (
    <text
      wrapMode="none"
      height={1}
      {...clickable(() => {
        setFocus(index)
        press(index)
      })}
      {...styled(focus === index ? looks.focusedButton : looks.button)}
    >
      {`[ ${label} ]`}
    </text>
  )
  let index = 0
  return (
    <>
      <Backdrop />
      <box
        position="absolute"
        zIndex={10}
        left={Math.max(Math.floor((width - outer) / 2), 0)}
        top={Math.max(Math.floor((height - boxHeight) / 2), 0)}
        width={outer}
        height={boxHeight}
        // Opaque, in the terminal's own background: the view's text doesn't show through its spaces.
        backgroundColor={RGBA.defaultBackground()}
        flexDirection="column"
        border
        borderStyle="rounded"
        {...(frame.fg === undefined ? {} : { borderColor: frame.fg })}
        paddingX={1}
      >
        <Line
          segments={cut(
            [seg(request.label, theme.styles.key), seg(" asks", theme.styles.dim)],
            inner,
          )}
        />
        <scrollbox
          ref={scroll}
          height={bodyHeight}
          flexShrink={0}
          focusable={false}
          scrollbarOptions={{ visible: false }}
        >
          {form.fields.map((field, f) => {
            const value = values[f] ?? { picked: [], text: "", on: false }
            const first = index
            index += rows.filter((row) => row.field === f).length
            return (
              <box
                key={field.key}
                flexDirection="column"
                flexShrink={0}
                paddingTop={f === 0 ? 0 : 1}
              >
                {titleLines(field, theme).map((segments, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the lines are drawn anew in order
                  <Line key={i} segments={cut(segments, inner)} />
                ))}
                {rows
                  .filter((row) => row.field === f)
                  .map((row, i) => {
                    const n = first + i
                    const focused = n === focus
                    const typing = typesAt(form, row)
                    const before: Segments = [
                      seg(focused ? "> " : "  ", looks.selector),
                      ...rowText(field, value, row.option, theme),
                    ]
                    return (
                      <box
                        key={row.option}
                        id={rowId(n)}
                        flexDirection="row"
                        height={1}
                        flexShrink={0}
                        {...clickable(() => {
                          setFocus(n)
                          if (!typing) pickRow(row)
                        })}
                      >
                        <Line segments={cut(before, inner)} />
                        {typing ? (
                          <input
                            ref={(input: InputRenderable | null) => {
                              if (input === null) inputs.current.delete(n)
                              else inputs.current.set(n, input)
                            }}
                            focused={focused}
                            flexGrow={1}
                            value={value.text}
                            onInput={(typed: string) =>
                              update(f, (now) => typeIn(field, now, typed))
                            }
                            placeholder={
                              field._tag === "Text" && field.number !== null ? "a number" : ""
                            }
                            {...(looks.option.fg === undefined
                              ? {}
                              : { textColor: looks.option.fg })}
                            {...(looks.option.fg === undefined
                              ? {}
                              : { focusedTextColor: looks.option.fg })}
                            {...(looks.placeholder.fg === undefined
                              ? {}
                              : { placeholderColor: looks.placeholder.fg })}
                            {...(looks.selected.fg === undefined
                              ? {}
                              : { cursorColor: looks.selected.fg })}
                          />
                        ) : null}
                      </box>
                    )
                  })}
              </box>
            )
          })}
        </scrollbox>
        <Line segments={[]} />
        <box flexDirection="row" height={1} flexShrink={0}>
          {button(sendLabel, rows.length)}
          <text wrapMode="none" height={1} fg={plainFg}>
            {"  "}
          </text>
          {button(refuseLabel, rows.length + 1)}
        </box>
        <Line
          segments={
            missing === null
              ? cut(hintSegments(formKeys, theme, inner + 2).slice(1), inner)
              : cut([seg(missing, looks.error)], inner)
          }
        />
      </box>
    </>
  )
}

/**
 * The answer form (Box.Form) for the request `requestId`, while it is open; once it isn't, the
 * form closes with a toast.
 */
export const AnswerForm = ({
  requestId,
  ticket,
}: {
  readonly requestId: string
  readonly ticket: string
}) => {
  const request = useRunViewPart((view) => view.requests.find((each) => each.id === requestId))
  const { box, toasts } = useInput()
  const form = useMemo(() => (request === undefined ? undefined : formOf(request)), [request])
  const close = () => {
    const open = box.get()
    if (open?._tag === "Form" && open.requestId === requestId) box.set(null)
  }
  const gone = request === undefined || form === undefined
  // biome-ignore lint/correctness/useExhaustiveDependencies: close reads the box as it is then
  useEffect(() => {
    if (!gone) return
    close()
    toasts.show(staleToast(ticket))
  }, [gone])
  if (request === undefined || form === undefined) return null
  return <FormBody key={request.id} request={request} form={form} close={close} />
}

/** The form's Esc, bound while no box is open too, so that it works from the moment it opens. */
export const AnswerFormKeys = () => {
  const { box } = useInput()
  useLayer("box", [{ key: "escape", run: () => box.set(null) }], "Form")
  return null
}
