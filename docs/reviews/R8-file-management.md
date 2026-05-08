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

### 🏗️ 架构设计 (30%) — 评分: 7.3/10

**分层清晰：** 前端 FileManager（目录浏览）→ FileViewer（内容渲染）→ CodePreview/MarkdownPreview（格式特定渲染），后端 file.go（读取）→ upload.go（写入）→ file_ops.go（操作），职责分明。

**路径安全核心：** `validateAndResolvePath` 是安全基石——`filepath.Abs` + `strings.HasPrefix(projectPath)` 双重检查，确保所有用户可控路径都在项目根目录内。在 file.go、upload.go、file_ops.go 的每个接受路径的 handler 中都调用了此函数。

**关键缺陷：**
- `file_ops.go` 的 Rename/Delete 操作接受客户端传入的 `BasePath`，虽经路径验证，但允许操作项目根目录下的任意子路径，缺乏目录限制
- 符号链接绕过：项目内 symlink 可能通过路径验证但实际指向外部

### ✨ 代码质量 (30%) — 评分: 6.8/10

**亮点：**
- `fileType.ts` 的文件类型检测覆盖了 50+ 种扩展名，分为 code/image/audio/video/markdown/archive/other 七类
- `FileManager.vue` 的触摸友好设计：长按选择、滑动删除
- `file_ops.go` 的错误响应使用了 `writeLocalizedError` + 结构化错误

**关注点：**
- 上传文件名未做 sanitize（如 `../../../etc/passwd` 作为文件名）
- `stores/app.ts:198-247` 与 `fileType.ts` 存在重复的扩展名列表
- `file_ops.go` 的 `ServeFileRename` 和 `ServeFileDelete` 接受 `req.BasePath` 但未验证其为合法目录

### 🛡️ 健壮性 (40%) — 评分: 5.5/10

**P0 级问题：**

1. **MarkdownPreview XSS**：`MarkdownPreview.vue:4,100` 使用 `v-html` 且 `sanitize:false`，渲染未清理的 markdown。精心构造的 .md 文件可执行任意 JS

2. **符号链接绕过路径验证**：`model/path.go:10-22` `filepath.Abs` 不跟随符号链接。项目内的 symlink 可逃逸到项目外

3. **客户端可控 BasePath**：`file_ops.go:24-25,134` Rename/Delete 的 `BasePath` 可覆盖 project cookie 路径，允许操作任意目录

4. **上传危险扩展名不完整**：`upload.go:58-62` 未阻止 .html、.svg。上传的 HTML 从 `/api/local-file/` 提供，构成存储型 XSS

5. **10MB 文件全量读入内存**：`file.go:209` `os.ReadFile` 读取最大 10MB 文件后再 JSON 编码

**P1 级问题：**

6. **上传文件名 TOCTOU 竞态**：`upload.go:82-90` 非原子性的 stat-then-create

7. **os.RemoveAll 跟随符号链接**：`file_ops.go:172` 可能删除项目外的内容

8. **ServeFileEditLine 无大小检查**：`file_ops.go:100`

9. **非原子文件写入**：`file_ops.go:119,234` crash 发生在 truncate 和 write 之间会丢失数据

10. **重复扩展名列表**：`stores/app.ts:198-247` vs `fileType.ts`

