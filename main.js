/**
 * EdgeEver GitHub Sync
 * 保存笔记后自动推送到 GitHub 仓库，以 Markdown 源文件形式保存。
 *
 * 设计要点：
 * - 事件驱动：监听 note.created / note.updated / note.deleted，保存成功即触发
 * - 内容去重：以笔记的 contentHash 比对，内容未变化时完全跳过网络请求
 * - 合并推送：连续编辑在 debounce 窗口内合并为一次推送
 * - 串行队列：所有推送排队执行，避免并发写同一文件造成冲突
 * - 路径迁移：笔记改名或移动笔记本时，自动删除旧路径文件
 */

const STORAGE_KEY = "github-sync-state-v1";
const API_VERSION = "2022-11-28";
const API_ORIGIN = "https://api.github.com";
const MAX_PATH_SEGMENT_BYTES = 100;
/** 默认静默期（秒）：停止编辑多久之后才自动提交一次 */
const DEFAULT_IDLE_SECONDS = 180;

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 净化路径片段：移除文件系统非法字符，保留中文 */
function sanitizeSegment(name) {
  const cleaned = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim();
  return cleaned || "untitled";
}

/** 按 UTF-8 字节数截断，避免超出文件系统路径长度限制 */
function truncateUtf8(value, maxBytes) {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= maxBytes) return value;
  let output = "";
  let size = 0;
  for (const char of value) {
    const charBytes = encoder.encode(char).length;
    if (size + charBytes > maxBytes - 3) break;
    output += char;
    size += charBytes;
  }
  return `${output}...`;
}

/** 标题优先；无标题时取正文首个非空行；都为空时用「未命名」 */
function deriveFileName(note) {
  const title = String(note.title ?? "").trim();
  if (title) return sanitizeSegment(title);

  const firstLine = String(note.contentMarkdown ?? "")
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line.length > 0);
  if (firstLine) return sanitizeSegment(firstLine);

  return "未命名";
}

/**
 * 从正文提取一句摘要，写入 frontmatter 的 description。
 * GitBook 会把 description 用于三处：站点 SEO meta、llms.txt 的每页摘要、
 * AI 检索的相关性判断 —— 缺失会明显拉低检索质量。
 */
