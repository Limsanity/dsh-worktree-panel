// dsh-worktree-panel — host half.
// The official workspace/session browser (ui-workspace) is disabled in
// cordis.patch.yml; this plugin's client half (generated from that exact
// component by lib/build.mjs) owns the sidebar slot and adds the
// project -> worktree dimension while preserving every official interaction.
// This host half serves the worktree topology: real git worktrees at
// <worktreeRoot>/<repoName>/<branch>/, registered as DSH workspaces, plus a
// per-directory session map so the tree can render 项目 → worktree → 会话.
// Node builtins only; no runtime dependencies.
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { existsSync, statSync } from "node:fs"
import { mkdir, readFile, writeFile, readdir, realpath } from "node:fs/promises"
import { join, basename, dirname, isAbsolute } from "node:path"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"
import { defineTool } from "@deepseek-ai/dsh-tools"
import { SessionId } from "@deepseek-ai/dsh-session"
import { installModelSelection } from "@deepseek-ai/dsh-agent"
import { createUserMessage } from "@deepseek-ai/dsh-llm"

const execFileAsync = promisify(execFile)
const MANIFEST_PATH = join(homedir(), ".dsh", "worktree-panel.json")
const API_PREFIX = "/api/dsh-worktree"
const SECTION_ORDER = 210

const inject = ["webServer", "sessions", "workspaceRegistry", "systemPrompt", "sessionQuery", "tools", "agents"]

const GUIDANCE = "本机已安装 @lim324/dsh-worktree-panel 插件（DSH Web GUI 的 worktree 分支管理面板）：为 git 项目增加 worktree 维度——项目组内展示主工作树与各分支 worktree，可创建/删除 worktree、切换主分支。worktree 默认存于 <项目>/.dsh/workspaces/，可在设置中改为全局路径。用户提到「worktree 面板 / 分支管理」时即指本插件。"

const TOOL_GUIDANCE = "当用户要求「创建 worktree 并修复/实现 xxx」或在某个项目里隔离地做改动时，用 worktree_task 工具：它会为该项目的某个分支创建 git worktree、把该目录注册为工作区、并在其中新建一个 DSH 会话、自动注入用户给的任务开始工作。它让一次对话自动派生出「独立分支上的新会话」，避免用户手动建 worktree、再开新会话、再重述问题。项目名用 worktree 面板里的项目名。\n\n分支命名规则（worktree_task 的 branch 参数）：修复类 → fix/<英文连字符（kebab）命名>；功能类 → feature/<英文连字符（kebab）命名>。请根据用户描述自动生成简短英文小写、用连字符连接的（kebab-case）分支名，例如「修复登录页偶发崩溃」→ fix/login-page-crash、「实现导出 PDF」→ feature/export-pdf。若用户已明确给出分支名就沿用；否则自动按此规则生成，并在调用时把 branch 传进去。\n\n删除 worktree：用 worktree_remove（参数 repo、branch，可选 force）。它删除对应分支的 git worktree 并 prune、按需注销其工作区；该目录有会话正在运行且未传 force 会被拒绝。"

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------
// Node 用裸命令名 "git" spawn 时会对整个 PATH 顺序 stat/readdir 来定位可执行文件；
// 本机 PATH 很长且 /usr/bin 排在末段，导致每次调用固定付出 ~110-150ms 的 PATH 解析
// 开销（一次 buildTree 约 110 次 git 调用）。这里首次调用时把 git 解析成绝对路径
// （一次 PATH 扫描），之后每次 execFile 都直接 execve 绝对路径，单次降到 ~16ms。
let GIT = null
function resolveGitPath() {
  const dirs = String(process.env.PATH ?? "").split(":")
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = join(dir, "git")
    try {
      if (statSync(candidate).isFile()) {
        GIT = candidate
        return candidate
      }
    } catch {
      // 该目录下没有 git，继续查下一项
    }
  }
  GIT = "git" // 兜底：PATH 解析不到 git 时沿用裸名（保持旧行为）
  return GIT
}

async function git(args, cwd) {
  const bin = GIT ?? (GIT = resolveGitPath())
  try {
    const { stdout } = await execFileAsync(bin, args, {
      cwd,
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
    })
    return { ok: true, out: String(stdout).trim() }
  } catch (error) {
    const detail = (error.stderr ? String(error.stderr) : String(error.message ?? error)).trim()
    return { ok: false, error: detail }
  }
}

// ---------------------------------------------------------------------------
// git 结果缓存：/tree 每 5s 重建一次，而 git 子进程很贵（本机约 150ms/spawn），
// 一次 buildTree 会跑 ~200 次 git。用短 TTL 缓存拓扑结果，避免每次重建都重复拖 git。
// 任何 mutation 都会失效（见 invalidateTreeCache）；TTL 兜底捕获 git 的旁路变更。
// ---------------------------------------------------------------------------
const GIT_CACHE_TTL_MS = 30000
const gitCache = new Map() // key -> { value, expiresAt }

function gitCacheGet(key) {
  const e = gitCache.get(key)
  if (e === undefined) return undefined
  if (e.expiresAt > Date.now()) return e.value
  gitCache.delete(key)
  return undefined
}
function gitCacheSet(key, value, ttl = GIT_CACHE_TTL_MS) {
  gitCache.set(key, { value, expiresAt: Date.now() + ttl })
}
function invalidateGitCaches() {
  gitCache.clear()
}

/** Main repo root of a checkout (main tree or linked worktree), or null. */
async function gitCommonRoot(path) {
  const key = "root:" + path
  const cached = gitCacheGet(key)
  if (cached !== undefined) return cached
  const r = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], path)
  // 非 git 目录也缓存 null，避免每次 buildTree 都对同一路径重跑 git。
  let value = null
  if (r.ok) {
    const common = r.out
    value = common.endsWith(".git") ? dirname(common) : common
  }
  gitCacheSet(key, value)
  return value
}

async function canonical(path) {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

async function listBranches(repoRoot) {
  const key = "branches:" + repoRoot
  const cached = gitCacheGet(key)
  if (cached !== undefined) return cached
  const r = await git(["for-each-ref", "refs/heads", "--format=%(refname:short)"], repoRoot)
  const value = r.ok ? r.out.split("\n").filter(Boolean) : []
  gitCacheSet(key, value)
  return value
}

/** All linked worktrees of a repo via `git worktree list --porcelain` —
 *  covers BOTH the orca layout (<root>/<project>/<branch>) and git's own
 *  relative worktrees (<repo>/.worktrees/<branch>). Broken/orphaned worktree
 *  checkouts are not registered by git and are skipped automatically. */
async function listWorktrees(repoRoot) {
  const key = "worktrees:" + repoRoot
  const cached = gitCacheGet(key)
  if (cached !== undefined) return cached
  const r = await git(["worktree", "list", "--porcelain"], repoRoot)
  const result = []
  if (r.ok) {
    let cur = null
    for (const line of r.out.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (cur !== null) result.push(cur)
        cur = { path: line.slice("worktree ".length) }
      } else if (line.startsWith("branch ") && cur !== null) {
        cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "")
      } else if (line === "detached" && cur !== null) {
        cur.detached = true
      }
    }
    if (cur !== null) result.push(cur)
  }
  const value = result.filter((w) => w.path !== repoRoot)
  gitCacheSet(key, value)
  return value
}

async function currentBranchRef(repoRoot) {
  const key = "ref:" + repoRoot
  const cached = gitCacheGet(key)
  if (cached !== undefined) return cached
  const r = await git(["symbolic-ref", "-q", "--short", "HEAD"], repoRoot)
  let value
  if (r.ok && r.out) {
    value = { branch: r.out, detached: false }
  } else {
    const h = await git(["rev-parse", "--short", "HEAD"], repoRoot)
    value = h.ok ? { branch: `(detached ${h.out})`, detached: true } : { branch: "unknown", detached: false }
  }
  gitCacheSet(key, value)
  return value
}

