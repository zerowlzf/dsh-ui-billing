// Keep this repository and a DSH checkout's copy of the plugin in step.
//
//   node sync.mjs --from-dsh <checkout>   copy <checkout>/packages/client/ui-billing -> here
//   node sync.mjs --into-dsh <checkout>   copy here -> <checkout>/packages/client/ui-billing
//   node sync.mjs --check <checkout>      report differences without writing anything
//
// The plugin is developed inside the DSH checkout, where the harness workspace
// resolves its imports and runs its gates; this repository is the release
// snapshot of that package directory. Only package files travel: build output
// (`lib/`) and installed dependencies (`node_modules/`) are ignored on both
// sides, and nothing outside the package directory is ever touched.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Every path the package owns, relative to the package directory. */
const PACKAGE_PATHS = [
  'src',
  'tests',
  'package.json',
  'tsconfig.json',
  'tsconfig.client.json',
  'tsconfig.host.json',
  'tsdown.config.ts',
  'README.md',
  'README.zh.md',
  'README.i18n.yaml',
]

/** Directory names that are never part of the source of record. */
const IGNORED_DIRECTORIES = new Set(['lib', 'node_modules', 'coverage', '.sessions'])

/**
 * Read this package's own files out of one directory tree.
 * @param root - the directory holding the package (or this repository's root).
 * @returns one entry per file, keyed by its path relative to `root`.
 */
function readTree(root) {
  const files = new Map()
  const record = (path) => {
    files.set(relative(root, path).split(sep).join('/'), readFileSync(path, 'utf8'))
  }
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry)
      if (statSync(path).isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry)) walk(path)
        continue
      }
      record(path)
    }
  }
  for (const item of PACKAGE_PATHS) {
    const path = join(root, item)
    if (!existsSync(path)) continue
    if (statSync(path).isDirectory()) walk(path)
    else record(path)
  }
  return files
}

/**
 * Compare two package trees.
 * @param left - first tree.
 * @param right - second tree.
 * @returns the file names that differ, in path order.
 */
function differences(left, right) {
  const names = new Set([...left.keys(), ...right.keys()])
  return [...names].sort().filter(name => left.get(name) !== right.get(name))
}

/**
 * Copy every package path from one tree over the other.
 * @param from - tree to read.
 * @param to - tree to replace those paths in.
 */
function copyInto(from, to) {
  for (const item of PACKAGE_PATHS) {
    const source = join(from, item)
    if (!existsSync(source)) continue
    const target = join(to, item)
    rmSync(target, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target, {
      recursive: true,
      filter: path => !IGNORED_DIRECTORIES.has(path.split(sep).pop()),
    })
  }
}

const [mode, checkout] = process.argv.slice(2)
if (!['--from-dsh', '--into-dsh', '--check'].includes(mode ?? '') || checkout === undefined) {
  console.error('usage: node sync.mjs --from-dsh|--into-dsh|--check <dsh-checkout>')
  process.exit(2)
}

const here = dirname(fileURLToPath(import.meta.url))
const packageDirectory = resolve(checkout, 'packages', 'client', 'ui-billing')
if (!existsSync(packageDirectory)) {
  console.error(`sync: ${packageDirectory} does not exist; is that a DSH checkout?`)
  process.exit(2)
}

if (mode === '--check') {
  const changed = differences(readTree(packageDirectory), readTree(here))
  if (changed.length === 0) {
    console.log('sync: this repository matches the checkout package.')
    process.exit(0)
  }
  console.error(`sync: ${String(changed.length)} file(s) differ from the checkout package:`)
  for (const name of changed) console.error(`  ${name}`)
  process.exit(1)
}

if (mode === '--from-dsh') {
  copyInto(packageDirectory, here)
  console.log(`sync: copied ${packageDirectory} -> here`)
} else {
  copyInto(here, packageDirectory)
  console.log(`sync: copied here -> ${packageDirectory}`)
}
