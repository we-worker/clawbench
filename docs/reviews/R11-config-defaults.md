# R11: 配置/默认值流程 Review

> 日期: 2026-05-09
> 审查范围: 配置加载 → ApplyDefaults → Agent注册 → 自动密码 → BinDir

## 审查范围

### 后端
- `cmd/server/main.go` (1-494) — 启动编排、密码哈希
- `internal/model/defaults.go` (1-150) — ApplyDefaults、ParsePresenceMap、自动密码
- `internal/model/config.go` (1-105) — 配置结构体
- `internal/model/agent.go` (1-117) — Agent 加载、YAML 解析
- `internal/model/path.go` (1-22) — 路径解析
- `config/agents/` — Agent YAML 定义目录
- `config/rules.md` — 全局规则注入

---

## 三维度评估

### 🏗️ 架构设计 (30%) — 评分: 8.0/10

**ParsePresenceMap 教科书级解决方案：**
- Go 的 bool 零值为 `false`，但 `proxy.enabled` 和 `ssh.enabled` 应默认为 `true`——如果直接在 struct 中设置默认值，YAML 中显式设为 `false` 时会被覆盖
- `ParsePresenceMap` 使用 `encoding/json.Decoder` 精确检测字段是否存在（`UseNumber` + 手动遍历 token），只对未出现的字段应用默认值，完美解决零值歧义
- 这是整个项目中最精巧的设计之一

**零配置理念出色：**
- `config.yaml` 完全可选，`ApplyDefaults()` 填充所有零值字段为合理默认值
- 配置搜索优先级：`BinDir/config` > `CWD/config` > legacy，保证便携部署
- `BinDir` 基于 `os.Executable()` 解析，确保二进制文件所在目录为根

**绿色便携布局：**
- 所有运行时数据（SQLite DB、日志、上传、SSH host key、TTS 模型、自动密码）集中在 `.clawbench/` 目录
- 删除 `.clawbench/` = 完全卸载，无系统级残留

**关注点：**
- 全局变量分散：`model.Agents`、`model.SessionToken`、`service.DB`、`service.GlobalScheduler` 等分布在多个包中，无统一生命周期管理
- `main()` 432 行过长，混合了配置加载、服务初始化、路由注册、信号处理
- Agent YAML 支持热插拔（`config/agents/` 目录），但无显式的 reload API 或文件变更监听

### ✨ 代码质量 (30%) — 评分: 7.3/10

**亮点：**
- TTS 初始化的 switch-case 覆盖 6 个引擎（minimax/edge/piper/kokoro/moss-nano/ollama），默认值合理
- Agent YAML 热插拔：`config/agents/` 目录下的文件自动加载，无需重启
- `BuildCommonPrompt` 的 `{{AVAILABLE_AGENTS}}`/`{{PORT}}`/`{{PROJECT_PATH}}` 占位符动态替换设计灵活

**关注点：**
- Agent 加载静默吞掉错误：`agent.go:64-69` `filepath.Walk` 中 `os.ReadDir` 或 `yaml.Unmarshal` 失败时仅 `log.Printf` 继续，可能导致部分 agent 缺失但用户不知情
- `rand.Read` 返回值未检查：`defaults.go:67` `rand.Read(uuid)` 忽略了 `(n, err)` 返回值
- `BinDir` 从 `os.Args[0]` 解析可能解析符号链接而非实际路径

### 🛡️ 健壮性 (40%) — 评分: 6.5/10

**P1 级问题：**

1. **硬编码盐值 + SHA-256 弱哈希**（与 R10-001 同源）：`main.go:398` 使用 `sha256.Sum256([]byte(password + "clawbench-salt"))`
2. **自动密码明文输出到 stdout**（与 R10-003 同源）：`main.go:394` `fmt.Printf` 打印密码

**P2 级问题：**

