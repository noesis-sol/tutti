// The soak's React tree: 16 cards over one transcript scrollbox, read from the stores with
// useSyncExternalStore (spec § 3.5).

import type { SyntaxStyle } from "@opentui/core"
import { memo, useSyncExternalStore } from "react"
import type { Item } from "./content.ts"
import { streamingText } from "./content.ts"
import type { Card, ExternalStore, RunView, Transcript } from "./store.ts"

// One line per field, cut to the card's width: a text that wraps in a fixed-height box is drawn
// over its siblings. `joined` passes each line as one string; otherwise JSX interpolation gives a
// <text> several children.
const CardView = memo(function CardView({ card, joined }: { card: Card; joined: boolean }) {
  const lines = joined
    ? [
        `${card.id} ${card.phase} ${card.elapsed}s`,
        card.title,
        `▸ ${card.activity} · ${card.tokens} tokens`,
      ]
    : [
        <>
          {card.id} {card.phase} {card.elapsed}s
        </>,
        card.title,
        <>
          ▸ {card.activity} · {card.tokens} tokens
        </>,
      ]
  return (
    <box border borderStyle="rounded" flexGrow={1} flexBasis={0} height={5} paddingX={1}>
      <text fg="#c0caf5" wrapMode="none" truncate>
        {lines[0]}
      </text>
      <text fg="#7aa2f7" wrapMode="none" truncate>
        {lines[1]}
      </text>
      <text fg="#9ece6a" wrapMode="none" truncate>
        {lines[2]}
      </text>
    </box>
  )
})

export const Dashboard = ({
  store,
  perRow,
  joined,
}: {
  store: ExternalStore<RunView>
  perRow: number
  joined: boolean
}) => {
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const rows: Card[][] = []
  for (let i = 0; i < view.cards.length; i += perRow) rows.push(view.cards.slice(i, i + perRow))
  return (
    <box flexDirection="column" flexShrink={0}>
      {rows.map((row, i) => (
        <box key={`row${i}`} flexDirection="row">
          {row.map((card) => (
            <CardView key={card.id} card={card} joined={joined} />
          ))}
        </box>
      ))}
    </box>
  )
}

const ItemView = memo(function ItemView({ item, style }: { item: Item; style: SyntaxStyle }) {
  switch (item.kind) {
    case "markdown":
      return <markdown content={item.text} syntaxStyle={style} />
    case "code":
      return (
        <box flexDirection="column">
          <text fg="#7aa2f7">{item.title}</text>
          <code content={item.code} filetype="typescript" syntaxStyle={style} />
        </box>
      )
    case "diff":
      return (
        <box flexDirection="column">
          <text fg="#7aa2f7">{item.title}</text>
          <diff diff={item.diff} filetype="typescript" syntaxStyle={style} height={12} />
        </box>
      )
  }
})

export const TranscriptView = ({
  store,
  style,
}: {
  store: ExternalStore<Transcript>
  style: SyntaxStyle
}) => {
  const t = useSyncExternalStore(store.subscribe, store.getSnapshot)
  return (
    <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" border borderStyle="single">
      {t.items.map((item) => (
        <ItemView key={item.id} item={item} style={style} />
      ))}
      {t.streaming && (
        <markdown
          key={`s${t.streaming.id}`}
          content={streamingText(t.streaming.id, t.streaming.chars)}
          syntaxStyle={style}
          streaming
        />
      )}
    </scrollbox>
  )
}

export const App = (props: {
  runView: ExternalStore<RunView>
  transcript: ExternalStore<Transcript>
  style: SyntaxStyle
  perRow: number
  joinedCardText?: boolean
}) => (
  <box flexDirection="column" width="100%" height="100%">
    <Dashboard store={props.runView} perRow={props.perRow} joined={props.joinedCardText ?? false} />
    <TranscriptView store={props.transcript} style={props.style} />
  </box>
)
