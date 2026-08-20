import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PluginEntry } from './types.js'
import { parsePatchEntries } from './patch.js'
import { scanPackage } from './scanner.js'

export function detectProfileName(configProfile?: string): string {
  if (configProfile) return configProfile
  const argv = process.argv
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--profile' && argv[i + 1]) return argv[i + 1]
    if (arg.startsWith('--profile=')) return arg.slice('--profile='.length)
  }
  return 'web'
}

export function resolveProfileDir(profile: string): string {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'profiles', profile)
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

export function resolvePackageDir(profileDir: string, packageName: string): string | undefined {
  const candidates = [
    join(profileDir, 'node_modules', packageName),
    join(profileDir, '..', 'node_modules', packageName),
  ]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return resolve(candidate)
  }
  return undefined
}

function resolveEntryPackageDir(profileDir: string, name?: string): string | undefined {
  if (!name || name.startsWith('.') || name.startsWith('/') || name.startsWith('file:')) return undefined
  let base = name
  const scoped = name.match(/^(@[^/]+\/[^/]+)(?:\/.*)?$/)
  if (scoped) base = scoped[1]
  else {
    const plain = name.match(/^([^/]+)(?:\/.*)?$/)
    if (plain) base = plain[1]
  }
  return resolvePackageDir(profileDir, base)
}

/**
 * Build the effective plugin roster for a profile:
 * bundle patches in order + the profile's own cordis.patch.yml.
 */
export function loadActiveEntries(profileDir: string): PluginEntry[] {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) return []

  const manifest = readJson(manifestPath)
  const bundles: string[] = manifest?.dsh?.profile?.bundles ?? []
  const map = new Map<string, PluginEntry>()

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
          services: [],
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
          services: [],
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
          services: [],
        })
      }
    }
  }

  const entries = [...map.values()]
  for (const entry of entries) {
    if (entry.disabled) continue
    const moduleDir = resolveEntryPackageDir(profileDir, entry.name)
    const scanDir = moduleDir || (entry.packageDir && existsSync(entry.packageDir) ? entry.packageDir : undefined)
    if (scanDir) {
      const scan = scanPackage(scanDir)
      entry.packageDir = scanDir
      entry.prefixes = scan.prefixes
      entry.exact = scan.exact
      entry.services = scan.services
    }
  }
  return entries
}

export interface StructureIssue {
  severity: 'error' | 'warning'
  message: string
}

export function auditProfileStructure(profileDir: string): StructureIssue[] {
  const issues: StructureIssue[] = []
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    issues.push({ severity: 'error', message: `profile manifest not found: ${manifestPath}` })
    return issues
  }

  const manifest = readJson(manifestPath)
  const bundles: string[] = manifest?.dsh?.profile?.bundles ?? []
  const idOwners = new Map<string, string>()
  const reportedCrossDuplicates = new Set<string>()

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

    const patchRel = pkg.dsh.bundle.patch as string
    const patchPath = join(pkgDir, patchRel)
    if (!existsSync(patchPath)) {
      issues.push({ severity: 'error', message: `bundle "${bundle}" declares patch "${patchRel}" but file is missing` })
      continue
    }

    const text = readFileSync(patchPath, 'utf8')
    const entries = parsePatchEntries(text, bundle)
    const seen = new Map<string, number>()
    for (const e of entries) {
      if (!e.id) {
        issues.push({ severity: 'error', message: `bundle "${bundle}" has an insert entry without id` })
      } else {
        const count = (seen.get(e.id) || 0) + 1
        seen.set(e.id, count)
        if (count > 1) issues.push({ severity: 'error', message: `bundle "${bundle}" has duplicate id "${e.id}"` })

        // Official @deepseek-ai core bundles intentionally share/override ids
        // (e.g. dsh-base vs dsh-web-app). Only flag cross-bundle duplicates
        // between non-official third-party bundles.
        const owner = idOwners.get(e.id)
        if (owner !== undefined && owner !== bundle && !isOfficialBundle(owner) && !isOfficialBundle(bundle)) {
          if (!reportedCrossDuplicates.has(e.id)) {
            reportedCrossDuplicates.add(e.id)
            issues.push({
              severity: 'error',
              message: `loader id "${e.id}" is registered by both bundle "${owner}" and bundle "${bundle}"`,
            })
          }
        } else if (owner === undefined) {
          idOwners.set(e.id, bundle)
        }
      }
    }
  }

  const profilePatchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(profilePatchPath)) {
    issues.push({ severity: 'warning', message: `profile patch file missing: ${profilePatchPath}` })
  } else {
    const text = readFileSync(profilePatchPath, 'utf8')
    const entries = parsePatchEntries(text, '')
    const seen = new Map<string, number>()
    for (const e of entries) {
      if (!e.id) issues.push({ severity: 'error', message: `profile patch has an insert entry without id` })
      else {
        const count = (seen.get(e.id) || 0) + 1
        seen.set(e.id, count)
        if (count > 1) issues.push({ severity: 'error', message: `profile patch has duplicate id "${e.id}"` })
      }
    }
  }

  return issues
}

function isOfficialBundle(name: string): boolean {
  return name.startsWith('@deepseek-ai/')
}
