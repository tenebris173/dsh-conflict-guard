/**
 * dsh-conflict-guard 浏览器半侧（client bundle）
 *
 * 挂在 DSH 的 shell.overlay 全局浮层上：
 * - 轮询 /dsh-conflict-guard/report
 * - 有冲突时自动弹出提醒
 * - 用户可直接点击“永久禁用 xxx”，调用 /dsh-conflict-guard/choose
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-conflict-guard',

  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var react = require('react')
    var { useEffect, useState, useCallback } = react
    var { jsx: h } = require('react/jsx-runtime')

    var overlayStyle = {
      position: 'fixed',
      inset: 0,
      zIndex: 9999,
      background: 'rgba(0,0,0,0.45)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'system-ui, sans-serif',
    }
    var cardStyle = {
      background: '#fff',
      color: '#1f2937',
      borderRadius: 16,
      padding: '20px 24px',
      maxWidth: 560,
      width: 'calc(100vw - 40px)',
      maxHeight: '80vh',
      overflowY: 'auto',
      boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
    }
    var titleStyle = { margin: '0 0 6px', fontSize: 20 }
    var subStyle = { margin: '0 0 14px', color: '#6b7280', fontSize: 14 }
    var itemStyle = {
      border: '1px solid #e5e7eb',
      borderRadius: 10,
      padding: '10px 12px',
      marginBottom: 10,
      fontSize: 14,
    }
    var btnRowStyle = { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }
    var btnStyle = {
      border: 'none',
      borderRadius: 8,
      padding: '8px 12px',
      background: '#2563eb',
      color: '#fff',
      cursor: 'pointer',
      fontSize: 13,
    }

    function ConflictPopup() {
      var [report, setReport] = useState(null)
      var [dismissedAt, setDismissedAt] = useState(0)
      var [busy, setBusy] = useState('')

      var load = useCallback(async function () {
        try {
          var res = await fetch('/dsh-conflict-guard/report')
          if (!res.ok) return
          var data = await res.json()
          setReport(data)
        } catch (e) { /* ignore */ }
      }, [])

      useEffect(function () {
        load()
        var timer = setInterval(load, 3000)
        return function () { clearInterval(timer) }
      }, [load])

      if (!report) return null
      var conflicts = report.conflicts || []
      var issues = report.issues || []
      var hasIssues = conflicts.length > 0 || issues.length > 0
      var show = hasIssues && report.updatedAt !== dismissedAt
      if (!show) return null

      async function choose(disableId) {
        setBusy(disableId)
        try {
          await fetch('/dsh-conflict-guard/choose', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ disableId }),
          })
          await load()
          setDismissedAt(report.updatedAt)
        } catch (e) { /* ignore */ }
        setBusy('')
      }

      return h('div', { style: overlayStyle },
        h('div', { style: cardStyle },
          h('h2', { style: titleStyle }, '🐋 DSH 插件冲突提醒 / Plugin Conflict Alert'),
          h('p', { style: subStyle }, '蓝色大肥鱼帮你拦下了潜在冲突，选择要保留谁吧～'),
          conflicts.map(function (c, i) {
            return h('div', { key: i, style: itemStyle },
              h('div', null, '[' + (c.severity === 'error' ? '错误' : '警告') + '] ' + (c.kind || c.detail)),
              h('div', null, c.detail),
              c.existingId ? h('div', { style: btnRowStyle },
                h('button', {
                  style: btnStyle,
                  disabled: busy === c.existingId,
                  onClick: function () { choose(c.existingId) },
                }, '永久禁用 ' + c.existingId)
              ) : null
            )
          }),
          issues.map(function (iss, i) {
            return h('div', { key: 'i' + i, style: itemStyle },
              '[' + (iss.severity === 'error' ? '错误' : '警告') + '] ' + iss.message
            )
          }),
          h('div', { style: btnRowStyle },
            h('button', {
              style: btnStyle,
              onClick: function () { setDismissedAt(report.updatedAt) },
            }, '知道了 / OK')
          )
        )
      )
    }

    var name = 'dsh-conflict-guard'
    var inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-conflict-guard',
          order: 9999,
        }, function () {
          return h(ConflictPopup)
        })
      })
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
