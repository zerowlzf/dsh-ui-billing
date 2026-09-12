/** CSS Modules type face for this package's own stylesheets. */

declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