/** Dirty file count plus ahead/behind parsed from `git status -sb --porcelain`. */
async function porcelainState(path) {
  const key = "status:" + path
  const cached = gitCacheGet(key)
  if (cached !== undefined) return cached
  const r = await git(["status", "--porcelain", "-b"], path)
  let value
  if (!r.ok) {
    value = { dirty: null, ahead: null, behind: null, upstream: null }
  } else {
    const lines = r.out.split("\n").filter(Boolean)
    const head = lines[0] ?? ""
    const dirty = Math.max(0, lines.length - 1)
    let ahead = null
    let behind = null
    let upstream = null
    if (head.includes("...")) {
      upstream = "tracking"
      const m = head.match(/\[(ahead (\d+))?(, )?(behind (\d+))?|\[gone\]/)
      if (head.includes("[gone]")) {
        upstream = "gone"
      } else if (m) {
        ahead = m[2] ? Number(m[2]) : 0
        behind = m[5] ? Number(m[5]) : 0
      }
    }
    value = { dirty, ahead, behind, upstream }
  }
  gitCacheSet(key, value)
  return value
}

// ---------------------------------------------------------------------------
// manifest (durable repo list + worktree location config)
// ---------------------------------------------------------------------------
function defaultManifest() {
  return {
    version: 1,
    root: join(homedir(), "orca", "workspaces"), // 兼容旧布局；worktreeRoot 为空时不再使用
    worktreeRoot: "", // 空 = 项目内 .dsh/workspaces；绝对路径 = 全局 <root>/<项目>/<分支>
    repos: [],
  }
}

/**
 * worktree 落盘基准目录：
 * - worktreeRoot 为空 → `<项目主仓库>/.dsh/workspaces`（项目内，默认）
 * - worktreeRoot 为绝对路径 → `<worktreeRoot>/<项目名>`（全局布局）
 */
function worktreeBase(manifest, repo) {
  const root = manifest.worktreeRoot
  if (typeof root === "string" && root.trim() !== "") return join(root.trim(), repo.name)
  return join(repo.path, ".dsh", "workspaces")
}

async function loadManifest() {
  try {
    const raw = JSON.parse(await readFile(MANIFEST_PATH, "utf8"))
    return { ...defaultManifest(), ...raw }
  } catch {
    return defaultManifest()
  }
}

async function saveManifest(manifest) {
  await mkdir(dirname(MANIFEST_PATH), { recursive: true })
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n")
}

/** Auto-discover git repos from the DSH workspace list (read-only seeding). */
async function seedRepos(ctx, manifest) {
  const existingRoots = new Set()
  // 并行解析 manifest 里已有包的 git 根（gitCommonRoot 已带缓存，且不依赖列表顺序）。
  const roots = await mapLimit(manifest.repos, 8, async (r) => ({ r, root: await gitCommonRoot(r.path) }))
  for (const { root } of roots) {
    if (root !== null) existingRoots.add(await canonical(root))
  }
  const candidates = []
  try {
    for (const ws of ctx.workspaceRegistry.list()) {
      if (typeof ws.path === "string") candidates.push(ws.path)
    }
  } catch {
    /* registry unavailable */
  }
  // 并行解析所有候选路径的 git 根；再按输入顺序去重、入库，保证 repo 顺序稳定。
  const results = await mapLimit(candidates, 8, async (path) => ({ path, root: await gitCommonRoot(path) }))
  for (const { path, root } of results) {
    if (root === null) continue
    const key = await canonical(root)
    // Worktree directories resolve to the same common root: only one repo entry.
    if (existingRoots.has(key)) continue
    existingRoots.add(key)
    let name = basename(root)
    const taken = new Set(manifest.repos.map((r) => r.name))
    if (taken.has(name)) {
      let i = 2
      while (taken.has(`${name}-${i}`)) i++
      name = `${name}-${i}`
    }
    manifest.repos.push({ name, path: root })
  }
}

/** Collapse manifest entries whose canonical git root is already covered. */
async function dedupeManifest(manifest) {
  const byRoot = new Map()
  const kept = []
  for (const r of manifest.repos) {
    const root = await gitCommonRoot(r.path)
    if (root === null) continue
    const key = await canonical(root)
    if (byRoot.has(key)) continue
    byRoot.set(key, r.name)
    kept.push({ ...r, path: root })
  }
  if (kept.length !== manifest.repos.length) {
    manifest.repos = kept
    await saveManifest(manifest)
  }
}

/** Load the manifest, seed it from the workspace registry, persist new repos. */
async function loadManifestSeeded(ctx, sessions, timings) {
  const manifest = await loadManifest()
  const before = manifest.repos.length
  let t = Date.now()
  await seedRepos(ctx, manifest)
  if (manifest.repos.length !== before) await saveManifest(manifest)
  if (timings) timings.seedRepos = Date.now() - t
  t = Date.now()
  await dedupeManifest(manifest)
  if (timings) timings.dedupe = Date.now() - t
  t = Date.now()
  await pruneOrphanWorkspaces(ctx, manifest, sessions)
  if (timings) timings.pruneOrphan = Date.now() - t
  return manifest
}

/**
 * Self-heal: unregister DSH workspaces that point at a deleted worktree
 * directory under <root>/<repo>/<branch> and have no running sessions.
 */
async function pruneOrphanWorkspaces(ctx, manifest, sessions) {
  const orphanPrefixes = manifest.repos.map((r) => worktreeBase(manifest, r) + "/")
  if (orphanPrefixes.length === 0) return
  let workspaces = []
  try {
    workspaces = ctx.workspaceRegistry.list()
  } catch {
    return
  }
  sessions = sessions ?? (await sessionMap(ctx))
  for (const ws of workspaces) {
    const path = typeof ws.path === "string" ? ws.path : ""
    if (!orphanPrefixes.some((prefix) => path.startsWith(prefix))) continue
    if (existsSync(path)) continue
    if (sessionsUnder(sessions.byCwd, await canonical(path)).some((s) => s.running)) continue
    try {
      await ctx.workspaceRegistry.delete(ws.id)
    } catch {
      /* keep the entry if cleanup fails */
    }
  }
}

// ---------------------------------------------------------------------------
// sessions per canonical directory + id index
// ---------------------------------------------------------------------------
/** 子代理（subagent）会话不应出现在侧边栏：官方侧边栏按 origin==='subagent' 隐藏。 */
function isSubagentSession(header) {
  if (header == null) return false
  if (header.origin === "subagent") return true
  return typeof header.delegationDepth === "number" && header.delegationDepth > 0
}

// 标题不再用 readTitleSnapshots（读完整会话日志，本机 50 个会话全量解码约 8s）在 /tree
// 热路径上逐个 fold。改为走投影通道——live 会话读 sessionProjections.title 单元（内存，
// 快）；persisted 会话读 sessionProjectionCache.cachedSnapshot（零 I/O）。只有确实写了标题
// 但投影/缓存都给不到、且不在持久化缓存里的会话，才在后台（fire-and-forget）用
// readTitleSnapshots 补折一次并写入持久化标题缓存，绝不阻塞 /tree 返回。
const TITLE_CACHE_PATH = join(homedir(), ".dsh", "worktree-panel-titles.json")
let titleCache = null
/** 正在后台补折标题的会话 id，防止同一会话重复触发。 */
const titleBackfill = new Set()

async function loadTitleCache() {
  if (titleCache !== null) return titleCache
  try {
    const raw = JSON.parse(await readFile(TITLE_CACHE_PATH, "utf8"))
    titleCache = new Map(Object.entries(raw))
  } catch {
    titleCache = new Map()
  }
  return titleCache
}

async function saveTitleCache() {
  if (titleCache === null) return
  try {
    await mkdir(dirname(TITLE_CACHE_PATH), { recursive: true })
    await writeFile(TITLE_CACHE_PATH, JSON.stringify(Object.fromEntries(titleCache), null, 2) + "\n")
  } catch {
    /* best effort */
  }
}

async function sessionMap(ctx, timings) {
  const byCwd = new Map()
  const byId = new Map()
  const agents = ctx.get("agents")
  // 投影通道是可选服务：拿不到就退回持久化标题缓存 id。
  let projections, projectionCache, titleService
  try {
    projections = ctx.get("sessionProjections")
    projectionCache = ctx.get("sessionProjectionCache")
    titleService = ctx.get("sessionTitle")
  } catch {
    projections = projectionCache = titleService = undefined
  }

  // 单一事实来源：sessionQuery 返回 live + persisted 全量 logical 会话。
  // 不再从 ctx.sessions.list() 读 —— raw Session 对象没有 cwd/title 直读属性，
  // 之前导致 live 会话整体丢失。这里统一用 rec.header.cwd 归因。
  let records = []
  const tList = Date.now()
  try {
    records = await ctx.sessionQuery.listSessions()
  } catch {
    // sessionQuery 不可用：退回 live-only（仍用 header 取 cwd）。
    try {
      records = ctx.sessions.list().map((s) => ({ header: s.header, live: true, persisted: false }))
    } catch {
      records = []
    }
  }
  if (timings) timings.listSessions = Date.now() - tList

  const tTitle = Date.now()
  const cache = await loadTitleCache()
  let cacheDirty = false
  const needBackfill = []

  for (const rec of records) {
    if (isSubagentSession(rec.header)) continue // 子代理会话不进侧边栏
    const id = rec.header.id
    const cwd = rec.header.cwd
    if (!cwd) continue

    let running = false
    if (rec.live) {
      try {
        running = agents?.get(id)?.status === "running"
      } catch {
        /* not running */
      }
    }

    // 标题优先级（全部廉价，绝不读完整日志）：
    //   live       → sessionProjections.title 单元（内存，最快）
    //   persisted  → sessionProjectionCache.cachedSnapshot（零 I/O）
    //   无投影服务时 live 回退 title 服务的内存 fold
    //   以上都拿不到 → 持久化标题缓存 → id
    let title = cache.get(id) ?? null
    try {
      if (rec.live) {
        const live = ctx.sessions.get(id)
        if (live) {
          if (projections) {
            const t = projections.stateOf(live, "title")
            if (typeof t === "string" && t) title = t
          } else {
            const snap = titleService?.get(live)
            const t = snap?.title
            if (typeof t === "string" && t) title = t
          }
        }
      } else if (projectionCache) {
        const snap = projectionCache.cachedSnapshot(rec.header)
        const t = snap?.values?.title
        if (typeof t === "string" && t) title = t
      }
    } catch {
      /* 投影/缓存不可用或读失败：退回缓存/id */
    }
    if (!title) title = id

    const summary = { id, title, running }
    byId.set(id, summary)
    const key = await canonical(cwd)
    const arr = byCwd.get(key) ?? []
    arr.push(summary)
    byCwd.set(key, arr)

    // 便宜拿到的真实标题计入持久缓存，让后续启动也快。
    if (title !== id && cache.get(id) !== title) {
      cache.set(id, title)
      cacheDirty = true
    }

    // 确有日志标题、但投影/缓存和持久缓存都没给到：后台一次性补折，让标题出现但不拖慢 /tree。
    // live 空白会话无事可折，跳过。
    if (title === id && !cache.has(id) && !rec.live) {
      needBackfill.push(id)
    }
  }

  if (cacheDirty) {
    try {
      await saveTitleCache()
    } catch {
      /* best effort */
    }
  }

  // 后台（fire-and-forget）补折：只对尚未在途的 id。
  // 用一个 setTimeout 延迟到 /tree 响应发出后再跑，避免与 buildTree 并发抢事件循环
  // （buildTree 里的 git 子进程在忙时会被显著拖慢）。
  if (needBackfill.length > 0) {
    const unique = needBackfill.filter((sid) => !titleBackfill.has(sid))
    if (unique.length > 0) {
      for (const sid of unique) titleBackfill.add(sid)
      setTimeout(() => {
        backfillTitles(ctx, unique).catch(() => {
          /* 意外失败即释放，下轮可重试 */
          for (const sid of unique) titleBackfill.delete(sid)
        })
      }, 1500)
    }
  }

  if (timings) timings.titleResolve = Date.now() - tTitle
  return { byCwd, byId }
}

/** 后台一次性折叠标题并写入持久缓存，随后失效 /tree 缓存让下轮展示。绝不 await 到调用方。 */
async function backfillTitles(ctx, ids) {
  let snapshots
  try {
    snapshots = await ctx.sessionQuery.readTitleSnapshots(ids)
  } catch {
    for (const sid of ids) titleBackfill.delete(sid)
    return
  }
  const cache = await loadTitleCache()
  let dirty = false
  for (const snap of snapshots ?? []) {
    titleBackfill.delete(snap.sessionId)
    if (snap.status !== "fulfilled") continue
    // 无标题也存 null：让持久缓存标记「该会话已看过标题」，避免下轮 /tree 重复补折。
    const t = snap.value?.title?.title ?? null
    if (cache.get(snap.sessionId) !== t) {
      cache.set(snap.sessionId, t)
      dirty = true
    }
  }
  // 释放所有在途标记，防止异常路径把 id 卡在 titleBackfill 里。
  for (const sid of ids) titleBackfill.delete(sid)
  if (dirty) {
    try {
      await saveTitleCache()
    } catch {
      /* best effort */
    }
    // 标题有变化：让下一次 /tree 拾取刚补折的标题（只作废 /tree 结果，保留 git 拓扑缓存）。
    invalidateTreeOnly()
  }
}

/** 某目录下的会话：cwd 精确 + 前缀（会话可能在子目录里）。 */
function sessionsUnder(byCwd, key) {
  const out = []
  for (const [cwd, arr] of byCwd) {
    if (cwd === key || cwd.startsWith(key + "/")) out.push(...arr)
  }
  return out
}

/** 同 sessionsUnder，但排除落在任一排除目录（及其子目录）下的会话。
 *  用于主项目节点：worktree 子目录里的会话应归到 worktree 节点，不进主节点。 */
function sessionsUnderExcluding(byCwd, key, excludeKeys) {
  const out = []
  for (const [cwd, arr] of byCwd) {
    if (cwd === key) {
      out.push(...arr)
      continue
    }
    if (!cwd.startsWith(key + "/")) continue
    let excluded = false
    for (const ex of excludeKeys) {
      if (cwd === ex || cwd.startsWith(ex + "/")) {
        excluded = true
        break
      }
    }
    if (!excluded) out.push(...arr)
  }
  return out
}

/**
 * 把某个目录下已存在的会话补挂到其 DSH 工作区的 sessionIds。
 *
 * dsh-workspace 的 attachSession 只接受「cwd 精确等于 workspace.path」的会话（子目录会话会因
 * cwd 校验不匹配而抛错，这里逐条 best-effort 挂载、失败跳过），且幂等（已挂的会话不再写入）。
 * 用于 worktree 注册 / worktree_task 里回填那些「先于工作区注册而创建」的历史会话——否则会话
 * 不在 sessionIds 里，依赖 workspace feed 的其它插件（如 dsh-gitlab 的 GitLab tab）会判定它
 * 「没有 workspace」。
 * @param ctx - 插件上下文。
 * @param workspace - 目标工作区实体（可为 undefined，无则直接返回）。
 * @param records - 可选：先取好的会话记录（`{ header }[]`），复用避免每工作区重复 listSessions。
 */
async function attachSessionsFor(ctx, workspace, records) {
  if (!workspace) return
  if (records === undefined) {
    records = []
    try {
      records = await ctx.sessionQuery.listSessions()
    } catch {
      // sessionQuery 不可用：退回 live-only（仍用 header 取 cwd）。
      try {
        records = ctx.sessions.list().map((s) => ({ header: s.header }))
      } catch {
        records = []
      }
    }
  }
  const key = await canonical(workspace.path)
  for (const rec of records) {
    const header = rec.header
    if (!header || !header.cwd) continue
    if (isSubagentSession(header)) continue
    let cwd
    try {
      cwd = await canonical(header.cwd)
    } catch {
      continue
    }
    if (cwd !== key) continue
    try {
      await workspace.attachSession(header.id)
    } catch {
      /* 子目录会话或 cwd 不匹配，跳过 */
    }
  }
}

/** 按路径解析工作区：先 canonical（realpath）再原路径。
 *  macOS 上 /Users 是 /private/Users 的符号链接，注册表存的可能是任一种写法。 */
async function resolveWorkspaceByPath(ctx, path) {
  try {
    const ws = await ctx.workspaceRegistry.resolveByPath(await canonical(path))
    if (ws) return ws
  } catch {
    /* fall through */
  }
  try {
    return await ctx.workspaceRegistry.resolveByPath(path)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// tree
// ---------------------------------------------------------------------------
/** 有界并发 map：对 items 逐项跑 async fn，同时最多 limit 个在跑。 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const workers = []
  const workerCount = Math.min(limit, items.length)
  for (let w = 0; w < workerCount; w++) {
    workers.push((async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await fn(items[i], i)
      }
    })())
  }
  await Promise.all(workers)
  return results
}

// /tree 结果缓存：轮询时避免每次全量重算（git 子进程 + 标题 fold 都很贵）。
// 任何成功 mutation 都会失效；另设短 TTL 兜底捕获 git 的旁路变更（新分支等）。
const TREE_CACHE_TTL_MS = 5000
let treeCache = null

function invalidateTreeOnly() {
  treeCache = null
}
function invalidateTreeCache() {
  // 任何 mutation 都可能改变分支/dirty/worktree 布局，一并作废 git 拓扑缓存；
  // 只需要作废 /tree 结果、保留 git 拓扑（如后台标题补折）的调用方用 invalidateTreeOnly。
  invalidateTreeOnly()
  invalidateGitCaches()
}

async function buildTreeCached(ctx) {
  const now = Date.now()
  if (treeCache !== null && treeCache.expiresAt > now) return treeCache.payload
  const payload = await buildTree(ctx)
  treeCache = { payload, expiresAt: now + TREE_CACHE_TTL_MS }
  return payload
}

async function buildTree(ctx) {
  const timings = {}
  const tStart = Date.now()
  // sessionMap 只算一次：传给 loadManifestSeeded → pruneOrphanWorkspaces 复用，
  // 避免标题 fold（读全量日志）在单次 /tree 里跑两遍。
  let t = Date.now()
  const sessions = await sessionMap(ctx, timings)
  timings.sessionMap = Date.now() - t
  t = Date.now()
  const manifest = await loadManifestSeeded(ctx, sessions, timings)
  timings.loadManifestSeeded = Date.now() - t
  t = Date.now()

  // 并行收集每个 repo 的 git 拓扑 + worktree 详情（git 调用互相独立）。
  // 细粒度打点：mapLimit 内多个 worker 并发，不能把各 worker 墙钟直接相加（会重复累加）。
  // 这里只统计非并发的准确量：gitTopology(阶段墙钟)、gitCalls(调用次数)、
  // worktreeResolve/canonical(非 git 开销)。git 是否真慢看 gitTopology - (worktreeResolve+canonical)。
  const gitTimings = { worktreeResolve: 0, canonical: 0, gitCalls: 0 }
  const repoResults = await mapLimit(manifest.repos, 8, async (repo) => {
    const root = await gitCommonRoot(repo.path)
    if (root === null) return null
    gitTimings.gitCalls += 4 // currentBranchRef + porcelainState + listBranches + listWorktrees
    const [head, main, branches, wtList] = await Promise.all([
      currentBranchRef(root),
      porcelainState(root),
      listBranches(root),
      listWorktrees(root),
    ])
    const wtKeys = new Set()
    const worktrees = await mapLimit(wtList.filter((w) => existsSync(w.path)), 8, async (wt) => {
      const path = wt.path
      gitTimings.gitCalls += 2 // currentBranchRef + porcelainState
      const [ref, state, key] = await Promise.all([
        currentBranchRef(path),
        porcelainState(path),
        canonical(path),
      ])
      wtKeys.add(key)
      let workspaceId = null
      const resolve0 = Date.now()
      try {
        // 只解析已有注册，不自动注册子目录（注册由用户显式操作触发）。
        const ws = await resolveWorkspaceByPath(ctx, key)
        workspaceId = ws?.id ?? null
      } catch {
        /* not registered */
      }
      gitTimings.worktreeResolve += Date.now() - resolve0
      // 会话归属统一按 cwd（精确 + 前缀）判定：header.cwd 是唯一事实来源，
      // 工作区的 sessionIds 账本可能缺会话（例如未显式 attach 的），不能作为唯一依据。
      return {
        name: wt.branch ?? basename(path),
        path,
        branch: ref.branch,
        dirty: state.dirty,
        ahead: state.ahead,
        behind: state.behind,
        upstream: state.upstream,
        sessions: sessionsUnder(sessions.byCwd, key),
        workspaceId,
      }
    })
    const can0 = Date.now()
    const mainKey = await canonical(root)
    gitTimings.canonical += Date.now() - can0
    return { repo, root, head, main, branches, worktrees, wtKeys, mainKey }
  })
  timings.gitTopology = Date.now() - t
  timings.gitCalls = gitTimings.gitCalls
  timings.worktreeResolve = gitTimings.worktreeResolve
  timings.canonical = gitTimings.canonical
  // 近似「git 子进程 + mapLimit 调度」占用：阶段墙钟减去非 git 的 resolve/canonical 开销。
  timings.gitBound = Math.max(0, timings.gitTopology - timings.worktreeResolve - timings.canonical)
  t = Date.now()

  // 主工作区解析（含可能的补注册，是写操作，串行执行避免并发写注册表）。
  const repos = []
  for (const r of repoResults) {
    if (r === null) continue
    let mainWorkspaceId = null
    try {
      const ws = await resolveWorkspaceByPath(ctx, r.mainKey)
      if (ws) mainWorkspaceId = ws.id
      else {
        // 旧清单条目可能缺主工作区注册：补注册一次，让项目组出现在官方列表。
        const created = await ctx.workspaceRegistry.create(r.root, r.repo.name)
        mainWorkspaceId = created.id
      }
    } catch {
      /* not registered */
    }
    // 主节点排除 worktree 子目录：worktree 会话已在各自节点展示，不能重复兜进主节点。
    // 除「现存 worktree 目录」外，还要排除该 repo 的 worktree 基准目录（worktreeBase，
    // 如 <repo>/.dsh/workspaces）。否则某分支 worktree 一旦被删除，其路径不在 wtKeys 里，
    // 该分支下的孤儿会话会因 cwd 以主目录开头而误归入「主工作树」节点。
    const excludeKeys = new Set(r.wtKeys)
    const wtBase = await canonical(worktreeBase(manifest, r.repo))
    if (wtBase !== r.mainKey) excludeKeys.add(wtBase)
    repos.push({
      name: r.repo.name,
      path: r.root,
      branch: r.head.branch,
      dirty: r.main.dirty,
      ahead: r.main.ahead,
      behind: r.main.behind,
      branches: r.branches,
      worktrees: r.worktrees,
      sessions: sessionsUnderExcluding(sessions.byCwd, r.mainKey, excludeKeys),
      workspaceId: mainWorkspaceId,
    })
  }
  // 基础项目：DSH 工作区里不落在任何仓库/工作树目录下的节点（非 git 项目），
  // 它们的会话原样复用挂进来，与 worktree 维度合并展示。
  const covered = new Set()
  for (const repo of repos) {
    covered.add(await canonical(repo.path))
    for (const wt of repo.worktrees) covered.add(await canonical(wt.path))
  }
  const workspaces = []
  try {
    for (const ws of ctx.workspaceRegistry.list()) {
      const path = typeof ws.path === "string" ? ws.path : undefined
      if (!path) continue
      const key = await canonical(path)
      if (covered.has(key)) continue
      workspaces.push({
        id: ws.id,
        name: (typeof ws.title === "string" && ws.title) || basename(path),
        path,
        sessions: sessionsUnder(sessions.byCwd, key),
      })
    }
  } catch {
    /* registry unavailable */
  }
  timings.materialize = Date.now() - t
  timings.total = Date.now() - tStart
  if (timings.total > 1000) {
    console.warn(`[dsh-worktree-panel] /tree build ${timings.total}ms ` + JSON.stringify(timings))
  }
  return { root: manifest.root, worktreeRoot: manifest.worktreeRoot ?? "", repos, workspaces, timings }
}

