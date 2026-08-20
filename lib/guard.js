function routesOverlap(a, b) {
  if (a === b) return true
  if (a.startsWith(b + '/') || b.startsWith(a + '/')) return true
  return false
}

export function findConflicts(candidate, active) {
  const conflicts = []

  for (const entry of active) {
    if (entry.disabled) continue
    if (entry.packageName === candidate.packageName) continue

    for (const id of candidate.ids) {
      if (id === entry.id) {
        conflicts.push({
          kind: 'plugin-id',
          severity: 'error',
          candidate: candidate.packageName,
          existing: `${entry.id} (${entry.packageName})`,
          detail: `Both plugins register the same loader id "${id}"`,
          candidateId: id,
          existingId: entry.id,
        })
      }
    }

    for (const cp of candidate.prefixes) {
      for (const ap of entry.prefixes) {
        if (routesOverlap(cp, ap)) {
          conflicts.push({
            kind: 'route-prefix',
            severity: cp === ap ? 'error' : 'warning',
            candidate: candidate.packageName,
            existing: `${entry.id} (${entry.packageName})`,
            detail: `Route prefix "${cp}" overlaps "${ap}"`,
            candidateId: candidate.ids[0],
            existingId: entry.id,
            route: cp,
          })
        }
      }
    }

    for (const ce of candidate.exact) {
      if (entry.exact.includes(ce)) {
        conflicts.push({
          kind: 'route-exact',
          severity: 'error',
          candidate: candidate.packageName,
          existing: `${entry.id} (${entry.packageName})`,
          detail: `Exact route "${ce}" is already registered`,
          candidateId: candidate.ids[0],
          existingId: entry.id,
          route: ce,
        })
      }
    }

    for (const cs of candidate.services || []) {
      if ((entry.services || []).includes(cs)) {
        conflicts.push({
          kind: 'service',
          severity: 'error',
          candidate: candidate.packageName,
          existing: `${entry.id} (${entry.packageName})`,
          detail: `Both plugins provide service "${cs}"`,
          candidateId: candidate.ids[0],
          existingId: entry.id,
        })
      }
    }
  }

  // A package is already installed as a bundle: report once, not once per entry.
  const existingPackages = new Set(active.filter((e) => !e.disabled).map((e) => e.packageName).filter(Boolean))
  if (existingPackages.has(candidate.packageName)) {
    const first = active.find((e) => e.packageName === candidate.packageName)
    if (first) {
      conflicts.push({
        kind: 'package-name',
        severity: 'warning',
        candidate: candidate.packageName,
        existing: `${first.id} (${first.packageName})`,
        detail: `Package "${candidate.packageName}" is already installed`,
        candidateId: candidate.ids[0],
        existingId: first.id,
      })
    }
  }

  return conflicts
}

export function findExistingConflicts(entries) {
  const conflicts = []
  const active = entries.filter((e) => !e.disabled)

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]
      const b = active[j]
      // Same bundle package: internal entries are not cross-plugin conflicts.
      if (a.packageName === b.packageName) continue

      if (a.id === b.id) {
        conflicts.push({
          kind: 'plugin-id',
          severity: 'error',
          candidate: a.packageName,
          existing: `${b.id} (${b.packageName})`,
          detail: `Both plugins register the same loader id "${a.id}"`,
          candidateId: a.id,
          existingId: b.id,
        })
      }

      for (const ap of a.prefixes) {
        for (const bp of b.prefixes) {
          if (routesOverlap(ap, bp)) {
            conflicts.push({
              kind: 'route-prefix',
              severity: ap === bp ? 'error' : 'warning',
              candidate: a.packageName,
              existing: `${b.id} (${b.packageName})`,
              detail: `Route prefix "${ap}" overlaps "${bp}"`,
              candidateId: a.id,
              existingId: b.id,
              route: ap,
            })
          }
        }
      }

      for (const ae of a.exact) {
        if (b.exact.includes(ae)) {
          conflicts.push({
            kind: 'route-exact',
            severity: 'error',
            candidate: a.packageName,
            existing: `${b.id} (${b.packageName})`,
            detail: `Exact route "${ae}" is registered by both`,
            candidateId: a.id,
            existingId: b.id,
            route: ae,
          })
        }
      }

      for (const as of a.services || []) {
        if ((b.services || []).includes(as)) {
          conflicts.push({
            kind: 'service',
            severity: 'error',
            candidate: a.packageName,
            existing: `${b.id} (${b.packageName})`,
            detail: `Both plugins provide service "${as}"`,
            candidateId: a.id,
            existingId: b.id,
          })
        }
      }
    }
  }

  return conflicts
}

