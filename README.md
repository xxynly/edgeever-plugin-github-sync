# EdgeEver GitHub Sync 插件

保存笔记后**自动推送**到 GitHub 仓库，以 Markdown 源文件形式保存。

事件驱动，不是轮询 —— 你在 EdgeEver 里保存的那一刻就推。内容没变则完全不发请求。

---

## 它解决什么问题

| 你担心的 | 插件的处理方式 |
|---|---|
| 「Actions 太慢，不知道啥时候跑」 | 不用 Actions。保存成功即触发，秒级完成 |
| 「文件没改动还去同步，有问题」 | 推送前比对笔记的 `contentHash`，**内容未变时零网络请求**（连远端文件都不读） |
| 「一篇笔记写一小时会提交几十次吗」 | 不会。静默期机制：只要还在写就不提交，停手后才提交一次 |
| 「并发推送会不会冲突」 | 所有写操作串行排队，且更新时携带文件 `sha` |

---

## 工作原理

```
你在 EdgeEver 编辑笔记 → 保存成功
        ↓
宿主派发 note.updated 事件（携带完整笔记对象）
        ↓
插件比对 contentHash ── 相同 → 直接跳过，不发任何请求
        ↓ 不同
按 笔记本层级/标题.md 计算路径
        ↓
调用 GitHub Contents API 写入（携带 sha 避免冲突）
```

推送的文件路径形如：

```
notes/技术笔记/入门指南.md
notes/技术笔记/架构设计/同步架构.md
```

文件开头会写入 YAML 元数据（可在设置中关闭）：

```markdown
---
title: "入门指南"
edgeever_id: memo_xxx
updated: "2026-10-15T10:00:00.000Z"
tags: ["指南"]
---

# 入门指南

正文内容…
```

---

## 前置准备

### 1. 创建一个存放笔记的仓库

在 GitHub 新建一个仓库，例如 `xxynly/notes`。

> 可以是**私有仓库**。插件仓库需要公开，笔记仓库不需要。

### 2. 创建一个细粒度 Token

访问 **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**

- **Repository access**：Only select repositories → 选中上一步的笔记仓库
- **Permissions → Repository permissions → Contents**：设为 **Read and write**

生成后复制 `github_pat_...`，**只显示一次**。

---

## 部署插件

把本目录的 `manifest.json` 和 `main.js` 推到一个**公开** GitHub 仓库：

```bash
cd edgeever-plugin-github-sync
git init
git add manifest.json main.js README.md
git commit -m "feat: EdgeEver GitHub Sync plugin v1.0.0"
git branch -M main
git remote add origin https://github.com/xxynly/edgeever-plugin-github-sync.git
git push -u origin main
```

> 只需上传 `manifest.json` 和 `main.js` 这两个文件，插件本身就能工作。
> `package.json` 和 `test/` 是本地测试用的，不影响插件运行。

---

## 在 EdgeEver 中安装

打开 EdgeEver → **插件市场** → 选择安装方式：

### 方式 A：Manifest 自由安装（最简单，无需 Release）

在「扩展 Manifest 地址」里填入：

```
https://raw.githubusercontent.com/xxynly/edgeever-plugin-github-sync/main/manifest.json
```

### 方式 B：GitHub 自由安装（标准方式）

需要先创建一个 Release：

1. 在插件仓库创建 Release，**Tag 填 `1.0.0`**（必须与 `manifest.json` 里的 `version` 一致）
2. 把 `manifest.json` 和 `main.js` 作为**Release 资产**上传
3. 回到 EdgeEver，在 GitHub 安装入口填入仓库地址：

```
https://github.com/xxynly/edgeever-plugin-github-sync
```

> 注意：EdgeEver 会校验仓库里的 `manifest.json` 与 Release 资产里的 `manifest.json` 的
> `id`、`version`、`type` 三者必须一致，否则拒绝安装。

安装后**记得启用插件**。

---

## 配置

进入插件的设置页，填写：

| 设置项 | 说明 |
|---|---|
| GitHub 用户名或组织 | 例如 `xxynly` |
| 仓库名 | 例如 `notes` |
| GitHub Token | 粘贴上一步生成的 `github_pat_...`（加密保存，不会回显） |
| 分支 | 默认 `main` |
| 仓库内目录 | 默认 `notes`，笔记会放在这个目录下 |
| 保存后自动推送 | 默认开启 |
| 静默提交延迟（秒） | 默认 60。停止编辑多久后提交 |
| 离开页面时立即提交 | 默认开启 |
| 写入 YAML 头信息 | 默认开启 |
| 删除笔记时同步删除文件 | 默认关闭 |
| 启动时全量补推 | 默认开启 |

---

## 验证

插件注册了 3 个命令，在 EdgeEver 的命令面板中执行：

| 命令 | 作用 |
|---|---|
| **GitHub 同步：检查连接与权限** | 先跑这个，确认 Token 和仓库都正常 |
| **GitHub 同步：立即同步全部笔记** | 把现有笔记一次性全部推上去 |
| **GitHub 同步：查看同步状态** | 显示已跟踪的笔记数和上次同步时间 |

