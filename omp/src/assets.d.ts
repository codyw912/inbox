// The Tern page imports its stylesheet with Bun's text import attribute.
declare module '*.css' {
  const css: string
  export default css
}