export function formatConflicts(conflicts, language = 'both') {
  if (conflicts.length === 0) {
    if (language === 'en') return 'No conflicts detected.'
    if (language === 'zh') return '未检测到冲突。'
    return '未检测到冲突。 / No conflicts detected.'
  }

  const lines = []
  if (language !== 'en') lines.push(`检测到 ${conflicts.length} 个潜在冲突：`)
  if (language !== 'zh') lines.push(`Detected ${conflicts.length} potential conflict(s):`)

  conflicts.forEach((c, i) => {
    const sev = c.severity === 'error' ? (language === 'en' ? 'ERROR' : '错误') : (language === 'en' ? 'WARNING' : '警告')
    if (language === 'zh') {
      lines.push(`${i + 1}. [${sev}] ${kindLabelZh(c.kind)}`)
      lines.push(`   新插件: ${c.candidate}`)
      lines.push(`   现有: ${c.existing}`)
      lines.push(`   详情: ${c.detail}`)
    } else if (language === 'en') {
      lines.push(`${i + 1}. [${sev}] ${kindLabelEn(c.kind)}`)
      lines.push(`   candidate: ${c.candidate}`)
      lines.push(`   existing: ${c.existing}`)
      lines.push(`   detail: ${c.detail}`)
    } else {
      lines.push(`${i + 1}. [${sev}] ${kindLabelZh(c.kind)} / ${kindLabelEn(c.kind)}`)
      lines.push(`   新插件 candidate: ${c.candidate}`)
      lines.push(`   现有 existing: ${c.existing}`)
      lines.push(`   详情 detail: ${c.detail}`)
    }
  })

  return lines.join('\n')
}

export function formatIssues(issues, language = 'both') {
  if (issues.length === 0) {
    return language === 'en' ? 'No profile structure issues.' : language === 'zh' ? '未发现配置结构问题。' : '未发现配置结构问题。 / No profile structure issues.'
  }

  const lines = []
  if (language !== 'en') lines.push(`检测到 ${issues.length} 个配置结构问题：`)
  if (language !== 'zh') lines.push(`Detected ${issues.length} profile structure issue(s):`)

  issues.forEach((issue, i) => {
    const sev = issue.severity === 'error' ? (language === 'en' ? 'ERROR' : '错误') : (language === 'en' ? 'WARNING' : '警告')
    const msg = issue.message
    if (language === 'zh') lines.push(`${i + 1}. [${sev}] ${msg}`)
    else if (language === 'en') lines.push(`${i + 1}. [${sev}] ${msg}`)
    else lines.push(`${i + 1}. [${sev}] ${msg}`)
  })

  return lines.join('\n')
}

function kindLabelZh(kind) {
  switch (kind) {
    case 'route-prefix': return '路由前缀冲突'
    case 'route-exact': return '精确路由冲突'
    case 'plugin-id': return '插件 ID 冲突'
    case 'package-name': return '包名重复'
    case 'service': return '服务名冲突'
  }
}

function kindLabelEn(kind) {
  switch (kind) {
    case 'route-prefix': return 'route prefix conflict'
    case 'route-exact': return 'exact route conflict'
    case 'plugin-id': return 'plugin id conflict'
    case 'package-name': return 'duplicate package name'
    case 'service': return 'service name conflict'
  }
}