// ---------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------
const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]+$/

async function handleAddRepo(body, ctx) {
  const path = String(body.path ?? "").trim()
  if (!path) return [400, { error: "请提供仓库路径" }]
  const root = await gitCommonRoot(path)
  if (root === null) return [400, { error: `该路径不是 git 仓库：${path}` }]
  const manifest = await loadManifestSeeded(ctx)
  let name = basename(root)
  const taken = new Set(manifest.repos.map((r) => r.name))
  if (taken.has(name)) {
    let i = 2
    while (taken.has(`${name}-${i}`)) i++
    name = `${name}-${i}`
  }
  manifest.repos.push({ name, path: root })
  await saveManifest(manifest)
  // 注册主工作区（若尚未注册），这样项目组会出现在官方工作区列表里，
  // worktree 维度也才有挂载点。
  let workspaceId = null
  try {
    const key = await canonical(root)
    const existing = await resolveWorkspaceByPath(ctx, key)
    if (existing) workspaceId = existing.id
    else {
      const ws = await ctx.workspaceRegistry.create(root, name)
      workspaceId = ws.id
    }
  } catch (error) {
    console.warn("dsh-worktree-panel: main workspace registration failed:", String(error))
  }
  return [200, { ok: true, name, path: root, workspaceId }]
}

