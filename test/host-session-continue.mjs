// Tests for worktree_session_continue. No real repository or session is changed.
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const temp = await mkdtemp(join(tmpdir(), "wtp-session-continue-"))
const dshHome = join(temp, "dsh-home")
const repo = join(temp, "demo-app")
const worktree = join(repo, ".dsh", "workspaces", "feature", "export-pdf")
const outside = join(temp, "outside")
const fakeBin = join(temp, "bin")
await Promise.all([
  mkdir(dshHome, { recursive: true }),
  mkdir(worktree, { recursive: true }),
  mkdir(outside, { recursive: true }),
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
  console.log("feature/export-pdf")
} else if (args[0] === "for-each-ref") {
  console.log("main\\nfeature/export-pdf")
} else if (args[0] === "worktree" && args[1] === "list") {
  console.log("worktree " + root + "\\nHEAD 0123456789abcdef\\nbranch refs/heads/main\\n")
  console.log("worktree " + wt + "\\nHEAD 0123456789abcdef\\nbranch refs/heads/feature/export-pdf")
} else if (args[0] === "status") {
  console.log("## feature/export-pdf")
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

const { handleWorktreeSessionContinue } = await import(`../lib/index.js?session-continue=${Date.now()}`)

const records = [
  { header: { id: "s-running", cwd: worktree }, live: true, persisted: true },
  { header: { id: "s-idle", cwd: worktree }, live: true, persisted: true },
  { header: { id: "s-cold", cwd: worktree }, live: false, persisted: true },
  { header: { id: "s-outside", cwd: outside }, live: false, persisted: true },
  { header: { id: "s-subagent", cwd: worktree, origin: "subagent" }, live: false, persisted: true },
]
const followups = { running: [], idle: [], cold: [], raced: [] }
const makeLiveAgent = (status, sink) => ({
  status,
  whenIdle: async () => {},
  followup: (message) => sink.push(message),
})
const live = new Map([
  ["s-running", makeLiveAgent("running", followups.running)],
  ["s-idle", makeLiveAgent("idle", followups.idle)],
])
let coldIdleCount = 0
const coldAgent = {
  status: "idle",
  whenIdle: async () => { coldIdleCount += 1 },
  followup: (message) => followups.cold.push(message),
}
const racedAgent = makeLiveAgent("idle", followups.raced)
const resumeCalls = []
const presetResolutions = []
const presetMounts = []
const disposed = []
let raceNextResume = false

const agents = {
  get: (id) => live.get(id),
  resume: async (options) => {
    resumeCalls.push(options)
    if (raceNextResume) {
      raceNextResume = false
      live.set("s-cold", racedAgent)
      const error = new Error("already owned")
      error.name = "SessionAlreadyOwnedError"
      throw error
    }
    return { agent: coldAgent }
  },
}
const sessionQuery = {
  listSessions: async () => records,
  readTitleSnapshots: async (ids) => ids.map((sessionId) => ({
    status: "fulfilled",
    sessionId,
    value: { title: { title: sessionId } },
  })),
  observeSession: async (id) => {
    const record = records.find((item) => item.header.id === id)
    if (!record) throw new Error("SESSION_QUERY_SESSION_NOT_FOUND")
    return {
      header: record.header,
      projections: { values: { agentPreset: "preset-original" } },
      dispose: () => disposed.push(id),
    }
  },
}
const mainWorkspace = {
  id: "ws-main",
  title: "demo-app",
  path: repo,
  createdAt: "2026-01-01T00:00:00.000Z",
  attachSession: async () => {},
}
const ctx = {
  agents,
  sessionQuery,
  workspaceRegistry: {
    list: () => [mainWorkspace],
    resolveByPath: async (path) => path === repo ? mainWorkspace : null,
    create: async () => { throw new Error("unexpected workspace creation") },
  },
  sessions: { list: () => [] },
  get: (name) => {
    if (name === "agents") return agents
    if (name === "agentDefaultModel") {
      return { currentSelection: () => ({ provider: "test-provider", model: "test-model" }) }
    }
    if (name === "agentPresets") {
      return {
        resolve: async (id) => {
          presetResolutions.push(id)
          return { id: id ?? "preset-default" }
        },
        mount: async (_agentCtx, id) => presetMounts.push(id),
      }
    }
    return undefined
  },
}

try {
  const runningResult = await handleWorktreeSessionContinue(ctx, {
    sessionId: "s-running",
    task: "运行结束后继续补测试",
  })
  assert.equal(followups.running.length, 1)
  assert.ok(JSON.stringify(followups.running[0]).includes("运行结束后继续补测试"))
  assert.match(runningResult, /会话：s-running/)
  assert.match(runningResult, /运行中，已排为后续轮次/)
  assert.equal(resumeCalls.length, 0)

  const idleResult = await handleWorktreeSessionContinue(ctx, {
    sessionId: "s-idle",
    task: "立即继续原会话",
  })
  assert.equal(followups.idle.length, 1)
  assert.match(idleResult, /空闲，已开始新轮次/)
  assert.equal(resumeCalls.length, 0)

  const coldResult = await handleWorktreeSessionContinue(ctx, {
    sessionId: "s-cold",
    task: "恢复后继续原需求",
  })
  assert.equal(resumeCalls.length, 1)
  assert.equal(String(resumeCalls[0].resumeSessionId), "s-cold")
  assert.deepEqual(resumeCalls[0].agentOptions, { provider: "test-provider", model: "test-model" })
  assert.equal(coldIdleCount, 1)
  assert.equal(followups.cold.length, 1)
  assert.match(coldResult, /已恢复原会话并投递任务/)
  assert.match(coldResult, /未创建新会话/)
  assert.equal(presetResolutions[0], "preset-original")

  // The setup installed by resume must mount the persisted preset, not silently
  // replace the original session with a fresh identity or default preset.
  await resumeCalls[0].setup({ on: () => () => {} })
  assert.deepEqual(presetMounts, ["preset-original"])

  // If another caller wins the resume race, follow the exact live agent it
  // published rather than creating another session or dropping the task.
  live.delete("s-cold")
  raceNextResume = true
  await handleWorktreeSessionContinue(ctx, { sessionId: "s-cold", task: "竞态下仍继续同一会话" })
  assert.equal(followups.raced.length, 1)

  await assert.rejects(
    handleWorktreeSessionContinue(ctx, { sessionId: "s-outside", task: "不应投递" }),
    /不属于 worktree 面板/,
  )
  await assert.rejects(
    handleWorktreeSessionContinue(ctx, { sessionId: "s-subagent", task: "不应投递" }),
    /不能通过 worktree_session_continue/,
  )
  await assert.rejects(
    handleWorktreeSessionContinue(ctx, { sessionId: "s-missing", task: "不应投递" }),
    /无法继续会话 s-missing/,
  )
  await assert.rejects(
    handleWorktreeSessionContinue(ctx, { sessionId: "s-idle", task: "   " }),
    /任务描述/,
  )

  assert.deepEqual(disposed.sort(), [
    "s-cold",
    "s-cold",
    "s-idle",
    "s-outside",
    "s-running",
    "s-subagent",
  ].sort())
  assert.equal(followups.running.length + followups.idle.length + followups.cold.length + followups.raced.length, 4)

  console.log("session continue test OK: running/idle/resume/preset/race/validation; same session ids")
} finally {
  await rm(temp, { recursive: true, force: true })
}