**推荐首次使用顺序**：先跑「检查连接与权限」→ 再跑「立即同步全部笔记」→ 之后正常编辑即可自动推送。

---

## 提交时机是怎么设计的

EdgeEver 的编辑器会在**停止输入 1.2 秒后自动保存**（源码常量 `EDITOR_LOCAL_SAVE_DELAY_MS`）。
这意味着写一篇长文时，每次思考停顿都会产生一次保存事件。如果保存即提交，
一小时下来就是几十个提交 —— 仓库历史会被自动保存淹没。

所以插件采用**静默期**策略：保存只负责把笔记放进待提交队列，
真正的提交发生在**你停手一段时间之后**。

```
你一直在写（每次停顿都短于静默期）
  → 计时器被反复重置 → 不提交

你停手超过静默期
  → 提交一次，内容是你写到的最终版本
```

默认静默期 **60 秒**。写一小时的文章，如果中途多次长时间停顿，
会产生若干个提交；如果连续写不停手，则只在最后提交一次。

### 三层提交时机

| 时机 | 触发条件 | 说明 |
| :--- | :--- | :--- |
| **静默期** | 停手 60 秒（可调） | 主力机制 |
| **离开页面** | 切走标签页 / 关闭页面 | 立即提交，不等静默期 |
| **手动命令** | 执行「立即提交未同步的改动」 | 你想立刻同步时 |

### 为什么不能只靠「退出时提交」

这是个很自然的想法，但单独使用不可靠：

1. **不关页面就永远不提交** —— 一直开着 EdgeEver 写，内容永远不会进仓库。
2. **关闭瞬间的请求不保证完成** —— 页面卸载时浏览器会中断进行中的请求。
   浏览器提供的 `sendBeacon` 无法设置 `Authorization` 头（GitHub 必须用），
   `fetch` 的 `keepalive` 又有 64 KB 体积上限，长笔记会超出。
3. **每篇笔记需要两个请求** —— 先查文件 `sha` 再写入，卸载窗口内几乎来不及。

所以「离开页面」只能作为**边界补充**，不能当主力。

### 提交失败不会丢内容

即使某次提交没成功，**笔记本身已经安全存在 EdgeEver 里**。
GitHub 上只是暂时落后一个版本，下次打开页面时插件会自动补推。
静默期机制解决的是「提交时机是否合理」，而不是「内容是否有备份」。

### 如果你想要更少或更多的提交

| 你的偏好 | 建议设置 |
| :--- | :--- |
| 提交越少越好，不介意 GitHub 上滞后 | 静默期调到 300～600 秒 |
| 希望 GitHub 上尽快看到最新内容 | 静默期调到 15～30 秒 |
| 想完全手动控制 | 关闭「保存后自动推送」，只用命令提交 |

---

## 行为细节

**首次使用**：插件默认在启动时执行一次全量补推（可关闭）。因为插件无法得知安装之前的历史，这一步会把已有笔记补齐。

**改名与移动**：笔记标题改变或移动到其他笔记本时，插件会在新路径创建文件，并自动删除旧路径的文件。

**同名笔记**：同一笔记本下两篇同名笔记，第二篇的文件名会自动追加 ID 后缀（如 `周报-bbb222.md`），不会互相覆盖。

**删除笔记**：默认**不会**删除仓库里的文件（避免误删）。如需镜像删除，在设置中开启。

**关于定时**：本插件是事件驱动，不使用 EdgeEver 的定时任务能力。定时任务在云端 Web 部署下受设备绑定限制（必须打开页面才会执行），事件驱动反而是更可靠的方案。

---

## 已知限制

- **应用打开期间运行**：EdgeEver 的插件运行在应用内。你在别处（比如手机）修改笔记后，需要打开一次 EdgeEver 页面才会推送。这是 EdgeEver 插件模型的固有特性。
- **附件不同步**：当前版本只同步 Markdown 正文，笔记中的图片等附件不会上传到仓库。
- **重命名分支**：如果在设置里改了分支，之前推送的记录仍指向旧分支，建议同步改分支后跑一次「立即同步全部笔记」。
- **Token 存储**：Token 通过插件的 `secret` 类型设置项保存，由 EdgeEver 本地加密，仅存于当前设备、不跨端同步。

---

## 本地测试

插件附带了一套模拟测试，在 Node 中伪造 EdgeEver 宿主与 GitHub API，验证去重、路径分配、Unicode 编码等行为：

```bash
node test/mock-test.mjs
```

当前结果：**26 项断言全部通过**。

---

## 文件说明

| 文件 | 用途 |
|---|---|
| `manifest.json` | 插件清单（分发必需） |
| `main.js` | 插件代码，免构建单文件 ESM（分发必需） |
| `package.json` | 仅用于本地跑测试，可不上传 |
| `test/mock-test.mjs` | 模拟测试，可不上传 |
