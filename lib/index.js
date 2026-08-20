import { watch, existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { scanPackage } from './scanner.js'
import { auditProfileStructure, detectProfileName, loadActiveEntries, resolveProfileDir } from './inventory.js'
import { findConflicts, findExistingConflicts, formatConflicts, formatIssues } from './guard.js'
import { disablePlugin } from './patch.js'

export const name = '@dsh-external/dsh-conflict-guard'
export const inject = ['tools', 'webServer']

export function apply(ctx, config) {
  const profileName = () => detectProfileName(config.profile)
  const profileDir = () => resolveProfileDir(profileName())
  const language = () => config.language ?? 'both'

  const buildReport = () => {
    const dir = profileDir()
    const active = loadActiveEntries(dir)
    const issues = auditProfileStructure(dir)
    const conflicts = findExistingConflicts(active)
    return {
      updatedAt: Date.now(),
      profile: profileName(),
      conflicts,
      issues,
    }
  }

  // ── 启动保护：拦截重复路由注册，避免 DSH 因插件冲突直接崩溃 ──────────
  if (ctx.webServer) {
    const originalRegister = ctx.webServer.register.bind(ctx.webServer)
    ctx.effect(() => {
      ctx.webServer.register = (route) => {
        const table = route.kind === 'exact' ? ctx.webServer.exact : ctx.webServer.prefixes
        if (table.has(route.path)) {
          ctx.logger?.warn?.(`[dsh-conflict-guard] blocked duplicate ${route.kind} route "${route.path}"`)
          return () => {}
        }
        return originalRegister(route)
      }
      return () => {
        ctx.webServer.register = originalRegister
      }
    }, 'dsh-conflict-guard: route guard')
  }

  // ── 报告接口：给浏览器端弹窗轮询 ──────────────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-conflict-guard/report',
    handler: async (_req, res) => {
      try {
        const report = buildReport()
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(report))
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: String(error?.message ?? error) }))
      }
    },
  }), 'dsh-conflict-guard: report route')

  // ── 选择接口：用户从弹窗里决定永久禁用哪个 ────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-conflict-guard/choose',
    handler: async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      let data = {}
      try {
        data = JSON.parse(body || '{}')
      } catch {
        // ignore malformed body
      }
      const id = typeof data.disableId === 'string' ? data.disableId : ''
      const result = disablePlugin(profileDir(), id)
      res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(result))
    },
  }), 'dsh-conflict-guard: choose route')

  // ── 文件监听：市场/手动/命令行安装都能触发重新扫描 ────────────────────
  let scanTimer
  const scheduleScan = () => {
    clearTimeout(scanTimer)
    scanTimer = setTimeout(() => {
      try {
        buildReport()
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-conflict-guard] scan failed: ${String(error?.message ?? error)}`)
      }
    }, 1200)
  }

  const dir = profileDir()
  ctx.effect(() => {
    const watchers = []
    try {
      const profileWatcher = watch(dir, (event, filename) => {
        if (filename === 'package.json' || filename === 'cordis.patch.yml') scheduleScan()
      })
      watchers.push(profileWatcher)
    } catch {
      // profile dir may not exist yet
    }

    const nodeModules = join(dir, 'node_modules')
    if (existsSync(nodeModules)) {
      try {
        const nmWatcher = watch(nodeModules, () => scheduleScan())
        watchers.push(nmWatcher)
      } catch {
        // ignore watch errors
      }
    }

    return () => {
      for (const w of watchers) {
        try { w.close() } catch { /* ignore */ }
      }
      clearTimeout(scanTimer)
    }
  }, 'dsh-conflict-guard: file watcher')

  // ── 工具：安装前检查 ──────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dsh_conflict_guard_check',
    description: 'Check DSH plugin conflicts before install or audit current profile',
    parameters: {
      pluginDir: { type: 'string', description: '待安装插件包目录（绝对路径）；留空则审计当前 profile' },
      profile: { type: 'string', description: 'profile 名，默认自动检测' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const prof = args.profile || profileName()
      const dir = resolveProfileDir(prof)
      const active = loadActiveEntries(dir)
      const issues = auditProfileStructure(dir)

      const parts = []
      if (args.pluginDir) {
        const candidate = scanPackage(args.pluginDir)
        const conflicts = findConflicts(candidate, active)
        parts.push(formatConflicts(conflicts, language()))
      } else {
        const conflicts = findExistingConflicts(active)
        parts.push(formatConflicts(conflicts, language()))
      }

      const issueText = formatIssues(issues, language())
      if (issueText && !issueText.startsWith('未发现') && !issueText.startsWith('No profile')) {
        parts.push(issueText)
      }

      return parts.join('\n\n')
    },
  })), '@dsh-external/dsh-conflict-guard: check tool')

  // ── 工具：用户同意后永久禁用 ──────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dsh_conflict_guard_fix',
    description: 'Disable one conflicting DSH plugin by loader id in cordis.patch.yml',
    parameters: {
      disableId: { type: 'string', required: true, description: '要禁用的插件行 id（例如 web-ui-pet）' },
      profile: { type: 'string', description: 'profile 名，默认自动检测' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const prof = args.profile || profileName()
      const dir = resolveProfileDir(prof)
      const result = disablePlugin(dir, args.disableId)
      const zh = result.ok
        ? `✅ 已禁用 ${args.disableId}${result.backup ? `（备份：${result.backup}）` : ''}`
        : `❌ 禁用失败：${result.message}`
      const en = result.ok
        ? `✅ Disabled ${args.disableId}${result.backup ? ` (backup: ${result.backup})` : ''}`
        : `❌ Failed to disable: ${result.message}`
      return language() === 'en' ? en : language() === 'zh' ? zh : `${zh}\n${en}`
    },
  })), '@dsh-external/dsh-conflict-guard: fix tool')
}
