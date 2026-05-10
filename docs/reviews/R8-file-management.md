# R8: 文件管理流程 Review

> 日期: 2026-05-10
> 审查范围: 目录浏览 → 文件查看 → 上传 → 内容渲染

## 审查范围

### 前端
- `web/src/components/file/FileManager.vue` (749行) — 目录浏览器：排序、过滤、上下文菜单、剪贴板、触摸手势
- `web/src/components/file/FileViewer.vue` (418行) — 文件查看器：内容分发、滚动位置缓存、word-wrap
- `web/src/components/file/CodePreview.vue` (191行) — 代码预览：逐行高亮、行号、双击复制
- `web/src/components/file/MarkdownPreview.vue` (169行) — Markdown预览：渲染/源码切换、本地图片路径修正、文件路径标注
- `web/src/components/file/FileHeader.vue` (382行) — 查看器头部：导航、下拉菜单、TOC/搜索
- `web/src/components/file/FileDetailsDialog.vue` (204行) — 文件详情：元数据展示、复制值
- `web/src/components/file/DirBreadcrumb.vue` (79行) — 面包屑导航
- `web/src/composables/useFileUpload.ts` (167行) — 上传composable：XHR上传、进度、限制检查
- `web/src/utils/fileType.ts` (100行) — 文件类型检测：50+扩展名分类
- `web/src/stores/app.ts` (399行) — 全局状态：文件浏览、历史导航、选择逻辑

### 后端
- `internal/handler/file.go` (511行) — 文件API：ListDir/ListFiles/GetFile/ServeLocalFile/ServeProjects
- `internal/handler/upload.go` (116行) — 上传API：文件上传+危险扩展名检查
- `internal/handler/file_ops.go` (431行) — 文件操作API：Rename/Delete/Create/Move/Copy/EditLine
- `internal/model/file.go` (108行) — 文件类型模型：IsTextFile/IsImageFile/IsAudioFile/IsVideoFile
- `internal/model/path.go` (23行) — 路径验证：ValidatePath

---

## 三维度评估

### 🏗️ 架构设计 (30%) — 评分: 7.3/10

**分层设计合理：**
- 前端：FileManager(目录浏览) → FileViewer(内容分发) → CodePreview/MarkdownPreview(格式特定渲染)，三层职责分明
- 后端：file.go(读取) → upload.go(写入) → file_ops.go(操作)，按操作类型拆分
- 前后端都有独立的文件类型检测逻辑，前端用于UI渲染决策，后端用于安全检查

**路径安全核心架构：**
- `validateAndResolvePath` → `model.ValidatePath` 是安全基石
- 原理：`filepath.Abs(filepath.Join(base, rel))` + `strings.HasPrefix(absPath, absBase+separator)`
- 在 file.go、upload.go、file_ops.go 的每个接受路径的 handler 中统一调用
- `handler.go:97-104` 封装为统一函数，避免遗漏

**架构缺陷：**

1. **客户端可控 BasePath 绕过项目隔离** (`file_ops.go:24-25,134`)
   - Rename 和 Delete 操作的 `req.BasePath` 可以覆盖 project cookie 路径
   - 虽然经过 `validateAndResolvePath`，但攻击者只需知道服务器上的合法目录路径，即可操作该目录下的文件
   - 这违反了"project cookie 是用户授权范围的唯一来源"的架构假设

2. **符号链接绕过路径验证** (`model/path.go:10-22`)
   - `filepath.Abs` 不解析符号链接。项目内的 symlink 指向外部目录时，路径验证通过但实际访问的是外部文件
   - 影响范围：所有使用 `validateAndResolvePath` 的 handler（ListDir、GetFile、ServeLocalFile、所有 file_ops）

3. **前后端文件类型列表不同步** (`stores/app.ts:205-254` vs `fileType.ts` vs `model/file.go`)
   - 前端 `stores/app.ts` 独立维护了一套 imageExts/audioExts/videoExts/textExts 列表
   - `fileType.ts` 有完整的 FileType 映射表
   - 后端 `model/file.go` 有自己的扩展名列表
   - 三处扩展名需要手动同步，极易出现不一致

4. **ServeProjects 混合了两个职责** (`file.go:272-350`)
   - GET 列出 watchDir 下的目录 + POST 创建目录
   - 路径解析逻辑比其他 handler 更复杂（处理绝对路径和相对路径的 fallback），增加攻击面

### ✨ 代码质量 (30%) — 评分: 6.8/10

**亮点：**
- `fileType.ts` 的文件类型检测覆盖了 50+ 种扩展名，统一接口 `getFileType()` 返回 lang/label/color/isMarkdown/isImage/isAudio/isVideo
- `FileManager.vue` 的触摸友好设计：长按上下文菜单、container touch start/move/end 三阶段
- `buildDirEntries` 的 `fileInfoWithTimeout` 设计精巧（3s超时避免NFS挂起）
- `loadFiles` 使用单调递增 `loadFilesSeq` 丢弃过期并发请求结果
- `stores/app.ts` 的文件历史导航实现了浏览器风格的 back/forward

