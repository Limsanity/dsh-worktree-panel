// Render test: mounts the patched official WorkspaceBrowser (captured from the
// slot registration) with react-dom/server, feeding it a realistic
// workspaces/sessions store plus a worktree-tree fixture from the /tree API.
// This exercises the injected nested SessionTree code exactly as the browser
// would — any undefined identifier or bad prop throws here first.
import { createRequire } from "node:module"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

// Resolve react/react-dom from the plugin's own node_modules (the same tree the
// bundle is developed against) instead of an npx cache that drifts.
const here = dirname(fileURLToPath(import.meta.url))
const cliRequire = createRequire(join(here, "..", "package.json"))
const React = cliRequire("react")
const ReactDOMServer = cliRequire("react-dom/server")
// Use the REAL jsx-runtime: its 3rd argument is the element KEY (React
// 18 createElement's 3rd argument is children — a naive stub corrupts keys
// into text children, which previously made the render "lose" everything).
const jsxRuntime = cliRequire("react/jsx-runtime")
// Real primitives import katex .css at module load (browser-only bundling), so
// render with a stub for every export. The stub is a function component that
// renders its children (so wrapper components like Tooltip keep the content
// under test visible) and doubles as a callable for helpers such as
// relativeTime(). The code under test is OUR injected SessionTree code, not the
// primitives.
// 组件型导出（Tooltip / HoverCard 等）在现代 bundle 里分别用 children 和 anchor
// 承载内容：两者都要透传，否则整行文字被 stub 吃掉，断言会假失败。
const primitivesStubComponent = (props) => {
  if (props && typeof props === "object") {
    if (props.anchor !== undefined) return props.anchor
    if ("children" in props) return props.children
  }
  return "dsh-stub"
}
const primitives = new Proxy(
  {},
  {
    get: (target, prop) => {
      if (prop === Symbol.toStringTag) return "Module"
      return primitivesStubComponent
    },
  },
)

// ---- minimal DOM so module-level CSS injectors don't crash ----
const el = () => ({
  style: {}, dataset: {}, children: [], parentElement: null,
  setAttribute() {}, appendChild(c) { this.children.push(c); return c },
  addEventListener() {}, removeEventListener() {},
  querySelector() { return null }, matches() { return false },
})
const fakeDocument = {
  head: el(), body: el(),
  querySelector: () => null,
  createElement: () => el(),
  getElementById: () => null,
}
const fakeWindow = {
  document: fakeDocument,
  __wtpInitialTree: null, // seeded below once the fixture exists
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      if (id !== "@lim324/dsh-worktree-panel") throw new Error("unexpected id " + id)
      factoryRef = factory
    },
  },
}
let factoryRef

const code = readFileSync(join(here, "..", "lib", "client.js"), "utf8")
new Function("window", "document", code)(fakeWindow, fakeDocument)
if (!factoryRef) throw new Error("no factory")

const mod = factoryRef((name) => {
  if (name === "react") return React
  if (name === "react/jsx-runtime") return jsxRuntime
  if (name === "@deepseek-ai/dsh-client-store") {
    // 0.2.1 起官方 bundle 从 dsh-client-store 拿 store 工厂（0.2.0 走的是
    // dsh-client-runtime/client）；这里给一个最小实现，渲染只需要快照读取。
    const createSnapshotStore = (initial) => {
      let value = initial
      return {
        getSnapshot: () => value,
        set: (next) => { value = typeof next === "function" ? next(value) : next },
        subscribe: () => () => {},
      }
    }
    const defineStore = (spec) => {
      const create = () => {
        const state = spec.init ? spec.init({}) : {}
        const actions = {}
        for (const [key, fn] of Object.entries(spec.actions ?? {})) actions[key] = (...args) => fn(state, ...args)
        return { state, actions, getSnapshot: () => state, set: () => {}, subscribe: () => () => {} }
      }
      const empty = () => ({})
      return { ...spec, create, getSnapshot: empty, subscribe: () => () => {} }
    }
    return { createSnapshotStore, defineStore }
  }
  if (name === "@deepseek-ai/cordis") return { Service: class Service { constructor(ctx) { this.ctx = ctx } } }
  if (name === "@deepseek-ai/dsh-client-runtime/client") {
    return {
      defineStore: (s) => ({ ...s }),
      indexSubagentDescendants: () => new Map(),
      abbreviateHomePath: (p) => p,
    }
  }
  if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives
  throw new Error("unexpected require: " + name)
})

