# R11: 配置/默认值流程 Review

> 日期: 2026-05-24
> 审查范围: config.yaml → ApplyDefaults → 零配置启动

## 审查范围

### 启动
- `cmd/server/main.go` (1-494) — 启动编排

### 模型
- `internal/model/config.go` (1-105) — 配置结构体 + 全局变量
- `internal/model/defaults.go` (1-152) — ParsePresenceMap + ApplyDefaults
- `internal/model/agent.go` (1-117) — Agent YAML 加载 + prompt 组装

### 平台
- `internal/platform/path.go` (1-97) — 跨平台路径工具

---

## 三维度评估

### 🏗️ 架构设计 (30%) — 评分: 8.0/10

**ParsePresenceMap 是教科书级解决方案：** Go 的 bool 零值是 `false`，但 `proxy.enabled` 和 `ssh.enabled` 的语义默认值是 `true`。通过先解析为 `map[string]any` 再检测 key 是否存在，干净地绕过了这个陷阱。

**零配置理念出色：** `config.yaml` 完全可选，`ApplyDefaults` 全覆盖所有字段，二进制即用。

**绿色便携布局：** BinDir 相对路径 + `.clawbench/` 数据目录，卸载即删。

**关注点：**
- 全局变量散落（`config.go:83-104` 有 14 个包级全局变量），由 main.go 逐行赋值，易遗漏
- `main()` 函数 432 行过长，应拆分为子函数
- 配置不支持热更新

### ✨ 代码质量 (30%) — 评分: 7.5/10

**亮点：**
- TTS 初始化的 switch-case 覆盖 6 种引擎 + default fallback，每个分支有 slog.Info
- Agent 加载支持 `config/agents/` 目录下的多 YAML 文件
- `{{AVAILABLE_AGENTS}}` 模板替换机制让 agent 间互相感知

**关注点：**
- Agent 加载静默吞错（`agent.go:64-69`），错误 YAML 文件被完全忽略无日志
- TLS cert/key 环境变量覆盖逻辑不对称
- `rand.Read` 返回值未检查（`defaults.go:67`）

### 🛡️ 健壮性 (40%) — 评分: 7.0/10

**P1 级问题：**

1. **硬编码盐值**：`sha256.Sum256([]byte(cfg.Password + "clawbench-salt"))` — 与 R10-001 同源
2. **自动密码明文输出到 stdout**：与 R10-006 同源

**P2 级问题：**

3. **auto-password 文件竞态**：`os.MkdirAll` + `os.WriteFile` 非原子，多实例启动竞态
4. **auto-password 文件内容未校验**：直接 `string(saved)` 赋值，可能包含换行或特殊字符
5. **Agent system_prompt 无 sanitize**：YAML 中的 prompt 直接拼接，无长度限制
6. **BinDir 取自 os.Args[0]**：symlink 启动时可能解析错误

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R11-001 | **P1** | 🛡️ 安全 | 硬编码盐值 + SHA-256 弱哈希 | `main.go:383` | 使用 bcrypt（与 R10-001 同源） |
| R11-002 | **P1** | 🛡️ 安全 | 自动密码明文输出到 stdout | `main.go:379` | 仅 `--fg` 模式输出或脱敏（与 R10-006 同源） |
| R11-003 | **P2** | 🛡️ 健壮性 | auto-password 文件写入无错误处理 + 竞态 | `defaults.go:70-71` | 检查 error，使用 0700 权限 |
| R11-004 | **P2** | 🛡️ 安全 | auto-password 文件内容未校验 | `defaults.go:61-63` | 校验格式一致性 |
| R11-005 | **P2** | 🛡️ 安全 | Agent system_prompt 无 sanitize | `agent.go:76-80` | 添加长度限制和危险内容检测 |
| R11-006 | **P2** | 🛡️ 健壮性 | BinDir 取自 os.Args[0] 可能解析 symlink | `main.go:81` | 使用 `filepath.EvalSymlinks` |
| R11-007 | **P3** | 🏗️ 架构 | Bool 默认值无编译时保障 | `defaults.go:117-131` | 定义 boolDefaults map 或 struct tag |
| R11-008 | **P3** | ✨ 质量 | Agent 加载静默吞错 | `agent.go:64-69` | 添加 slog.Warn |
| R11-009 | **P3** | 🛡️ 健壮性 | UserHomeDir fallback 可能返回空字符串 | `path.go:17-29` | 添加空字符串检查 |

---

## 改进建议 (Top 3)

1. **密码哈希迁移到 bcrypt (R11-001)**: 这是最直接的安全收益。bcrypt 自带盐、可调 cost。预期收益：消除密码破解风险。

2. **auto-password 写入安全 (R11-003+R11-004)**: 检查 `os.WriteFile` error；目录权限改为 0700；校验文件内容格式。预期收益：消除密码文件竞态和内容篡改风险。

3. **Agent 加载增加日志 + prompt 限制 (R11-005+R11-008)**: 静默吞错让运维成噩梦；超长 prompt 应 warning；添加最大长度限制。预期收益：提升可调试性和安全性。

---

## 亮点

- **ParsePresenceMap**：Go bool 零值陷阱的教科书级解决方案
- **零配置理念**：config.yaml 完全可选 + ApplyDefaults 全覆盖
- **绿色便携布局**：BinDir 相对路径 + `.clawbench/` 数据目录
- **配置搜索优先级**：BinDir/config > CWD/config > legacy，向后兼容
- **Agent YAML 热插拔**：`config/agents/` 目录下多文件，新增 agent 只需加文件
