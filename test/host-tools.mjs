// Host-side routing tool test. Uses a fake read-only git executable and an
// isolated DSH_HOME: no real repository, branch, worktree or session is changed.
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, chmod, rm, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const temp = await mkdtemp(join(tmpdir(), "wtp-host-tools-"))
const dshHome = join(temp, "dsh-home")
const repo = join(temp, "demo-app")
const worktree = join(repo, ".dsh", "workspaces", "feature", "export-pdf")
const standalone = join(temp, "notes")
const fakeBin = join(temp, "bin")
await Promise.all([
  mkdir(dshHome, { recursive: true }),
  mkdir(worktree, { recursive: true }),
  mkdir(standalone, { recursive: true }),
  mkdir(fakeBin, { recursive: true }),
])

process.env.DSH_HOME = dshHome
process.env.FAKE_REPO_ROOT = repo
process.env.FAKE_WORKTREE = worktree
process.env.PATH = `${fakeBin}:${process.env.PATH ?? ""}`

const fakeGit = join(fakeBin, "git")
await writeFile(fakeGit, `#!/usr/bin/env node
const { join } = require("node:path")
const args = process.argv.slice(2)
const root = process.env.FAKE_REPO_ROOT
const wt = process.env.FAKE_WORKTREE
if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
  console.log(join(root, ".git"))
} else if (args[0] === "symbolic-ref") {
  console.log(process.cwd() === wt ? "feature/export-pdf" : "main")
} else if (args[0] === "for-each-ref") {
  console.log("main\\nfeature/export-pdf")
} else if (args[0] === "worktree" && args[1] === "list") {
  console.log("worktree " + root + "\\nHEAD 0123456789abcdef\\nbranch refs/heads/main\\n")
  console.log("worktree " + wt + "\\nHEAD 0123456789abcdef\\nbranch refs/heads/feature/export-pdf")
} else if (args[0] === "status") {
  console.log(process.cwd() === wt ? "## feature/export-pdf" : "## main")
} else {
  console.error("unexpected/mutating git invocation: " + args.join(" "))
  process.exit(2)
}
`)
await chmod(fakeGit, 0o755)
await writeFile(join(dshHome, "worktree-panel.json"), JSON.stringify({
  version: 1,
  root: "",
  worktreeRoot: "",
  repos: [{ name: "demo-app", path: repo }],
}))

const {
  agentTreePayload,
  apply,
  handleWorktreeList,
  handleWorktreeSession,
} = await import(`../lib/index.js?host-tools=${Date.now()}`)

const attached = []
const created = []
const followups = []
const makeWorkspace = (id, title, path) => ({
  id,
  title,
  path,
  createdAt: "2026-01-01T00:00:00.000Z",
  attachSession: async (sessionId) => attached.push({ workspaceId: id, sessionId: String(sessionId) }),
})
const workspaces = [
  // 用户手动给主工作区标注了业务语义：name 仍是目录名，workspaceTitle 才是项目本体名。
  makeWorkspace("ws-main", "demo-app（演示用 PDF 导出项目）", repo),
  makeWorkspace("ws-notes", "notes", standalone),
]
const workspaceRegistry = {
  list: () => workspaces,
  // 真实 registry 按规范化（realpath）路径匹配，这里保持一致：
  // macOS 的 /var 与 /private/var 会被 realpath 统一，否则会误触发「补注册」。
  resolveByPath: async (path) => {
    const key = await realpath(String(path)).catch(() => String(path))
    for (const workspace of workspaces) {
      if ((await realpath(workspace.path).catch(() => workspace.path)) === key) return workspace
    }
    return null
  },
  create: async (path, title) => {
    const workspace = makeWorkspace(`ws-created-${workspaces.length + 1}`, title, path)
    workspaces.push(workspace)
    return workspace
  },
  delete: async () => {},
}
const titles = {
  "s-main": "主工作树日常修复",
  "s-pdf": "实现导出 PDF",
  "s-notes": "整理发布笔记",
}
const sessionQuery = {
  listSessions: async () => [
    { header: { id: "s-main", cwd: repo }, live: false },
    { header: { id: "s-pdf", cwd: worktree }, live: false },
    { header: { id: "s-notes", cwd: standalone }, live: false },
  ],
  readTitleSnapshots: async (ids) => ids.map((sessionId) => ({
    status: "fulfilled",
    sessionId,
    value: { title: { title: titles[sessionId] ?? sessionId } },
  })),
}
const agents = {
  create: async (options) => {
    created.push(options)
    return {
      agent: {
        whenIdle: async () => {},
        followup: (message) => followups.push(message),
      },
    }
  },
  get: () => undefined,
}
const ctx = {
  workspaceRegistry,
  sessionQuery,
  sessions: { list: () => [] },
  get: (name) => {
    if (name === "agents") return agents
    if (name === "agentDefaultModel") {
      return { currentSelection: () => ({ provider: "test-provider", model: "test-model" }) }
    }
    if (name === "agentPresets") {
      return { resolve: async () => ({ id: "default-preset" }), mount: async () => {} }
    }
    return undefined
  },
}

