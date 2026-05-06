# R8: 文件管理流程 Review

> 日期: 2026-05-24
> 审查范围: 目录浏览 → 文件查看 → 上传 → 内容渲染

## 审查范围

### 前端
- `web/src/components/file/FileManager.vue` (1-746) — 目录浏览器
- `web/src/components/file/FileViewer.vue` (1-367) — 文件查看器
- `web/src/components/file/CodePreview.vue` (1-173) — 代码预览
- `web/src/components/file/MarkdownPreview.vue` (1-162) — Markdown预览
- `web/src/components/file/FileHeader.vue` (1-312) — 查看器头部
- `web/src/components/file/FileDetailsDialog.vue` (1-203) — 文件详情
- `web/src/components/file/DirBreadcrumb.vue` (1-78) — 面包屑导航
- `web/src/utils/fileType.ts` (1-99) — 文件类型检测

### 后端
- `internal/handler/file.go` (1-470) — 文件API
- `internal/handler/upload.go` (1-115) — 上传API
- `internal/handler/file_ops.go` (1-426) — 文件操作API
- `internal/model/file.go` (1-107) — 文件模型
- `internal/model/path.go` (1-22) — 路径验证

---

## 三维度评估

### 🏗️ 架构设计 (30%) — 评分: 7.5/10

**分层清晰：** 前端 FileManager（目录浏览）→ FileViewer（内容渲染）→ CodePreview/MarkdownPreview（格式特定渲染），后端 file.go（读取）→ upload.go（写入）→ file_ops.go（操作），职责分明。

**路径安全核心：** `validateAndResolvePath` 是安全基石——`filepath.Abs` + `strings.HasPrefix(projectPath)` 双重检查，确保所有用户可控路径都在项目根目录内。在 file.go、upload.go、file_ops.go 的每个接受路径的 handler 中都调用了此函数。

**关键缺陷：**
- `file_ops.go` 的 Rename/Delete 操作接受客户端传入的 `BasePath`，虽经路径验证，但允许操作项目根目录下的任意子路径，缺乏目录限制
- 符号链接绕过：项目内 symlink 可能通过路径验证但实际指向外部

### ✨ 代码质量 (30%) — 评分: 7.0/10

**亮点：**
- `fileType.ts` 的文件类型检测覆盖了 50+ 种扩展名，分为 code/image/audio/video/markdown/archive/other 七类
- `FileManager.vue` 的触摸友好设计：长按选择、滑动删除
- `file_ops.go` 的错误响应使用了 `writeLocalizedError` + 结构化错误

**关注点：**
- `file_ops.go` 的 `ServeFileRename` 和 `ServeFileDelete` 接受 `req.BasePath` 但未验证其为合法目录
- 上传文件名未做 sanitize（如 `../../../etc/passwd` 作为文件名）
- `file.go` 的大文件直接 `os.ReadFile` 全量加载到内存，无流式传输

### 🛡️ 健壮性 (40%) — 评分: 6.5/10

**P0 级问题：**

1. **`req.BasePath` 客户端可控导致任意路径操作**：Rename/Delete 操作的 `BasePath` 经 `validateAndResolvePath` 验证确保在项目内，但项目根目录下的任何文件/目录都可被重命名或删除，包括 `.clawbench/` 配置目录和 `.git/` 仓库

2. **符号链接绕过路径验证**：项目内的符号链接指向外部路径时，`filepath.Abs` 解析后的路径仍以 projectPath 开头，但 `os.ReadFile` 跟随 symlink 读取外部文件

**P1 级问题：**

3. **上传文件名未做 sanitize**：用户上传的文件名可能包含 `../`、空字节、特殊字符

4. **删除/重命名操作返回值未检查**：`os.Remove` 和 `os.Rename` 的错误被忽略的部分场景

5. **大文件全量加载到内存**：`file.go` 的 `ServeFileContent` 对非图片文件直接 `os.ReadFile`，大文件可能 OOM

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R8-001 | **P0** | 🛡️ 安全 | Rename/Delete 操作的 BasePath 客户端可控，可操作项目内任意文件 | `file_ops.go` | 添加目录白名单或禁止操作 .clawbench/ 和 .git/ |
| R8-002 | **P0** | 🛡️ 安全 | 符号链接绕过路径验证，可读取项目外文件 | `file.go`, `path.go` | 使用 `filepath.EvalSymlinks` 后再验证，或禁止 symlink |
| R8-003 | **P1** | 🛡️ 安全 | 上传文件名未做 sanitize，可能包含路径穿越字符 | `upload.go` | 清洗文件名：移除路径分隔符、空字节，限制长度 |
| R8-004 | **P1** | 🛡️ 健壮性 | 大文件全量加载到内存，可能 OOM | `file.go` ServeFileContent | 添加文件大小检查，超过阈值返回错误或使用 io.Copy 流式传输 |
| R8-005 | **P1** | 🛡️ 健壮性 | 文件操作非原子性，Rename 可能导致中间状态 | `file_ops.go` | 添加错误回滚或至少记录中间状态 |
| R8-006 | **P2** | ✨ 质量 | 上传文件类型黑名单不足，仅阻止 .exe/.bat/.cmd | `upload.go` | 扩展黑名单或改为白名单 |
| R8-007 | **P2** | 🛡️ 安全 | CreateDir 未验证目录名是否含特殊字符 | `file_ops.go` | sanitize 目录名 |
| R8-008 | **P2** | ✨ 质量 | CodePreview 的 highlight.js 语言检测可能不准确 | `CodePreview.vue` | 使用文件扩展名映射语言 |
| R8-009 | **P3** | ✨ 质量 | FileManager 的触摸手势与滚动冲突 | `FileManager.vue` | 添加手势阈值区分 |
| R8-010 | **P3** | ✨ 质量 | FileDetailsDialog 的时间格式未国际化 | `FileDetailsDialog.vue` | 使用 i18n 格式化 |

---

## 改进建议 (Top 3)

1. **修复路径操作安全边界 (R8-001+R8-002)**: (1) 文件操作应禁止操作 `.clawbench/` 和 `.git/` 目录下的文件（除非是显式的 git 操作）；(2) 使用 `filepath.EvalSymlinks` 解析符号链接后再做路径验证，防止 symlink 绕过。预期收益：消除任意文件删除/重命名和路径穿越风险。

2. **上传文件名 sanitize + 类型限制 (R8-003+R8-006)**: 清洗上传文件名（移除 `/\`、空字节、特殊字符，限制长度），扩展文件类型限制为白名单模式（只允许已知安全的文件类型）。预期收益：防止上传恶意文件。

3. **大文件流式传输 (R8-004)**: 添加文件大小检查（如 10MB），超过阈值时使用 `io.Copy` 流式传输而非全量加载，或直接返回文件 URL 让前端通过 `<a>` 标签下载。预期收益：防止大文件 OOM。

---

## 亮点

- **validateAndResolvePath 路径安全基石**：在所有接受用户路径的 handler 中统一调用
- **fileType.ts 的全面文件类型检测**：50+ 种扩展名，7 种分类
- **FileManager 的触摸友好设计**：长按选择、滑动删除、双击打开
- **上传大小和数量限制**：MaxBytesReader + max_files 配置
- **文件详情弹窗**：显示大小、权限、修改时间，方便调试