**代码重复：**
- `stores/app.ts:205-254` 的 imageExts/audioExts/videoExts/textExts 列表与 `fileType.ts` 完全重复
- `formatSize` 在 `FileManager.vue:411-416` 和 `fileType.ts:95-99` 重复实现（且单位不同：K vs KB）
- `FileManager.vue` 三个排序按钮的模板代码高度重复（第11-28行），可通过 v-for 简化

**错误处理：**
- 后端统一使用 `writeLocalizedError`/`writeLocalizedErrorf`，国际化友好
- 前端 `doPaste`/`doNewFile`/`doNewFolder` 的错误处理模式一致：try/catch + toast
- 但 `doOpenAsProject` 使用 `resp.text().then()` 链式调用而非 async/await，与同文件其他函数风格不一致

**命名和注释：**
- `currentRenderId` 在 `MarkdownPreview.vue:36` 是竞态保护的好模式，但缺少注释说明
- `clipboard` reactive 对象在 `FileManager.vue:239` 缺少类型定义
- `pendingRestore`/`restoreTimer`/`restoreAttempts` 在 `FileViewer.vue` 的滚动恢复逻辑复杂，注释不够详细

### 🛡️ 健壮性 (40%) — 评分: 5.5/10

**P0 级问题（5个）：**

**R8-001: MarkdownPreview XSS**
- `MarkdownPreview.vue:4` 使用 `v-html="renderedHtml"` 渲染
- `MarkdownPreview.vue:100` `sanitize: false` 明确禁用了净化
- 注释说"MarkdownPreview不需要净化，因为是受信任的文件内容"
- 但用户上传或编辑的 .md 文件完全不受信任！精心构造的 markdown 可包含 `<script>`、`<img onerror=>`、`<iframe>` 等 HTML 标签
- 攻击路径：上传恶意 .md → 打开 → 执行任意 JS → 可读取所有 API 数据

**R8-002: 符号链接绕过路径验证**
- `model/path.go:15` `filepath.Join(absBase, relPath)` + `filepath.Abs` 不跟随符号链接
- 攻击路径：在项目中创建 `ln -s /etc shadow` → 访问 `/api/file/shadow/passwd` → `filepath.Abs` 解析后仍以项目根开头 → 验证通过 → 读取 /etc/passwd
- 影响：ListDir、GetFile、ServeLocalFile、所有 file_ops 操作

**R8-003: 客户端可控 BasePath**
- `file_ops.go:24-25` Rename 和 `file_ops.go:134` Delete 接受 `req.BasePath`
- 虽然调用了 `validateAndResolvePath`，但 BasePath 本身可以是服务器上任意合法目录
- 攻击路径：POST `/api/file/delete` with `{ "path": "important.conf", "basePath": "/etc" }` → `validateAndResolvePath("/etc", "important.conf")` → 验证通过 → 删除 /etc/important.conf
- 这与 `requireProject` 从 cookie 获取 projectPath 的安全模型矛盾

**R8-004: 上传扩展名黑名单不完整导致存储型 XSS**
- `upload.go:58-62` 的 `dangerousExts` 只有 11 个条目
- 缺少：`.html`、`.htm`、`.svg`、`.xhtml`
- 攻击路径：上传 evil.html → 文件存储在 `.clawbench/uploads/evil.html` → 通过 `/api/local-file/` 直接提供 → 浏览器加载执行 JS
- `.svg` 也支持 `<script>` 和事件处理器，同样构成 XSS
- `ServeLocalFile` (`file.go:267`) 直接 `http.ServeFile`，无 CSP 头保护

**R8-005: 10MB 文件全量读入内存**
- `file.go:187-209` 先检查 `info.Size() > 10MB` 拒绝，然后 `os.ReadFile(absPath)` 将整个文件读入内存
- JSON 编码 `FileContent` 时，Go 的 `json.Marshal` 会将 string 内容再复制一份
- 峰值内存：10MB 原始 + ~10MB JSON string = ~20MB
- 多并发请求可能导致 OOM

**P1 级问题（6个）：**

**R8-006: 上传文件名 TOCTOU 竞态**
- `upload.go:82-90` 先 `os.Stat` 检查文件是否存在，然后 `os.Create` 创建
- 窗口期：两个并发上传同名文件，都通过 Stat 检查，后一个覆盖前一个
- 应使用 `os.OpenFile` with `O_EXCL|O_CREATE` 原子创建