/** 把非 git 目录初始化为 git 仓库（含首次提交），并收录为项目。 */
async function handleInitRepo(body, ctx) {
  const path = String(body.path ?? "").trim()
  if (!path) return [400, { error: "请提供目录路径" }]
  if (!existsSync(path)) return [404, { error: `目录不存在：${path}` }]
  const existingRoot = await gitCommonRoot(path)
  if (existingRoot !== null) {
    // 已是 git 仓库：直接收录为项目（等价于 add）。
    return handleAddRepo({ path }, ctx)
  }
  const init = await git(["init", "-b", "main"], path)
  if (!init.ok) return [400, { error: `git init 失败：${init.error}` }]
  // 首次提交：目录为空时补一个占位文件保证提交成功。
  const hasFiles = (await readdir(path)).length > 0
  if (!hasFiles) {
    try {
      await writeFile(join(path, ".gitkeep"), "")
    } catch {
      /* best effort */
    }
  }
  await git(["add", "-A"], path)
  const commit = await git(["commit", "-m", "init"], path)
  if (!commit.ok && hasFiles) {
    return [200, { ok: true, warning: `git 已初始化，但首次提交失败：${commit.error}` }]
  }
  // 收录为项目（manifest 条目 + 主工作区注册）。
  const manifest = await loadManifestSeeded(ctx)
  let name = basename(path)
  const taken = new Set(manifest.repos.map((r) => r.name))
  if (taken.has(name)) {
    let i = 2
    while (taken.has(`${name}-${i}`)) i++
    name = `${name}-${i}`
  }
  manifest.repos.push({ name, path })
  await saveManifest(manifest)
  let workspaceId = null
  try {
    const key = await canonical(path)
    const existing = await resolveWorkspaceByPath(ctx, key)
    if (existing) workspaceId = existing.id
    else {
      const ws = await ctx.workspaceRegistry.create(path, name)
      workspaceId = ws.id
    }
  } catch (error) {
    console.warn("dsh-worktree-panel: main workspace registration failed:", String(error))
  }
  return [200, { ok: true, name, path, workspaceId }]
}

