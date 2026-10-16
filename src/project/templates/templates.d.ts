// The templates are imported as text (`with { type: "text" }`), which Bun's types declare only from
// TypeScript 7.1; until then, this declares the Markdown ones.
declare module "*.md" {
  const text: string
  export default text
}
