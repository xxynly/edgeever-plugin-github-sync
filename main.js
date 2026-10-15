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
const DEFAULT_IDLE_SECONDS = 60;

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

  /** 轻量连通性、权限与分支自检 */
  async verify() {
    const { owner, repo } = this.config;
    const repoPath = `${API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const repoResponse = await this.fetch(repoPath, { method: "GET", headers: this.headers() });
    if (!repoResponse.ok) throw await this.describeError(repoResponse);
    const data = await repoResponse.json();
    const permissions = data?.permissions ?? {};
    if (permissions.push === false) {
      throw new Error("Token 对该仓库没有写入权限，请授予 Contents 读写权限");
    }

    // 分支必须存在，否则后续写入一定失败。这里提前暴露，避免"权限正常但同步失败"。
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
    if (!branchResponse.ok) throw await this.describeError(branchResponse);

    return { defaultBranch: data?.default_branch ?? null, private: Boolean(data?.private) };
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
    this.state = { notes: {}, lastSyncAt: null };
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
    const [owner, repo, token, branch, pathPrefix, frontmatter, autoPush, idleSeconds, mirrorDelete, syncOnStartup, flushOnHide] =
      await Promise.all([
        get("github.owner"),
        get("github.repo"),
        get("github.token"),
        get("github.branch"),
        get("notes.path"),
        get("notes.frontmatter"),
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
      };
    }
  }

  async saveState() {
    await this.context.storage.set(STORAGE_KEY, this.state);
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
    const base = truncateUtf8(sanitizeSegment(note.title) || note.id, MAX_PATH_SEGMENT_BYTES);
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

    const lines = ["---", `title: ${yamlScalar(note.title ?? "")}`, `edgeever_id: ${note.id}`];
    if (note.updatedAt) lines.push(`updated: ${yamlScalar(note.updatedAt)}`);
    if (Array.isArray(note.tags) && note.tags.length > 0) {
      lines.push(`tags: [${note.tags.map((tag) => yamlScalar(tag)).join(", ")}]`);
    }
    lines.push("---", "");
    return `${lines.join("\n")}\n${body}`;
  }

  /** 推送单篇笔记；内容与路径都未变化时直接跳过 */
  async pushNote(note) {
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
    await this.saveState();
    return { pushed: true, path };
  }

  async removeNote(noteId) {
    const record = this.state.notes[noteId];
    if (!record?.path) return { skipped: true };
    if (!this.config.mirrorDelete) return { skipped: true };

    await this.client.deleteFile(record.path, `sync(delete): ${noteId}`);
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
    for (const entry of entries) {
      await this.enqueue(() => this.pushNote(entry.note));
    }
    return entries.length;
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
        context.ui.showNotice("GitHub 同步：请先在插件设置中填写仓库与 Token");
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
            `连接正常，可写入。默认分支 ${info.defaultBranch ?? "未知"}${info.private ? "，私有仓库" : ""}`,
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
          const count = await engine.flush();
          context.ui.showNotice(count > 0 ? `已提交 ${count} 篇待同步笔记` : "当前没有待同步的改动");
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
