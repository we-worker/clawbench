# Git Worktree & Branch Management Design

**Date:** 2026-09-05
**Status:** Approved (修订版 — 采纳架构评审建议)

## Overview

将 Git 历史标签页从单一的 commit 列表界面升级为管理视图：默认展示现有 commit 历史界面，通过面包屑钻入新增的「管理」视图（Worktree + 分支管理）。管理视图支持查看、切换 worktree 和分支，不做创建/删除/合并/推送等操作。

## 1. 界面层级与导航

**导航模式：面包屑钻入**（与现有 commits→files→diff 模式一致）

在 `GitHistoryContent` 顶部区域新增一个入口按钮（图标或文字链接），点击后钻入 `GitManageContent` 视图，面包屑显示为「管理 ← 历史」。返回时回到 commit 历史视图。

**导航逻辑：**
- 进入 Git 标签页时默认展示 commit 历史（跟当前行为一致）
- 从聊天中点击 commit hash 跳转过来，直接在历史视图中定位
- 两个视图各自状态保持，切换不丢失
- 钻入管理视图时，历史视图数据不清空；返回时复用缓存

**「管理」视图内部布局：**
- 上下分栏，**可折叠**
- **上半区：Worktree 列表** — 卡片形式，区头可点击折叠/展开
- **下半区：分支列表** — 列表形式，区头可点击折叠/展开
- 折叠状态持久化到 localStorage
- 只有 1 个 worktree 时，上半区折叠为一行状态栏（显示当前分支+脏状态），下半区获得全部空间

## 2. Worktree 区域

**Worktree 卡片信息：**
- Worktree 路径 — API 返回绝对路径 `path` + 相对路径 `displayPath`
- 关联的分支名
- 工作区状态标记：✓ 干净 / ⚠ 有 N 个未提交文件
- 当前活跃 worktree 用高亮边框或背景色区分
- Worktree 被锁定时（`git worktree list` 显示 locked）显示 🔒 标记

**切换 Worktree（= 切换项目路径）：**
1. 点击非当前 worktree 的卡片 → 弹出确认弹窗
2. 弹窗内容：「切换项目到 [displayPath]？」+ 显示关联分支名
3. 确认 → 调用现有项目切换流程（`setProject()` → 全页重载）
4. 取消 → 关闭弹窗
5. 切换完成后 toast 提示「已切换到 [分支名]」

### §2.1 Worktree 切换 — 全页重载的代价与缓解

现有 `setProject()` 实现为 `window.location.reload()`，这是已知的技术债。当前阶段接受此代价，但需明确：

**丢失的状态：** 终端会话、进行中的 SSE 流、进行中的 AI 聊天流
**保留的状态：** localStorage、cookie、SQLite 持久化的聊天记录
**UX 缓解措施：**
- 切换前检查是否有进行中的 AI 会话（`chatRunning === true`），如有则额外警告
- 切换前检查终端是否有活跃会话，如有则额外警告
- 重载期间显示 loading overlay，避免白屏闪烁
- 未来可实现轻量级项目切换协议（不重载页面），但不在本设计范围内

## 3. 分支区域

**分支列表行信息：**
- 分支名（当前分支用高亮或前缀标记）
- ahead/behind 远程的 commit 数（如 `↑2 ↓1`），无远程时不显示
- 默认分支（main/master）置顶
- 行高最小 44px（满足移动端触控标准）

**切换分支流程：**
1. 点击非当前分支 → 禁用整个分支列表（防止连击）→ `POST /api/git/checkout`
2. **工作区干净** → `git switch <branch>`，toast 提示「已切换到 [分支名]」
3. **工作区脏** → 后端返回 `dirty_worktree` 错误码 → 前端弹出选项弹窗：
   - **Stash 后切换** — 带参数 `stash=true` 重新请求，提示「已切换，原更改已 stash（共 N 个 stash）」
   - **强制切换** — 带参数 `force=true` 重新请求，需二次确认（`useDialog().confirm()` 设置 `dangerous: true`）
   - **取消**
4. 切换完成后刷新分支列表（当前分支标记变更）、「历史」视图标记过期

### §3.1 Stash 计数指示器

虽不做 stash 管理 UI，但 stash 是隐性数据，必须可见：
- 管理视图中显示当前仓库的 stash 计数（`git stash list` 的条目数）
- 当 stash 计数 > 0 时，在管理视图顶部或分支区标题旁显示徽标「📦 N stash」
- 点击该徽标不做任何操作（仅提示性），长按可复制 `git stash pop` 命令

### §3.2 切换分支并发控制

**服务端：** 每个 projectPath 维护一个 checkout 互斥锁。如果已有 checkout 在执行中，返回 `409 Conflict`。
**客户端：** 点击分支后禁用整个分支列表，显示 loading spinner。请求完成后（无论成功失败）重新启用。

## 4. 不做的（YAGNI）

- 不做创建/删除分支
- 不做合并/rebase
- 不做 push/pull/fetch
- 不做 stash 管理 UI（只在切换分支时自动 stash，stash 计数仅作提示）
- 不做创建/删除 worktree

## 5. 后端 API

### 新增端点

**`GET /api/git/worktrees`**
- 返回：`[{ path, displayPath, branch, isCurrent, dirty, untrackedCount, locked }]`
- 实现：解析 `git worktree list --porcelain`
- 脏状态：对每个 worktree 路径并行执行 `git -C <path> status --porcelain`（goroutine 并发 + 5s 超时）
- `path`：绝对路径；`displayPath`：相对于主仓库的路径，若无法相对化则用绝对路径
- locked：解析 porcelain 输出中的 `locked` 行