try {
  const listed = JSON.parse(await handleWorktreeList(ctx, {}))
  assert.equal(listed.repos.length, 1)
  assert.equal(listed.repos[0].name, "demo-app")
  assert.equal(listed.repos[0].path, repo)
  assert.equal(listed.repos[0].sessions[0].title, "主工作树日常修复")
  assert.equal(listed.repos[0].worktrees.length, 1)
  assert.equal(listed.repos[0].worktrees[0].path, worktree)
  assert.equal(listed.repos[0].worktrees[0].sessions[0].title, "实现导出 PDF")
  // 回归：workspace title 必须透出给 agent，否则只能靠目录名猜项目归属。
  assert.equal(listed.repos[0].workspaceTitle, "demo-app（演示用 PDF 导出项目）")
  // worktree 节点若没有独立 workspace title，则不重复输出主项目 title。
  assert.equal(listed.repos[0].worktrees[0].workspaceTitle, null)
  assert.equal(listed.workspaces.length, 1)
  assert.equal(listed.workspaces[0].path, standalone)
  assert.equal(listed.workspaces[0].sessions[0].title, "整理发布笔记")

  const filtered = JSON.parse(await handleWorktreeList(ctx, { repo: "DEMO" }))
  assert.equal(filtered.repos.length, 1)
  assert.equal(filtered.workspaces.length, 0)
  const missingFilter = JSON.parse(await handleWorktreeList(ctx, { repo: "no-such-project" }))
  assert.match(missingFilter.warning, /没有候选/)
  // 业务语义过滤：按 workspace title 里的中文关键词也应命中项目。
  const byTitle = JSON.parse(await handleWorktreeList(ctx, { repo: "演示用" }))
  assert.equal(byTitle.repos.length, 1)
  assert.equal(byTitle.repos[0].name, "demo-app")

  const truncated = agentTreePayload({
    repos: [{ name: "many", path: repo, sessions: Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, title: `t${i}` })) }],
    workspaces: [],
  })
  assert.equal(truncated.repos[0].sessions.length, 20)
  assert.equal(truncated.repos[0].sessionCount, 25)
  assert.equal(truncated.repos[0].sessionsTruncated, 5)

  // The worktree starts unregistered: dispatch must register that exact path,
  // create a fresh session, attach it and queue the task without any git mutation.
  const result = await handleWorktreeSession(ctx, {
    path: worktree,
    task: "继续实现导出 PDF，并补齐测试",
  })
  assert.equal(created.length, 1)
  assert.equal(created[0].meta.cwd, worktree)
  assert.equal(created[0].meta.agentPreset, "default-preset")
  assert.deepEqual(created[0].agentOptions, { provider: "test-provider", model: "test-model" })
  assert.ok(workspaces.some((workspace) => workspace.path === worktree))
  assert.equal(attached[0].sessionId, String(created[0].sessionId))
  assert.ok(JSON.stringify(followups[0]).includes("继续实现导出 PDF，并补齐测试"))
  assert.match(result, /分支 worktree/)
  assert.match(result, /feature\/export-pdf/)

  await handleWorktreeSession(ctx, { path: repo, task: "在主工作树修复问题" })
  await handleWorktreeSession(ctx, { path: standalone, task: "继续整理发布笔记" })
  assert.equal(created.length, 3)
  assert.equal(created[1].meta.cwd, repo)
  assert.equal(created[2].meta.cwd, standalone)
  assert.equal(followups.length, 3)

  await assert.rejects(
    handleWorktreeSession(ctx, { path: join(temp, "not-a-target"), task: "不应执行" }),
    /不在 worktree 面板的已有目标中/,
  )
  assert.equal(created.length, 3)

  const registeredTools = []
  const registeredSections = []
  const disposers = []
  apply({
    ...ctx,
    tools: { register: (tool) => registeredTools.push(tool) },
    systemPrompt: { section: (section) => registeredSections.push(section) },
    webServer: { register: () => () => {} },
    effect: (fn) => {
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    },
  })
  assert.deepEqual(registeredTools.map((tool) => tool.name), [
    "worktree_list",
    "worktree_session",
    "worktree_session_continue",
    "worktree_task",
    "worktree_remove",
  ])
  assert.ok(registeredSections.some((section) =>
    section.name === "tool:worktree-panel" && section.text.includes("已有工作区自动派单")))
  for (const dispose of disposers) dispose?.()

  console.log("host tools test OK: list/filter/route/register/attach/followup; no git mutations")
} finally {
  await rm(temp, { recursive: true, force: true })
}
