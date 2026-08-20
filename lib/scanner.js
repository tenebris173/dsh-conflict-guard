import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { parsePatchEntries } from './patch.js'

const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'])
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage'])

function walkFiles(dir, out) {
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

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

export function extractRoutesFromFile(file) {
  const src = readFileSync(file, 'utf8')
  // Drop pure comment lines so route-like text in comments is not treated as code.
  const code = src.split(/\r?\n/).filter((line) => {
    const t = line.trim()
    return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'))
  }).join('\n')
  const prefixes = new Set()
  const exact = new Set()

  // Build constant route assignments (e.g. `const ROUTE_PREFIX = '/pet'`).
  const assignments = new Map()
  const assignRe = /(?:const|let|var|export\s+const)\s+([A-Za-z_$][\w$]*)\s*=\s*['"`](\/[^'"`]+)['"`]/g
  let m
  while ((m = assignRe.exec(code)) !== null) {
    assignments.set(m[1], m[2])
  }

  // Match route registration blocks: `kind: prefix|exact` with a literal or
  // constant `path:`. This avoids treating mere path mentions (like a proxy
  // checking `/pet`) as owning the route.
  const routeBlockRe = /kind:\s*['"](prefix|exact)['"][\s\S]{0,400}?path:\s*([A-Za-z_$][\w$]*|['"`][^'"`]+['"`])|path:\s*([A-Za-z_$][\w$]*|['"`][^'"`]+['"`])[\s\S]{0,400}?kind:\s*['"](prefix|exact)['"]/g
  while ((m = routeBlockRe.exec(code)) !== null) {
    const kind = m[1] ?? m[4]
    const raw = m[2] ?? m[3]
    let path = raw
    if (path.startsWith("'") || path.startsWith('"') || path.startsWith('`')) {
      path = path.slice(1, -1)
    } else {
      path = assignments.get(raw)
    }
    if (!path || !path.startsWith('/')) continue
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
  }
}

export function extractServicesFromFile(file) {
  const src = readFileSync(file, 'utf8')
  const code = src.split(/\r?\n/).filter((line) => {
    const t = line.trim()
    return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'))
  }).join('\n')
  const services = new Set()
  const re = /(?:ctx\.provide|provide)\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  let m
  while ((m = re.exec(code)) !== null) services.add(m[1])
  const constRe = /(?:export\s+)?const\s+(?:provide|service)\s*=\s*['"]([^'"]+)['"]/g
  while ((m = constRe.exec(code)) !== null) services.add(m[1])
  return [...services].sort()
}

export function scanPackage(packageDir) {
  const pkgJsonPath = join(packageDir, 'package.json')
  const pkg = readJson(pkgJsonPath)
  const packageName = pkg?.name ?? packageDir

  const prefixes = new Set()
  const exact = new Set()
  const services = new Set()
  const files = []
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
    for (const s of extractServicesFromFile(file)) services.add(s)
  }

  const ids = new Set()
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
  }
}
