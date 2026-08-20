/**
 * @dsh-external/dsh-conflict-guard — DSH 插件冲突检测与自动禁用（安检门）。
 *
 * 目标：在安装/加载插件前发现会破坏稳定性的冲突（路由前缀、插件 ID、
 * patch 结构等），并把选择权交给用户；同时提供启动/审计模式扫描已有冲突。
 */
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { scanPackage } from './scanner.js'
import { auditProfileStructure, detectProfileName, loadActiveEntries, resolveProfileDir } from './inventory.js'
import { findConflicts, findExistingConflicts, formatConflicts, formatIssues } from './guard.js'
import { disablePlugin } from './patch.js'

export const name = '@dsh-external/dsh-conflict-guard'
export const inject = ['tools']

export interface Config {
  profile?: string
  language?: 'zh' | 'en' | 'both'
}

export function apply(ctx: Context, config: Config): void {
  const profileName = () => detectProfileName(config.profile)
  const profileDir = () => resolveProfileDir(profileName())
  const language = () => config.language ?? 'both'

  // 检查：给定待装插件目录，或扫描当前 profile 已有冲突。
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dsh_conflict_guard_check',
    description: 'Check DSH plugin conflicts before install or audit current profile',
    parameters: {
      pluginDir: { type: 'string', description: '待安装插件包目录（绝对路径）；留空则审计当前 profile' },
      profile: { type: 'string', description: 'profile 名，默认自动检测' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { pluginDir?: string; profile?: string }) {
      const prof = args.profile || profileName()
      const dir = resolveProfileDir(prof)
      const active = loadActiveEntries(dir)
      const issues = auditProfileStructure(dir)

      const parts: string[] = []
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

  // 修复：把用户选择不要的插件写成 disabled。
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dsh_conflict_guard_fix',
    description: 'Disable one conflicting DSH plugin by loader id in cordis.patch.yml',
    parameters: {
      disableId: { type: 'string', required: true, description: '要禁用的插件行 id（例如 web-ui-pet）' },
      profile: { type: 'string', description: 'profile 名，默认自动检测' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { disableId: string; profile?: string }) {
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