async function handleRemoveRepo(body, ctx) {
  const manifest = await loadManifestSeeded(ctx)
  const repo = manifest.repos.find((r) => r.name === String(body.name ?? ""))
  if (!repo) return [404, { error: `未找到项目：${body.name}` }]
  // 一并清理该项目下的所有 linked worktree（受运行中会话保护，除非 force）。
  const root = await gitCommonRoot(repo.path)
  if (root !== null) {
    const wts = await listWorktrees(root)
    for (const wt of wts) {
      const path = wt.path
      if (!existsSync(path)) continue
      const label = wt.branch ?? basename(path)
      if (!body.force) {
        const running = sessionsUnder((await sessionMap(ctx)).byCwd, await canonical(path)).filter((s) => s.running)
        if (running.length > 0) {
          return [409, { error: `worktree「${label}」有 ${running.length} 个会话正在运行，请先结束会话或改用 force` }]
        }
      }
      // 目录删除前解析注册（删除后 resolveByPath 可能失配）。
      let ws = null
      try {
        ws = await resolveWorkspaceByPath(ctx, path)
      } catch {
        /* not registered */
      }
      const removed = await git(
        ["worktree", "remove", path, ...(body.force ? ["--force"] : [])],
        root,
      )
      if (removed.ok && ws !== null) {
        try {
          await ctx.workspaceRegistry.delete(ws.id)
        } catch {
          /* keep the registry entry if cleanup fails */
        }
      }
    }
    await git(["worktree", "prune"], root)
  }
  manifest.repos = manifest.repos.filter((r) => r.name !== repo.name)
  await saveManifest(manifest)
  // 注销主工作区（磁盘目录与会话记录保留；无会话引用时才删除注册）。
  if (root !== null) {
    const remaining = sessionsUnder((await sessionMap(ctx)).byCwd, await canonical(root))
    if (remaining.length === 0) {
      try {
        const ws = await resolveWorkspaceByPath(ctx, root)
        if (ws) await ctx.workspaceRegistry.delete(ws.id)
      } catch {
        /* keep the registry entry if cleanup fails */
      }
    }
  }
  return [200, { ok: true }]
}

async function handleCreateWorktree(ctx, body) {
  const manifest = await loadManifestSeeded(ctx)
  const repo = manifest.repos.find((r) => r.name === body.repo)
  if (!repo) return [404, { error: `未找到项目：${body.repo}` }]
  const branch = String(body.branch ?? "").trim()
  if (!BRANCH_NAME_RE.test(branch)) return [400, { error: `非法分支名：${branch}` }]
  const root = await gitCommonRoot(repo.path)
  if (root === null) return [400, { error: `项目不是有效的 git 仓库：${repo.path}` }]
  const base = worktreeBase(manifest, repo)
  const target = join(base, branch)
  if (existsSync(target)) return [409, { error: `该分支的 worktree 已存在：${target}` }]
  const hasBranch = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root)).ok
  if (!hasBranch) {
    const b = body.base ? String(body.base) : undefined
    const args = ["branch", branch]
    if (b) args.push(b)
    const created = await git(args, root)
    if (!created.ok) return [400, { error: `创建分支失败：${created.error}` }]
  }
  await mkdir(base, { recursive: true })
  const added = await git(["worktree", "add", target, branch], root)
  if (!added.ok) return [400, { error: `创建 worktree 失败：${added.error}` }]
  // 不自动注册子目录为工作区（注册由用户在 worktree 上显式操作触发）。
  return [200, { ok: true, path: target, workspaceId: null }]
}

