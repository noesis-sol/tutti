// The templates are imported as text (`with { type: "text" }`), which Bun's types declare only from
// TypeScript 7.1; until then, this declares the Markdown ones, the runners' headers and the
// .gitignore.
declare module "*.md" {
  const text: string
  export default text
}

declare module "*.sh" {
  const text: string
  export default text
}

declare module "*/tutti-gitignore" {
  const text: string
  export default text
}
