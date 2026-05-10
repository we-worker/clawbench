# R9: Git 历史流程 Review

> 日期: 2026-05-10
> 审查范围: Git命令 → Diff解析 → 图渲染 → UI交互

## 审查范围

### 后端
- `internal/handler/git.go` (516行) — Git HTTP API处理器，包含7个endpoint：project-history, init, file-diff, commit-files, history, diff, status, working-tree。含parseGitLog/parseDecorateRefs/parseGitStatusPorcelain解析器和gitDiff差异获取逻辑。
- `internal/handler/handler.go` (232行) — 共享基础设施：路由注册、validateAndResolvePath路径校验、requireProject/requirMethod守卫。
- `internal/model/path.go` (23行) — ValidatePath路径遍历防护。

### 前端
- `web/src/components/git/GitHistoryDrawer.vue` (630行) — 主容器，双模式（project/file），三层下钻（commits→files→diff），状态管理，数据加载。
- `web/src/components/git/GitGraph.vue` (326行) — SVG图形渲染组件，tooltip交互，persistedShaToLane稳定性优化。
- `web/src/components/git/GitDiffView.vue` (163行) — Diff渲染容器，v-html展示，scoped深度样式。
- `web/src/components/git/GitCommitList.vue` (458行) — 提交列表，虚拟图+信息双栏，IntersectionObserver懒加载，搜索过滤，手势切换图。
- `web/src/components/git/GitCommitMeta.vue` (116行) — 提交元信息面板，SHA复制。
- `web/src/components/git/GitBreadcrumb.vue` (134行) — 面包屑导航，支持project/file两种下钻路径。

### 工具
- `web/src/utils/gitGraph.ts` (609行) — 图形算法核心：两阶段（车道分配+连线生成），级联渲染，车道压缩，SHA→分支名映射。
- `web/src/utils/diff.ts` (127行) — Diff解析与渲染：hunk解析，行号追踪，语法高亮，HTML生成。

## 三维度评估

### 🏗️ 架构设计 (30%)

**整体分层清晰，职责边界合理。** 后端git.go承担了命令执行+输出解析双重职责，7个endpoint均遵循"校验→执行→响应"的三段式结构。前端三层组件（Drawer→CommitList→DiffView/Breadcrumb/Meta）形成了清晰的下钻流水线。

**优点：**
- 双模式（project/file）共享Drawer但走不同数据流，代码复用率高
- gitGraph.ts将纯计算与Vue组件解耦，computeGraphData是无副作用的纯函数，可独立测试
- 持久化lane分配（persistedShaToLane）解决懒加载时视觉跳变的架构决策正确

**问题：**
1. **后端git.go职责过重**：516行文件包含7个handler + 3个解析器 + 1个helper（gitDiff）。parseGitLog/parseDecorateRefs/parseGitStatusPorcelain应抽离到独立包（如`internal/git/parser.go`），handler只做HTTP层编排。这使得git.go难以单元测试解析逻辑而不启动HTTP服务器。
2. **前端数据加载散落在Drawer中**：`loadProjectHistory`、`loadFileHistory`、`loadMoreCommits`、`loadCommitFiles`、`loadDiff`全部在GitHistoryDrawer.vue中，该文件已达630行。考虑抽出`useGitHistory` composable。
3. **gitDiff函数合并staged+unstaged的方式粗糙**：直接`append(cached, '\n', unstaged)`可能产生无效的diff格式（两个独立的diff输出用换行拼接），前端diff.ts解析器不会出错但语义上两个diff可能属于同一文件不同段落，显示时缺少分隔。
4. **SHA参数未校验格式**：ServeGitCommitFiles和ServeGitFileDiff接受`sha`查询参数直接传入`exec.Command`，虽然Go的exec.Command不会shell展开，但恶意SHA值（如包含空格或特殊字符）可能被git命令误解。当前仅检查非空，缺少格式校验。
5. **前后端状态同步脆弱**：`hasMore`的判断依赖`len(commits) == 30`这个硬编码常量与后端`-30`参数一致。如果任何一端改了分页大小而另一端未同步，分页将失效。

### ✨ 代码质量 (30%)

**优点：**
- gitGraph.ts算法注释详尽，两阶段+四步流程文档清晰
- `renderCascade`函数抽象了跨多lane的级联渲染，消除了重复代码
- parseGitLog使用`SplitN(line, "|", 5)`正确处理commit message中的管道符
- diff.ts的`escapeHtml`用于非代码内容，`highlightLine`用于代码内容，XSS防护分层合理
- parseGitStatusPorcelain正确处理了XY双状态、rename箭头、引用路径等边界

