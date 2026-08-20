import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import type { RouteScan } from './types.js'
import { parsePatchEntries } from './patch.js'

const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'])
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage'])

function walkFiles(dir: string, out: string[]): void {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry)) continue
    const full = join(dir, entry)
    try {
      const st = statSync(full)
      if (st.isDirectory()) {
        walkFiles(full, out)
      } else if (st.isFile() && SOURCE_EXTS.has(extname(full))) {
        out.push(full)
      }
    } catch {
      // ignore unreadable entries
    }
  }
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Extract route prefixes/exact paths from one source file.
 * It first looks for `kind: prefix|exact` + `path:` registration blocks,
 * then falls back to conservative route-looking literals.
 */
export function extractRoutesFromFile(file: string): { prefixes: string[]; exact: string[]; dynamicRoutes: string[] } {
  const src = readFileSync(file, 'utf8')
  // Drop pure comment lines so route-like text in comments is not treated as code.
  const code = src.split(/\r?\n/).filter((line) => {
    const t = line.trim()
    return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'))
  }).join('\n')
  const prefixes = new Set<string>()
  const exact = new Set<string>()
  const dynamicRoutes = new Set<string>()

  // Build constant route assignments (e.g. `const ROUTE_PREFIX = '/pet'`).
  const assignments = new Map<string, string>()
  const assignRe = /(?:const|let|var|export\s+const)\s+([A-Za-z_$][\w$]*)\s*=\s*['"`](\/[^'"`]+)['"`]/g
  let m: RegExpExecArray | null
  while ((m = assignRe.exec(code)) !== null) {
    assignments.set(m[1], m[2])
  }

  // Split object literals into balanced blocks, then look for `kind:` and
  // `path:` inside the SAME block. This catches both inline `register({...})`
  // and route objects registered indirectly (e.g. `routes.map(r => register(r))`).
  for (const block of collectObjectBlocks(code)) {
    const kindMatch = block.match(/kind:\s*['"](prefix|exact)['"]/)
    const pathMatch = block.match(/path:\s*([A-Za-z_$][\w$]*|['"`][^'"`]+['"`])/)
    if (!kindMatch || !pathMatch) continue
    const kind = kindMatch[1]
    const raw = pathMatch[1]
    let path = raw
    if (path.startsWith("'") || path.startsWith('"') || path.startsWith('`')) {
      path = path.slice(1, -1)
    } else {
      if (!assignments.has(raw)) dynamicRoutes.add(raw)
      path = assignments.get(raw) ?? ''
    }
    if (!path.startsWith('/')) continue
    if (path.startsWith('//') || path.includes('/../') || /\.(js|json|webm|mp4|png|jpe?g|gif|css|map|d\.ts)$/i.test(path)) continue
    if (path === '/plugins' || path === '/plugins/' || path === '/api' || path === '/api/' || path === '/favicon.ico') continue
    if (path === '/pet' || path === '/pet/' || path.startsWith('/pet/')) {
      prefixes.add('/pet')
      continue
    }
    if (kind === 'prefix') prefixes.add(path)
    else exact.add(path)
  }

  return {
    prefixes: [...prefixes].sort(),
    exact: [...exact].sort(),
    dynamicRoutes: [...dynamicRoutes].sort(),
  }
}

/**
 * Collect every balanced object-literal block in a source file. Each block is
 * self-contained, so kind/path pairs cannot be assembled across unrelated
 * objects.
 */
function collectObjectBlocks(code: string): string[] {
  const blocks: string[] = []
  const re = /\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    const start = m.index
    let depth = 1
    let i = start + 1
    let quote: string | null = null
    let escaped = false
    while (i < code.length && depth > 0) {
      const ch = code[i]
      if (quote) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch
      } else if (ch === '{') {
        depth += 1
      } else if (ch === '}') {
        depth -= 1
      }
      i += 1
    }
    blocks.push(code.slice(start, i))
  }
  return blocks
}

export function extractServicesFromFile(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  const code = src.split(/\r?\n/).filter((line) => {
    const t = line.trim()
    return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'))
  }).join('\n')
  const services = new Set<string>()
  const re = /(?:ctx\.provide|provide)\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) services.add(m[1])
  const constRe = /(?:export\s+)?const\s+(?:provide|service)\s*=\s*['"]([^'"]+)['"]/g
  while ((m = constRe.exec(code)) !== null) services.add(m[1])
  return [...services].sort()
}

function collectSlotRegisterBlocks(code: string): string[] {
  const blocks: string[] = []
  const re = /slots\.register\s*\(\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    const start = m.index + m[0].length - 1
    let depth = 1
    let i = start + 1
    let quote: string | null = null
    let escaped = false
    while (i < code.length && depth > 0) {
      const ch = code[i]
      if (quote) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch
      } else if (ch === '{') {
        depth += 1
      } else if (ch === '}') {
        depth -= 1
      }
      i += 1
    }
    blocks.push(code.slice(start, i))
  }
  return blocks
}

export function extractSlotsFromFile(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  const code = src.split(/\r?\n/).filter((line) => {
    const t = line.trim()
    return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'))
  }).join('\n')
  const slots = new Set<string>()
  for (const block of collectSlotRegisterBlocks(code)) {
    const name = block.match(/name:\s*['"]([^'"]+)['"]/)?.[1]
    const id = block.match(/id:\s*['"]([^'"]+)['"]/)?.[1]
    if (name) slots.add(id ? `${name}#${id}` : name)
  }
  return [...slots].sort()
}

/** Scan a plugin package directory for route declarations and patch ids. */
export function scanPackage(packageDir: string): RouteScan {
  const pkgJsonPath = join(packageDir, 'package.json')
  const pkg = readJson(pkgJsonPath)
  const packageName = pkg?.name ?? packageDir

  const prefixes = new Set<string>()
  const exact = new Set<string>()
  const services = new Set<string>()
  const slots = new Set<string>()
  const dynamicRoutes = new Set<string>()
  const files: string[] = []
  for (const sub of ['lib', 'src']) {
    const dir = join(packageDir, sub)
    if (existsSync(dir)) walkFiles(dir, files)
  }
  if (files.length === 0 && existsSync(join(packageDir, 'index.js'))) {
    files.push(join(packageDir, 'index.js'))
  }

  for (const file of files) {
    const r = extractRoutesFromFile(file)
    for (const p of r.prefixes) prefixes.add(p)
    for (const p of r.exact) exact.add(p)
    for (const d of r.dynamicRoutes || []) dynamicRoutes.add(d)
    for (const s of extractServicesFromFile(file)) services.add(s)
    for (const s of extractSlotsFromFile(file)) slots.add(s)
  }

  const deps: Record<string, string> = {}
  const section = pkg?.peerDependencies
  if (section && typeof section === 'object') {
    for (const [name, range] of Object.entries(section)) deps[name] = String(range)
  }

  const ids = new Set<string>()
  const patchRel = pkg?.dsh?.bundle?.patch
  if (patchRel && typeof patchRel === 'string') {
    const patchPath = join(packageDir, patchRel)
    if (existsSync(patchPath)) {
      const text = readFileSync(patchPath, 'utf8')
      for (const e of parsePatchEntries(text, packageName)) {
        ids.add(e.id)
      }
    }
  }
  if (ids.size === 0 && packageName) ids.add(packageName)

  return {
    packageName,
    packageDir,
    prefixes: [...prefixes].sort(),
    exact: [...exact].sort(),
    ids: [...ids].sort(),
    services: [...services].sort(),
    slots: [...slots].sort(),
    dynamicRoutes: [...dynamicRoutes].sort(),
    deps,
  }
}
