/**
 * 本地模拟测试：在 Node 中伪造 EdgeEver 插件上下文，验证同步逻辑。
 * 运行： node test/mock-test.mjs
 */

import plugin from "../main.js";

/* ---------------- 伪造的 GitHub 服务端 ---------------- */

const remote = new Map(); // path -> { content, sha }
let shaCounter = 0;
const calls = [];
/** 置为 true 时，所有请求都返回 fine-grained token 权限不足的 403 */
let forceForbidden = false;

function fakeSha() {
  shaCounter += 1;
  return `sha${String(shaCounter).padStart(4, "0")}`;
}

async function fakeGitHub(url, init = {}) {
  const method = (init.method ?? "GET").toUpperCase();
  const parsed = new URL(url);
  const path = decodeURIComponent(parsed.pathname);
  calls.push({ method, path, body: init.body ? JSON.parse(init.body) : null });

  if (forceForbidden) {
    return json({ message: "Resource not accessible by personal access token" }, 403);
  }

  // 仓库信息
  if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) {
    return json({ default_branch: "main", permissions: { push: true }, private: false });
  }

  // 分支查询（verify 会校验分支是否存在）
  const branchMatch = path.match(/^\/repos\/([^/]+)\/([^/]+)\/branches\/(.+)$/);
  if (branchMatch) {
    const branch = decodeURIComponent(branchMatch[3]);
    return branch === "main"
      ? json({ name: "main" })
      : json({ message: "Branch not found" }, 404);
  }

  // Contents API
  const match = path.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/?(.*)$/);
  if (!match) return json({ message: "Not Found" }, 404);
  const filePath = match[3];

  // 目录列表请求（verify 用来探测 Token 是否具备 Contents 权限）
  if (!filePath) {
    return json([...remote.keys()].map((name) => ({ type: "file", name })));
  }

  if (method === "GET") {
    const existing = remote.get(filePath);
    return existing ? json({ sha: existing.sha }) : json({ message: "Not Found" }, 404);
  }
  if (method === "PUT") {
    const body = JSON.parse(init.body);
    const content = Buffer.from(body.content, "base64").toString("utf8");
    const sha = fakeSha();
    remote.set(filePath, { content, sha });
    return json({ content: { sha }, commit: { sha: fakeSha() } });
  }
  if (method === "DELETE") {
    remote.delete(filePath);
    return json({ commit: { sha: fakeSha() } });
  }
  return json({ message: "Unsupported" }, 405);
}

