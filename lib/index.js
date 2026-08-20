import { defineTool } from '@deepseek-ai/dsh-tools'
import { scanPackage } from './scanner.js'
import { auditProfileStructure, detectProfileName, loadActiveEntries, resolveProfileDir } from './inventory.js'
import { findConflicts, findExistingConflicts, formatConflicts, formatIssues } from './guard.js'
import { disablePlugin } from './patch.js'

export const name = '@dsh-external/dsh-conflict-guard'
export const inject = ['tools']

export function apply(ctx, config) {
  const profileName = () => detectProfileName(config.profile)
  const profileDir = () => resolveProfileDir(profileName())
  const language = () => config.language ?? 'both'

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