**R8-007: os.RemoveAll 跟随符号链接**
- `file_ops.go:172` `os.RemoveAll(absPath)` 会递归删除，且跟随符号链接
- 如果被删目录包含指向项目外的 symlink，`RemoveAll` 会删除 symlink 目标的全部内容
- 结合 R8-002（symlink 绕过路径验证），攻击者可构造指向重要目录的 symlink 然后请求删除

**R8-008: ServeFileEditLine 无大小检查**
- `file_ops.go:100` `os.ReadFile(absPath)` 无大小限制
- 对 10GB 文件的 EditLine 请求会导致 OOM
- 虽然 `GetFile` 限制了 10MB，但 EditLine 是独立端点，无此限制

**R8-009: 非原子文件写入**
- `file_ops.go:119` `os.WriteFile` 直接截断写入，crash 发生在 truncate 和 write 之间会丢失数据
- `file_ops.go:234` 同样问题
- 安全模式：写入临时文件 → `os.Rename` 原子替换

**R8-010: 重复扩展名列表不一致风险**
- `stores/app.ts:205-254` 独立维护扩展名列表，与 `fileType.ts` 和 `model/file.go` 存在重复
- 添加新文件类型时必须同步三处，极易遗漏
- 例如 `stores/app.ts` 的 textExts 列表与 `model/file.go` 的 IsTextFile 列表可能不同步

