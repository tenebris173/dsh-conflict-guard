/**
 * @dsh-external/dsh-conflict-guard — DSH 插件冲突检测与自动禁用（安检门）。
 *
 * V2：在安装前检测基础上，增加 Web 自动弹窗、文件监听、启动保护和
 * 服务名冲突检测；永久禁用始终由用户选择。
 */
import { watch, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { scanPackage } from './scanner.js'
import { auditProfileStructure, detectProfileName, loadActiveEntries, resolveProfileDir } from './inventory.js'
import { findConflicts, findExistingConflicts, formatConflicts, formatIssues } from './guard.js'
import { disablePlugin } from './patch.js'

export const name = '@dsh-external/dsh-conflict-guard'
export const inject = ['tools', 'webServer']

export interface Config {
  profile?: string
  language?: 'zh' | 'en' | 'both'
}

export function apply(ctx: Context, config: Config = {}): void {
  const cfg = config ?? {}
  const profileName = () => detectProfileName(cfg.profile)
  const profileDir = () => resolveProfileDir(profileName())
  const language = () => cfg.language ?? 'both'

  const buildReport = () => {
    const dir = profileDir()
    const active = loadActiveEntries(dir)
    const issues = auditProfileStructure(dir)
    const conflicts = findExistingConflicts(active)
    for (const e of active) {
      if (e.dynamicRoutes && e.dynamicRoutes.length > 0) {
        issues.push({
          severity: 'warning' as const,
          message: `${e.id} uses dynamic route path(s): ${e.dynamicRoutes.join(', ')}`,
        })
      }
    }
    return {
      updatedAt: Date.now(),
      profile: profileName(),
      conflicts,
      issues,
      signature: fingerprint({ conflicts, issues }),
    }
  }

  // 启动保护：拦截重复路由注册，避免 DSH 因插件冲突直接崩溃。
  if (ctx.webServer) {
    const originalRegister = ctx.webServer.register.bind(ctx.webServer)
    ctx.effect(() => {
      ctx.webServer.register = (route: any) => {
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

  // 报告接口：给浏览器端弹窗轮询。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-conflict-guard/report',
    handler: async (_req: any, res: any) => {
      try {
        const report = buildReport()
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(report))
      } catch (error: any) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: String(error?.message ?? error) }))
      }
    },
  }), 'dsh-conflict-guard: report route')

  // 选择接口：用户从弹窗里决定永久禁用哪个。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-conflict-guard/choose',
    handler: async (req: any, res: any) => {
      let body = ''
      for await (const chunk of req) body += chunk
      let data: any = {}
      try {
        data = JSON.parse(body || '{}')
      } catch {
        // ignore malformed body
      }
      const id = typeof data.disableId === 'string' ? data.disableId.trim() : ''
      if (!id) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, message: 'disableId is required' }))
        return
      }
      const result = disablePlugin(profileDir(), id)
      res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(result))
    },
  }), 'dsh-conflict-guard: choose route')

  // 页面弹窗：直接注入 HTML，不依赖客户端模块系统。
  const popupScript = `
<script>
(function () {
  var dismissedSignature = localStorage.getItem('dsh-conflict-guard-dismissed') || '';
  function show(report) {
    if (!report || !report.conflicts || report.conflicts.length === 0) return;
    if (report.signature === dismissedSignature) return;
    var old = document.getElementById('dsh-conflict-guard-popup');
    if (old) old.remove();
    var overlay = document.createElement('div');
    overlay.id = 'dsh-conflict-guard-popup';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif';
    var card = document.createElement('div');
    card.style.cssText = 'background:#fff;color:#1f2937;border-radius:16px;padding:20px 24px;max-width:560px;width:calc(100vw - 40px);max-height:80vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)';
    var title = document.createElement('h2');
    title.textContent = '🐋 DSH 插件冲突提醒 / Plugin Conflict Alert';
    var sub = document.createElement('p');
    sub.textContent = '蓝色大肥鱼帮你拦下了潜在冲突，选择要保留谁吧～';
    card.appendChild(title);
    card.appendChild(sub);
    (report.conflicts || []).forEach(function (c) {
      var item = document.createElement('div');
      item.style.cssText = 'border:1px solid #e5e7eb;border-radius:10px;padding:10px 12px;margin-bottom:10px;font-size:14px';
      var d = document.createElement('div');
      d.textContent = '[' + (c.severity === 'error' ? '错误' : '警告') + '] ' + (c.detail || c.kind);
      item.appendChild(d);
      var ids = [];
      if (c.candidateId) ids.push(c.candidateId);
      if (c.existingId && c.existingId !== c.candidateId) ids.push(c.existingId);
      ids.forEach(function (id) {
        var btn = document.createElement('button');
        btn.textContent = '永久禁用 ' + id;
        btn.style.cssText = 'margin-top:8px;margin-right:6px;border:none;border-radius:8px;padding:8px 12px;background:#2563eb;color:#fff;cursor:pointer';
        btn.onclick = function () {
          fetch('/dsh-conflict-guard/choose', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ disableId: id })
          }).then(function () {
            dismissedSignature = report.signature;
            localStorage.setItem('dsh-conflict-guard-dismissed', report.signature);
            overlay.remove();
          });
        };
        item.appendChild(btn);
      });
      card.appendChild(item);
    });
    var ok = document.createElement('button');
    ok.textContent = '知道了 / OK';
    ok.style.cssText = 'margin-top:10px;border:none;border-radius:8px;padding:8px 12px;background:#6b7280;color:#fff;cursor:pointer';
    ok.onclick = function () {
      dismissedSignature = report.signature;
      localStorage.setItem('dsh-conflict-guard-dismissed', report.signature);
      overlay.remove();
    };
    card.appendChild(ok);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }
  function poll() {
    fetch('/dsh-conflict-guard/report').then(function (r) { return r.json(); }).then(show).catch(function () {});
  }
  setInterval(poll, 3000);
  poll();
})();
</script>`
  if (typeof ctx.webServer.tapIndex === 'function') {
    ctx.effect(() => ctx.webServer.tapIndex((html) => html.replace('</head>', popupScript + '</head>')), 'dsh-conflict-guard: popup script')
  }

  // 文件监听：市场/手动/命令行安装都能触发重新扫描。
  let scanTimer: any
  const scheduleScan = () => {
    clearTimeout(scanTimer)
    scanTimer = setTimeout(() => {
      try {
        buildReport()
      } catch (error: any) {
        ctx.logger?.warn?.(`[dsh-conflict-guard] scan failed: ${String(error?.message ?? error)}`)
      }
    }, 1200)
  }

  const dir = profileDir()
  ctx.effect(() => {
    const watchers: any[] = []
    const watchRecursive = (target: string, handler: (event: string, filename: string | null) => void) => {
      try {
        return watch(target, { recursive: true }, handler)
      } catch {
        try { return watch(target, handler) } catch { return undefined }
      }
    }

    const profileWatcher = watchRecursive(dir, (event, filename) => {
      if (filename === 'package.json' || filename === 'cordis.patch.yml') scheduleScan()
    })
    if (profileWatcher) watchers.push(profileWatcher)

    const nodeModules = join(dir, 'node_modules')
    if (existsSync(nodeModules)) {
      const nmWatcher = watchRecursive(nodeModules, () => scheduleScan())
      if (nmWatcher) watchers.push(nmWatcher)
    }

    return () => {
      for (const w of watchers) {
        try { w.close() } catch { /* ignore */ }
      }
      clearTimeout(scanTimer)
    }
  }, 'dsh-conflict-guard: file watcher')

  // 工具：安装前检查。
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

  // 工具：用户同意后永久禁用。
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

  // 工具：可选启动冒烟测试（真实拉起一次 dsh web）。
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dsh_conflict_guard_smoke',
    description: 'Startup smoke test: spawn a temporary dsh web instance and verify it boots',
    parameters: {
      profile: { type: 'string', description: 'profile 名，默认自动检测' },
      timeoutMs: { type: 'number', description: '超时毫秒，默认 60000' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { profile?: string; timeoutMs?: number }) {
      const prof = args.profile || profileName()
      const timeout = Math.min(Math.max(Number(args.timeoutMs) || 60000, 5000), 120000)
      return await new Promise<string>((resolve) => {
        const child = spawn('cmd.exe', ['/c', 'dsh', 'web', '--profile', prof, '--port', '0'], { windowsHide: true })
        let out = ''
        let done = false
        const timer = setTimeout(() => {
          if (!done) {
            done = true
            try { child.kill() } catch { /* ignore */ }
            resolve(`❌ smoke test timeout after ${timeout}ms`)
          }
        }, timeout)
        child.stdout.on('data', (d) => {
          out += d.toString()
          const m = out.match(/dsh web: http:\/\/\S+/)
          if (m) {
            if (!done) {
              done = true
              clearTimeout(timer)
              try { child.kill() } catch { /* ignore */ }
              resolve(`✅ smoke test OK: ${m[0]}`)
            }
          }
        })
        child.stderr.on('data', (d) => { out += d.toString() })
        child.on('exit', (code) => {
          if (!done) {
            done = true
            clearTimeout(timer)
            resolve(`❌ smoke test exited code ${code}: ${out.slice(-500)}`)
          }
        })
        child.on('error', (err) => {
          if (!done) {
            done = true
            clearTimeout(timer)
            resolve(`❌ smoke test error: ${err.message}`)
          }
        })
      })
    },
  })), '@dsh-external/dsh-conflict-guard: smoke tool')
}

/** Deterministic short hash of a JSON value, used as a conflict signature. */
function fingerprint(value: unknown): string {
  const json = JSON.stringify(value) ?? 'null'
  let h = 5381
  for (let i = 0; i < json.length; i++) {
    h = ((h << 5) + h + json.charCodeAt(i)) >>> 0
  }
  return h.toString(36)
}