**问题：**
1. **硬编码魔法数字**：git.go中`-30`分页大小硬编码；gitGraph.ts中`LANE_WIDTH=20`、`rowHeight=46`、节点半径`16/7/6/3.5/4`等；GitCommitList.vue中`SWIPE_THRESHOLD=50`；这些缺少集中管理。
2. **错误处理不一致**：
   - `ServeGitProjectHistory`中`output, _ := cmd.CombinedOutput()`忽略错误（:142）
   - `ServeGitHistory`中`output, _ := cmd.CombinedOutput()`忽略错误（:350）
   - `ServeGitWorkingTreeFiles`中`output, _ := cmd.CombinedOutput()`忽略错误（:507）
   - 而其他handler如ServeGitFileDiff通过gitDiff→writeDiffResponse链处理错误
   - 这种不一致导致部分endpoint在git命令失败时静默返回空数据
3. **重复的drilldown样式**：GitHistoryDrawer.vue和GitCommitList.vue都定义了`.drilldown-page`、`.drilldown-header`、`.drilldown-item`等相同样式，违反DRY原则。
4. **type annotation缺失**：gitGraph.ts是纯JS文件，computeGraphData的commits参数和返回值无类型约束。在TypeScript项目中，这降低了IDE支持和重构安全性。
5. **formatDate函数重复**：GitCommitMeta.vue和GitCommitList.vue各自实现了formatDate，逻辑不同（一个用toLocaleString，一个用formatRelativeTime），应统一。

### 🛡️ 健壮性 (40%)

**这是本次审查的重点关注维度。**

#### 安全性

1. **P0 - SHA参数注入风险**（R9-001）：`ServeGitCommitFiles`和`ServeGitFileDiff`接受用户提供的`sha`查询参数，直接传入`exec.Command("git", "diff-tree", ..., sha)`和`exec.Command("git", "show", commit, "--", relPath)`。虽然Go的exec.Command不做shell展开，不构成经典命令注入，但恶意SHA值（如`HEAD~1`、`--all`、空格分隔的多个参数）可能被git误解。例如`sha=HEAD~1 --hard`可能被git解析为多个参数。**建议：添加SHA格式正则校验`^[0-9a-f]{4,40}$`或`^[0-9a-zA-Z._~/-]+$`**。

2. **P1 - skip参数整数溢出**（R9-002）：`ServeGitProjectHistory`中`fmt.Sscanf(s, "%d", &skip)`无上限校验。攻击者传入极大值（如`skip=999999999`）可导致git log执行超慢查询。**建议：添加skip上限校验**。

3. **P2 - diff输出中的XSS**（R9-003）：`renderDiff`函数对diff内容使用`highlightLine`（经过hljs处理），对hunk header使用`escapeHtml`，对fallback raw使用`escapeHtml`。GitDiffView.vue通过`v-html="html"`渲染。虽然当前路径上大部分内容经过转义，但`highlightLine`内部调用`hljs.highlight()`，其输出可能包含HTML标签。如果hljs版本有漏洞或语言定义被篡改，存在XSS风险。此外，`diff-content`使用`white-space: pre`但不设置`word-break`，超长无空格字符串可能撑破布局。

4. **路径遍历防护完善**：`validateAndResolvePath`使用`filepath.Abs`+`strings.HasPrefix`防护路径遍历，所有涉及relPath的endpoint（history, diff, file-diff, status, working-tree）均调用此函数。测试`TestServeGitHistory_PathTraversal`验证了`../../../etc/passwd`被拒绝。防护有效。

#### 性能

5. **P1 - 大仓库搜索全量加载**（R9-004）：`onSearch`函数在搜索时通过while循环加载全部历史记录（:338-353）。对于有数万次提交的仓库，这会发出数百次HTTP请求并占用大量内存。**建议：后端实现git log --grep服务端搜索**。

6. **P1 - gitDiff无输出大小限制**（R9-005）：`gitDiff`和`writeDiffResponse`没有对diff输出大小做限制。对于大型二进制文件或巨幅变更，git show可能输出MB级diff，导致内存峰值和传输延迟。**建议：添加`--stat`预检或输出大小限制**。

7. **P2 - computeGraphData全量计算**（R9-006）：每次commits列表变化都重新计算全部节点和连线。对于懒加载追加场景，虽然有persistedShaToLane优化lane分配，但连线生成仍需遍历全部commits。当commits达到数百条时，计算开销不可忽视。**建议：增量计算或Web Worker**。

8. **P2 - parseGitStatusPorcelain未处理copy状态**（R9-007）：git status porcelain的C（copied）状态未被处理，会被归入default case。虽然copy在git中较少见，但在大仓库中可能出现。

#### 竞态条件

