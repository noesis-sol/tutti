// The answer form (§ 4.5, § 7.3): what a card can't hold, answered in the worker view. A question
// request's questions, each with its options and Other to type your own, one or several picked; an
// elicitation's fields from its requestedSchema (MCP's flat form: text, numbers, a yes/no, one or
// several of an enum). This module is the form without its drawing: its fields, the rows the focus
// moves between, what picking does, and the Answer the values make (Choose, or Accept with content),
// or the first field still missing a value.
//
// A requestedSchema comes from an MCP server and is read as untrusted: whatever isn't a property
// the form knows is a text field, and every title, description and label is sanitised to be shown.
// The values sent back are the schema's own, as it gave them.
import { Predicate } from "effect"
import type { Answer, AttentionRequest } from "../agent/Attention.ts"
import { sanitizeLine } from "./sanitize.ts"

/** One of a choice's options: its label shown, and the value sent for it. */
export interface Option {
  readonly label: string
  readonly value: string
  readonly description?: string
}

/** A field of the form. */
export type Field =
  | {
      /** One option or, `multi`, several; with `other`, also your own text. */
      readonly _tag: "Choice"
      readonly key: string
      readonly title: string
      readonly header?: string
      readonly description?: string
      readonly options: ReadonlyArray<Option>
      readonly multi: boolean
      readonly other: boolean
      readonly required: boolean
      readonly min?: number
      readonly max?: number
    }
  | {
      /** A line you type: text, or a number (`integer` a whole one). */
      readonly _tag: "Text"
      readonly key: string
      readonly title: string
      readonly description?: string
      readonly number: "number" | "integer" | null
      readonly required: boolean
      readonly min?: number
      readonly max?: number
    }
  | {
      /** Yes or no. */
      readonly _tag: "Toggle"
      readonly key: string
      readonly title: string
      readonly description?: string
    }

/** A field's value: the options picked (a Choice's Other is the index past its options), its text, a Toggle's state. */
export interface Value {
  readonly picked: ReadonlyArray<number>
  readonly text: string
  readonly on: boolean
}

/** The form a request is answered with: a question's or an elicitation's. */
export interface Form {
  readonly kind: "Question" | "Elicitation"
  readonly fields: ReadonlyArray<Field>
}

/** A place the focus rests: an option of a field (a Choice's Other past its options), or its line. */
export interface Row {
  readonly field: number
  readonly option: number
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  Predicate.isObject(value) ? value : undefined

const text = (value: unknown): string | undefined =>
  typeof value === "string" && sanitizeLine(value).trim() !== ""
    ? sanitizeLine(value).trim()
    : undefined

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

/** `{ key: value }`, or nothing when value is undefined. */
const maybe = <K extends string, V>(key: K, value: V | undefined): { [k in K]?: V } =>
  (value === undefined ? {} : { [key]: value }) as { [k in K]?: V }

/**
 * The options a schema gives: `enum` (labelled by `enumNames` when it names each), or `oneOf` /
 * `anyOf` of `{ const, title }`. Only string values are options.
 */
const optionsOf = (
  schema: Readonly<Record<string, unknown>>,
): ReadonlyArray<Option> | undefined => {
  if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : []
    const all = schema.enum.length === names.length
    return schema.enum.flatMap((value, i) =>
      typeof value === "string"
        ? [
            {
              value,
              label: (all ? text(names[i]) : undefined) ?? (sanitizeLine(value) || "(empty)"),
            },
          ]
        : [],
    )
  }
  const listed = Array.isArray(schema.oneOf) ? schema.oneOf : schema.anyOf
  if (!Array.isArray(listed)) return undefined
  return listed.flatMap((each) => {
    const option = record(each)
    const value = option?.const
    return typeof value === "string"
      ? [
          {
            value,
            label: text(option?.title) ?? (sanitizeLine(value) || "(empty)"),
            ...maybe("description", text(option?.description)),
          },
        ]
      : []
  })
}