// capture the registered components
const registered = {}
const ctx = {
  remote: { directoryPicker: {} },
  shortcuts: { catalog: () => [] },
  slots: undefined,
  get: (name) => {
    if (name === "connection") return { hostDescription: "test-host" }
    if (name === "sessions") return ctx.sessions
    if (name === "workspaces") return ctx.workspaces
    return undefined
  },
  locale: { register: () => {}, bind: () => (key) => key, subscribe: () => () => {} },
  sessions: { search: async () => ({ ok: true, value: { items: [] } }), searchResultLimit: 50, binding: () => undefined },
  workspaces: {},
  slots: {
    entries: () => [], subscribe: () => () => {},
    inject: (name, cb) => { registered[name] = cb() },
    register: (opts, Component) => ({ opts, Component }),
    provideRoot: () => {},
    registerFactory: () => {},
    subscribe: () => () => {},
  },
  effect: () => () => {},
}
mod.apply(ctx)
const WorkspaceBrowser = registered["sidebar.workspaces"]?.Component
if (!WorkspaceBrowser) throw new Error("WorkspaceBrowser not captured")

// ---- store fixtures ----
const now = Date.now()
const sess = (id, title, extra = {}) => ({ id, title, displayTitle: title, updatedAt: now - 1000, completed: true, running: false, blank: false, retainedBy: { mainView: 1 }, runningSubagentCount: 0, projectionValues: {}, ...extra })
const byId = {
  s1: sess("s1", "主树上的会话"),
  s2: sess("s2", "feature-01 里的会话", { running: true }),
  s3: sess("s3", "feature-01 里另一个会话"),
}
const sessionsState = {
  phase: "ready",
  current: "s1",
  ids: ["s1", "s2", "s3"],
  byId,
  projectionsBySession: {},
}
const workspacesState = {
  phase: "ready",
  items: [
    { workspaceId: "ws-main", title: "myapp", createdAt: now, sessionIds: ["s1"] },
    { workspaceId: "ws-feature", title: "myapp/feature-01", createdAt: now, sessionIds: ["s2", "s3"] },
    // 「临时会话」入口的目标：非 git 的 misc 工作区。
    { workspaceId: "ws-misc", title: "misc", path: "/Users/you/lab/misc", createdAt: now, sessionIds: [] },
  ],
  archivedSessionIds: [],
}
const viewState = {
  groupBy: "workspace",
  orderBy: "updated",
  groupExpansion: { "ws-main": true, "ws-feature": true },
  sessionOrderByAccount: {},
  sessionUpdatedAtByAccount: {},
}

// fetch mock returning the worktree topology
const treeFixture = {
  root: "/Users/you/orca/workspaces",
  repos: [
    {
      name: "myapp",
      path: "/wt/myapp/main",
      branch: "main",
      dirty: 0,
      ahead: 0,
      behind: 0,
      branches: ["main", "feature-01", "feature-02"],
      worktrees: [
        {
          name: "feature-01",
          path: "/wt/myapp/feature-01",
          branch: "feature-01",
          dirty: 2,
          ahead: 1,
          behind: 0,
          upstream: "tracking",
          workspaceId: "ws-feature",
          sessions: [{ id: "s2" }, { id: "s3" }],
        },
      ],
      sessions: [],
      workspaceId: "ws-main",
    },
  ],
  workspaces: [],
}
globalThis.fetch = async () => ({ ok: true, json: async () => treeFixture })
fakeWindow.__wtpInitialTree = treeFixture

// ---- hooks ----
const selectorHook = (state) => (selector) => selector(state)
const useStore = selectorHook(viewState)
const useWorkspaces = (selector) => selector(workspacesState)
const useSessions = (selector) => selector(sessionsState)
const useDirectoryFlow = (selector) => selector(false)
const useHostInfo = (selector) => selector({ home: undefined })
const useShortcuts = (selector) => selector([])
const useWorkspaceShortcuts = (selector) => selector({ searchRequest: 0, addRequested: false, directoryBusy: false, renameTarget: null })
const usePanelInfo = (selector) => selector({ activePanelId: null })
const useSessionStatus = (selector) => selector(new Map())

const actions = {
  retainAccountKeys: () => {},
  setGroupBy: () => {}, setOrderBy: () => {}, setGroupExpanded: () => {},
  syncSessionOrderAccount: () => {}, setSessionOrder: () => {},
}
const t = (key, params) => {
  const zh = {
    "wtp.main": "主工作树",
    "wtp.currentBranch": "当前分支",
    "wtp.dirty": "有改动",
    "wtp.clean": "干净",
    "wtp.pickerOpen": "＋ 分支 → 创建 worktree",
    "wtp.pickerClose": "－ 收起分支列表",
    "wtp.open": "打开",
    "wtp.collapse": "收起",
    "wtp.newSession": "+ 新会话",
    "wtp.noPendingBranches": "所有分支都已有 worktree",
    "wtp.newBranchPlaceholder": "新分支名（创建分支并开 worktree）",
    "wtp.createWorktree": "为此分支创建 worktree",
    "wtp.removeWorktree": "删除该 worktree",
    "wtp.removeConfirm": "确定删除 worktree「{name}」？未提交的改动会丢失。",
    "wtp.failed": "操作失败：{msg}",
    "group.ungrouped": "未分组",
    "empty.none": "暂无会话",
    "section.sessions": "会话",
    "section.workspaces": "工作区",
    "sessions.expand": "展开其余 {n} 个会话",
    "sessions.collapse": "收起",
    "wtp.quickSession": "临时会话",
    "wtp.quickSessionTooltip": "在 misc 工作区新建会话",
    "wtp.quickSessionMissing": "未找到 misc 工作区（标题或目录名）",
  }
  if (params) return (zh[key] ?? key) + ":" + JSON.stringify(params)
  return zh[key] ?? key
}