9. **P1 - fetch竞态**（R9-008）：`loadProjectHistory`连续发起两个fetch请求（`/api/git/project-history`和`/api/git/working-tree`），如果第一个成功但第二个失败，`loadedWtFiles`为空数组，导致working tree entry不被添加，但commits已加载。更严重的是，如果用户快速切换文件/项目，旧请求的响应可能覆盖新请求的状态。**建议：添加AbortController取消机制**。

10. **P2 - loadMoreCommits无防重复**（R9-009）：虽然`loadingMore`守卫存在，但IntersectionObserver可能在loadingMore设为true之前多次触发。当前IntersectionObserver的threshold: 0.1 + rootMargin: 100px可能在快速滚动时重复emit。实际影响有限因为HTTP请求会排队完成。

#### 边界条件

11. **P1 - 空仓库/初始提交无parent**（R9-010）：parseGitLog对`parts[1]`（parents字段）处理正确，空字符串→空数组。但gitGraph.ts的computeGraphData在Step A中walk first-parent chain时，对`parents.length === 0`正确break。然而，如果后端返回的commits中某个commit的parents为`undefined`而非空数组（如后端marshalJSON时nil slice→null），`c.parents || []`在ts中能兜底，但`shaToLane`中的`parents[0]`可能访问undefined数组的第一个元素。**建议：后端确保空数组序列化为[]而非null**。

12. **P1 - merge commit在file history中重复文件**（R9-011）：`ServeGitCommitFiles`使用`git diff-tree -m`，对merge commit会分别显示每个parent的diff。如果一个文件在两个parent中都修改了，它会出现在结果中两次（一次对parent1，一次对parent2），path相同但type可能不同。前端`:key="f.path + '-' + f.type"`可能冲突。

13. **P2 - tooltip定位在滚动后偏移**（R9-012）：GitGraph.vue的tooltip使用`event.clientX/Y`定位，这是视口坐标。但如果页面在tooltip显示后滚动（例如在移动端触摸滚动），tooltip不会跟随移动。`@scroll="dismissTooltip"`仅在git-graph-scroll元素上监听，外部滚动不会触发dismiss。

14. **P2 - 日期解析失败静默**（R9-013）：GitCommitMeta.vue的formatDate使用`new Date(dateStr)`，如果dateStr格式不合法（如空字符串已排除但非ISO格式如"2 hours ago"），`toLocaleString`可能返回"Invalid Date"。GitCommitList.vue的formatDate有7天阈值判断，同样依赖Date构造。

15. **P3 - GitBreadcrumb中canNavigateCommit逻辑冗余**（R9-014）：`canNavigateCommit` computed在两种模式下返回相同值（都是`currentView === 'diff'`），if/else分支可简化。