**R8-011: 上传文件名清理不完整**
- `upload.go:76-80` 只替换了空格为下划线
- 未处理：路径分隔符 `/`、`\`、空字节 `\x00`、特殊字符 `..`、超长文件名
- 攻击：文件名 `../../../etc/passwd` 经过 `filepath.Base()` 后只取 `passwd`（当前安全），但 `filepath.Base` 对 `C:\` 等 Windows 路径行为不确定
- 空字节在 Go 中可截断字符串但可能在底层文件系统造成问题

**P2 级问题（6个）：**

**R8-012: scrollPositions Map 无界增长**
- `FileViewer.vue:161` `const scrollPositions = new Map()` 永远只增不减
- 长时间使用后可能积累数千条目
- 建议：LRU 限制最近 100 个文件

**R8-013: filepath.Walk 跟随符号链接**
- `file.go:109` `filepath.Walk` 默认不跟随 symlink（这是安全的）
- 但它不会检测到 symlink 指向项目外的文件，在 ListFiles 结果中可能暴露外部文件信息
- 实际上 `filepath.Walk` 不跟随 symlink，所以只显示 symlink 名称而非目标内容——低风险

**R8-014: IsTextFile 每次调用分配 slice**
- `model/file.go:13-57` 每次调用 IsTextFile 都创建新的 `[]string` slice
- 在 `buildDirEntries` 中每个文件都调用，大目录下可能频繁分配
- 建议：包级别 var 预分配或使用 map 查找

**R8-015: copyFile 不保留文件权限**
- `file_ops.go:389` `os.Create` 创建的文件默认权限 0644，不保留源文件权限
- 对于可执行脚本等，copy 后丢失执行权限

**R8-016: fixLocalImagePaths 正则脆弱**
- `MarkdownPreview.vue:79` 使用正则 `/<img\s+([^>]*src=[^>]*)>/gi` 匹配 img 标签
- 不能处理自闭合 `<img/>`、属性换行、单引号等
- 建议改用 DOM 解析

**R8-017: useFileUpload 顺序上传**
- `useFileUpload.ts:103-109` 使用 `for...of` + `await` 顺序上传
- 多文件上传效率低，可考虑并发上传（限制并发数）

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R8-001 | **P0** | 🛡️安全 | MarkdownPreview v-html sanitize:false 导致 XSS | `MarkdownPreview.vue:4,100` | 启用 DOMPurify 或设置 `sanitize: true` |
| R8-002 | **P0** | 🛡️安全 | 符号链接绕过 validateAndResolvePath，可访问项目外文件 | `model/path.go:15-21` | 验证前使用 `filepath.EvalSymlinks` 解析符号链接 |
| R8-003 | **P0** | 🛡️安全 | Rename/Delete BasePath 客户端可控，可操作任意目录 | `file_ops.go:24-25,134` | 删除 BasePath 参数，强制使用 project cookie |
| R8-004 | **P0** | 🛡️安全 | 上传扩展名黑名单缺少 .html/.svg，构成存储型 XSS | `upload.go:58-62` | 添加 .html/.htm/.svg/.xhtml 到黑名单 |
| R8-005 | **P0** | 🛡️健壮性 | 10MB 文件全量读入内存后 JSON 编码，峰值 20MB | `file.go:187-209` | 降小限制或改用流式传输 |
| R8-006 | **P1** | 🛡️安全 | 上传文件名 TOCTOU 竞态（stat-then-create） | `upload.go:82-90` | 使用 `os.OpenFile` with `O_EXCL\|O_CREATE` |
| R8-007 | **P1** | 🛡️安全 | os.RemoveAll 跟随符号链接，可删除项目外内容 | `file_ops.go:172` | 检查 symlink 或使用安全的递归删除 |
| R8-008 | **P1** | 🛡️健壮性 | ServeFileEditLine 无文件大小检查，可致 OOM | `file_ops.go:100` | 添加文件大小上限（如 10MB） |
| R8-009 | **P1** | 🛡️健壮性 | 非原子文件写入，crash 时可能丢失数据 | `file_ops.go:119,234` | 写入临时文件后 `os.Rename` |
| R8-010 | **P1** | ✨质量 | 重复扩展名列表（stores/app.ts vs fileType.ts vs model/file.go） | `stores/app.ts:205-254` | 前端统一到 fileType.ts，后端考虑 API 返回 |
| R8-011 | **P1** | 🛡️安全 | 上传文件名清理不完整（缺 / \ 空字节 长度限制） | `upload.go:76-80` | 完整 sanitize：移除路径分隔符、空字节、限制长度 |
| R8-012 | **P2** | 🛡️泄漏 | scrollPositions Map 无界增长 | `FileViewer.vue:161` | 添加 LRU 或上限（最近 100 个文件） |
| R8-013 | **P2** | 🛡️安全 | ListFiles filepath.Walk 可能暴露 symlink 存在 | `file.go:109` | 标记 symlink 或过滤 |
| R8-014 | **P2** | ✨质量 | IsTextFile 每次调用分配 slice | `model/file.go:13-57` | 包级别 var 预分配或使用 map |
| R8-015 | **P2** | ✨质量 | copyFile 不保留源文件权限 | `file_ops.go:389` | `os.Chmod` 保留权限 |
| R8-016 | **P2** | ✨质量 | fixLocalImagePaths 正则匹配 HTML 脆弱 | `MarkdownPreview.vue:79` | 改用 DOM 解析 |
| R8-017 | **P2** | ✨质量 | useFileUpload 顺序上传效率低 | `useFileUpload.ts:103-109` | 限制并发数的并发上传 |

---

## 改进建议 (Top 3)

1. **修复路径安全核心 (R8-001+R8-002+R8-003)**：
   - (a) MarkdownPreview 启用 DOMPurify（`sanitize: true`），阻止 .md 文件中的 XSS；
   - (b) `ValidatePath` 在做前缀检查前调用 `filepath.EvalSymlinks` 解析所有符号链接，确保 resolved path 在项目根内；
   - (c) `file_ops.go` 的 Rename/Delete 删除 `BasePath` 参数，强制使用 `requireProject` 从 cookie 获取 projectPath。
   - 预期收益：消除 XSS、路径穿越和任意文件操作三个最严重的安全风险。

2. **上传安全加固 (R8-004+R8-006+R8-011)**：
   - (a) 扩展名黑名单添加 `.html`/`.htm`/`.svg`/`.xhtml`，或改用白名单（只允许已知的安全类型）；
   - (b) 使用 `os.OpenFile(dstPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)` 原子创建，避免 TOCTOU 竞态；
   - (c) 完整 sanitize 文件名：移除 `/`、`\`、空字节、`..` 组件，限制长度 ≤ 255。
   - 预期收益：消除存储型 XSS 和文件上传攻击面。

3. **大文件和原子性 (R8-005+R8-008+R8-009)**：
   - (a) `GetFile` 考虑降低限制到 2MB 或改用流式 JSON 编码（`json.Encoder` + 分块读取）；
   - (b) `ServeFileEditLine` 添加文件大小上限（如 10MB），与 `GetFile` 保持一致；
   - (c) `ServeFileEditLine` 和 `ServeFileCreate` 使用临时文件+rename 的原子写入模式。
   - 预期收益：防止大文件 OOM，防止写入中断导致数据丢失。

---

## 亮点

- **validateAndResolvePath 路径安全基石**：在所有接受用户路径的 handler 中统一调用，单一安全检查点
- **loadFilesSeq 并发控制**：使用单调递增计数器丢弃过期并发请求结果，避免竞态
- **fileInfoWithTimeout 防挂起**：3s 超时避免 NFS 硬挂导致目录列表请求阻塞
- **fileType.ts 全面类型检测**：50+ 种扩展名，统一接口，color/label/lang 分类完整
- **FileManager 触摸友好设计**：长按上下文菜单、empty area 触摸、clipboard 操作
- **上传双限制**：`MaxBytesReader` + `maxUploadSize()` + 前端 `uploadMaxFiles`/`uploadMaxSizeMB` 配置
- **FileViewer 滚动恢复**：per-file scroll position cache + 轮询等待内容就绪