function deriveDescription(markdown) {
  const lines = String(markdown ?? "")
    .split("\n")
    .map((line) => line.trim())
    // 跳过空行、分隔线与标题行 —— description 不应等于标题
    .filter((line) => line && line !== "---" && !/^#{1,6}\s/.test(line))
    .map((line) =>
      line
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_`>]/g, "")
        .trim(),
    )
    .filter(Boolean);

  const first = lines[0] ?? "";
  if (!first) return "";
  return first.length > 120 ? `${first.slice(0, 119)}…` : first;
}

function joinPath(...parts) {
  return parts
    .map((part) => String(part ?? "").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

/** 编码路径，逐段处理以保留斜杠 */
function encodeRepoPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function yamlScalar(value) {
  return JSON.stringify(String(value ?? ""));
}

/* ------------------------------------------------------------------ */
/* GitHub Contents API 客户端                                          */
/* ------------------------------------------------------------------ */

class GitHubClient {
  constructor(config, fetchImpl) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  headers() {
    return {
      Authorization: `Bearer ${this.config.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "Content-Type": "application/json",
    };
  }

  endpoint(path) {
    const { owner, repo } = this.config;
    return `${API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeRepoPath(path)}`;
  }

  async describeError(response) {
    let detail = "";
    try {
      const body = await response.json();
      detail = body?.message ?? "";
    } catch {
      /* 响应体不是 JSON，忽略 */
    }

    // Fine-grained Token 权限不足时 GitHub 固定返回这句，直接给出可操作指引，
    // 否则用户只会看到一句无从下手的英文。
    if (detail.includes("Resource not accessible by personal access token")) {
      return new Error(
        `GitHub ${response.status}：这个 Token 的权限不足。`
        + "注意 Fine-grained Token 创建时所有权限默认都是 No access，"
        + "只配 Repository access 是不够的，必须另外手动开启权限项。"
        + "请到 GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens，"
        + "打开该 Token 确认两点：① Repository access 里已勾选目标仓库；"
        + "② 下方 Permissions → Repository permissions → 找到 Contents，设为 Read and write。"
        + "改完立即生效，无需重新生成 Token。",
      );
    }

    const hint = {
      401: "Token 无效或已过期",
      403: "Token 权限不足或触发限流",
      404: "仓库或分支不存在，或 Token 无权访问",
      409: "文件冲突，请重试",
      422: "分支不存在，或文件路径与内容被拒绝",
    }[response.status];
    return new Error(`GitHub ${response.status}${hint ? `（${hint}）` : ""}${detail ? `：${detail}` : ""}`);
  }

  /** 读取文件元信息，不存在时返回 null */
  async getFile(path) {
    const url = `${this.endpoint(path)}?ref=${encodeURIComponent(this.config.branch)}`;
    const response = await this.fetch(url, { method: "GET", headers: this.headers() });
    if (response.status === 404) return null;
    if (!response.ok) throw await this.describeError(response);
    const data = await response.json();
    return { sha: data?.sha ?? null };
  }

  async putFile(path, content, message) {
    const existing = await this.getFile(path);
    const body = {
      message,
      content: toBase64(content),
      branch: this.config.branch,
    };
    if (existing?.sha) body.sha = existing.sha;

    const response = await this.fetch(this.endpoint(path), {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await this.describeError(response);
    const data = await response.json();
    return { sha: data?.content?.sha ?? null, commit: data?.commit?.sha ?? null };
  }

  async deleteFile(path, message) {
    const existing = await this.getFile(path);
    if (!existing?.sha) return false;
    const response = await this.fetch(this.endpoint(path), {
      method: "DELETE",
      headers: this.headers(),
      body: JSON.stringify({ message, sha: existing.sha, branch: this.config.branch }),
    });
    if (!response.ok) throw await this.describeError(response);
    return true;
  }

  /** 轻量连通性、Token 权限与分支自检 */
  async verify() {
    const { owner, repo } = this.config;
    const repoPath = `${API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const repoResponse = await this.fetch(repoPath, { method: "GET", headers: this.headers() });
    if (!repoResponse.ok) throw await this.describeError(repoResponse);
    const data = await repoResponse.json();

    // 注意：响应里的 permissions 反映的是「当前用户对该仓库的权限」，
    // 而不是「这个 Token 的权限」。Token 权限不足时它依然可能为 true，
    // 所以必须真正打一次 Contents 接口才能验证 Token 是否可用。
    const contentsResponse = await this.fetch(
      `${repoPath}/contents/?ref=${encodeURIComponent(this.config.branch)}`,
      { method: "GET", headers: this.headers() },
    );
    if (contentsResponse.status === 403) throw await this.describeError(contentsResponse);
    if (contentsResponse.status === 404) {
      const fallback = data?.default_branch;
      throw new Error(
        `分支「${this.config.branch}」不存在${fallback ? `，该仓库的默认分支是「${fallback}」` : ""}`,
      );
    }
    if (!contentsResponse.ok) throw await this.describeError(contentsResponse);

    // 分支校验属于辅助诊断：能确认分支不存在就报错；
    // 若该端点本身因权限或限流不可用，不应阻塞正常的同步流程。
    let branchNote = "";
    const branchResponse = await this.fetch(
      `${repoPath}/branches/${encodeURIComponent(this.config.branch)}`,
      { method: "GET", headers: this.headers() },
    );
    if (branchResponse.status === 404) {
      const fallback = data?.default_branch;
      throw new Error(
        `分支「${this.config.branch}」不存在${fallback ? `，该仓库的默认分支是「${fallback}」` : ""}`,
      );
    }
    if (branchResponse.status === 403) branchNote = "（分支校验被 GitHub 拒绝，已跳过）";

    return {
      defaultBranch: data?.default_branch ?? null,
      private: Boolean(data?.private),
      branchNote,
    };
  }
}

/* ------------------------------------------------------------------ */
/* 同步引擎                                                            */
/* ------------------------------------------------------------------ */

class SyncEngine {
  constructor(context) {
    this.context = context;
    this.config = null;
    this.client = null;
    this.state = { notes: {}, lastSyncAt: null, history: [] };
    this.notebooks = new Map();
    this.chain = Promise.resolve();
    /** noteId -> { note, timer }：已排队、等待静默期结束的待推送项 */
    this.pending = new Map();
  }

  notify(message) {
    try {
      this.context.ui.showNotice(message);
    } catch {
      /* 提示失败不影响同步 */
    }
  }

  async readConfig() {
    const get = (key) => this.context.settings.get(key);
    const [owner, repo, token, branch, pathPrefix, frontmatter, description, autoPush, idleSeconds, mirrorDelete, syncOnStartup, flushOnHide] =
      await Promise.all([
        get("github.owner"),
        get("github.repo"),
        get("github.token"),
        get("github.branch"),
        get("notes.path"),
        get("notes.frontmatter"),
        get("notes.description"),
        get("sync.auto"),
        get("sync.idle.seconds"),
        get("sync.mirror.delete"),
        get("sync.on.startup"),
        get("sync.flush.on.hide"),
      ]);

    const seconds = Number(idleSeconds);
    return {
      owner: String(owner ?? "").trim(),
      repo: String(repo ?? "").trim(),
      token: String(token ?? "").trim(),
      branch: String(branch ?? "").trim() || "main",
      pathPrefix: String(pathPrefix ?? "").trim(),
      autoPush: autoPush !== false,
      debounceMs: Number.isFinite(seconds) && seconds >= 0
        ? seconds * 1000
        : DEFAULT_IDLE_SECONDS * 1000,
      frontmatter: frontmatter !== false,
      description: description !== false,
      mirrorDelete: mirrorDelete === true,
      syncOnStartup: syncOnStartup !== false,
      flushOnHide: flushOnHide !== false,
    };
  }

  isConfigured() {
    const { owner, repo, token } = this.config ?? {};
    return Boolean(owner && repo && token);
  }

  async loadState() {
    const stored = await this.context.storage.get(STORAGE_KEY);
    if (stored && typeof stored === "object") {
      this.state = {
        notes: stored.notes && typeof stored.notes === "object" ? stored.notes : {},
        lastSyncAt: stored.lastSyncAt ?? null,
        history: Array.isArray(stored.history) ? stored.history : [],
      };
    }

    // 清理历史遗留的临时 ID 记录。这些笔记在服务器上并不存在（正式 ID 才是），
    // 它们的记录会白白占用路径，导致正式 ID 只能退让成 "标题-后缀.md"。
    // 剔除后路径得以释放，正式 ID 下次推送时会自动迁移回正常文件名。
    let removed = 0;
    for (const key of Object.keys(this.state.notes)) {
      if (key.startsWith("memo_local_") || key.startsWith("local_")) {
        delete this.state.notes[key];
        removed += 1;
      }
    }
    if (removed > 0) await this.saveState();
  }

  async saveState() {
    await this.context.storage.set(STORAGE_KEY, this.state);
  }

  /** 记录一条同步历史，供面板展示（最多保留 20 条） */
  recordHistory(path, action) {
    const list = Array.isArray(this.state.history) ? this.state.history : [];
    list.unshift({ path, action, at: Date.now() });
    this.state.history = list.slice(0, 20);
  }

  async refreshNotebooks() {
    const list = await this.context.notebooks.list();
    this.notebooks = new Map(list.map((notebook) => [notebook.id, notebook]));
  }

  /** 由 parentId 链还原笔记本的目录路径 */
  notebookPath(notebookId) {
    const segments = [];
    let current = this.notebooks.get(notebookId);
    let guard = 0;
    while (current && guard < 32) {
      segments.unshift(sanitizeSegment(current.name));
      current = current.parentId ? this.notebooks.get(current.parentId) : null;
      guard += 1;
    }
    return segments.join("/");
  }

  pathOwners() {
    const owners = new Map();
    for (const [noteId, record] of Object.entries(this.state.notes)) {
      if (record?.path) owners.set(record.path, noteId);
    }
    return owners;
  }

  /** 计算笔记对应的仓库文件路径，遇到同名冲突时追加 ID 后缀 */
  allocatePath(note) {
    const directory = joinPath(this.config.pathPrefix, this.notebookPath(note.notebookId));
    const base = truncateUtf8(deriveFileName(note), MAX_PATH_SEGMENT_BYTES);
    const preferred = joinPath(directory, `${base}.md`);

    const owners = this.pathOwners();
    const owner = owners.get(preferred);
    if (!owner || owner === note.id) return preferred;

    const suffix = String(note.id).slice(-6);
    const fallbackBase = truncateUtf8(base, MAX_PATH_SEGMENT_BYTES - 8);
    return joinPath(directory, `${fallbackBase}-${suffix}.md`);
  }

  renderMarkdown(note) {
    const body = note.contentMarkdown ?? "";
    if (!this.config.frontmatter) return body;

    const lines = ["---", `title: ${yamlScalar(note.title ?? "")}`];
    if (this.config.description) {
      const description = deriveDescription(body);
      if (description) lines.push(`description: ${yamlScalar(description)}`);
    }
    lines.push(`edgeever_id: ${note.id}`);
    if (note.updatedAt) lines.push(`updated: ${yamlScalar(note.updatedAt)}`);
    if (Array.isArray(note.tags) && note.tags.length > 0) {
      lines.push(`tags: [${note.tags.map((tag) => yamlScalar(tag)).join(", ")}]`);
    }
    lines.push("---", "");
    return `${lines.join("\n")}\n${body}`;
  }

  /** 推送单篇笔记；内容与路径都未变化时直接跳过 */
  async pushNote(note) {
    // EdgeEver 对「尚未同步到服务器的本地笔记」使用 memo_local_ 前缀的临时 ID，
    // 同步完成后会被替换成正式 ID（memo_<hex>）。若此时推送，仓库里会留下一个
    // 永远不会再被更新的孤儿文件（正式 ID 到来后会另建一个文件）。
    // 权威依据：crates/desktop-sidecar/src/memo.rs:639
    //   memo_id.starts_with("memo_local_")
    const noteId = String(note.id ?? "");
    if (noteId.startsWith("memo_local_") || noteId.startsWith("local_")) {
      return { skipped: true, reason: "unsynced-local" };
    }

    // 标题与正文都为空的白板笔记没有同步价值，推送只会产生 untitled 垃圾文件。
    const hasTitle = Boolean(String(note.title ?? "").trim());
    const hasBody = Boolean(String(note.contentMarkdown ?? "").trim());
    if (!hasTitle && !hasBody) {
      return { skipped: true, reason: "empty-note" };
    }

    const record = this.state.notes[note.id] ?? null;
    const path = this.allocatePath(note);

    if (record && record.hash === note.contentHash && record.path === path) {
      return { skipped: true, path };
    }

    const markdown = this.renderMarkdown(note);
    const action = record ? "update" : "create";
    const result = await this.client.putFile(
      path,
      markdown,
      `sync(${action}): ${note.title || note.id}`,
    );

    if (record && record.path && record.path !== path) {
      try {
        await this.client.deleteFile(record.path, `sync(move): ${note.title || note.id}`);
      } catch {
        /* 旧路径清理失败不影响本次推送结果 */
      }
    }

    this.state.notes[note.id] = { hash: note.contentHash, path, sha: result.sha, at: Date.now() };
    this.recordHistory(path, action);
    await this.saveState();
    return { pushed: true, path };
  }

  async removeNote(noteId) {
    const record = this.state.notes[noteId];
    if (!record?.path) return { skipped: true };
    if (!this.config.mirrorDelete) return { skipped: true };

    await this.client.deleteFile(record.path, `sync(delete): ${noteId}`);
    this.recordHistory(record.path, "delete");
    delete this.state.notes[noteId];
    await this.saveState();
    return { deleted: true, path: record.path };
  }

  /** 全量补推：遍历所有含正文的笔记，只推送有变化的部分 */
  async fullSync(options = {}) {
    await this.refreshNotebooks();
    // 宿主实现 queryContent 时会对每篇笔记并发发起一次详情请求，
    // 因此页大小取 50 而非上限 200，避免瞬时打出过多并发请求。
    const limit = 50;
    // 使用 created-desc：createdAt 恒定不变，翻页过程中不会因笔记被编辑而错位。
    // 列表接口已排除回收站中的笔记，无需额外过滤删除态。
    const sort = "created-desc";
    let offset = 0;
    let pushed = 0;
    let skipped = 0;
    let failed = 0;
    const errors = [];

    for (;;) {
      const page = await this.context.notes.queryContent({ limit, offset, sort });
      const notes = Array.isArray(page?.notes) ? page.notes : [];

      for (const note of notes) {
        try {
          const result = await this.pushNote(note);
          if (result.skipped) skipped += 1;
          else pushed += 1;
        } catch (error) {
          failed += 1;
          if (errors.length < 3) errors.push(`${note.title || note.id}: ${error.message}`);
        }
      }

      if (page?.nextOffset == null || notes.length === 0) break;
      offset = page.nextOffset;
    }

    this.state.lastSyncAt = Date.now();
    await this.saveState();

    if (!options.silent) {
      const summary = `同步完成：推送 ${pushed} 篇，跳过 ${skipped} 篇${failed ? `，失败 ${failed} 篇` : ""}`;
      this.notify(summary);
    }
    return { pushed, skipped, failed, errors };
  }

  /** 所有写操作串行执行 */
  enqueue(task) {
    this.chain = this.chain
      .then(task)
      .catch((error) => {
        this.notify(`GitHub 同步失败：${error.message}`);
      });
    return this.chain;
  }

  /**
   * 记录一次待推送。真正的推送发生在静默期结束之后。
   *
   * EdgeEver 的编辑器会在停止输入 1.2 秒后自动保存（EDITOR_LOCAL_SAVE_DELAY_MS），
   * 因此一次持续写作会产生大量 note.updated 事件。只要用户还在写，
   * 这里的计时器就会被不断重置 —— 连续写作期间不会推送，直到真正停手。
   */
  schedule(note) {
    if (!this.config.autoPush) return;
    const existing = this.pending.get(note.id);
    if (existing?.timer) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      this.pending.delete(note.id);
      void this.enqueue(() => this.pushNote(note));
    }, this.config.debounceMs);

    this.pending.set(note.id, { note, timer });
  }

  /**
   * 立即推送所有待同步项，不等静默期。
   * 用于编辑会话的边界：页面被隐藏、关闭，或用户主动触发。
   * 即使这里没能跑完，内容也不会丢失 —— 笔记已存在于 EdgeEver，
   * 下次打开时 syncOnStartup 会补推。
   */
  async flush() {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) clearTimeout(entry.timer);

    let pushed = 0;
    for (const entry of entries) {
      await this.enqueue(async () => {
        const result = await this.pushNote(entry.note);
        if (result?.pushed) pushed += 1;
      });
    }
    return pushed;
  }

  cancelAll() {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                            */
/* ------------------------------------------------------------------ */

export default {
  activate(context) {
    const engine = new SyncEngine(context);
    const disposers = [];
    let disposed = false;

    const guard = (task) => async (...args) => {
      if (disposed) return;
      try {
        await task(...args);
      } catch (error) {
        context.ui.showNotice(`GitHub 同步：${error.message}`);
      }
    };

    const bootstrap = async () => {
      engine.config = await engine.readConfig();
      if (!engine.isConfigured()) {
        context.ui.showNotice(
          "GitHub 同步：还没连接 GitHub。执行命令「GitHub 同步：开始配置向导」即可完成设置",
        );
        return false;
      }
      engine.client = new GitHubClient(engine.config, (input, init) => context.network.fetch(input, init));
      await engine.loadState();
      await engine.refreshNotebooks();
      return true;
    };

    // 事件监听：保存成功后触发
    disposers.push(
      context.events.on("note.created", ({ note }) => {
        engine.schedule(note);
      }),
    );
    disposers.push(
      context.events.on("note.updated", ({ note }) => {
        engine.schedule(note);
      }),
    );
    disposers.push(
      context.events.on("note.deleted", ({ noteId }) => {
        const entry = engine.pending.get(noteId);
        if (entry?.timer) clearTimeout(entry.timer);
        engine.pending.delete(noteId);
        void engine.enqueue(() => engine.removeNote(noteId));
      }),
    );

    // 设置变更后重新读取配置
    disposers.push(
      context.events.on("settings.changed", () => {
        void guard(async () => {
          engine.config = await engine.readConfig();
          if (engine.isConfigured()) {
            engine.client = new GitHubClient(engine.config, (input, init) => context.network.fetch(input, init));
          }
        })();
      }),
    );

    // EdgeEver 的部分操作不会给插件派发任何事件 —— repository-events.ts
    // 只包装了 create / update / delete / restore / merge / sync 等，
    // **moveMemos（移动笔记到其他笔记本）不在其中**。
    // 因此除 note.* 事件外，还需要在有把握的时机主动全量比对一次：
    //   1) 工作区从服务器拉到新内容（workspace.synced 且 changed > 0）
    //   2) 窗口重新获得焦点 / 页面重新可见
    // 三者共用节流。路径变化由既有的迁移逻辑处理：写新路径 + 删旧路径。
    const CATCH_UP_THROTTLE_MS = 60_000;
    let lastCatchUpAt = 0;
    const scheduleCatchUp = () => {
      const now = Date.now();
      if (now - lastCatchUpAt < CATCH_UP_THROTTLE_MS) return;
      lastCatchUpAt = now;
      void engine.enqueue(() => engine.fullSync({ silent: true }));
    };

    disposers.push(
      context.events.on("workspace.synced", ({ changed }) => {
        if (changed > 0) scheduleCatchUp();
      }),
    );

    if (typeof document !== "undefined" && typeof window !== "undefined") {
      const catchUpWhenVisible = () => {
        if (document.visibilityState !== "visible") return;
        scheduleCatchUp();
      };
      window.addEventListener("focus", catchUpWhenVisible);
      document.addEventListener("visibilitychange", catchUpWhenVisible);
      disposers.push(() => {
        window.removeEventListener("focus", catchUpWhenVisible);
        document.removeEventListener("visibilitychange", catchUpWhenVisible);
      });
    }

    // 命令：立即全量同步
    disposers.push(
      context.commands.register({
        id: "github-sync-now",
        title: "GitHub 同步：立即同步全部笔记",
        run: guard(async () => {
          if (!(await bootstrap())) return;
          context.ui.showNotice("GitHub 同步：开始全量同步…");
          await engine.fullSync();
        }),
      }),
    );

    // 命令：连通性与权限自检
    disposers.push(
      context.commands.register({
        id: "github-sync-verify",
        title: "GitHub 同步：检查连接与权限",
        run: guard(async () => {
          if (!(await bootstrap())) return;
          const info = await engine.client.verify();
          context.ui.showNotice(
            `连接正常，Token 可读写。默认分支 ${info.defaultBranch ?? "未知"}`
            + `${info.private ? "，私有仓库" : ""}${info.branchNote ?? ""}`,
          );
        }),
      }),
    );

    // 命令：查看同步状态
    disposers.push(
      context.commands.register({
        id: "github-sync-status",
        title: "GitHub 同步：查看同步状态",
        run: guard(async () => {
          if (!(await bootstrap())) return;
          const count = Object.keys(engine.state.notes).length;
          const last = engine.state.lastSyncAt ? new Date(engine.state.lastSyncAt).toLocaleString() : "从未";
          context.ui.showNotice(`已跟踪 ${count} 篇笔记，上次全量同步：${last}`);
        }),
      }),
    );

    // 命令：立即提交待同步的改动，不等静默期
    disposers.push(
      context.commands.register({
        id: "github-sync-flush",
        title: "GitHub 同步：立即提交未同步的改动",
        run: guard(async () => {
          if (!(await bootstrap())) return;
          const pushed = await engine.flush();
          context.ui.showNotice(
            pushed > 0
              ? `已提交 ${pushed} 篇笔记`
              : "没有需要提交的改动（空笔记与尚未同步到服务器的笔记会自动跳过）",
          );
        }),
      }),
    );

    // 同步控制台面板。
    // 宿主负责页头 / 工具栏 / 空状态，内容区由插件自绘，
    // 因此视觉可以完全按设计稿实现，并自动跟随 EdgeEver 的主题变量。
    disposers.push(
      context.ui.panels.register({
        id: "github-sync-dashboard",
        title: "GitHub 同步",
        purpose: "dashboard",
        presentation: "dialog",
        mount(container, { shell, requestClose }) {
          let activeTab = "overview";
          let status = { kind: "checking", text: "正在检查连接…", detail: "" };
          let alive = true;

          const el = (tag, styles, text) => {
            const node = document.createElement(tag);
            if (styles) node.setAttribute("style", styles);
            if (text !== undefined) node.textContent = text;
            return node;
          };

          const relativeTime = (timestamp) => {
            if (!timestamp) return "从未";
            const diff = Date.now() - timestamp;
            if (diff < 60_000) return "刚刚";
            if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
            if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
            return `${Math.floor(diff / 86_400_000)} 天前`;
          };

          const repoLabel = () => {
            const cfg = engine.config ?? {};
            if (!cfg.owner || !cfg.repo) return "尚未配置仓库";
            const prefix = cfg.pathPrefix ? ` · ${cfg.pathPrefix}/` : "";
            return `${cfg.owner}/${cfg.repo} · ${cfg.branch}${prefix}`;
          };

          const statusPalette = () => {
            if (status.kind === "ok") {
              return { bg: "var(--color-emerald-50,#ecfdf5)", fg: "var(--color-emerald-700,#047857)" };
            }
            if (status.kind === "error") {
              return { bg: "var(--color-destructive,#fef2f2)", fg: "var(--color-destructive-foreground,#b91c1c)" };
            }
            return { bg: "var(--color-muted,#f1f5f9)", fg: "var(--color-muted-foreground,#475569)" };
          };

          const buildStatusBar = () => {
            const { bg, fg } = statusPalette();
            const bar = el(
              "div",
              `display:flex;align-items:center;gap:10px;padding:12px 16px;border-radius:var(--radius-md,8px);background:${bg};`,
            );
            const dot = el("span", `width:8px;height:8px;border-radius:50%;background:${fg};flex-shrink:0;`);
            const label = el("span", `font-size:13px;font-weight:500;color:${fg};`, status.text);
            bar.append(dot, label);
            if (status.detail) {
              bar.append(
                el("span", "font-size:13px;color:var(--color-muted-foreground,#64748b);margin-left:auto;", status.detail),
              );
            }
            return bar;
          };

          const buildMetric = (label, value) => {
            const card = el(
              "div",
              "background:var(--color-secondary,#f8fafc);border-radius:var(--radius-md,8px);padding:14px 16px;min-width:0;",
            );
            card.append(
              el("p", "font-size:13px;color:var(--color-muted-foreground,#64748b);margin:0 0 6px;", label),
              el("p", "font-size:24px;font-weight:500;margin:0;line-height:1.2;", String(value)),
            );
            return card;
          };

          const buildHistoryRows = (entries) => {
            const list = el(
              "div",
              "border:0.5px solid var(--color-border,#e2e8f0);border-radius:var(--radius-lg,12px);overflow:hidden;",
            );
            if (entries.length === 0) {
              list.append(
                el("p", "font-size:13px;color:var(--color-muted-foreground,#64748b);margin:0;padding:16px;", "还没有同步记录"),
              );
              return list;
            }
            entries.forEach((entry, index) => {
              const row = el(
                "div",
                `display:flex;justify-content:space-between;align-items:center;gap:12px;padding:11px 14px;${
                  index === entries.length - 1 ? "" : "border-bottom:0.5px solid var(--color-border,#e2e8f0);"
                }`,
              );
              const left = el("div", "min-width:0;");
              const fileName = String(entry.path ?? "").split("/").pop() ?? "";
              const dir = String(entry.path ?? "").split("/").slice(0, -1).join(" / ");
              left.append(
                el(
                  "p",
                  "font-size:13px;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
                  entry.action === "delete" ? `${fileName}（已删除）` : fileName,
                ),
              );
              if (dir) {
                left.append(el("p", "font-size:12px;color:var(--color-muted-foreground,#94a3b8);margin:2px 0 0;", dir));
              }
              row.append(left, el("span", "font-size:13px;color:var(--color-muted-foreground,#64748b);flex-shrink:0;", relativeTime(entry.at)));
              list.append(row);
            });
            return list;
          };

          const buildOverview = () => {
            const fragment = document.createDocumentFragment();
            const metrics = el("div", "display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;");
            metrics.append(
              buildMetric("已跟踪笔记", Object.keys(engine.state.notes).length),
              buildMetric("待提交", engine.pending.size),
              buildMetric("上次同步", engine.state.lastSyncAt ? relativeTime(engine.state.lastSyncAt) : "从未"),
            );
            fragment.append(metrics);

            fragment.append(el("p", "font-size:13px;font-weight:500;margin:20px 0 8px;", "最近同步"));
            fragment.append(buildHistoryRows((engine.state.history ?? []).slice(0, 4)));
            return fragment;
          };

          const buildHistory = () => {
            const fragment = document.createDocumentFragment();
            fragment.append(el("p", "font-size:13px;font-weight:500;margin:0 0 8px;", `全部记录（最近 ${(engine.state.history ?? []).length} 条）`));
            fragment.append(buildHistoryRows(engine.state.history ?? []));
            return fragment;
          };

          const buildDiagnostics = () => {
            const cfg = engine.config ?? {};
            const fragment = document.createDocumentFragment();
            const list = el(
              "div",
              "border:0.5px solid var(--color-border,#e2e8f0);border-radius:var(--radius-lg,12px);overflow:hidden;",
            );
            const rows = [
              ["仓库", cfg.owner && cfg.repo ? `${cfg.owner}/${cfg.repo}` : "未填写"],
              ["分支", cfg.branch || "main"],
              ["仓库内目录", cfg.pathPrefix || "（根目录）"],
              ["Token", cfg.token ? `已配置（${String(cfg.token).slice(0, 7)}…）` : "未填写"],
              ["YAML 头信息", cfg.frontmatter ? "写入" : "不写入"],
              ["静默提交延迟", `${Math.round((cfg.debounceMs ?? 0) / 1000)} 秒`],
              ["离开页面时提交", cfg.flushOnHide ? "开启" : "关闭"],
              ["删除时同步删除文件", cfg.mirrorDelete ? "开启" : "关闭"],
            ];
            rows.forEach(([key, value], index) => {
              const row = el(
                "div",
                `display:flex;justify-content:space-between;gap:16px;padding:11px 14px;${
                  index === rows.length - 1 ? "" : "border-bottom:0.5px solid var(--color-border,#e2e8f0);"
                }`,
              );
              row.append(
                el("span", "font-size:13px;color:var(--color-muted-foreground,#64748b);", key),
                el("span", "font-size:13px;text-align:right;", value),
              );
              list.append(row);
            });
            fragment.append(list);
            fragment.append(
              el(
                "p",
                "font-size:12px;color:var(--color-muted-foreground,#94a3b8);margin:12px 0 0;line-height:1.6;",
                "提示：Token 需要 Contents 的 Read and write 权限；只勾选 Repository access 是不够的。",
              ),
            );
            return fragment;
          };

          function render() {
            if (!alive) return;
            container.replaceChildren();
            const root = el("div", "display:flex;flex-direction:column;gap:12px;");
            root.append(buildStatusBar());
            if (activeTab === "overview") root.append(buildOverview());
            else if (activeTab === "history") root.append(buildHistory());
            else root.append(buildDiagnostics());
            container.append(root);
          }

          function syncChrome() {
            shell.set({
              header: {
                title: "GitHub 同步",
                description: repoLabel(),
                actions: [
                  { id: "sync-now", label: "立即同步", variant: "primary" },
                  { id: "close", label: "关闭", variant: "ghost" },
                ],
              },
              toolbar: [
                {
                  type: "tabs",
                  key: "tab",
                  value: activeTab,
                  options: [
                    { value: "overview", label: "概览" },
                    { value: "history", label: "记录" },
                    { value: "diagnostics", label: "诊断" },
                  ],
                },
                { type: "button", key: "refresh", label: "刷新" },
              ],
              onAction(id) {
                if (id === "close") {
                  requestClose();
                  return;
                }
                if (id === "sync-now") {
                  void guard(async () => {
                    if (!(await bootstrap())) return;
                    context.ui.showNotice("GitHub 同步：开始全量同步…");
                    await engine.fullSync();
                    await refreshStatus();
                  })();
                }
              },
              onChange(key, value) {
                if (key === "tab") {
                  activeTab = value;
                  syncChrome();
                  render();
                  return;
                }
                if (key === "refresh") void refreshStatus();
              },
            });
          }

          async function refreshStatus() {
            status = { kind: "checking", text: "正在检查连接…", detail: "" };
            render();
            try {
              if (!(await bootstrap())) {
                status = { kind: "error", text: "尚未完成设置", detail: "请先在插件设置中填写仓库与 Token" };
                render();
                return;
              }
              const info = await engine.client.verify();
              status = {
                kind: "ok",
                text: "已连接，Token 可读写",
                detail: `上次同步 ${engine.state.lastSyncAt ? relativeTime(engine.state.lastSyncAt) : "从未"}${
                  info.private ? " · 私有仓库" : ""
                }`,
              };
            } catch (error) {
              status = { kind: "error", text: error.message, detail: "" };
            }
            syncChrome();
            render();
          }

          syncChrome();
          render();
          void refreshStatus();

          return () => {
            alive = false;
          };
        },
      }),
    );

    // 命令：打开同步控制台
    disposers.push(
      context.commands.register({
        id: "github-sync-dashboard",
        title: "GitHub 同步：打开同步控制台",
        run: guard(async () => {
          await context.ui.panels.open("github-sync-dashboard");
        }),
      }),
    );

    // 首次配置向导。
    // 插件可以读写自己的设置项（context.settings.set），
    // 因此向导能把用户填写的内容直接写入，省掉去设置页逐项填写的麻烦 ——
    // 这是把「11 个技术化配置项」收敛成「3 个必填字段」的关键。
    disposers.push(
      context.ui.panels.register({
        id: "github-sync-onboarding",
        title: "连接 GitHub",
        purpose: "onboarding",
        presentation: "dialog",
        mount(container, { shell, requestClose }) {
          let alive = true;
          let busy = false;
          let result = null;
          let showTokenHelp = false;
          const draft = {
            owner: engine.config?.owner ?? "",
            repo: engine.config?.repo ?? "",
            token: engine.config?.token ?? "",
            branch: engine.config?.branch ?? "main",
            pathPrefix: engine.config?.pathPrefix ?? "notes",
          };

          const el = (tag, styles, text) => {
            const node = document.createElement(tag);
            if (styles) node.setAttribute("style", styles);
            if (text !== undefined) node.textContent = text;
            return node;
          };

          const field = (label, key, placeholder, options = {}) => {
            const wrap = el("div", "display:flex;flex-direction:column;gap:6px;");
            wrap.append(el("label", "font-size:13px;font-weight:500;", label));
            const input = document.createElement("input");
            input.type = options.secret ? "password" : "text";
            input.placeholder = placeholder;
            input.value = draft[key] ?? "";
            input.setAttribute(
              "style",
              "font-size:13px;padding:8px 10px;border-radius:var(--radius-md,8px);"
              + "border:0.5px solid var(--color-border,#e2e8f0);"
              + "background:var(--color-background,#fff);color:var(--color-foreground,#111);"
              + "width:100%;box-sizing:border-box;font-family:inherit;",
            );
            input.addEventListener("input", () => {
              draft[key] = input.value;
              result = null;
            });
            wrap.append(input);
            if (options.hint) {
              wrap.append(el("p", "font-size:12px;color:var(--color-muted-foreground,#94a3b8);margin:0;line-height:1.5;", options.hint));
            }
            return wrap;
          };

          function render() {
            if (!alive) return;
            container.replaceChildren();
            const root = el("div", "display:flex;flex-direction:column;gap:14px;");

            root.append(
              el(
                "p",
                "font-size:13px;color:var(--color-muted-foreground,#64748b);margin:0;line-height:1.6;",
                "填写下面三项即可开始。其余设置都有合理默认值，之后可在插件设置里调整。",
              ),
            );

            const row = el("div", "display:grid;grid-template-columns:1fr 1fr;gap:12px;");
            row.append(field("GitHub 用户名", "owner", "xxynly"));
            row.append(field("笔记仓库名", "repo", "notes"));
            root.append(row);

            root.append(
              field("GitHub Token", "token", "github_pat_...", {
                secret: true,
                hint: "需要 Contents 的 Read and write 权限。注意：新建 Token 时权限默认是 No access，必须手动开启。",
              }),
            );

            const helpToggle = el(
              "button",
              "align-self:flex-start;font-size:12px;padding:0;border:none;background:none;color:var(--color-primary,#2563eb);cursor:pointer;font-family:inherit;",
              showTokenHelp ? "收起创建步骤" : "如何创建 Token？",
            );
            helpToggle.addEventListener("click", () => {
              showTokenHelp = !showTokenHelp;
              render();
            });
            root.append(helpToggle);

            if (showTokenHelp) {
              const steps = el(
                "div",
                "font-size:12px;line-height:1.8;color:var(--color-muted-foreground,#64748b);"
                + "padding:12px 14px;border-radius:var(--radius-md,8px);background:var(--color-secondary,#f8fafc);",
              );
              const lines = [
                "1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens",
                "2. 点 Generate new token，Repository access 选 Only select repositories，勾选你的笔记仓库",
                "3. 往下滚动到 Permissions → Repository permissions → 找到 Contents，设为 Read and write",
                "4. 生成后复制 github_pat_ 开头的字符串，粘贴到上面",
              ];
              lines.forEach((line) => steps.append(el("p", "margin:0 0 6px;", line)));
              root.append(steps);
            }

            const action = el(
              "button",
              "font-size:13px;font-weight:500;padding:9px 18px;border-radius:var(--radius-md,8px);border:none;"
              + "background:var(--color-primary,#111);color:var(--color-primary-foreground,#fff);"
              + "cursor:pointer;font-family:inherit;align-self:flex-start;",
              busy ? "正在验证…" : "验证并开始同步",
            );
            if (busy) action.disabled = true;
            action.addEventListener("click", () => void submit());
            root.append(action);

            if (result) {
              const palette = result.kind === "ok"
                ? { bg: "var(--color-emerald-50,#ecfdf5)", fg: "var(--color-emerald-700,#047857)" }
                : { bg: "var(--color-destructive,#fef2f2)", fg: "var(--color-destructive-foreground,#b91c1c)" };
              const box = el(
                "div",
                `padding:12px 14px;border-radius:var(--radius-md,8px);background:${palette.bg};`,
              );
              box.append(el("p", `font-size:13px;font-weight:500;color:${palette.fg};margin:0;line-height:1.6;`, result.text));
              if (result.detail) {
                box.append(el("p", `font-size:12px;color:${palette.fg};margin:6px 0 0;line-height:1.6;`, result.detail));
              }
              root.append(box);
            }

            container.append(root);
          }

          async function submit() {
            if (busy) return;
            const owner = String(draft.owner ?? "").trim();
            const repo = String(draft.repo ?? "").trim();
            const token = String(draft.token ?? "").trim();
            if (!owner || !repo || !token) {
              result = { kind: "error", text: "请先填写用户名、仓库名和 Token。" };
              render();
              return;
            }

            busy = true;
            result = null;
            render();

            try {
              await context.settings.set("github.owner", owner);
              await context.settings.set("github.repo", repo);
              await context.settings.set("github.token", token);
              await context.settings.set("github.branch", String(draft.branch ?? "").trim() || "main");
              await context.settings.set("notes.path", String(draft.pathPrefix ?? "").trim());

              engine.config = await engine.readConfig();
              engine.client = new GitHubClient(engine.config, (input, init) => context.network.fetch(input, init));

              const info = await engine.client.verify();
              const summary = await engine.fullSync({ silent: true });
              busy = false;
              result = {
                kind: "ok",
                text: `连接成功，已同步 ${summary.pushed} 篇笔记${summary.skipped ? `（${summary.skipped} 篇无变化已跳过）` : ""}。`,
                detail: `分支 ${info.defaultBranch ?? engine.config.branch}${info.private ? "，私有仓库" : ""}。之后每次编辑保存都会自动同步，可在控制台查看状态。`,
              };
              render();
            } catch (error) {
              busy = false;
              result = { kind: "error", text: error.message, detail: "修正后可直接在上方修改并重新验证，不必关闭窗口。" };
              render();
            }
          }

          shell.set({
            header: {
              title: "连接 GitHub",
              description: "三步完成：填仓库、填 Token、验证",
              actions: [{ id: "close", label: "关闭", variant: "ghost" }],
            },
            onAction(id) {
              if (id === "close") requestClose();
            },
          });

          render();

          return () => {
            alive = false;
          };
        },
      }),
    );

    // 命令：打开配置向导
    disposers.push(
      context.commands.register({
        id: "github-sync-onboarding",
        title: "GitHub 同步：开始配置向导",
        run: guard(async () => {
          await context.ui.panels.open("github-sync-onboarding");
        }),
      }),
    );

    // 编辑会话边界：页面被隐藏或即将关闭时，立即提交待推送的改动。
    // 解决"写了一半就切走 / 关掉页面"的场景，避免改动一直滞留在待推送队列里。
    if (typeof document !== "undefined" && typeof window !== "undefined") {
      const flushWhenHidden = () => {
        if (document.visibilityState !== "hidden") return;
        if (!engine.config?.flushOnHide) return;
        void engine.flush();
      };
      const flushOnPageHide = () => {
        void engine.flush();
      };
      document.addEventListener("visibilitychange", flushWhenHidden);
      window.addEventListener("pagehide", flushOnPageHide);
      disposers.push(() => {
        document.removeEventListener("visibilitychange", flushWhenHidden);
        window.removeEventListener("pagehide", flushOnPageHide);
      });
    }

    // 启动时补齐：把尚未推送或已变化的笔记同步一次
    void (async () => {
      try {
        if (!(await bootstrap())) return;
        if (!engine.config.syncOnStartup) return;
        await engine.fullSync({ silent: true });
      } catch (error) {
        context.ui.showNotice(`GitHub 同步启动检查失败：${error.message}`);
      }
    })();

    return () => {
      disposed = true;
      engine.cancelAll();
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          /* 清理失败可忽略 */
        }
      }
    };
  },
};
