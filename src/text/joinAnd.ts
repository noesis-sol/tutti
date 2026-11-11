// Lists items as a sentence does, for init's steps, the pre-flight and the templates' notices.

/** Lists items as a sentence does: "a", "a and b", "a, b and c". */
export const joinAnd = (items: ReadonlyArray<string>): string =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
