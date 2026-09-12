// Render test: mounts the patched official WorkspaceBrowser (captured from the
// slot registration) with react-dom/server, feeding it a realistic
// workspaces/sessions store plus a worktree-tree fixture from the /tree API.
// This exercises the injected nested SessionTree code exactly as the browser
// would — any undefined identifier or bad prop throws here first.
import { createRequire } from "node:module"
import { readFileSync, writeFileSync, globSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

// Resolve react/react-dom from the dsh CLI's npx-cache dependency tree
// (the same store that hosts @deepseek-ai/dsh-client-ui-workspace).
const reactPkg = globSync(join(homedir(), ".npm", "_npx", "*", "node_modules", "react", "package.json"))[0]
if (!reactPkg) throw new Error("cannot locate react in the npx cache")
const cliRequire = createRequire(reactPkg)
const React = cliRequire("react")
const ReactDOMServer = cliRequire("react-dom/server")
// Use the REAL jsx-runtime: its 3rd argument is the element KEY (React
// 18 createElement's 3rd argument is children — a naive stub corrupts keys
// into text children, which previously made the render "lose" everything).
const jsxRuntime = cliRequire("react/jsx-runtime")
// Real primitives import katex .css at module load (browser-only bundling), so
// render with a component stub: every primitives export renders as <dsh-stub>.
// The code under test is OUR injected SessionTree nesting, not the primitives.
// Callable stub: some primitives are FUNCTIONS (relativeTime, …) while others
// are components, so every export must be callable.
//
// It must also keep the subtree visible. 0.1.5-rc.1 wraps every row in a
// primitive card that receives the row through an `anchor` PROP
// (`HoverCard anchor={<div role="treeitem">…}>`); the 0.1.1 bundle rendered the
// same rows inline. A stub that only returns a marker therefore REPLACES the
// entire row (group header, session title, …) with "dsh-stub", which is what
// made the session-title assertions fail here.
//
// Order: render children, else the element passed as `anchor`, else the first
// string-valued text prop, else the marker. `content` is deliberately not
// rendered — it is hover-card body, not row content.
const RENDER_PROPS = ["children", "anchor"]
const TEXT_PROPS = ["label", "title", "text", "value", "name", "message", "alt"]
const primitives = new Proxy(
  {},
  {
    get: (target, prop) => {
      if (prop === Symbol.toStringTag) return "Module"
      return function stub(props) {
        if (props !== null && typeof props === "object") {
          for (const key of RENDER_PROPS) {
            if (props[key] !== undefined && props[key] !== null) return props[key]
          }
          for (const key of TEXT_PROPS) {
            if (typeof props[key] === "string") return props[key]
          }
        }
        return "dsh-stub"
      }
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

const code = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js"), "utf8")
new Function("window", "document", code)(fakeWindow, fakeDocument)
if (!factoryRef) throw new Error("no factory")

const mod = factoryRef((name) => {
  if (name === "react") return React
  if (name === "react/jsx-runtime") return jsxRuntime
  // 0.1.5-rc.1 deleted @deepseek-ai/dsh-client-runtime. The bundle now takes
  // Service from cordis and defineStore from dsh-client-store (both are served
  // by the web shell's seed table in the browser), and the helpers that module
  // used to re-export (indexSubagentDescendants, abbreviateHomePath) are
  // module-local in the new bundle.
  if (name === "@deepseek-ai/cordis") return { Service: class Service { constructor(c) { this.ctx = c } } }
  if (name === "@deepseek-ai/dsh-client-store") return { defineStore: (s) => ({ ...s }) }
  if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives
  throw new Error("unexpected require: " + name)
})

// capture the registered components
const registered = {}
// Both halves resolve dependencies through `ctx.get(name)` in 0.1.5-rc.1, and
// workspaces/sessions expose a `list` SNAPSHOT STORE. The effects are not run
// here (render-only), but apply() still reads ctx.remote.directoryPicker and
// publishes root hooks through ctx.slots.provideRoot.
const workspacesList = {
  getSnapshot: () => ({ items: [], archivedSessionIds: [], current: undefined }),
  subscribe: () => () => {},
}
const sessionsList = {
  getSnapshot: () => ({ ids: [], byId: {}, current: undefined, phase: "ready" }),
  subscribe: () => () => {},
}
const services = {
  connection: { hostDescription: "test-host" },
  inputTriggers: { registerSource: () => () => {} },
  workspaces: { list: workspacesList },
  sessions: { list: sessionsList, search: async () => ({ ok: true, value: { items: [] } }), searchResultLimit: 50, binding: () => undefined },
}
const ctx = {
  get: (name) => services[name],
  ...services,
  layout: {},
  remote: { directoryPicker: { pick: async () => undefined, available: () => false }, query: {} },
  locale: { register: () => {} },
  slots: {
    entries: () => [], subscribe: () => () => {},
    inject: (name, cb) => { registered[name] = cb() },
    register: (opts, Component) => ({ opts, Component }),
    provideRoot: () => {},
  },
  effect: () => () => {},
}
mod.apply(ctx)
const WorkspaceBrowser = registered["sidebar.workspaces"]?.Component
if (!WorkspaceBrowser) throw new Error("WorkspaceBrowser not captured")

// ---- store fixtures ----
const now = Date.now()
const sess = (id, title, extra = {}) => ({ id, displayTitle: title, updatedAt: now - 1000, completed: true, running: false, blank: false, ...extra })
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
}
const workspacesState = {
  phase: "ready",
  items: [
    { workspaceId: "ws-main", title: "myapp", createdAt: now, sessionIds: ["s1"] },
    { workspaceId: "ws-feature", title: "myapp/feature-01", createdAt: now, sessionIds: ["s2", "s3"] },
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
const useHostDescription = (selector) => selector({ home: undefined })
// 0.1.5-rc.1: the browser reads the host home through useHostInfo, and the panel
// active state through usePanelInfo.
const useHostInfo = (selector) => selector({ home: "/Users/you" })
const usePanelInfo = (selector) => selector({ activePanelId: null })
// sessionNode() reads pendingInteractions.get(id) — it must be a Map, not the
// bare state object the old harness passed.
const useSessionPendingInteraction = () => new Map()

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
  }
  if (params) return (zh[key] ?? key) + ":" + JSON.stringify(params)
  return zh[key] ?? key
}

// SessionTree needs `useSessions` as a hook returning the full state via selector
const props = {
  wide: true,
  expandSidebar: () => {},
  useSessions,
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
  useHostDescription,
  useHostInfo,
  usePanelInfo,
  useSessionPendingInteraction,
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

const checks = [
  ["nested worktree row", html.includes("feature-01")],
  ["worktree dirty status text", html.includes("有改动") || html.includes("Modified")],
  ["main worktree row", html.includes("主工作树") || html.includes("Main worktree")],
  ["main session under main worktree", html.includes("主树上的会话")],
  ["nested session under worktree", html.includes("feature-01 里的会话")],
  ["worktree row plus button", (html.match(/<button[^>]*class="dsh-wtp-icon-btn"/g) || []).length >= 2],
  ["no duplicate new-session row", !/>\+ 新会话</.test(html)],
  ["dialog closed by default", !html.includes("创建分支") && !html.includes("Create branch")],
]
// ---- regression: the worktree dimension must not reshape the tree ----------
// Covers the two defects fixed in "keep worktree rows nested when a project
// group is collapsed" (adapt/dsh-0.1.5-rc.1). Both are invisible to a
// single-state render, and both were originally found only by eye:
//   * a COLLAPSED project used to spill its worktrees back to the top level;
//   * a project with NO group at all must keep them, because the nested render
//     can never happen there — hiding them would strand those sessions.
// Effects do not run under renderToString, so the default-expansion effect
// cannot mask the collapsed case here.
const WORKTREE_WS_TITLE = "myapp/feature-01" // the worktree's own DSH workspace
const rerender = () => ReactDOMServer.renderToString(React.createElement(WorkspaceBrowser, props))
const savedItems = workspacesState.items
const savedExpansion = viewState.groupExpansion
const regression = []

// (1) project group collapsed: nothing nested, and no spill to the top level
viewState.groupExpansion = {}
const collapsed = rerender()
// `dsh-wtp-worktree-name` is the panel's OWN marker class (not a hashed CSS
// module), so it isolates "a nested worktree row rendered" from "a worktree
// workspace row was spilled to the top level" — the latter is the actual fix,
// and it is the assertion that fails against a bundle without it.
const NESTED_ROW_MARKER = "dsh-wtp-worktree-name"
regression.push([
  "collapsed project: no nested worktree row",
  !collapsed.includes(NESTED_ROW_MARKER),
])
regression.push([
  "collapsed project: worktree workspace row NOT spilled to the top level",
  !collapsed.includes(WORKTREE_WS_TITLE),
])

// (2) project group absent: the worktree's own row must stay renderable
workspacesState.items = savedItems.filter((w) => w.workspaceId !== "ws-main")
const orphaned = rerender()
regression.push([
  "project without a group: worktree workspace row stays reachable",
  orphaned.includes(WORKTREE_WS_TITLE),
])

// restore the primary fixture (the dumped /tmp/wtp-full.html stays valid)
workspacesState.items = savedItems
viewState.groupExpansion = savedExpansion
checks.push(...regression)

let failed = 0
if (process.env.DUMP_HTML) console.log("--- html head ---\n" + html.slice(0, 2000) + "\n---")
for (const [name, ok] of checks) {
  console.log((ok ? "ok  " : "FAIL") + " " + name)
  if (!ok) failed++
}
if (failed) process.exit(1)
console.log("render test OK: patched WorkspaceBrowser rendered with nested worktree dimension")