async function handleRemoveWorktree(ctx, body) {
  const manifest = await loadManifestSeeded(ctx)
  const repo = manifest.repos.find((r) => r.name === body.repo)
  if (!repo) return [404, { error: `未找到项目：${body.repo}` }]
  const branch = String(body.branch ?? "")
  if (!BRANCH_NAME_RE.test(branch)) return [400, { error: `非法分支名：${branch}` }]
  const root = await gitCommonRoot(repo.path)
  if (root === null) return [400, { error: `项目不是有效的 git 仓库：${repo.path}` }]
  // 按分支名在 git 注册表里定位 worktree（覆盖 orca 与 .worktrees 两种布局）。
  const wts = await listWorktrees(root)
  const wt = wts.find((w) => w.branch === branch || basename(w.path) === branch)
  if (!wt || !existsSync(wt.path)) return [404, { error: `未找到 worktree：${branch}` }]
  const target = wt.path
  if (!body.force) {
    const sessions = await sessionMap(ctx)
    const inside = sessionsUnder(sessions.byCwd, await canonical(target)).filter((s) => s.running)
    if (inside.length > 0) {
      return [409, { error: `有 ${inside.length} 个会话正在该 worktree 中运行，请先结束会话或改用 force` }]
    }
  }
  // 解析目标工作区（在目录删除前解析：resolveByPath 对不存在的目录可能失配）。
  let targetWorkspace = null
  try {
    const key = await canonical(target)
    targetWorkspace = await resolveWorkspaceByPath(ctx, target)
  } catch {
    /* not registered */
  }
  const removed = await git(
    ["worktree", "remove", target, ...(body.force ? ["--force"] : [])],
    root,
  )
  if (!removed.ok) return [400, { error: `删除失败：${removed.error}` }]
  await git(["worktree", "prune"], root)
  // 删除了 worktree 就无条件注销其工作区注册：目录已不存在，保留的注册只会让
  // 工作区数量不变，客户端侧边栏（按 workspaces.length 变化触发 /tree 刷新）就不会
  // 刷新，导致删除后侧边栏仍显示旧的 worktree 节点。
  if (targetWorkspace !== null) {
    try {
      await ctx.workspaceRegistry.delete(targetWorkspace.id)
    } catch {
      /* keep the registry entry if cleanup fails */
    }
  }
  return [200, { ok: true }]
}

/**
 * 切换主工作树的分支（在主仓库执行 git checkout）。
 * 已在其他 worktree 检出的分支不可切（git 限制）。
 */
async function handleSwitchMain(ctx, body) {
  const manifest = await loadManifestSeeded(ctx)
  const repo = manifest.repos.find((r) => r.name === body.repo)
  if (!repo) return [404, { error: `未找到项目：${body.repo}` }]
  const branch = String(body.branch ?? "").trim()
  if (!BRANCH_NAME_RE.test(branch)) return [400, { error: `非法分支名：${branch}` }]
  const root = await gitCommonRoot(repo.path)
  if (root === null) return [400, { error: `项目不是有效的 git 仓库：${repo.path}` }]
  // create：新建分支并切换（不建 worktree），让新分支直接成为主工作树的当前分支。
  if (body.create === true) {
    const exists = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root)).ok
    if (exists) return [409, { error: `分支已存在：${branch}` }]
    const r = await git(["checkout", "-b", branch], root)
    if (!r.ok) return [400, { error: `创建分支失败：${r.error}` }]
    return [200, { ok: true, branch }]
  }
  const wts = await listWorktrees(root)
  if (wts.some((w) => w.branch === branch)) {
    return [409, { error: `分支「${branch}」已在 worktree 中检出，无法在主工作树切换` }]
  }
  const r = await git(["checkout", branch], root)
  if (!r.ok) return [400, { error: `切换分支失败：${r.error}` }]
  return [200, { ok: true, branch }]
}

/**
 * 按需注册一个 worktree 为 DSH 工作区（用户显式触发：在该 worktree 上点
 * 「+ 新会话」）。注册后该目录可开新会话、会话归类到其下。
 */
async function handleRegisterWorktree(ctx, body) {
  const manifest = await loadManifestSeeded(ctx)
  const repo = manifest.repos.find((r) => r.name === body.repo)
  if (!repo) return [404, { error: `未找到项目：${body.repo}` }]
  const branch = String(body.branch ?? "").trim()
  if (!BRANCH_NAME_RE.test(branch)) return [400, { error: `非法分支名：${branch}` }]
  const root = await gitCommonRoot(repo.path)
  if (root === null) return [400, { error: `项目不是有效的 git 仓库：${repo.path}` }]
  const wts = await listWorktrees(root)
  const wt = wts.find((w) => w.branch === branch || basename(w.path) === branch)
  if (!wt || !existsSync(wt.path)) return [404, { error: `未找到 worktree：${branch}` }]
  try {
    const key = await canonical(wt.path)
    const existing = await resolveWorkspaceByPath(ctx, wt.path)
    const ws = existing ?? await ctx.workspaceRegistry.create(wt.path, `${repo.name}/${branch}`)
    // 回填该 worktree 目录下已存在的会话：注册本身不创建会话，若会话先于工作区注册而建
    // （例如先开 worktree、后手动「注册」），它们不在 sessionIds 里，其它插件会判定无 workspace。
    await attachSessionsFor(ctx, ws)
    return [200, { ok: true, workspaceId: ws.id }]
  } catch (error) {
    return [500, { error: `注册失败：${String(error)}` }]
  }
}

// ---------------------------------------------------------------------------
// worktree_task — agent-callable tool: create worktree + spawn a session in it
// ---------------------------------------------------------------------------
const WORKTREE_TASK_OUTPUT = {
  schema: { type: "string" },
  render: (_args, value) => [{ type: "text", text: value }],
}

/** 把文本压成英文连字符命名的小写 slug：只保留 a-z0-9，其余（含中文）一律丢弃并转为连字符。 */
function slugify(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "")
}

/** 推断任务类型（fix | feature）：显式 kind 优先，否则按任务文本关键词。 */
function inferTaskKind(task, kind) {
  if (typeof kind === "string" && kind.trim() !== "") {
    const k = kind.trim().toLowerCase()
    if (["fix", "bug", "bugfix", "defect", "修复", "缺陷"].includes(k)) return "fix"
    return "feature"
  }
  const t = String(task ?? "").toLowerCase()
  if (/修复|解决|修正|fix|bug|缺陷|报错|崩溃|故障|问题/.test(t)) return "fix"
  return "feature"
}

/**
 * Spawn a branch + git worktree, register it as a DSH workspace, then create
 * and start a fresh session rooted in that worktree with the given task.
 *
 * Runs the new session in the background (fire-and-forget): the tool returns
 * immediately after queueing the task, and the new agent loop keeps running
 * under the host. Uses the deployment-default model and agent preset.
 */