11. **上传文件名清理不完整**：`upload.go:76-80`

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R8-001 | **P0** | 🛡️ 安全 | MarkdownPreview v-html sanitize:false 导致 XSS | `MarkdownPreview.vue:4,100` | 启用 DOMPurify 或设置 sanitize:true |
| R8-002 | **P0** | 🛡️ 安全 | 符号链接绕过 validateAndResolvePath | `model/path.go:10-22` | 使用 `filepath.EvalSymlinks` 后再验证 |
| R8-003 | **P0** | 🛡️ 安全 | Rename/Delete BasePath 客户端可控，可操作任意目录 | `file_ops.go:24-25,134` | 限制 BasePath 只能为项目根目录 |
| R8-004 | **P0** | 🛡️ 安全 | 上传扩展名黑名单缺少 .html/.svg，构成存储型 XSS | `upload.go:58-62` | 添加 .html/.svg 到黑名单 |
| R8-005 | **P0** | 🛡️ 健壮性 | 10MB 文件全量读入内存后 JSON 编码 | `file.go:209` | 使用 io.Copy 流式传输 |
| R8-006 | **P1** | 🛡️ 安全 | 上传文件名 TOCTOU 竞态（stat-then-create） | `upload.go:82-90` | 使用 O_EXCL 原子创建 |
| R8-007 | **P1** | 🛡️ 安全 | os.RemoveAll 跟随符号链接，可删除项目外内容 | `file_ops.go:172` | 使用 `filepath.EvalSymlinks` 或手动递归删除 |
| R8-008 | **P1** | 🛡️ 健壮性 | ServeFileEditLine 无大小检查 | `file_ops.go:100` | 添加文件大小上限 |
| R8-009 | **P1** | 🛡️ 健壮性 | 非原子文件写入，crash 时可能丢失数据 | `file_ops.go:119,234` | 写入临时文件后 rename |
| R8-010 | **P1** | ✨ 质量 | 重复扩展名列表（stores/app.ts vs fileType.ts） | `stores/app.ts:198-247` | 统一到 fileType.ts |
| R8-011 | **P1** | 🛡️ 安全 | 上传文件名清理不完整 | `upload.go:76-80` | 完整 sanitize：移除 /\\、空字节、限制长度 |
| R8-012 | **P2** | 🛡️ 泄漏 | scrollPositions Map 无界增长 | `FileViewer.vue:161` | 添加 LRU 或上限 |
| R8-013 | **P2** | 🛡️ 安全 | filepath.Walk 跟随符号链接 | `file.go:109` | 不跟随 symlink 或检查 |
| R8-014 | **P2** | ✨ 质量 | IsTextFile 每次调用分配 slice | `model/file.go:12-65` | 预分配或缓存结果 |
| R8-015 | **P2** | ✨ 质量 | Copy 不保留文件权限 | `file_ops.go:382-397` | 使用 `io.Copy` + `os.Chmod` |
| R8-016 | **P2** | 🛡️ 健壮性 | fixLocalImagePaths 正则脆弱 | `MarkdownPreview.vue:77-93` | 改用 DOM 解析 |

---

## 改进建议 (Top 3)

1. **修复路径安全 (R8-001+R8-002+R8-003)**: (1) MarkdownPreview 启用 DOMPurify（`sanitize: true`），阻止 XSS；(2) `validateAndResolvePath` 添加 `filepath.EvalSymlinks` 解析符号链接后再做前缀检查；(3) `file_ops.go` 的 BasePath 限制为项目根目录，禁止客户端覆盖。预期收益：消除 XSS、路径穿越和任意文件操作三个最严重的安全风险。

2. **上传安全 (R8-004+R8-006+R8-011)**: (1) 扩展名黑名单添加 .html/.svg；（2）使用 `O_EXCL` 原子创建避免 TOCTOU 竞态；（3）完整 sanitize 文件名——移除 `/\\`、空字节、特殊字符，限制长度。预期收益：消除存储型 XSS 和文件上传攻击面。

3. **大文件处理 (R8-005+R8-008)**: `ServeFileContent` 对大文件使用 `io.Copy` 流式传输而非全量加载；`ServeFileEditLine` 添加文件大小上限检查。预期收益：防止大文件 OOM。

---

## 亮点

- **validateAndResolvePath 路径安全基石**：在所有接受用户路径的 handler 中统一调用
- **fileType.ts 的全面文件类型检测**：50+ 种扩展名，7 种分类
- **FileManager 的触摸友好设计**：长按选择、滑动删除、双击打开
- **上传大小和数量限制**：MaxBytesReader + max_files 配置
