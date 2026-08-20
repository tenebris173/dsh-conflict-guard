# dsh-conflict-guard / DSH 插件安检门

> Detect DSH plugin conflicts before install/load, let the user choose which plugin to keep, and persist the choice.
> 在安装/加载 DSH 插件前检测冲突，把选择权交给用户，并永久保存选择。

## What it does / 它能做什么

- 🔍 Scans a plugin package for route prefixes (`/pet`, `/api/pet`, ...), loader ids, and package names before installation.
- ⚔️ Detects conflicts with already-installed active plugins:
  - route prefix / exact route conflicts
  - duplicate loader entry id
  - duplicate package installation
  - basic patch structure problems (missing bundle patch, missing patch file, insert entry without id)
- 🧑‍🤝‍🧑 Lets the user choose which plugin to keep.
- 💾 Persists the choice by writing `disabled: true` into `cordis.patch.yml` with a timestamped backup.
- 🌐 Bilingual reports (中文 / English).

## Install / 安装

### From source (local) / 本地源码安装

```bash
# In the plugin directory
npm pack
# Then install the tgz with dsh plugin manager
dsh plugin --profile web add <path-to-tgz>
```

### As a DSH bundle / 作为 bundle 安装

Add this package to your profile `dsh.profile.bundles`, or use the DSH plugin manager. The bundle patch mounts:

```yaml
- insert:
    - id: dsh-conflict-guard
      name: '@dsh-external/dsh-conflict-guard'
```

## Usage / 使用

This plugin registers two agent tools:

### `dsh_conflict_guard_check`

Check a candidate plugin directory before installing, or audit the current profile.

```json
{ "pluginDir": "C:/path/to/plugin-package" }
```

Leave `pluginDir` empty to audit the current profile.

### `dsh_conflict_guard_fix`

Disable one conflicting plugin by loader id (persistent).

```json
{ "disableId": "web-ui-pet" }
```

Example flow:

1. User wants to install `dsh-pet`.
2. Agent runs `dsh_conflict_guard_check` with the plugin directory.
3. The tool reports: `@linxin666/dsh-pet` and `dsh-pet` both register `/pet`.
4. Agent asks the user which one to keep.
5. User chooses `dsh-pet`.
6. Agent runs `dsh_conflict_guard_fix` with `disableId: web-ui-pet` (or the conflicting id).
7. The choice is written to `cordis.patch.yml` with a backup.

## Coverage / 覆盖范围

| Type / 类型 | Supported / 支持 |
|---|---|
| Route prefix conflict / 路由前缀冲突 | ✅ |
| Exact route conflict / 精确路由冲突 | ✅ |
| Duplicate loader id / 插件 ID 重复 | ✅ |
| Duplicate package install / 包名重复 | ✅ |
| Patch structure basics / patch 结构基础 | ✅ |
| Startup smoke test / 启动冒烟测试 | 🔜 v2 |
| Web popup / Web 自动弹窗 | 🔜 v2 |
| Runtime auto disable / 运行时自动停用 | ❌ (handled by dsh-conflict-guardian) |

## Limitations / 已知限制

- Static source scanning cannot catch dynamically constructed route strings.
- It does not parse every possible conflict type; it focuses on the common ones that crash DSH at install/startup.
- The `fix` tool writes to the profile patch file; always creates a timestamped backup first.

## Background & Credits / 背景与致谢

This plugin was born from a real user problem:

- The user installed the floating desktop pet `dsh-pet` while the family bundle's pet plugin was also active. Both registered the `/pet` route, and DSH crashed at startup with a duplicate route error.
- The user realized plugin conflict detection is a common need, proposed the "security gate" (安检门) concept, and commissioned this development.
- The user is not a developer. The requirement, acceptance testing, and final decisions were driven by the user; the implementation was done by an AI assistant.

这个插件来自一个真实用户问题：

- 用户安装了浮动桌宠 `dsh-pet`，与全家桶自带宠物同时注册 `/pet` 路由，导致 DSH 启动崩溃。
- 用户意识到“插件冲突检测”是普遍需求，提出了“安检门”概念并委托开发。
- 用户本人不会开发；需求提出、验收和最终把关由用户完成，代码实现由 AI 助手完成。

## License / 许可

BSD-3-Clause