async function handleWorktreeTask(ctx, args, exec) {
  const repoName = String(args.repo ?? "").trim()
  const task = String(args.task ?? "").trim()
  if (!repoName) throw new Error("请提供项目名 repo")
  if (!task) throw new Error("请提供任务描述 task")
  // 分支名：优先用显式提供的；缺省则按 kind/任务自动推断为 fix/<英文slug> 或 feature/<英文slug>（分支名必须为英文连字符命名）。
  let branch = String(args.branch ?? "").trim()
  if (!branch) {
    const kind = inferTaskKind(task, args.kind)
    const slug = slugify(task)
    if (!slug) {
      throw new Error(`无法从任务自动生成英文分支名，请显式传入英文 branch 参数（如 fix/login-page-crash 或 feature/export-pdf）。`)
    }
    branch = `${kind}/${slug}`
  }
  if (!BRANCH_NAME_RE.test(branch)) throw new Error(`非法分支名（需英文，用连字符连接，如 fix/login-page-crash）：${branch}`)

  const manifest = await loadManifestSeeded(ctx)
  const repo = manifest.repos.find((r) => r.name === repoName)
  if (!repo) throw new Error(`未找到项目：${repoName}`)

  // 1. 创建分支 + worktree。
  const root = await gitCommonRoot(repo.path)
  if (root === null) throw new Error(`项目不是有效的 git 仓库：${repo.path}`)
  const base = worktreeBase(manifest, repo)
  const target = join(base, branch)
  if (existsSync(target)) throw new Error(`该分支的 worktree 已存在：${target}`)
  const hasBranch = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root)).ok
  if (!hasBranch) {
    const fromBase = typeof args.base === "string" && args.base.trim() !== "" ? args.base.trim() : undefined
    const created = await git(fromBase ? ["branch", branch, fromBase] : ["branch", branch], root)
    if (!created.ok) throw new Error(`创建分支失败：${created.error}`)
  }
  await mkdir(base, { recursive: true })
  const added = await git(["worktree", "add", target, branch], root)
  if (!added.ok) throw new Error(`创建 worktree 失败：${added.error}`)

  // 2. 把该 worktree 注册为 DSH 工作区（这样会话归到它的下面、可开新会话）。
  let workspaceId = null
  let workspaceObj = null
  try {
    const key = await canonical(target)
    const existing = await resolveWorkspaceByPath(ctx, key)
    if (existing) {
      workspaceId = existing.id
      workspaceObj = existing
    } else {
      const ws = await ctx.workspaceRegistry.create(target, `${repo.name}/${branch}`)
      workspaceId = ws.id
      workspaceObj = ws
    }
  } catch (error) {
    throw new Error(`注册 worktree 工作区失败：${String(error)}`)
  }

  // 3. 在该目录下新建并启动一个会话，默认模型 + 默认预设。
  const agents = ctx.get("agents")
  if (!agents) throw new Error("agents 服务不可用")
  const defaultModel = ctx.get("agentDefaultModel")
  const presets = ctx.get("agentPresets")

  let selection = null
  try {
    const sel = defaultModel?.currentSelection?.()
    if (sel?.provider && sel?.model) selection = sel
  } catch {
    /* fall through to caller model */
  }
  if (!selection) {
    const caller = exec?.agent?.options
    if (caller?.provider && caller?.model) selection = { provider: caller.provider, model: caller.model }
  }
  if (!selection) throw new Error("无法确定模型：请先配置默认模型")

  let presetId = null
  if (presets) {
    try {
      presetId = (await presets.resolve(undefined)).id
    } catch {
      presetId = null
    }
  }

  const sessionId = SessionId(`session-${randomUUID()}`)
  const { agent } = await agents.create({
    sessionId,
    meta: { cwd: target, ...(presetId !== null ? { agentPreset: presetId } : {}) },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
      if (presetId !== null && presets) await presets.mount(agentCtx, presetId)
    },
  })

  // 把刚创建的会话挂到该 worktree 的工作区，否则它不在 sessionIds 里，
  // 依赖 workspace feed 的其它插件（如 dsh-gitlab 的 GitLab tab）会判定「没有 workspace」。
  if (workspaceObj) {
    try {
      await workspaceObj.attachSession(sessionId)
    } catch {
      /* best effort：挂不上不阻断任务 */
    }
  }

  // 等首轮就绪后注入任务；只排队唤醒，不等它跑完（后台运行）。
  await agent.whenIdle()
  agent.followup(createUserMessage({
    content: [{ type: "text", text: task }],
    source: { kind: "user" },
  }))

  invalidateTreeCache()

  return [
    "已在 worktree 中新建会话并开始任务：",
    `项目：${repo.name}  分支：${branch}`,
    `worktree 目录：${target}`,
    `新会话：${String(sessionId)}`,
    `工作区：${workspaceId ?? "(未注册)"}`,
    `任务：${task}`,
  ].join("\n")
}

/** Tool definition factory bound to the plugin context. */
function registerWorktreeTaskTool(ctx) {
  return defineTool({
    name: "worktree_task",
    description:
      "为指定项目创建一个新分支和 git worktree，并立即在该 worktree 目录下新建一个 DSH 会话、自动注入指定任务让其开始工作。用于用户要求「创建 worktree 并修复/实现 xxx」时，隔离出独立分支上的新会话来干活。分支名必须为英文、用小写连字符命名：修复类 → fix/<kebab>，实现/功能类 → feature/<kebab>；省略 branch 时由工具按 kind/任务自动推断，但若无法生成英文名会要求你补传。",
    parameters: {
      repo: { type: "string", required: true, description: "worktree 面板中的项目名。" },
      task: { type: "string", required: true, description: "在该 worktree 新会话中要完成的任务（修复/实现内容）。" },
      branch: { type: "string", description: "分支名（必须英文、小写连字符）。修复类 fix/<kebab>，功能类 feature/<kebab>；缺省由工具按 kind/任务自动推断。" },
      kind: { type: "string", description: "任务类型：fix | feature。省略时按任务内容推断（含「修复/解决/缺陷」等则为 fix，其余视为 feature）。" },
      base: { type: "string", description: "新分支基于的已有分支；缺省从当前默认分支创建。" },
    },
    output: WORKTREE_TASK_OUTPUT,
    timeoutMs: 60_000,
    execute: (args, exec) => handleWorktreeTask(ctx, args, exec),
  })
}

/** worktree_remove 的 execute 体：复用 handleRemoveWorktree，把 [code,payload] 映射为结果/错误。 */
async function handleWorktreeRemove(ctx, args) {
  const repo = String(args.repo ?? "")
  const branch = String(args.branch ?? "")
  const force = args.force === true
  const [code, payload] = await handleRemoveWorktree(ctx, { repo, branch, force })
  if (code >= 200 && code < 300) {
    invalidateTreeCache()
    return `已删除 worktree：项目 ${repo} / 分支 ${branch}${force ? "（force）" : ""}`
  }
  throw new Error(payload?.error ?? `删除 worktree 失败（HTTP ${code}）`)
}

/** Tool definition factory: symmetric counterpart of worktree_task. */
function registerWorktreeRemoveTool(ctx) {
  return defineTool({
    name: "worktree_remove",
    description:
      "删除指定项目下某分支的 git worktree（含 prune，并按需注销其 DSH 工作区）。若该目录有会话正在运行且未传 force 会被拒绝。用于用户要求「删除/移除 worktree」、「清理隔离分支」时。",
    parameters: {
      repo: { type: "string", required: true, description: "worktree 面板中的项目名。" },
      branch: { type: "string", required: true, description: "要删除的 worktree 对应分支名（如 fix/login-page-crash）。" },
      force: { type: "boolean", description: "是否强制删除（忽略运行中会话，并会丢弃未提交改动）。缺省 false。" },
    },
    output: WORKTREE_TASK_OUTPUT,
    timeoutMs: 60_000,
    execute: (args, exec) => handleWorktreeRemove(ctx, args),
  })
}

// ---------------------------------------------------------------------------
// config (worktree 落盘位置)
// ---------------------------------------------------------------------------

/** 读取 worktree 落盘配置：空 worktreeRoot = 项目内 .dsh/workspaces。 */
async function handleGetConfig(ctx) {
  const manifest = await loadManifest()
  const worktreeRoot = typeof manifest.worktreeRoot === "string" ? manifest.worktreeRoot : ""
  return { worktreeRoot, mode: worktreeRoot.trim() === "" ? "project" : "global" }
}

/** 更新 worktree 落盘位置：空字符串 = 恢复项目内 .dsh/workspaces。 */
async function handleSetConfig(ctx, body) {
  const value = body?.worktreeRoot
  if (value !== undefined && typeof value !== "string") {
    return [400, { error: "worktreeRoot 必须是字符串" }]
  }
  const worktreeRoot = String(value ?? "").trim()
  if (worktreeRoot !== "") {
    if (!isAbsolute(worktreeRoot)) {
      return [400, { error: `worktreeRoot 必须是绝对路径：${worktreeRoot}` }]
    }
    await mkdir(worktreeRoot, { recursive: true })
  }
  const manifest = await loadManifest()
  manifest.worktreeRoot = worktreeRoot
  await saveManifest(manifest)
  return [200, { ok: true, worktreeRoot, mode: worktreeRoot === "" ? "project" : "global" }]
}

// ---------------------------------------------------------------------------
// migration（worktree 存放位置变更时的批量搬运）
// ---------------------------------------------------------------------------

