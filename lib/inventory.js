import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parsePatchEntries } from './patch.js'
import { scanPackage } from './scanner.js'

export function detectProfileName(configProfile) {
  if (configProfile) return configProfile
  const argv = process.argv
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--profile' && argv[i + 1]) return argv[i + 1]
    if (arg.startsWith('--profile=')) return arg.slice('--profile='.length)
  }
  return 'web'
}

export function resolveProfileDir(profile) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'profiles', profile)
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

export function resolvePackageDir(profileDir, packageName) {
  const candidates = [
    join(profileDir, 'node_modules', packageName),
    join(profileDir, '..', 'node_modules', packageName),
  ]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return resolve(candidate)
  }
  return undefined
}

export function loadActiveEntries(profileDir) {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) return []

  const manifest = readJson(manifestPath)
  const bundles = manifest?.dsh?.profile?.bundles ?? []
  const map = new Map()

  for (const bundle of bundles) {
    const pkgDir = resolvePackageDir(profileDir, bundle)
    if (!pkgDir) continue
    const pkg = readJson(join(pkgDir, 'package.json'))
    const patchRel = pkg?.dsh?.bundle?.patch
    if (!patchRel || typeof patchRel !== 'string') continue

    const patchPath = join(pkgDir, patchRel)
    if (!existsSync(patchPath)) continue
    const text = readFileSync(patchPath, 'utf8')
    for (const e of parsePatchEntries(text, bundle)) {
      const existing = map.get(e.id)
      if (existing) {
        if (e.name) existing.name = e.name
        if (e.disabled) existing.disabled = true
      } else {
        map.set(e.id, {
          id: e.id,
          name: e.name ?? bundle,
          packageName: bundle,
          packageDir: pkgDir,
          disabled: e.disabled,
          prefixes: [],
          exact: [],
        })
      }
    }
  }

  const profilePatchPath = join(profileDir, 'cordis.patch.yml')
  if (existsSync(profilePatchPath)) {
    const text = readFileSync(profilePatchPath, 'utf8')
    for (const e of parsePatchEntries(text, '')) {
      const existing = map.get(e.id)
      if (existing) {
        if (e.name) existing.name = e.name
        if (e.disabled) existing.disabled = true
      } else if (e.disabled) {
        map.set(e.id, {
          id: e.id,
          name: e.name ?? e.id,
          packageName: e.packageName ?? '',
          packageDir: '',
          disabled: true,
          prefixes: [],
          exact: [],
        })
      } else if (e.name) {
        const pkgDir = resolvePackageDir(profileDir, e.name)
        map.set(e.id, {
          id: e.id,
          name: e.name,
          packageName: e.name,
          packageDir: pkgDir ?? '',
          disabled: false,
          prefixes: [],
          exact: [],
        })
      }
    }
  }

  const entries = [...map.values()]
  for (const entry of entries) {
    if (entry.disabled) continue
    if (entry.packageDir && existsSync(entry.packageDir)) {
      const scan = scanPackage(entry.packageDir)
      entry.prefixes = scan.prefixes
      entry.exact = scan.exact
    }
  }
  return entries
}

export function auditProfileStructure(profileDir) {
  const issues = []
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    issues.push({ severity: 'error', message: `profile manifest not found: ${manifestPath}` })
    return issues
  }

  const manifest = readJson(manifestPath)
  const bundles = manifest?.dsh?.profile?.bundles ?? []

  for (const bundle of bundles) {
    const pkgDir = resolvePackageDir(profileDir, bundle)
    if (!pkgDir) {
      issues.push({ severity: 'error', message: `bundle "${bundle}" is listed but not installed/resolvable` })
      continue
    }

    const pkg = readJson(join(pkgDir, 'package.json'))
    if (!pkg?.dsh?.bundle?.patch) {
      issues.push({ severity: 'error', message: `bundle "${bundle}" has no dsh.bundle.patch declaration` })
      continue
    }

    const patchRel = pkg.dsh.bundle.patch
    const patchPath = join(pkgDir, patchRel)
    if (!existsSync(patchPath)) {
      issues.push({ severity: 'error', message: `bundle "${bundle}" declares patch "${patchRel}" but file is missing` })
      continue
    }

    const text = readFileSync(patchPath, 'utf8')
    const entries = parsePatchEntries(text, bundle)
    for (const e of entries) {
      if (!e.id) issues.push({ severity: 'error', message: `bundle "${bundle}" has an insert entry without id` })
    }
  }

  const profilePatchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(profilePatchPath)) {
    issues.push({ severity: 'warning', message: `profile patch file missing: ${profilePatchPath}` })
  }

  return issues
}