/** A field of an elicitation's form from its schema property `key`. */
const fieldOf = (key: string, property: unknown, required: boolean): Field => {
  const schema = record(property) ?? {}
  const shown = {
    key,
    title: text(schema.title) ?? (sanitizeLine(key) || "(unnamed)"),
    ...maybe("description", text(schema.description)),
  }
  const type = schema.type
  if (type === "boolean") return { _tag: "Toggle", ...shown }
  if (type === "array") {
    const options = optionsOf(record(schema.items) ?? {})
    if (options !== undefined && options.length > 0) {
      return {
        _tag: "Choice",
        ...shown,
        options,
        multi: true,
        other: false,
        required,
        ...maybe("min", finite(schema.minItems)),
        ...maybe("max", finite(schema.maxItems)),
      }
    }
  }
  const options = optionsOf(schema)
  if (options !== undefined && options.length > 0) {
    return { _tag: "Choice", ...shown, options, multi: false, other: false, required }
  }
  const number = type === "number" || type === "integer" ? type : null
  return {
    _tag: "Text",
    ...shown,
    number,
    required,
    ...maybe("min", finite(number === null ? schema.minLength : schema.minimum)),
    ...maybe("max", finite(number === null ? schema.maxLength : schema.maximum)),
  }
}

/** The form that answers `request`: its questions, or its elicitation's fields; none for a permission. */
export const formOf = (request: AttentionRequest): Form | undefined => {
  const kind = request.kind
  switch (kind._tag) {
    case "Permission":
      return undefined
    case "Question":
      return {
        kind: "Question",
        fields: kind.questions.map((question, i) => ({
          _tag: "Choice",
          key: String(i),
          title: sanitizeLine(question.question),
          ...maybe("header", text(question.header)),
          options: question.options.map((option) => ({
            label: sanitizeLine(option.label),
            value: option.label,
            ...maybe("description", text(option.description)),
          })),
          multi: question.multiSelect,
          other: true,
          required: true,
        })),
      }
    case "Elicitation": {
      const schema = record(kind.requestedSchema) ?? {}
      const properties = record(schema.properties) ?? {}
      const required = Array.isArray(schema.required) ? schema.required : []
      return {
        kind: "Elicitation",
        fields: Object.entries(properties).map(([key, property]) =>
          fieldOf(key, property, required.includes(key)),
        ),
      }
    }
  }
}

/** The schema property of field `key` in `request`'s elicitation, for its default. */
const propertyOf = (request: AttentionRequest, key: string): Readonly<Record<string, unknown>> => {
  if (request.kind._tag !== "Elicitation") return {}
  return record(record(record(request.kind.requestedSchema)?.properties)?.[key]) ?? {}
}

/** A field's value with nothing picked or typed. */
const emptyValue: Value = { picked: [], text: "", on: false }

/** `field`'s value as the form opens with the schema's default `given`. */
const initialValue = (field: Field, given: unknown): Value => {
  switch (field._tag) {
    case "Toggle":
      return { ...emptyValue, on: given === true }
    case "Text":
      return typeof given === "string" || finite(given) !== undefined
        ? { ...emptyValue, text: sanitizeLine(String(given)) }
        : emptyValue
    case "Choice": {
      const values = Array.isArray(given) ? given : [given]
      const picked = field.options.flatMap((option, i) =>
        values.includes(option.value) ? [i] : [],
      )
      return { ...emptyValue, picked: field.multi ? picked : picked.slice(0, 1) }
    }
  }
}

/** Each field's value as the form opens: the schema's defaults, else nothing picked or typed. */
export const initialValues = (request: AttentionRequest, form: Form): ReadonlyArray<Value> =>
  form.fields.map((field) => initialValue(field, propertyOf(request, field.key).default))

/** How many rows a field has: a Choice's options and its Other; one for the rest. */
export const rowsOfField = (field: Field): number =>
  field._tag === "Choice" ? field.options.length + (field.other ? 1 : 0) : 1

/** Every row of the form, in order. */
export const rowsOf = (form: Form): ReadonlyArray<Row> =>
  form.fields.flatMap((field, i) =>
    Array.from({ length: rowsOfField(field) }, (_, option) => ({ field: i, option })),
  )

/** Whether a row is a line you type in: a Text field, or a Choice's Other. */
export const typesAt = (form: Form, row: Row): boolean => {
  const field = form.fields[row.field]
  return (
    field?._tag === "Text" ||
    (field?._tag === "Choice" && field.other && row.option === field.options.length)
  )
}

/**
 * `value` with option `option` of `field` picked, as Space, Enter or `1`–`9` pick it: one of a
 * single choice replaces what was picked; one of a multiple choice is added, or taken out if it
 * was picked. A Toggle flips.
 */
export const pick = (field: Field, value: Value, option: number): Value => {
  switch (field._tag) {
    case "Toggle":
      return { ...value, on: !value.on }
    case "Text":
      return value
    case "Choice":
      if (option < 0 || option >= rowsOfField(field)) return value
      if (!field.multi) return { ...value, picked: [option] }
      return value.picked.includes(option)
        ? { ...value, picked: value.picked.filter((each) => each !== option) }
        : { ...value, picked: [...value.picked, option].sort((a, b) => a - b) }
  }
}