function json(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

/* ---------------- 伪造的 EdgeEver 宿主 ---------------- */

function createHost({ notes, notebooks, settings }) {
  const store = new Map();
  const listeners = new Map();
  const commands = new Map();
  const notices = [];
  const panels = new Map();
  const openedPanels = [];
  const settingsMap = new Map(Object.entries(settings));

  const context = {
    settings: { get: async (key) => settingsMap.get(key) ?? null },
    storage: {
      get: async (key) => store.get(key) ?? null,
      set: async (key, value) => void store.set(key, value),
    },
    notebooks: { list: async () => notebooks },
    notes: {
      queryContent: async ({ offset = 0, limit = 100 } = {}) => {
        const page = notes.slice(offset, offset + limit);
        const next = offset + page.length < notes.length ? offset + page.length : null;
        return { notes: page, totalCount: notes.length, nextOffset: next };
      },
    },
    events: {
      on: (event, handler) => {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(handler);
        return () => {};
      },
    },
    commands: {
      register: (command) => {
        commands.set(command.id, command);
        return () => {};
      },
    },
    ui: {
      showNotice: (message) => notices.push(message),
      panels: {
        register: (panel) => {
          panels.set(panel.id, panel);
          return () => panels.delete(panel.id);
        },
        open: async (id) => {
          openedPanels.push(id);
        },
      },
    },
    network: { fetch: fakeGitHub },
  };

  return {
    context,
    listeners,
    commands,
    notices,
    panels,
    openedPanels,
    settingsMap,
    store,
    emit: (event, payload) => {
      for (const handler of listeners.get(event) ?? []) handler(payload);
    },
  };
}

/* ---------------- 断言工具 ---------------- */

let passed = 0;
let failed = 0;

function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------- 测试数据 ---------------- */

const NOTEBOOKS = [
  { id: "nb_root", parentId: null, name: "技术笔记", memoCount: 2 },
  { id: "nb_child", parentId: "nb_root", name: "架构设计", memoCount: 1 },
];

function makeNote(overrides = {}) {
  return {
    id: "memo_001",
    notebookId: "nb_root",
    title: "入门指南",
    excerpt: "",
    tags: ["指南"],
    isPinned: false,
    isArchived: false,
    revision: 1,
    contentMarkdown: "# 入门指南\n\n这是正文。",
    contentText: "入门指南 这是正文。",
    contentHash: "hash-a",
    createdAt: "2026-10-15T10:00:00.000Z",
    updatedAt: "2026-10-15T10:00:00.000Z",
    ...overrides,
  };
}

const SETTINGS = {
  "github.owner": "xxynly",
  "github.repo": "notes",
  "github.token": "github_pat_test",
  "github.branch": "main",
  "notes.path": "notes",
  "notes.frontmatter": true,
  "sync.auto": true,
  "sync.idle.seconds": 0,
  "sync.mirror.delete": false,
  "sync.on.startup": true,
  "sync.flush.on.hide": true,
};

/* ---------------- 用例 ---------------- */

console.log("\n[1] 启动时全量补推");
{
  const noteA = makeNote({ id: "memo_001", title: "入门指南", contentHash: "hash-a" });
  const noteB = makeNote({
    id: "memo_002",
    notebookId: "nb_child",
    title: "同步架构",
    contentHash: "hash-b",
    contentMarkdown: "# 同步架构\n\n正文二。",
  });

  const host = createHost({ notes: [noteA, noteB], notebooks: NOTEBOOKS, settings: SETTINGS });
  const dispose = plugin.activate(host.context);
  await sleep(60);

  check("推送了 2 个文件", remote.size === 2, `实际 ${remote.size}`);
  check(
    "根目录笔记路径正确",
    remote.has("notes/技术笔记/入门指南.md"),
    [...remote.keys()].join(", "),
  );
  check(
    "子笔记本层级路径正确",
    remote.has("notes/技术笔记/架构设计/同步架构.md"),
    [...remote.keys()].join(", "),
  );

  const file = remote.get("notes/技术笔记/入门指南.md");
  check("正文内容正确写入", file?.content.includes("这是正文。"));
  check("YAML 头信息已写入", file?.content.startsWith("---\ntitle: \"入门指南\""));
  check("frontmatter 含 tags", file?.content.includes('tags: ["指南"]'));
  check("中文经 base64 往返无损", file?.content.includes("# 入门指南"));

  dispose();
}

console.log("\n[2] 内容未变化时跳过推送（去重）");
{
  remote.clear();
  calls.length = 0;
  const note = makeNote({ contentHash: "hash-x" });
  const host = createHost({ notes: [note], notebooks: NOTEBOOKS, settings: SETTINGS });
  const dispose = plugin.activate(host.context);
  await sleep(60);

  const putsAfterFirst = calls.filter((c) => c.method === "PUT").length;
  check("首次推送发生 1 次 PUT", putsAfterFirst === 1, `实际 ${putsAfterFirst}`);

  calls.length = 0;
  // 内容与 hash 都没变 —— 模拟一次无实际改动的保存
  host.emit("note.updated", { note: { ...note } });
  await sleep(60);

  const putsAfterSecond = calls.filter((c) => c.method === "PUT").length;
  check("内容未变时不产生任何 PUT 请求", putsAfterSecond === 0, `实际 ${putsAfterSecond}`);
  check(
    "内容未变时也不读取远端文件",
    calls.filter((c) => c.method === "GET" && c.path.includes("/contents/")).length === 0,
    JSON.stringify(calls),
  );

  dispose();
}

console.log("\n[3] 内容变化时正常推送");
{
  remote.clear();
  calls.length = 0;
  const note = makeNote({ contentHash: "hash-v1" });
  const host = createHost({ notes: [note], notebooks: NOTEBOOKS, settings: SETTINGS });
  const dispose = plugin.activate(host.context);
  await sleep(60);

  calls.length = 0;
  const updated = { ...note, contentHash: "hash-v2", contentMarkdown: "# 入门指南\n\n改过了。" };
  host.emit("note.updated", { note: updated });
  await sleep(60);

  const puts = calls.filter((c) => c.method === "PUT");
  check("内容变化时产生 1 次 PUT", puts.length === 1, `实际 ${puts.length}`);
  check("更新时携带 sha（避免冲突）", Boolean(puts[0]?.body?.sha), JSON.stringify(puts[0]?.body));
  check("新内容已写入远端", remote.get("notes/技术笔记/入门指南.md")?.content.includes("改过了。"));

  dispose();
}

console.log("\n[4] 连续编辑合并为一次推送");
{
  remote.clear();
  calls.length = 0;
  const note = makeNote({ contentHash: "h0" });
  const host = createHost({ notes: [note], notebooks: NOTEBOOKS, settings: { ...SETTINGS, "sync.idle.seconds": 0.15 } });
  const dispose = plugin.activate(host.context);
  await sleep(220);

  calls.length = 0;
  for (let i = 1; i <= 5; i += 1) {
    host.emit("note.updated", { note: { ...note, contentHash: `h${i}` } });
    await sleep(20);
  }
  await sleep(260);

  const puts = calls.filter((c) => c.method === "PUT");
  check("5 次连续保存合并为 1 次推送", puts.length === 1, `实际 ${puts.length}`);

  dispose();
}

console.log("\n[5] 同名笔记冲突时自动加后缀");
{
  remote.clear();
  calls.length = 0;
  const noteA = makeNote({ id: "memo_aaa111", title: "周报", contentHash: "ha" });
  const noteB = makeNote({ id: "memo_bbb222", title: "周报", contentHash: "hb" });
  const host = createHost({ notes: [noteA, noteB], notebooks: NOTEBOOKS, settings: SETTINGS });
  const dispose = plugin.activate(host.context);
  await sleep(80);

  const keys = [...remote.keys()].sort();
  check("同名笔记生成了两个不同文件", keys.length === 2, keys.join(", "));
  check("其中一个保持原文件名", keys.includes("notes/技术笔记/周报.md"));
  check(
    "另一个带 ID 后缀",
    keys.some((key) => /周报-.+\.md$/.test(key)),
    keys.join(", "),
  );

  dispose();
}

console.log("\n[6] 删除笔记的镜像行为");
{
  remote.clear();
  calls.length = 0;
  const note = makeNote({ contentHash: "hd" });
  const host = createHost({ notes: [note], notebooks: NOTEBOOKS, settings: SETTINGS });
  const dispose = plugin.activate(host.context);
  await sleep(60);

  calls.length = 0;
  host.emit("note.deleted", { noteId: note.id });
  await sleep(60);

  check(
    "默认不删除仓库文件（mirrorDelete=false）",
    remote.size === 1 && calls.filter((c) => c.method === "DELETE").length === 0,
    `remote=${remote.size}, deleteCalls=${calls.filter((c) => c.method === "DELETE").length}`,
  );

  dispose();
}

console.log("\n[7] 开启镜像删除后同步删除文件");
{
  remote.clear();
  calls.length = 0;
  const note = makeNote({ contentHash: "hd2" });
  const host = createHost({
    notes: [note],
    notebooks: NOTEBOOKS,
    settings: { ...SETTINGS, "sync.mirror.delete": true },
  });
  const dispose = plugin.activate(host.context);
  await sleep(60);

  host.emit("note.deleted", { noteId: note.id });
  await sleep(60);

  check("仓库文件已被删除", remote.size === 0, `剩余 ${remote.size}`);

  dispose();
}

console.log("\n[8] 笔记移动到其他笔记本时迁移路径");
{
  remote.clear();
  calls.length = 0;
  const note = makeNote({ id: "memo_mv", title: "待迁移", notebookId: "nb_root", contentHash: "hm1" });
  const host = createHost({ notes: [note], notebooks: NOTEBOOKS, settings: SETTINGS });
  const dispose = plugin.activate(host.context);
  await sleep(60);
  check("初始路径在根笔记本下", remote.has("notes/技术笔记/待迁移.md"));

  host.emit("note.updated", {
    note: { ...note, notebookId: "nb_child", contentHash: "hm2" },
  });
  await sleep(60);

  check("新路径已生成", remote.has("notes/技术笔记/架构设计/待迁移.md"), [...remote.keys()].join(", "));
  check("旧路径已清理", !remote.has("notes/技术笔记/待迁移.md"), [...remote.keys()].join(", "));

  dispose();
}

console.log("\n[9] 未配置时给出提示且不发请求");
{
  remote.clear();
  calls.length = 0;
  const host = createHost({
    notes: [makeNote()],
    notebooks: NOTEBOOKS,
    settings: { ...SETTINGS, "github.token": "" },
  });
  const dispose = plugin.activate(host.context);
  await sleep(60);

  check("没有任何网络请求", calls.length === 0, JSON.stringify(calls));
  check(
    "给出了配置提示",
    host.notices.some((message) => message.includes("开始配置向导")),
    JSON.stringify(host.notices),
  );

  dispose();
}

console.log("\n[10] 权限自检命令");
{
  calls.length = 0;
  const host = createHost({ notes: [], notebooks: NOTEBOOKS, settings: SETTINGS });
  const dispose = plugin.activate(host.context);
  await sleep(60);

  check("注册了 6 个命令", host.commands.size === 6, [...host.commands.keys()].join(", "));
  check(
    "注册了同步控制台面板",
    host.panels.has("github-sync-dashboard"),
    [...host.panels.keys()].join(", "),
  );
  check(
    "注册了首次配置向导面板",
    host.panels.has("github-sync-onboarding"),
    [...host.panels.keys()].join(", "),
  );
  await host.commands.get("github-sync-verify").run();
  await sleep(20);
  check(
    "自检命令返回可写入结论",
    host.notices.some((message) => message.includes("连接正常")),
    JSON.stringify(host.notices),
  );

  dispose();
}

console.log("\n[11] 分页遍历：超过单页上限时全部推送");
{
  remote.clear();
  calls.length = 0;
  const many = Array.from({ length: 120 }, (_, index) =>
    makeNote({
      id: `memo_p${String(index).padStart(3, "0")}`,
      title: `分页笔记 ${index}`,
      contentHash: `hp${index}`,
      contentMarkdown: `# 分页笔记 ${index}\n\n正文 ${index}`,
    }),
  );
  const host = createHost({ notes: many, notebooks: NOTEBOOKS, settings: SETTINGS });
  const dispose = plugin.activate(host.context);
  await sleep(800);

  check("120 篇笔记全部推送（跨 3 页）", remote.size === 120, `实际 ${remote.size}`);
  check(
    "首篇与末篇都在",
    remote.has("notes/技术笔记/分页笔记 0.md") && remote.has("notes/技术笔记/分页笔记 119.md"),
    [...remote.keys()].slice(0, 2).join(", "),
  );

  dispose();
}

console.log("\n[12] 持续写作：全程只在停手后提交一次");
{
  remote.clear();
  calls.length = 0;
  const note = makeNote({ contentHash: "h-init" });
  const host = createHost({
    notes: [note],
    notebooks: NOTEBOOKS,
    settings: { ...SETTINGS, "sync.idle.seconds": 0.3 },
  });
  const dispose = plugin.activate(host.context);
  await sleep(150);
  calls.length = 0;

  // 模拟持续写作：每 100ms 触发一次保存（EdgeEver 停手 1.2 秒即自动保存），
  // 每次间隔都短于静默期 300ms —— 相当于用户一直在敲键盘、从未停手。
  for (let index = 1; index <= 20; index += 1) {
    host.emit("note.updated", {
      note: {
        ...note,
        contentHash: `h-edit-${index}`,
        contentMarkdown: `# 入门指南\n\n第 ${index} 次编辑`,
      },
    });
    await sleep(100);
  }

  const duringWriting = calls.filter((call) => call.method === "PUT").length;
  check("持续写作期间一次都没提交", duringWriting === 0, `实际 ${duringWriting}`);

  await sleep(450);

  const afterIdle = calls.filter((call) => call.method === "PUT").length;
  check("停手后只提交一次", afterIdle === 1, `实际 ${afterIdle}`);
  check(
    "提交的是最终版本而非中间态",
    remote.get("notes/技术笔记/入门指南.md")?.content.includes("第 20 次编辑"),
  );

  dispose();
}

console.log("\n[13] 离开页面时立即提交（不等静默期）");
{
  remote.clear();
  calls.length = 0;

  const documentListeners = {};
  const windowListeners = {};
  globalThis.document = {
    visibilityState: "visible",
    addEventListener: (type, handler) => {
      (documentListeners[type] ??= []).push(handler);
    },
    removeEventListener: () => {},
  };
  globalThis.window = {
    addEventListener: (type, handler) => {
      (windowListeners[type] ??= []).push(handler);
    },
    removeEventListener: () => {},
  };

  const note = makeNote({ contentHash: "hx" });
  const host = createHost({
    notes: [note],
    notebooks: NOTEBOOKS,
    settings: { ...SETTINGS, "sync.idle.seconds": 600 },
  });
  const dispose = plugin.activate(host.context);
  await sleep(150);
  calls.length = 0;

  host.emit("note.updated", {
    note: { ...note, contentHash: "hx2", contentMarkdown: "# 入门指南\n\n刚写的新内容" },
  });
  await sleep(60);
  check("静默期内尚未提交", calls.filter((call) => call.method === "PUT").length === 0);

  // 模拟用户切走标签页
  globalThis.document.visibilityState = "hidden";
  for (const handler of documentListeners.visibilitychange ?? []) handler();
  await sleep(180);

  const afterHide = calls.filter((call) => call.method === "PUT").length;
  check("页面隐藏后立即提交", afterHide === 1, `实际 ${afterHide}`);
  check(
    "提交内容为最新版本",
    remote.get("notes/技术笔记/入门指南.md")?.content.includes("刚写的新内容"),
  );

  dispose();
  delete globalThis.document;
  delete globalThis.window;
}

console.log("\n[14] 分支名填错时给出明确提示");
{
  const host = createHost({
    notes: [],
    notebooks: NOTEBOOKS,
    settings: { ...SETTINGS, "github.branch": "master" },
  });
  const dispose = plugin.activate(host.context);
  await sleep(80);

  await host.commands.get("github-sync-verify").run();
  await sleep(40);

  check(
    "指出分支不存在",
    host.notices.some((message) => message.includes("分支") && message.includes("不存在")),
    JSON.stringify(host.notices),
  );
  check(
    "并给出仓库实际的默认分支",
    host.notices.some((message) => message.includes("main")),
    JSON.stringify(host.notices),
  );

  dispose();
}

console.log("\n[15] Token 权限不足时给出可操作指引");
{
  forceForbidden = true;
  const host = createHost({ notes: [], notebooks: NOTEBOOKS, settings: SETTINGS });
  const dispose = plugin.activate(host.context);
  await sleep(80);

  await host.commands.get("github-sync-verify").run();
  await sleep(40);

  const notices = host.notices.join(" | ");
  check(
    "指出是 Token 权限不足",
    notices.includes("Token 的权限不足"),
    notices,
  );
  check(
    "说明权限默认是 No access（这是最容易踩的坑）",
    notices.includes("No access"),
    notices,
  );
  check(
    "给出 Contents 需设为 Read and write 的指引",
    notices.includes("Contents") && notices.includes("Read and write"),
    notices,
  );
  check(
    "给出 Repository access 需勾选仓库的指引",
    notices.includes("Repository access"),
    notices,
  );

  dispose();
  forceForbidden = false;
}

console.log("\n[16] 尚未同步到服务器的本地笔记不推送");
{
  remote.clear();
  calls.length = 0;
  // EdgeEver 的本地临时 ID 真实格式是 memo_local_<纳秒时间戳>
  // （依据 crates/desktop-sidecar/src/memo.rs:639 的 starts_with("memo_local_")）。
  // 若此时推送，会留下永远不再更新的孤儿文件，正式 ID 到来后又另建一个文件。
  const localNote = makeNote({
    id: "memo_local_1792083438388084000",
    title: "草稿",
    contentHash: "h-local",
    contentMarkdown: "本地草稿内容",
  });
  const legacyLocalNote = makeNote({
    id: "local_634d4c34-036f-448b-95c2-462cbd174ad5",
    title: "草稿二",
    contentHash: "h-local2",
    contentMarkdown: "另一种临时 ID 格式",
  });
  const host = createHost({
    notes: [localNote, legacyLocalNote],
    notebooks: NOTEBOOKS,
    settings: SETTINGS,
  });
  const dispose = plugin.activate(host.context);
  await sleep(120);

  check("没有生成任何文件", remote.size === 0, [...remote.keys()].join(", "));
  check("也没有发出写请求", calls.filter((call) => call.method === "PUT").length === 0);

  dispose();
}

console.log("\n[17] 空笔记跳过；无标题但有正文的用正文首行命名");
{
  remote.clear();
  calls.length = 0;
  const blank = makeNote({
    id: "memo_blank01",
    title: "",
    contentHash: "h-blank",
    contentMarkdown: "",
  });
  const untitled = makeNote({
    id: "memo_untitled1",
    title: "",
    contentHash: "h-untitled",
    contentMarkdown: "## 会议纪要\n\n今天讨论了同步方案。",
  });
  const host = createHost({ notes: [blank, untitled], notebooks: NOTEBOOKS, settings: SETTINGS });
  const dispose = plugin.activate(host.context);
  await sleep(120);

  const keys = [...remote.keys()];
  check("只推送了 1 个文件（空笔记被跳过）", keys.length === 1, keys.join(", "));
  check(
    "无标题笔记用正文首行命名",
    keys.includes("notes/技术笔记/会议纪要.md"),
    keys.join(", "),
  );
  check("没有产生 untitled 文件", !keys.some((key) => key.includes("untitled")), keys.join(", "));

  dispose();
}

console.log("\n[18] 工作区拉到新内容后立即同步到仓库");
{
  remote.clear();
  calls.length = 0;
  // 用可变数组，模拟"另一台终端新增了笔记，本终端随后拉取到"
  const notes = [];
  const host = createHost({ notes, notebooks: NOTEBOOKS, settings: SETTINGS });
  const dispose = plugin.activate(host.context);
  await sleep(90);
  calls.length = 0;

  host.emit("workspace.synced", { bootstrapped: false, changed: 0 });
  await sleep(80);
  check(
    "changed 为 0 时不触发同步",
    calls.filter((call) => call.method === "PUT").length === 0,
  );

  notes.push(makeNote({
    id: "memo_remote1",
    title: "来自另一终端",
    contentHash: "h-remote",
    contentMarkdown: "# 来自另一终端\n\n同步测试",
  }));
  host.emit("workspace.synced", { bootstrapped: false, changed: 1 });
  await sleep(180);

  check(
    "拉到新内容后立即推送到仓库",
    remote.has("notes/技术笔记/来自另一终端.md"),
    [...remote.keys()].join(", "),
  );

  dispose();
}

console.log("\n[19] 清理遗留的临时 ID 记录后，正式 ID 迁移回正常文件名");
{
  remote.clear();
  calls.length = 0;

  const localId = "memo_local_1792083438388084000";
  const realId = "memo_7d3f59b7bcfc4c4099d98e30f9a86ccb";
  const note = makeNote({
    id: realId,
    title: "123",
    contentHash: "h-real",
    contentMarkdown: "正式内容",
  });

  const host = createHost({ notes: [note], notebooks: NOTEBOOKS, settings: SETTINGS });
  // 预置历史状态：临时 ID 曾占用 "123.md"，若不清理，正式 ID 只能退让成 "123-<后缀>.md"
  host.store.set("github-sync-state-v1", {
    notes: { [localId]: { hash: "h-local", path: "notes/技术笔记/123.md" } },
    lastSyncAt: null,
  });

  const dispose = plugin.activate(host.context);
  await sleep(150);

  const keys = [...remote.keys()];
  check(
    "正式 ID 用回正常文件名",
    keys.includes("notes/技术笔记/123.md"),
    keys.join(", "),
  );
  check(
    "没有产生带后缀的重复文件",
    !keys.some((key) => /123-.+\.md$/.test(key)),
    keys.join(", "),
  );

  dispose();
}

console.log("\n[20] 移动笔记（EdgeEver 不派发事件）后，靠焦点兜底完成路径迁移");
{
  remote.clear();
  calls.length = 0;

  const listeners = {};
  globalThis.window = {
    addEventListener: (type, handler) => {
      (listeners[type] ??= []).push(handler);
    },
    removeEventListener: () => {},
  };
  globalThis.document = {
    visibilityState: "visible",
    addEventListener: (type, handler) => {
      (listeners[type] ??= []).push(handler);
    },
    removeEventListener: () => {},
  };

  const note = makeNote({
    id: "memo_move001",
    title: "会被移动的笔记",
    contentHash: "h-move",
    contentMarkdown: "# 会被移动的笔记\n\n内容",
  });
  const host = createHost({ notes: [note], notebooks: NOTEBOOKS, settings: SETTINGS });
  const dispose = plugin.activate(host.context);
  await sleep(140);

  check(
    "初始位置在根笔记本下",
    remote.has("notes/技术笔记/会被移动的笔记.md"),
    [...remote.keys()].join(", "),
  );

  // 模拟用户把笔记拖到子笔记本。EdgeEver 的 moveMemos 不会派发任何插件事件。
  note.notebookId = "nb_child";
  note.contentHash = "h-move-2";

  // 触发窗口焦点，走兜底的全量比对
  for (const handler of listeners.focus ?? []) handler();
  await sleep(200);

  check(
    "新位置已生成",
    remote.has("notes/技术笔记/架构设计/会被移动的笔记.md"),
    [...remote.keys()].join(", "),
  );
  check(
    "旧位置已清理",
    !remote.has("notes/技术笔记/会被移动的笔记.md"),
    [...remote.keys()].join(", "),
  );

  dispose();
  delete globalThis.window;
  delete globalThis.document;
}

/* ---------------- 汇总 ---------------- */

console.log(`\n${"=".repeat(46)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log("=".repeat(46));
process.exit(failed === 0 ? 0 : 1);