// SessionTree needs `useSessions` as a hook returning the full state via selector
const props = {
  wide: true,
  expandSidebar: () => {},
  useSessions,
  useSessionStatus,
  usePanelInfo,
  useWorkspaces,
  useStore,
  actions,
  startSession: () => {},
  open: () => {},
  renameSession: async () => {},
  forkSession: () => {},
  renameWorkspace: async () => {},
  deleteWorkspace: async () => {},
  insertWorkspaceBefore: async () => {},
  archiveSession: async () => {},
  insertSessionBefore: async () => {},
  createWorkspace: async () => ({}),
  searchSessions: async () => ({ items: [] }),
  searchResultLimit: 50,
  useDirectoryFlow,
  useHostInfo,
  useShortcuts,
  useWorkspaceShortcuts,
  requestSessionRename: () => {},
  notifyArchivedNotOpenable: () => {},
  unarchiveSession: async () => {},
  requestSearch: () => {},
  requestAddWorkspace: () => {},
  closeAddWorkspace: () => {},
  setDirectoryBusy: () => {},
  renderSlot: () => null,
  t,
}

// SessionTree actually receives useSessions/useWorkspaces/useStore/useDirectoryFlow
// as slot-provided hooks — but the WorkspaceBrowser component signature we read
// destructures exactly these; render and catch any runtime error.
let html = ""
try {
  html = ReactDOMServer.renderToString(React.createElement(WorkspaceBrowser, props))
} catch (err) {
  console.error("RENDER FAILED:", err && err.stack ? err.stack : err)
  process.exit(1)
}
writeFileSync("/tmp/wtp-full.html", html)

// 目标缺失：没有 misc 工作区时入口必须是置灰态（aria-disabled），
// 且绝不能变成「在最近的工作区开会话」。
const noMiscState = { ...workspacesState, items: workspacesState.items.filter((workspace) => workspace.title !== "misc") }
let htmlNoMisc = ""
try {
  htmlNoMisc = ReactDOMServer.renderToString(
    React.createElement(WorkspaceBrowser, { ...props, useWorkspaces: (selector) => selector(noMiscState) }),
  )
} catch (err) {
  console.error("RENDER FAILED (no misc):", err && err.stack ? err.stack : err)
  process.exit(1)
}

const checks = [
  ["nested worktree row", html.includes("feature-01")],
  ["worktree dirty status text", html.includes("有改动") || html.includes("Modified")],
  ["main worktree row", html.includes("主工作树") || html.includes("Main worktree")],
  ["main session under main worktree", html.includes("主树上的会话")],
  ["nested session under worktree", html.includes("feature-01 里的会话")],
  ["worktree row plus button", (html.match(/<button[^>]*class="dsh-wtp-icon-btn"/g) || []).length >= 2],
  ["no duplicate new-session row", !/>\+ 新会话</.test(html)],
  ["dialog closed by default", !html.includes("创建分支") && !html.includes("Create branch")],
  ["quick session row rendered", html.includes('class="dsh-wtp-quick-session"')],
  ["quick session tooltip names misc", html.includes("在 misc 工作区新建会话")],
  ["quick session hint is misc", /dsh-wtp-quick-session-hint[^>]*>misc</.test(html)],
  ["quick session resolved a workspace", !html.includes("dsh-wtp-quick-session-missing")],
  ["quick session missing state", htmlNoMisc.includes("dsh-wtp-quick-session-missing") && htmlNoMisc.includes('aria-disabled="true"')],
  ["quick session missing tooltip", htmlNoMisc.includes("未找到 misc 工作区")],
]
let failed = 0
if (process.env.DUMP_HTML) console.log("--- html head ---\n" + html.slice(0, 2000) + "\n---")
for (const [name, ok] of checks) {
  console.log((ok ? "ok  " : "FAIL") + " " + name)
  if (!ok) failed++
}
if (failed) process.exit(1)
console.log("render test OK: patched WorkspaceBrowser rendered with nested worktree dimension")