**`GET /api/git/branches`**
- 返回：`[{ name, isCurrent, isDefault, ahead, behind, remoteTracking }]`
- 实现：解析 `git for-each-ref --format='%(refname:short) %(upstream:short) %(upstream:track)' refs/heads/`
- 默认分支检测（按优先级）：
  1. `git symbolic-ref refs/remotes/origin/HEAD` → 提取分支名
  2. 检查 `main` 分支是否存在
  3. 检查 `master` 分支是否存在
  4. 无默认标记

**`POST /api/git/checkout`**
- 请求：`{ branch: string, stash?: boolean, force?: boolean }`
- 实现：
  - 默认 → `git switch <branch>`
  - `stash=true` → 先 `git stash`，再 `git switch <branch>`
  - `force=true` → `git switch -f <branch>`（需二次确认，前端用 `useDialog().confirm({ dangerous: true })`）
- 服务端互斥锁：每个 projectPath 同时只允许一个 checkout 操作，冲突返回 `409 Conflict`
- 返回：`{ success: boolean, branch: string, stashed?: boolean, stashCount?: number, error?: string }`

### §5.1 Checkout 错误码

| error 值 | 含义 | 前端行为 |
|----------|------|---------|
| `dirty_worktree` | 工作区有未提交更改 | 弹出 stash/force/取消选项弹窗 |
| `checkout_conflict` | 切换产生冲突（如 unmerged paths） | toast 提示冲突文件列表 |
| `hook_rejected` | git hook 拒绝了切换 | toast 提示 hook 拒绝 |
| `branch_not_found` | 分支不存在 | toast 提示，刷新分支列表 |
| `checkout_in_progress` | 已有 checkout 在执行 | toast 提示稍后重试 |
| `detached_head` | 当前处于 detached HEAD | 允许操作但提示 |

### 不新增的端点

- **Worktree 切换** — 复用现有项目路径切换流程（`POST /api/project`），无需额外接口

## 6. 前端组件架构

### 新增组件

```
web/src/components/git/
  GitManageContent.vue     ← 管理视图容器（面包屑钻入）
  GitWorktreeList.vue      ← 上半区：Worktree 卡片列表
  GitWorktreeCard.vue      ← 单个 Worktree 卡片
  GitBranchList.vue        ← 下半区：分支列表
  GitBranchRow.vue         ← 单个分支行（统一命名：Row 后缀，与 Card 对称）
  GitCheckoutSheet.vue     ← 分支切换选项弹窗（BottomSheet，三选项：stash/force/取消）
```

### 组件层级

```
GitHistoryContent.vue（现有，内部增加视图状态）
  ├── currentView === 'commits' → 现有 commit 列表（不变）
  ├── currentView === 'files'   → 现有文件列表（不变）
  ├── currentView === 'diff'    → 现有 diff 视图（不变）
  └── currentView === 'manage'  → GitManageContent.vue（新增）
        ├── GitWorktreeList.vue
        │     └── GitWorktreeCard.vue × N
        └── GitBranchList.vue
              └── GitBranchRow.vue × N
```

### Dialog/Sheet 策略

- **Worktree 切换确认** → 使用现有 `useDialog().confirm()` 单例，无需自定义组件
- **分支脏工作区选项** → 使用 `GitCheckoutSheet.vue`（BottomSheet），因为需要三个选项（stash/force/取消），超出 `useDialog().confirm()` 的能力
- **强制切换二次确认** → 使用 `useDialog().confirm({ dangerous: true })`

### 状态管理

`stores/app.ts` 新增：
- `gitWorktrees: array` — worktree 列表缓存
- `gitBranches: array` — 分支列表缓存
- `gitStashCount: number` — stash 条目数
- `loadGitWorktrees()` — 加载 worktree 列表
- `loadGitBranches()` — 加载分支列表

### 现有组件改动

- `GitHistoryContent.vue` — 新增 `currentView === 'manage'` 分支，增加面包屑「管理」层级
- `GitBreadcrumb.vue` — 新增「管理」层级
- 其他组件不动（GitHistoryDrawer / GitCommitList / GitGraph / useCommitNavigation）

## 7. 数据流与边界情况

**数据加载时机：**
- 钻入管理视图时，如果数据为空则加载（worktrees + branches + stashCount 并行请求）
- 已有数据且 git 状态未变（branch/head/dirty 不变）则复用缓存
- 切换分支成功后强制重新加载 branches + stashCount
- 切换 worktree 后全页重载，所有状态自动初始化

**管理视图 loading/error 状态：**
- 两个区域（worktrees / branches）各自独立 loading 和 error 状态
- loading 时显示骨架屏
- error 时显示错误提示 + 重试按钮
- 支持下拉刷新（touch 设备）或刷新按钮刷新两个列表

**边界情况：**
- 无 worktree（普通单目录仓库）→ worktree 列表折叠为一行状态栏，显示当前分支+脏状态
- 无远程 → branches 的 ahead/behind 不显示
- 非 git 仓库 → 管理 tab 显示 git init 提示（复用现有逻辑）
- worktree 路径不存在（已被手动删除）→ 显示 ⚠ 警告标记 + 「路径不存在」提示，切换按钮禁用
- Detached HEAD → 分支列表无当前分支高亮，当前状态行显示「detached HEAD at abc1234」
- Bare repository → worktree 列表正常显示，无「主工作区」标记