16. **P3 - working tree diff合并格式问题**（R9-015）：`gitDiff`函数在HEAD模式下将staged和unstaged diff用`\n`拼接。两个独立的unified diff输出拼接后，`diff --git a/...`行会连续出现两次，前端diff.ts的`renderDiff`会将第二个`diff`行作为meta line跳过，但`---`/`+++`行如果出现在hunk中间（不会，因为先关闭currentHunk再开始新hunk）则没问题。实际风险是如果staged diff末尾恰好在hunk中间被截断（不会发生，因为CombinedOutput返回完整输出）。低风险但合并方式不够健壮。

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R9-001 | P0 | 健壮性 | SHA参数未校验格式，恶意值可能被git命令误解 | git.go:244,273-281,212 | 添加正则校验`^[0-9a-f]{4,40}$`或白名单字符集 |
| R9-002 | P1 | 健壮性 | skip参数无上限校验，可导致慢查询DoS | git.go:127-130 | 添加skip上限（如max=10000） |
| R9-003 | P2 | 健壮性 | v-html渲染diff经hljs输出，存在XSS间接风险 | GitDiffView.vue:6, diff.ts:120 | 添加CSP或DOMPurify后处理；对超长内容截断 |
| R9-004 | P1 | 健壮性 | 搜索时全量加载所有commits，大仓库性能灾难 | GitHistoryDrawer.vue:338-353 | 后端实现`git log --grep`搜索API |
| R9-005 | P1 | 健壮性 | gitDiff无输出大小限制，巨幅diff可导致OOM | git.go:183-215 | 添加`--stat`预检或io.LimitReader |
| R9-006 | P2 | 健壮性 | computeGraphData全量重算，大数据集性能差 | gitGraph.ts:103-589 | 增量计算或Web Worker offload |
| R9-007 | P2 | 质量 | parseGitStatusPorcelain未处理copy(C)状态 | git.go:428-466 | 添加C状态处理 |
| R9-008 | P1 | 健壮性 | fetch竞态：快速切换时旧请求覆盖新状态 | GitHistoryDrawer.vue:247-284 | 添加AbortController |
| R9-009 | P2 | 健壮性 | IntersectionObserver可能重复触发load-more | GitCommitList.vue:179-183 | 添加debounce或标志位检查 |
| R9-010 | P1 | 健壮性 | 后端nil parents slice→JSON null，前端或出异常 | git.go:38-41 | `Parents: parents` → `Parents: parents`后确保非nil |
| R9-011 | P1 | 健壮性 | merge commit diff-tree -m产生重复文件条目 | git.go:281-308 | 去重或使用`--cc`合并diff |
| R9-012 | P2 | 健壮性 | tooltip在页面滚动时不跟随/不消失 | GitGraph.vue:2,145 | 在document/parent上监听scroll事件dismiss |
| R9-013 | P2 | 健壮性 | 非ISO日期格式导致Invalid Date显示 | GitCommitMeta.vue:51-58 | 添加fallback格式解析 |
| R9-014 | P3 | 质量 | canNavigateCommit逻辑冗余，两分支返回相同值 | GitBreadcrumb.vue:58-61 | 简化为`props.currentView === 'diff'` |
| R9-015 | P3 | 健壮性 | staged+unstaged diff用换行拼接，格式不够健壮 | git.go:196-204 | 使用`git diff HEAD`一步获取完整差异 |
| R9-016 | P2 | 架构 | git.go职责过重，516行含7个handler+3个解析器 | git.go | 解析器抽离到`internal/git/parser.go` |
| R9-017 | P2 | 架构 | GitHistoryDrawer.vue 630行，数据加载逻辑应抽出 | GitHistoryDrawer.vue | 抽出`useGitHistory` composable |
| R9-018 | P2 | 质量 | 硬编码分页大小30，前后端需同步 | git.go:136,149 | 提取为常量或配置项 |
| R9-019 | P3 | 质量 | drilldown重复样式在Drawer和CommitList中 | GitHistoryDrawer.vue, GitCommitList.vue | 提取shared CSS |
| R9-020 | P3 | 质量 | formatDate函数在Meta和List中实现不同 | GitCommitMeta.vue:51, GitCommitList.vue:159 | 统一为共享util |
| R9-021 | P2 | 质量 | gitGraph.ts为纯JS无类型约束 | gitGraph.ts | 迁移为TypeScript，定义Commit/Node/Line接口 |
| R9-022 | P1 | 健壮性 | git命令执行错误被静默忽略，返回空数据 | git.go:142,350,507 | 区分"空结果"和"命令失败"，后者返回500 |
| R9-023 | P3 | 健壮性 | GitCommitList触摸手势可能与列表滚动冲突 | GitCommitList.vue:130-149 | 添加垂直滚动检测，取消水平手势 |

## 改进建议 (Top 3)

1. **SHA参数校验 + 输出大小限制**：这是最紧迫的安全/健壮性改进。在后端添加SHA格式白名单正则（`^[0-9a-f]{4,40}$`），对skip参数添加上限（10000），对git命令输出添加大小限制（1MB）。这三个改动可以一次性完成，防护面覆盖命令注入、DoS、OOM。预期收益：消除P0风险，封堵2个P1。

2. **搜索性能优化**：当前搜索实现全量加载所有commits到前端再过滤，对大仓库不可行。改为后端`git log --grep=<query>`搜索API，前端只传递搜索词。这同时解决了R9-004的内存问题和R9-006的computeGraphData性能问题（搜索结果数量可控）。预期收益：搜索可用性从"小仓库专用"提升到"任意仓库可用"。

3. **fetch竞态防护**：添加AbortController机制，在每次新请求发起时取消上一次未完成的请求。具体改动：GitHistoryDrawer.vue中维护一个AbortController ref，在loadProjectHistory/loadFileHistory开头cancel旧的并创建新的，fetch传入signal。预期收益：消除快速切换时的状态不一致和内存泄漏。

## 亮点

- **车道压缩算法**（gitGraph.ts Step D）设计精巧，通过贪心区间着色让非重叠分支共享视觉轨道，在保持可读性的同时显著减少了水平空间占用。
- **持久化lane分配**（persistedShaToLane）解决了懒加载时图形跳变的常见问题，这是一个容易被忽视但严重影响用户体验的细节。
- **级联渲染**（renderCascade）对跨多lane的octopus merge提供了视觉上清晰的步进路径，避免了直接bezier穿越中间lane的混乱。
- **parseGitStatusPorcelain**的XY双状态解析很完整，正确处理了rename箭头提取、staged+unstaged双条目生成等边界。
- **路径遍历防护**一致性好：所有涉及relPath的endpoint均调用validateAndResolvePath，测试覆盖了`../../../etc/passwd`场景。
- **双模式架构**（project/file）复用率高，同一套Drawer/CommitList/DiffView组件服务两种场景，通过mode prop切换数据流。