/** `value` with `typed` in its line: typing in a Choice's Other picks it, emptying it unpicks it. */
export const typeIn = (field: Field, value: Value, typed: string): Value => {
  if (field._tag !== "Choice") return { ...value, text: typed }
  const other = field.options.length
  const rest = value.picked.filter((each) => each !== other)
  if (typed.trim() === "") return { ...value, text: typed, picked: rest }
  return {
    ...value,
    text: typed,
    picked: field.multi ? [...rest, other] : [other],
  }
}

/** What the form's values make: the answer, or the first field missing a value and why. */
export type Outcome =
  | { readonly _tag: "Answer"; readonly answer: Answer }
  | { readonly _tag: "Missing"; readonly field: number; readonly message: string }

/** What a field's value gives: its value, nothing, or why it can't be sent. */
type Given = { readonly value: string | number | boolean | ReadonlyArray<string> } | null | string

const bounds = (what: string, min: number | undefined, max: number | undefined): string =>
  min !== undefined && max !== undefined
    ? `${what} from ${min} to ${max}`
    : min !== undefined
      ? `${what} of at least ${min}`
      : `${what} of at most ${max}`

const outside = (n: number, min: number | undefined, max: number | undefined): boolean =>
  (min !== undefined && n < min) || (max !== undefined && n > max)

/** What `field`'s `value` gives. A question's choice is its labels, joined by ", " when several. */
const givenOf = (field: Field, value: Value): Given => {
  switch (field._tag) {
    case "Toggle":
      return { value: value.on }
    case "Text": {
      const typed = value.text.trim()
      if (typed === "") return null
      if (field.number === null) {
        const length = [...value.text].length
        return outside(length, field.min, field.max)
          ? `needs ${bounds("a length", field.min, field.max)}`
          : { value: value.text }
      }
      const n = Number(typed)
      if (!Number.isFinite(n)) return "needs a number"
      if (field.number === "integer" && !Number.isInteger(n)) return "needs a whole number"
      return outside(n, field.min, field.max)
        ? `needs ${bounds("a number", field.min, field.max)}`
        : { value: n }
    }
    case "Choice": {
      const own = value.text.trim()
      const chosen = value.picked.flatMap((i) => {
        const option = field.options[i]
        if (option !== undefined) return [option.value]
        return field.other && i === field.options.length && own !== "" ? [own] : []
      })
      if (chosen.length === 0) return null
      if (field.other) return { value: chosen.join(", ") }
      if (!field.multi) return { value: chosen[0] ?? "" }
      return outside(chosen.length, field.min, field.max)
        ? `needs ${bounds("a choice", field.min, field.max)}`
        : { value: chosen }
    }
  }
}

/** Whether a field must be given before the form is sent. */
const requiredOf = (field: Field): boolean => field._tag !== "Toggle" && field.required

/**
 * The answer `form`'s `values` make: a question's Choose, one answer a question in order (an
 * option's label, your own text, or several joined by ", "); an elicitation's Accept, its content
 * the fields given. Missing: the first required field with nothing, or a value out of its bounds.
 */
export const answerOf = (form: Form, values: ReadonlyArray<Value>): Outcome => {
  const content: Record<string, string | number | boolean | ReadonlyArray<string>> = {}
  const answers: Array<string> = []
  for (const [i, field] of form.fields.entries()) {
    const given = givenOf(field, values[i] ?? emptyValue)
    if (typeof given === "string")
      return { _tag: "Missing", field: i, message: `${field.title} ${given}` }
    if (given === null) {
      if (requiredOf(field)) {
        const what = field._tag === "Choice" ? "Choose an answer to" : "Fill in"
        return { _tag: "Missing", field: i, message: `${what} ${field.title}` }
      }
      continue
    }
    content[field.key] = given.value
    answers.push(String(given.value))
  }
  return form.kind === "Question"
    ? { _tag: "Answer", answer: { _tag: "Choose", answers } }
    : { _tag: "Answer", answer: { _tag: "Accept", content } }
}

/** The answer the form's other button sends: a question denied, an elicitation declined. */
export const refusalOf = (form: Form): Answer =>
  form.kind === "Question" ? { _tag: "Deny" } : { _tag: "Decline" }

/** The form's buttons' labels: the one that sends it, and the one that refuses. */
export const buttonLabels = (form: Form): readonly [string, string] =>
  form.kind === "Question" ? ["Answer", "Deny"] : ["Accept", "Decline"]
