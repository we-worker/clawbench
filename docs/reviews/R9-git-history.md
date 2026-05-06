# R9: Git 历史流程 Review

> 日期: 2026-05-24
> 审查范围: Git命令 → Diff解析 → 图渲染 → UI交互

## 审查范围

### 前端
- `web/src/components/git/GitHistoryDrawer.vue` (1-632) — 历史抽屉编排
- `web/src/components/git/GitGraph.vue` (1-325) — SVG 图渲染
- `web/src/components/git/GitDiffView.vue` (1-163) — Diff 展示
- `web/src/components/git/GitCommitList.vue` (1-457) — 提交列表
- `web/src/components/git/GitCommitMeta.vue` (1-115) — 提交元数据
- `web/src/components/git/GitBreadcrumb.vue` (1-133) — 面包屑导航
- `web/src/utils/gitGraph.ts` (1-608) — 图布局算法
- `web/src/utils/diff.ts` (1-126) — Diff 解析与渲染

### 后端
- `internal/handler/git.go` (1-515) — Git 命令执行与 API

---

## 三维度评估

### 🏗️ 架构设计 (30%) — 评分: 8.5/10

**后端 handler 按职责拆分清晰：** 8 个 handler（project-history / file-diff / commit-files / history / diff / status / working-tree / init），每个函数单一职责。

**前端图算法设计精良：** `gitGraph.ts` 的两阶段算法（Lane Assignment → Connection Generation），Phase 1 四步（A-D）逐步优化 lane 分配，Phase D 的区间着色压缩复用非重叠 lane。

**关注点：**
- `gitDiff()` 返回 `[]byte` 但直接 `string(output)` 写入 JSON，大 diff 无截断/流式处理
- `GitHistoryDrawer.vue` 职责略重（632行），同时管理数据加载、导航状态、diff 渲染、工作树逻辑

### ✨ 代码质量 (30%) — 评分: 8.0/10

**亮点：**
- **命令注入防护到位**：全部使用 `exec.Command` 数组传参 + `--` 分隔符，无 shell 注入风险
- **diff XSS 防护完善**：`escapeHtml` 覆盖 hunk header、prefix、fallback raw，`highlightLine` 失败时 fallback 到 `escapeHtml`
- **图算法质量高**：lane 压缩算法（区间着色）避免了不必要的 lane 扩张，`renderCascade` 优雅处理 octopus merge
- `parseGitStatusPorcelain` 正确处理 XY 双状态和 rename 箭头

**关注点：**
- `GitCommitMeta.vue:55` 的 `formatDate` 硬编码 `zh-CN` locale，与 i18n 体系不一致
- `GitBreadcrumb.vue:24` 的 `v-html="FILE_OPEN_ICON_SVG"` 使用预定义常量，虽安全但违反最佳实践

### 🛡️ 健壮性 (40%) — 评分: 7.5/10

**P0 级问题：**

1. **SHA 参数未验证格式**：`ServeGitCommitFiles` 中 `sha` 参数未验证格式。用户可传入 `--all` 或其他 flag-like 值。虽然 `exec.Command` 数组传参不会导致 shell 注入，但 git 会将 `--all` 解释为 flag，可能泄露全部 commit 信息

**P1 级问题：**

2. **文件历史无分页**：`ServeGitHistory` 对某文件的全部 commit 历史无限制，数千条 commit 全量加载到内存

3. **大 diff 无大小限制**：`gitDiff` 对超大文件的 diff 全量加载，可能 OOM

4. **搜索全量加载**：`onSearch` 循环加载全部 commit 到内存，大仓库可能加载数万条

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R9-001 | **P0** | 🛡️ 安全 | SHA 参数未验证格式，可传入 flag-like 值（如 `--all`） | `git.go:281` | 正则校验 `^[0-9a-f]{4,40}$` |
| R9-002 | **P1** | 🛡️ 健壮性 | 文件历史无分页，大仓库全量加载 | `git.go:142,212` | 添加 `-N` 限制返回条数 |
| R9-003 | **P1** | 🛡️ 健壮性 | 大 diff 无大小限制，可能 OOM | `git.go:212` | 添加 `--stat` 预检或限流截断 |
| R9-004 | **P1** | 🛡️ 健壮性 | 搜索全量加载全部 commit 到内存 | `GitHistoryDrawer.vue:342-353` | 改为后端搜索 `git log --grep` |
| R9-005 | **P2** | 🛡️ 健壮性 | `shaToBranchNames` 反向遍历无上限保护 | `gitGraph.ts:536-554` | 添加 visited 上限 |
| R9-006 | **P2** | ✨ 质量 | `formatDate` 硬编码 `zh-CN` locale | `GitCommitMeta.vue:55` | 使用 i18n locale |
| R9-007 | **P3** | ✨ 质量 | `v-html` 使用预定义 SVG 常量 | `GitBreadcrumb.vue:24` | 改用组件 |
| R9-008 | **P3** | ✨ 质量 | `skip` 参数 Sscanf 错误未显式检查 | `git.go:129` | 检查 n 和 err |

---

## 改进建议 (Top 3)

1. **验证 SHA 参数格式 (R9-001)**: 在所有接受 SHA 的 handler 中添加正则校验 `^[0-9a-f]{4,40}$`，拒绝含 `--` 或非 hex 字符的输入。这是最直接的安全收益。预期收益：消除 git flag 注入风险。

2. **文件历史分页 + diff 大小限制 (R9-002+R9-003)**: `ServeGitHistory` 加 `-N` 限制返回条数（如 50），前端按需加载更多。`gitDiff` 添加 `--stat` 预检，diff 超过阈值时截断并返回 warning。预期收益：防止大仓库 OOM。

3. **搜索改为后端搜索 (R9-004)**: `onSearch` 应改为调用 `git log --grep` 后端 API，而非前端全量加载后 filter。预期收益：减少内存压力，提升搜索体验。

---

## 亮点

- **命令注入防护三层防线**：`exec.Command` 数组传参 + `--` 分隔符 + `validateAndResolvePath`
- **diff XSS 双层防护**：`escapeHtml` + `highlightLine` fallback
- **图算法质量高**：lane 压缩算法、octopus merge 处理、lazy-load lane 稳定性
- **parseGitStatusPorcelain**：正确处理 XY 双状态和 rename 箭头
- **persistedShaToLane**：分页加载时保持已有 lane 映射，避免视觉抖动
