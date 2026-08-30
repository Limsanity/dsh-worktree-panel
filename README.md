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

**优先：从 npm 安装（推荐）**

```sh
dsh plugin --profile web add @lim324/dsh-worktree-panel
# 指定版本 / install a specific version
dsh plugin --profile web add @lim324/dsh-worktree-panel@<版本 / version>
```

装完重启 `dsh web`，工作区侧边栏即出现 worktree 维度。/ Restart `dsh web` afterwards; the worktree dimension appears in the sidebar.

### 升级 / Upgrade

```sh
dsh plugin --profile web add @lim324/dsh-worktree-panel@<新版本 / new version>
# 然后重启 dsh web / then restart dsh web
```

### GitHub 源码安装（需要先 build）

本项目是 patch 式构建：`lib/client.js` 由 `lib/build.mjs` 在**官方 `@deepseek-ai/dsh-client-ui-workspace` bundle** 上打补丁生成，因此从源码安装前必须先 build。

```sh
git clone https://github.com/Limsanity/dsh-worktree-panel.git
cd dsh-worktree-panel
npm run build     # 生成 lib/client.js（需要本机已装 DSH，用于定位官方 ui-workspace bundle）
dsh plugin --profile web add link:/绝对路径/到/dsh-worktree-panel
```

### 源码开发 / Development

用 `link:` 方式安装后，改动 `lib/build.mjs` 的 patch 点，或重新 `npm run build`，才会反映到 `lib/`。

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

## AI 工具 / Agent Tools

插件向 DSH 智能体（agent）注册两个可直接调用的工具，让它能在一次对话里自动创建/清理「独立分支上的新会话」，无需你手动建 worktree、再开新会话、再重述任务。

Two agent-callable tools are registered so the agent can create/clean up an isolated branch + session in one turn, without you manually making the worktree, opening a session, and re-stating the task.

### `worktree_task`

```jsonc
{ "repo": "项目名", "task": "在该 worktree 新会话中要完成的任务",
  "branch": "可选，英文连字符命名", "kind": "可选，fix | feature", "base": "可选，基于的分支" }
```

- 为 `repo` 创建分支 + git worktree，把该目录注册为工作区，并**在其下新建一个 DSH 会话、注入 `task` 让其开始工作**（后台运行，用默认模型/预设）。
- 分支名自动生成**英文小写、连字符（kebab）命名**：修复类 `fix/<name>`，功能类 `feature/<name>`（如「修复登录页偶发崩溃」→ `fix/login-page-crash`）。传了 `branch` 则优先沿用。
- Creates the branch + git worktree, registers it as a workspace, then spawns a fresh session rooted there with `task` (runs in background, default model/preset). Branch names auto-derive to English kebab-case: `fix/<name>` for fixes, `feature/<name>` for features; an explicit `branch` wins.

### `worktree_remove`

```jsonc
{ "repo": "项目名", "branch": "要删除的分支名", "force": "可选，是否强制" }
```

- 删除该分支的 git worktree（`git worktree remove` + `prune`）并注销其工作区；该目录有**运行中会话**且未传 `force` 会被拒绝。
- Removes the branch's worktree (`git worktree remove` + `prune`) and unregisters its workspace; blocked while sessions there are running unless `force`.

---

## Slash 命令 / Slash Commands

在 Web 输入框直接敲，避免重复输入「创建 worktree」。Type these in the composer to skip typing "create worktree".

| 输入 / Type | 输入框变成 / Becomes | 效果 / Effect |
|---|---|---|
| `/wtfix` + 空格 | `创建 worktree 修复：` | 接着输入问题 → agent 调 `worktree_task` → `fix/<kebab>` 分支 + 新会话 |
| `/wtfeat` + 空格 | `创建 worktree 实现：` | 接着输入功能 → agent 调 `worktree_task` → `feature/<kebab>` 分支 + 新会话 |

也可以输入 `/` 从候选菜单里选 `wtfix` / `wtfeat`，或直接 `/wtfix <任务>` 回车（前缀会自动替换成 `创建 worktree 修复：`）。You can also pick `wtfix` / `wtfeat` from the `/` candidate menu, or reply `/wtfix <task>` (the token expands to `创建 worktree 修复：`).

---

## 许可 / License

MIT · `lib/client.js` 衍生自 `@deepseek-ai/dsh-client-ui-workspace`，详见 `NOTICE` / `LICENSE`。/ MIT · `lib/client.js` is derived from `@deepseek-ai/dsh-client-ui-workspace`; see `NOTICE` / `LICENSE`.
