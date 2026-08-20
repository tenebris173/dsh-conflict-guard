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

  const blockRe = /kind:\s*['"](prefix|exact)['"][\s\S]{0,400}?path:\s*['"]([^'"]+)['"]|path:\s*['"]([^'"]+)['"][\s\S]{0,400}?kind:\s*['"](prefix|exact)['"]/g
  let m
  while ((m = blockRe.exec(code)) !== null) {
    const kind = m[1] ?? m[4]
    const path = m[2] ?? m[3]
    if (!path.startsWith('/')) continue
    if (kind === 'prefix') prefixes.add(path)
    else exact.add(path)
  }

  const mentionsRouting = /register|webServer|ctx\.router|router\.(get|post|all|use)/.test(code)
  if (mentionsRouting) {
    // Catch constant assignments like `const ROUTE_PREFIX = '/pet'` or
    // `export const PET_API_PREFIX = '/api/pet'`. This avoids treating
    // strings in comments/examples as real plugin routes.
    const constRe = /(?:const|let|var|export\s+const)\s+[A-Za-z0-9_]+\s*=\s*['"`](\/[A-Za-z0-9_\-/{}.:]+)['"`]/g
    while ((m = constRe.exec(code)) !== null) {
      const p = m[1]
      if (!p.startsWith('/')) continue
      if (p.startsWith('//') || p.includes('/../') || /\.(js|json|webm|mp4|png|jpe?g|gif|css|map|d\.ts)$/i.test(p)) continue
      if (p === '/plugins' || p === '/plugins/' || p === '/api' || p === '/api/' || p === '/favicon.ico') continue
      if (p === '/pet' || p === '/pet/' || p.startsWith('/pet/')) {
        prefixes.add('/pet')
        continue
      }
      if (p.startsWith('/api/')) {
        prefixes.add(p)
      }
    }
  }

  return {
    prefixes: [...prefixes].sort(),
    exact: [...exact].sort(),
  }
}

export function scanPackage(packageDir) {
  const pkgJsonPath = join(packageDir, 'package.json')
  const pkg = readJson(pkgJsonPath)
  const packageName = pkg?.name ?? packageDir

  const prefixes = new Set()
  const exact = new Set()
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
  }
}
