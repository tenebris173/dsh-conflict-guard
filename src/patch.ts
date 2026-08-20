import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PatchEntry {
  id: string
  name?: string
  disabled: boolean
  packageName?: string
}

function cleanValue(value?: string): string | undefined {
  if (!value) return value
  return value.replace(/\s*#.*$/, '').trim()
}

/** Collect one top-level YAML list item starting at `start` (a `- ` line). */
function collectBlock(lines: string[], start: number): string {
  const out = [lines[start]]
  let i = start + 1
  while (i < lines.length) {
    const line = lines[i]
    if (/^-\s/.test(line)) break
    out.push(line)
    i++
  }
  return out.join('\n')
}

/**
 * Parse the small, regular YAML subset used by DSH patch files:
 * top-level `- id:` entries and `- insert:` blocks containing nested `- id:` entries.
 */
export function parsePatchEntries(text: string, packageName = ''): PatchEntry[] {
  const entries: PatchEntry[] = []
  const lines = text.split(/\r?\n/)

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const topId = line.match(/^-\s*id:\s*['"]?([^'"\n]+)['"]?\s*$/)
    if (topId) {
      const block = collectBlock(lines, i)
      const id = cleanValue(topId[1])!
      const disabled = /disabled:\s*true/.test(block)
      const nameMatch = block.match(/name:\s*['"]?([^'"\n]+)['"]?/)
      entries.push({ id, name: cleanValue(nameMatch?.[1]), disabled, packageName })
      i += block.split('\n').length
      continue
    }

    if (/^-\s*insert:/.test(line)) {
      const block = collectBlock(lines, i)
      const idRe = /^\s+- id:\s*['"]?([^'"\n]+)['"]?\s*$/gm
      let m: RegExpExecArray | null
      while ((m = idRe.exec(block)) !== null) {
        const id = cleanValue(m[1])!
        const after = block.slice(m.index + m[0].length)
        const next = after.search(/^\s+- id:/m)
        const sub = next === -1 ? after : after.slice(0, next)
        const disabled = /disabled:\s*true/.test(sub)
        const nameMatch = sub.match(/name:\s*['"]?([^'"\n]+)['"]?/)
        entries.push({ id, name: cleanValue(nameMatch?.[1]), disabled, packageName })
      }
      i += block.split('\n').length
      continue
    }

    i++
  }

  return entries
}

export interface DisableResult {
  ok: boolean
  file: string
  backup?: string
  message: string
}

/**
 * Disable a loader entry by id in the profile's cordis.patch.yml.
 * Text-based edit preserves comments and `!!js` expressions.
 */
export function disablePlugin(profileDir: string, id: string): DisableResult {
  const file = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(file)) {
    return { ok: false, file, message: `patch file not found: ${file}` }
  }

  const original = readFileSync(file, 'utf8')
  const lines = original.split(/\r?\n/)
  const startLine = findIdLine(lines, id)

  let next: string
  if (startLine !== -1) {
    const nested = /^\s/.test(lines[startLine])
    const blockEnd = findBlockEnd(lines, startLine, nested)
    const blockLines = lines.slice(startLine, blockEnd)
    const blockText = blockLines.join('\n')

    if (/disabled:\s*true/.test(blockText)) {
      return { ok: true, file, message: `${id} is already disabled` }
    }

    const insertAt = startLine + 1
    const idIndent = (lines[startLine].match(/^\s*/) || [''])[0]
    if (/disabled:\s*false/.test(blockText)) {
      next = lines.map((ln, idx) => {
        if (idx >= startLine && idx < blockEnd && /disabled:\s*false/.test(ln)) {
          return ln.replace(/disabled:\s*false/, 'disabled: true')
        }
        return ln
      }).join('\n')
    } else {
      const updated = [...lines]
      updated.splice(insertAt, 0, `${idIndent}  disabled: true`)
      next = updated.join('\n')
    }
  } else {
    const trimmed = original.replace(/\s+$/, '')
    next = `${trimmed}\n- id: ${id}\n  disabled: true\n`
  }

  const backup = `${file}.bak-${Date.now()}`
  copyFileSync(file, backup)
  writeFileSync(file, next, 'utf8')
  return { ok: true, file, backup, message: `disabled ${id} in ${file}` }
}

/** Locate the `- id: <target>` line, top-level first, then nested (indented). */
function findIdLine(lines: string[], id: string): number {
  const top = new RegExp(`^-\\s*id:\\s*['"]?${escapeRegExp(id)}['"]?\\s*(?:#.*)?$`)
  for (let i = 0; i < lines.length; i++) {
    if (top.test(lines[i])) return i
  }
  const nested = new RegExp(`^\\s+-\\s*id:\\s*['"]?${escapeRegExp(id)}['"]?\\s*(?:#.*)?$`)
  for (let i = 0; i < lines.length; i++) {
    if (nested.test(lines[i])) return i
  }
  return -1
}

function findBlockEnd(lines: string[], start: number, nested: boolean): number {
  let i = start + 1
  if (nested) {
    const indent = (lines[start].match(/^\s*/) || [''])[0]
    while (i < lines.length) {
      const line = lines[i]
      if (line.trim() === '') {
        i++
        continue
      }
      const curIndent = (line.match(/^\s*/) || [''])[0]
      if (curIndent.length <= indent.length) break
      i++
    }
  } else {
    while (i < lines.length) {
      if (/^-\s/.test(lines[i])) break
      i++
    }
  }
  return i
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