/** 生成迁移计划：遍历每个项目，找到旧 base 下的 worktree 并计算新路径。 */
async function buildMigrationPlan(ctx, oldWorktreeRoot, newWorktreeRoot) {
  const manifest = await loadManifest()
  const oldRoot = String(oldWorktreeRoot ?? manifest.worktreeRoot ?? "").trim()
  const newRoot = String(newWorktreeRoot ?? "").trim()
  if (oldRoot === newRoot) return { same: true, oldRoot, newRoot, items: [] }

  const items = []
  const sessions = await sessionMap(ctx)

  for (const repo of manifest.repos) {
    const oldBase = worktreeBase({ ...manifest, worktreeRoot: oldRoot }, repo)
    const newBase = worktreeBase({ ...manifest, worktreeRoot: newRoot }, repo)
    if (oldBase === newBase) continue

    const root = await gitCommonRoot(repo.path)
    if (!root) continue

    const wts = await listWorktrees(root)
    for (const wt of wts) {
      if (!existsSync(wt.path)) continue
      if (!wt.path.startsWith(oldBase + "/")) continue

      const rel = wt.path.slice(oldBase.length + 1)
      const newPath = join(newBase, rel)
      const state = await porcelainState(wt.path)
      const dirty = state.dirty != null && state.dirty > 0
      const key = await canonical(wt.path)
      const active = sessionsUnder(sessions.byCwd, key).some((s) => s.running)
      const ws = await resolveWorkspaceByPath(ctx, wt.path)

      items.push({
        repo: repo.name,
        branch: wt.branch || basename(wt.path),
        oldPath: wt.path,
        newPath,
        dirty,
        active,
        detached: !!wt.detached,
        workspaceId: ws?.id || null,
        skipped: dirty || active,
        skipReason: dirty ? "dirty" : active ? "active" : null,
      })
    }
  }

  return { same: false, oldRoot, newRoot, items }
}

/** 执行迁移：逐项 git worktree move + 更新 DSH 工作区注册。 */
async function executeMigration(ctx, plan) {
  const manifest = await loadManifest()
  const results = []

  for (const item of plan.items) {
    if (item.skipped) {
      results.push({ ...item, migrated: false })
      continue
    }

    try {
      const repo = manifest.repos.find((r) => r.name === item.repo)
      if (!repo) {
        results.push({ ...item, migrated: false, error: "项目不在清单中" })
        continue
      }

      await mkdir(dirname(item.newPath), { recursive: true })
      const root = await gitCommonRoot(repo.path)
      const r = await git(["worktree", "move", item.oldPath, item.newPath], root)
      if (!r.ok) {
        results.push({ ...item, migrated: false, error: r.error })
        continue
      }

      let newWorkspaceId = null
      if (item.workspaceId) {
        try { await ctx.workspaceRegistry.delete(item.workspaceId) } catch { /* gone already */ }
        try {
          const ws = await ctx.workspaceRegistry.create(item.newPath, `${item.repo}/${item.branch}`)
          newWorkspaceId = ws.id
        } catch (e) {
          results.push({ ...item, migrated: true, newWorkspaceId: null, workspaceError: String(e?.message ?? e) })
          continue
        }
      }

      results.push({ ...item, migrated: true, newWorkspaceId })
    } catch (e) {
      results.push({ ...item, migrated: false, error: String(e?.message ?? e) })
    }
  }

  return results
}

async function handleMigrate(ctx, body) {
  const oldRoot = body.oldWorktreeRoot !== undefined ? String(body.oldWorktreeRoot) : undefined
  const newRoot = String(body.worktreeRoot ?? "")
  const execute = body.execute === true

  // oldWorktreeRoot 缺省时会退化为 manifest 当前值；若 config 刚保存完，
  // 两者相等会导致迁移静默跳过。显式提醒调用方传旧值。
  if (oldRoot === undefined) {
    const manifest = await loadManifest()
    if (String(manifest.worktreeRoot ?? "").trim() === newRoot.trim()) {
      console.warn(
        "dsh-worktree-panel: /migrate 未传 oldWorktreeRoot，且 manifest 已等于目标值，" +
          "迁移会被判定为 no-op。调用方（设置页）应始终携带保存前的旧路径。"
      )
    }
  }

  const plan = await buildMigrationPlan(ctx, oldRoot, newRoot)
  if (plan.same) return [200, { same: true, oldRoot: plan.oldRoot, newRoot: plan.newRoot, items: [] }]
  if (!execute) return [200, { ...plan, dryRun: true }]

  const results = await executeMigration(ctx, plan)
  return [200, { ...plan, items: results, executed: true }]
}

// ---------------------------------------------------------------------------
// http plumbing
// ---------------------------------------------------------------------------
function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? ""
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1"
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = ""
    req.on("data", (chunk) => {
      body += chunk
      if (body.length > limit) {
        reject(new Error("请求体过大"))
        req.destroy()
      }
    })
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"))
      } catch (error) {
        reject(error)
      }
    })
    req.on("error", reject)
  })
}

function sendJson(res, code, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" })
  res.end(text)
}

/** Wrap a (body, req) => [code, payload] handler into a Node http handler. */
function routeHandler(fn, { mutate = false } = {}) {
  return async (req, res) => {
    if (req.method === "OPTIONS") {
      sendJson(res, 204, {})
      return
    }
    if (mutate && req.method === "POST" && !isLoopback(req)) {
      sendJson(res, 403, { error: "变更操作仅限本机（127.0.0.1）调用" })
      return
    }
    try {
      const body = req.method === "POST" ? await readJson(req) : {}
      const [code, payload] = await fn(body, req)
      if (mutate && code >= 200 && code < 300) invalidateTreeCache()
      sendJson(res, code, payload)
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  }
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------
export function apply(ctx, config) {
  const cfg = config ?? {}
  if (cfg.enabled === false) return

  ctx.systemPrompt.section({
    name: "plugin:worktree-panel",
    order: SECTION_ORDER,
    text: GUIDANCE,
  })

  // Agent-callable tools + their guidance: spawn a fresh session in a new
  // worktree, and symmetrically remove a worktree (with workspace cleanup).
  ctx.tools.register(registerWorktreeTaskTool(ctx))
  ctx.tools.register(registerWorktreeRemoveTool(ctx))
  ctx.systemPrompt.section({
    name: "tool:worktree-panel",
    order: 112,
    text: TOOL_GUIDANCE,
  })

  const routes = [
    {
      kind: "exact",
      path: `${API_PREFIX}/tree`,
      handler: routeHandler(async () => [200, await buildTreeCached(ctx)]),
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/config`,
      handler: routeHandler(async (body, req) => {
        if (req.method === "POST") return handleSetConfig(ctx, body)
        return [200, await handleGetConfig(ctx)]
      }, { mutate: true }),
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/repos`,
      handler: routeHandler(async (body) => handleAddRepo(body, ctx), { mutate: true }),
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/repos/remove`,
      handler: routeHandler(async (body) => handleRemoveRepo(body, ctx), { mutate: true }),
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/repos/init`,
      handler: routeHandler(async (body) => handleInitRepo(body, ctx), { mutate: true }),
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/worktrees`,
      handler: routeHandler(async (body) => handleCreateWorktree(ctx, body), { mutate: true }),
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/worktrees/remove`,
      handler: routeHandler(async (body) => handleRemoveWorktree(ctx, body), { mutate: true }),
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/worktrees/register`,
      handler: routeHandler(async (body) => handleRegisterWorktree(ctx, body), { mutate: true }),
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/worktrees/switch`,
      handler: routeHandler(async (body) => handleSwitchMain(ctx, body), { mutate: true }),
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/migrate`,
      handler: routeHandler(async (body) => handleMigrate(ctx, body), { mutate: true }),
    },
  ]

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  })

  // 启动时回填：把各工作区目录下「已存在但未挂靠到 sessionIds」的会话补进工作区。
  // 历史会话可能先于工作区注册而建（worktree 尤其如此），若不补挂，依赖 workspace feed
  // 的其它插件（如 dsh-gitlab 的 GitLab tab）会判定它们「没有 workspace」。
  const healTimer = setTimeout(async () => {
    try {
      let records
      try {
        records = await ctx.sessionQuery.listSessions()
      } catch {
        records = undefined
      }
      for (const ws of ctx.workspaceRegistry.list()) await attachSessionsFor(ctx, ws, records)
    } catch {
      /* best effort：回填失败不阻断启动 */
    }
  }, 0)
  ctx.effect(() => () => clearTimeout(healTimer))
}

export { API_PREFIX, BRANCH_NAME_RE, GUIDANCE, buildTree, inject, MANIFEST_PATH }
