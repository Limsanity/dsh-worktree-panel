# @lim324/dsh-worktree-panel

> Fork of [HeathHe/dsh-worktree-panel](https://github.com/HeathHe/dsh-worktree-panel)，scoped 为 `@lim324`。/ Forked from [HeathHe/dsh-worktree-panel](https://github.com/HeathHe/dsh-worktree-panel), scoped under `@lim324`.

<p align="center">
  <a href="https://www.npmjs.com/package/@lim324/dsh-worktree-panel"><img alt="npm version" src="https://img.shields.io/npm/v/@lim324/dsh-worktree-panel?label=npm&color=blue"></a>
  <a href="https://www.npmjs.com/package/@lim324/dsh-worktree-panel"><img alt="monthly downloads" src="https://img.shields.io/npm/dm/@lim324/dsh-worktree-panel?label=%E6%9C%88%E4%B8%8B%E8%BD%BD&color=brightgreen"></a>
  <a href="https://github.com/Limsanity/dsh-worktree-panel"><img alt="stars" src="https://img.shields.io/github/stars/Limsanity/dsh-worktree-panel?style=social"></a>
  <a href="https://github.com/Limsanity/dsh-worktree-panel/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/github/license/Limsanity/dsh-worktree-panel?color=orange"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-DeepSeek%20Harness%20Web-8A2BE2">
</p>

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 界面增加 git worktree 维度的分支管理面板：在官方工作区/会话侧边栏之上，展示 **项目 → 主工作树 / 分支 worktree → 会话**，并保留官方列表的全部原有交互。

A git worktree / branch panel for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI: on top of the official workspace/session sidebar it adds a **project → main working tree / branch worktree → session** dimension while preserving every interaction of the official list.

---

## 使用 / Usage

### 安装 / Install

```sh
dsh plugin --profile web add @lim324/dsh-worktree-panel

# 或直接从 GitHub 安装
dsh plugin --profile web add github:Limsanity/dsh-worktree-panel
```

装完重启 `dsh web`，工作区侧边栏即出现 worktree 维度。/ Restart `dsh web` afterwards; the worktree dimension appears in the sidebar.

安装指定版本 / Install a specific version:

```sh
dsh plugin --profile web add @lim324/dsh-worktree-panel@0.1.1
```

### 升级 / Upgrade

```sh
dsh plugin --profile web add @lim324/dsh-worktree-panel@<新版本 / new version>
# 然后重启 dsh web / then restart dsh web
```

### 源码开发 / Development

```sh
dsh plugin --profile web add link:/绝对路径/到/dsh-worktree-panel
```

---

## 功能 / Features

- **主工作树 + 分支 worktree** — 项目组内展示主工作树（当前分支 + 干净/有改动状态）与各分支 worktree
- **会话管理** — 在 worktree 内开新会话、删除 worktree、切换主工作树分支
- **一键创建** — 底部「＋ 分支 → 创建 worktree」为未建 worktree 的分支一键创建（可选新建分支）
- **落盘位置可配置** — 默认项目内 `.dsh/workspaces/`，或改为全局目录；更改时自动检测并批量迁移已有 worktree（跳过有未提交改动 / 活跃会话的）
- **零侵入** — 非 git 工作区保持官方原样，不显示任何 worktree UI

- **Main working tree + branch worktrees** — shows the main working tree (current branch + clean/dirty status) and each branch worktree within a project group
- **Session management** — open a new session inside a worktree, delete a worktree, switch the main working tree's branch
- **One-click create** — the bottom "＋ branch → create worktree" button creates a worktree for any branch without one (optionally a new branch)
- **Configurable location** — default `.dsh/workspaces/` inside the project or a global directory; changing it auto-detects and bulk-migrates existing worktrees (skipping those with uncommitted changes / active sessions)
- **Zero intrusion** — non-git workspaces stay exactly as the official UI, no worktree UI is shown

---

## 许可 / License

MIT · `lib/client.js` 衍生自 `@deepseek-ai/dsh-client-ui-workspace`，详见 `NOTICE` / `LICENSE`。/ MIT · `lib/client.js` is derived from `@deepseek-ai/dsh-client-ui-workspace`; see `NOTICE` / `LICENSE`.