3. **auto-password 文件写入无错误处理 + 竞态**：`defaults.go:70-71` `os.WriteFile` 返回值未检查；首次启动时多个进程可能同时检测到文件不存在并写入
4. **auto-password 文件内容未验证**：`defaults.go:61-63` 读取已有 auto-password 文件时不验证内容格式，空文件或损坏文件会导致空密码
5. **Agent system_prompt 未做 sanitize**：`agent.go:76-80` YAML 中的 `system_prompt` 直接注入到 AI 请求，未检查长度限制或恶意内容
6. **BinDir 从 os.Args[0] 解析可能解析符号链接**：`main.go:81` `filepath.Dir(os.Args[0])` 不解析符号链接，可能导致配置搜索路径不正确
7. **Agent 加载静默吞掉错误**：`agent.go:64-69` 读取/解析失败时仅 log 继续
8. **rand.Read 返回值未检查**：`defaults.go:67` 忽略错误返回

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R11-001 | **P1** | 🛡️ 安全 | 硬编码盐值 + SHA-256 弱哈希（与 R10-001 同源） | `main.go:398` | 替换为 bcrypt |
| R11-002 | **P1** | 🛡️ 安全 | 自动密码明文输出到 stdout（与 R10-003 同源） | `main.go:394` | 改为写入 stderr 或仅写入文件 |
| R11-003 | **P2** | 🛡️ 健壮性 | auto-password 文件写入无错误处理 + 多进程竞态 | `defaults.go:70-71` | 检查 WriteFile 错误；使用 `O_EXCL` 原子创建 |
| R11-004 | **P2** | 🛡️ 健壮性 | auto-password 文件内容未验证，空/损坏文件导致空密码 | `defaults.go:61-63` | 验证读取内容非空且为合法 UUID 格式 |
| R11-005 | **P2** | 🛡️ 安全 | Agent system_prompt 未做长度限制和内容检查 | `agent.go:76-80` | 添加最大长度限制（如 100KB），检测恶意注入模式 |
| R11-006 | **P2** | 🛡️ 健壮性 | BinDir 从 os.Args[0] 解析可能不解析符号链接 | `main.go:81` | 使用 `os.Executable()` + `filepath.EvalSymlinks` |
| R11-007 | **P2** | 🛡️ 健壮性 | Agent 加载静默吞掉错误，用户可能不知部分 agent 缺失 | `agent.go:64-69` | 加载失败时 log + 在 `/api/agents` 响应中标记 |
| R11-008 | **P2** | 🛡️ 健壮性 | `rand.Read` 返回值未检查，极端情况下 UUID 可能为全零 | `defaults.go:67` | 检查 `n == 16 && err == nil` |
| R11-009 | **P3** | ✨ 质量 | Bool 默认值无编译时保证，新增字段可能忘记加入 ParsePresenceMap | `defaults.go:117-131` | 添加单元测试覆盖所有 bool 字段 |
| R11-010 | **P3** | ✨ 质量 | `UserHomeDir` fallback 可能返回空字符串 | `path.go:17-29` | 空字符串时 fallback 到 `/tmp` 或报错 |

---

## 改进建议 (Top 3)

1. **密码哈希迁移到 bcrypt (R11-001)**: 与 R10-001 同源问题。`main.go:398` 使用 `sha256.Sum256([]byte(password + "clawbench-salt"))`，SHA-256 + 硬编码盐值可被 GPU 快速暴力破解。建议替换为 `bcrypt.GenerateFromPassword`，cost ≥ 12。需设计迁移策略：兼容期同时支持旧 SHA-256 验证，验证成功后自动 rehash。预期收益：消除密码破解风险。

2. **auto-password 写入安全加固 (R11-003+R11-004)**: 当前 `os.WriteFile` 返回值未检查，多进程竞态可能同时写入；读取时不验证内容格式。建议：(1) 使用 `os.OpenFile` + `O_WRONLY|O_CREATE|O_EXCL` 原子创建，避免竞态；(2) 读取已有文件后验证内容为合法 UUID 格式（正则 `^[0-9a-f-]{36}$`），不合法则重新生成。预期收益：消除文件竞态和空密码风险。

3. **Agent 加载添加日志 + Prompt 限制 (R11-005+R11-007)**: 当前 agent 加载失败静默吞掉错误，用户可能不知部分 agent 缺失；system_prompt 无长度限制。建议：(1) 加载失败时 log.Warning 并在 `/api/agents` 响应中标记失败 agent；(2) 对 system_prompt 添加最大长度限制（100KB），超长时截断并 warning。预期收益：提升可观测性，防止恶意超长 prompt。

---

## 亮点

- **ParsePresenceMap** — 教科书级解决 Go bool 零值陷阱，精确检测字段是否存在而非检测零值
- **零配置理念** — `config.yaml` 完全可选，`ApplyDefaults()` 覆盖所有字段，零配置即可安全运行
- **绿色便携布局** — `BinDir` 相对路径 + `.clawbench/` 数据目录，删除即卸载
- **配置搜索优先级** — `BinDir/config` > `CWD/config` > legacy，保证便携部署优先
- **Agent YAML 热插拔** — `config/agents/` 目录自动加载，无需重启
