# ACP (Agent Client Protocol) 集成设计

> 调研日期：2026-05-16
> CodeBuddy 版本：v2.94.2 (`@tencent-ai/codebuddy-code`)
> 评审修订：2026-05-16（解决 4 Critical + 5 Important 评审问题）

## 一、背景

当前 ClawBench 的 AI 后端采用 CLI 子进程模式（如 `codebuddy --print --output-format stream-json`），每次对话启动新进程。现需新增 ACP 传输层，通过 Agent Client Protocol 实现流式对话，支持多会话并发、斜杠命令和 Skill 查询。

**ACP 是开放标准**，由 Zed Industries 于 2025年9月发布，定位为"AI Agent 时代的 LSP"。任何支持 ACP 的 Agent 都可以接入，不仅仅是 CodeBuddy。

**已支持 ACP 的 Agent：**
- Claude Code
- Codex
- Gemini CLI
- CodeBuddy
- Kiro CLI
- Cursor
- Qwen Code
- iFlow CLI

**架构原则：ACP 后端实现必须是通用的，CodeBuddy 只是第一个接入的 Agent。**

## 二、ACP 协议标准概述

### 2.1 协议定位

ACP（Agent Client Protocol）标准化了编辑器/客户端与 AI 编码 Agent 之间的通信：
- **类比 LSP：** 正如 LSP 让任何语言服务接入任何编辑器，ACP 让任何 Agent 接入任何客户端
- **消除集成爆炸：** N 个客户端 + M 个 Agent = N+M 套实现（而非 N×M）
- **协议格式：** JSON-RPC 2.0，支持 stdio 和 HTTP 传输
- **官网：** https://agentclientprotocol.com

### 2.2 各 Agent 的 ACP 接入方式

不同 Agent 暴露 ACP 的方式不同：

| Agent | ACP 接入方式 | Daemon 模式 | 默认端口 |
|-------|-------------|-------------|---------|
| CodeBuddy | `codebuddy daemon start` → HTTP API | ✅ | 9191 |
| Claude Code | `claude acp` → stdio 子进程 | ❌（每次 spawn） | N/A |
| Codex | `codex acp` → stdio 子进程 | ❌ | N/A |
| Gemini CLI | `gemini acp` → stdio 子进程 | ❌ | N/A |
| Kiro CLI | `kiro-cli acp` → stdio 子进程 | ❌ | N/A |

**ClawBench 需要同时支持 HTTP 和 stdio 两种 ACP 传输：**
- **HTTP 传输（Daemon 模式）：** 适用于 CodeBuddy 等支持 daemon 的 Agent，单进程多会话
- **stdio 传输（子进程模式）：** 适用于 Claude Code、Codex 等，每次会话 spawn 子进程

### 2.3 CodeBuddy Daemon 模式

```bash
# 启动 daemon（默认端口 9191）
codebuddy daemon start

# 指定端口
codebuddy daemon start --port 9192

# 停止 daemon
codebuddy daemon stop

# 查看状态
codebuddy daemon status
```

Daemon 启动后提供 HTTP API，监听 `http://localhost:{port}`。

### 2.4 可用的传输协议（CodeBuddy 特有）

| 协议 | 端点 | 特点 |
|------|------|------|
| **Runs API** | `POST /api/v1/runs` | Gateway Protocol 格式，仅返回**完成后的**消息，不支持增量流式 |
| **ACP** | `POST /api/v1/acp` | JSON-RPC 2.0 over SSE，**完整增量流式**，支持 session 管理、斜杠命令、Skill |
| **WebUI** | `GET /` | 浏览器界面，非 API |

**结论：ACP 是唯一满足流式需求的协议。**

### 2.5 请求头要求（CodeBuddy 特有）

所有 API 请求（除 `/api/v1/health` 外）必须包含：

```
x-codebuddy-request: true
```

> ⚠️ 这是 CodeBuddy 实现的特殊要求，非 ACP 标准部分。ACPBackend 实现需支持 per-agent 自定义请求头（通过 `acp_headers` YAML 配置）。

## 三、ACP 协议详解

### 3.1 协议基础

- 传输：HTTP + SSE（Daemon 模式）或 stdio（子进程模式）
- 格式：JSON-RPC 2.0
- 请求（HTTP 模式）：`POST /api/v1/acp`
- 响应：SSE 流，每个事件格式为 `data: {json}\n\n`

### 3.2 连接生命周期

```
connect → initialize → session/new → session/prompt (流式) → session/end
                                                  ↕
                                          session/cancel (可随时取消)
```

> 注：`connect` 步骤为 HTTP 模式特有，stdio 模式直接从 `initialize` 开始。

### 3.3 Step 1: Connect（建立连接，HTTP 模式特有）

**请求：**
```
POST /api/v1/acp/connect
Headers: x-codebuddy-request: true
```

**响应（非 SSE，普通 JSON）：**
```json
{
  "connectionId": "conn-abc123",
  "sessionToken": "st-xyz789"
}
```

### 3.4 Step 2: Initialize（协议握手）

**请求：**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientInfo": {
      "name": "clawbench",
      "version": "1.0.0"
    }
  }
}
```

**SSE 响应：**
```
data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"serverInfo":{"name":"codebuddy","version":"2.94.2"}}}
```

### 3.5 Step 3: Session/New（创建会话）

**请求：**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": {
    "cwd": "/home/user/project",
    "mcpServers": []
  }
}
```

> ⚠️ **关键参数说明：**
> - `cwd`：必填，工作目录（不是 `workingDirectory`）
> - `mcpServers`：必填，MCP 服务器配置数组（即使为空也要传 `[]`）

**SSE 响应（多事件）：**

1. `session/update` — 返回 sessionId：
```
data: {"jsonrpc":"2.0","id":2,"result":{"type":"session/update","sessionId":"sess-xxx"}}
```

2. `available_commands_update` — 返回可用斜杠命令列表（71个）：
```
data: {"jsonrpc":"2.0","id":2,"result":{"type":"available_commands_update","commands":[...]}}
```

3. 后续可能有 `mcp_server_update` 等事件

> ⚠️ SSE 连接在 session/new 后保持打开，需要逐行读取，提取 sessionId 后继续。**不要** `resp.read()` 全部响应，否则会阻塞。

### 3.6 Step 4: Session/Prompt（发送提示，流式响应）

**请求：**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/prompt",
  "params": {
    "sessionId": "sess-xxx",
    "prompt": [
      {"type": "text", "text": "帮我实现这个功能"}
    ]
  }
}
```

> ⚠️ **prompt 格式：**
> - 是一个**内容部件数组**，不是嵌套的 `messages` 结构
> - 每个部件：`{type: "text", text: "..."}`
> - 不支持 `role` 字段，不需要包装在 `messages` 里

**SSE 流式事件（增量输出）：**

| 事件类型 | 说明 | 对应 StreamEvent |
|---------|------|-----------------|
| `agent_message_chunk` | AI 文本输出增量 | `content` |
| `agent_thought_chunk` | 思考过程增量 | `thinking` |
| `tool_call` | 工具调用开始 | `tool_use` |
| `tool_call_update` | 工具调用进度/完成 | `tool_result` |
| `session_end` | 会话轮次结束 | `done` |
| JSON-RPC error | 协议错误 | `error` |

**成功事件示例：**

```
data: {"jsonrpc":"2.0","id":3,"result":{"type":"agent_message_chunk","sessionId":"sess-xxx","content":"我来帮你"}}

data: {"jsonrpc":"2.0","id":3,"result":{"type":"agent_message_chunk","sessionId":"sess-xxx","content":"实现这个功能"}}

data: {"jsonrpc":"2.0","id":3,"result":{"type":"tool_call","sessionId":"sess-xxx","toolCall":{"id":"tc-1","toolName":"Read","input":{"file_path":"/path/to/file"}}}}

data: {"jsonrpc":"2.0","id":3,"result":{"type":"tool_call_update","sessionId":"sess-xxx","toolCallId":"tc-1","status":"completed","output":"file contents..."}}

data: {"jsonrpc":"2.0","id":3,"result":{"type":"session_end","sessionId":"sess-xxx","reason":"end_turn"}}
```

**错误事件示例：**

```
data: {"jsonrpc":"2.0","id":3,"error":{"code":-32600,"message":"Invalid params"}}
```

**SSE 断连（daemon 崩溃）：** 检测 SSE 流意外关闭，映射为 `StreamEvent{Type: "error", Reason: "acp_stream_disconnected"}`。

**ACP 错误码映射：**

| JSON-RPC 错误码 | 含义 | StreamEvent.Reason |
|-----------------|------|-------------------|
| -32700 | Parse error | `acp_parse_error` |
| -32600 | Invalid Request | `acp_invalid_request` |
| -32601 | Method not found | `acp_method_not_found` |
| -32602 | Invalid params | `acp_invalid_params` |
| -32603 | Internal error | `acp_internal_error` |

### 3.7 Step 5: Session/Cancel（取消）

**请求（通知，无 id）：**
```json
{
  "jsonrpc": "2.0",
  "method": "session/cancel",
  "params": {
    "sessionId": "sess-xxx"
  }
}
```

### 3.8 Session/Resume（恢复会话）

**请求：**
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "session/resume",
  "params": {
    "sessionId": "sess-xxx"
  }
}
```

- 恢复运行时会话（进程仍存活），**不回放历史**
- 适用于：网络断线重连、AutoResume（ExitPlanMode 后继续）

**架构决策：优先使用 `session/resume`，不使用 `session/load`。**

理由：
- `session/load` 会回放历史消息并持续打开 SSE，存在挂起风险
- ClawBench 已有完整的历史消息存储和前端渲染，不需要 ACP 侧回放
- ClawBench 会话恢复场景（`Resume: true`）映射为 `session/resume`
- `session/load` 仅在极少数需要 ACP 侧上下文的场景考虑

### 3.9 Session/Load（加载历史会话）

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "session/load",
  "params": {
    "sessionId": "sess-xxx"
  }
}
```

- 加载历史会话**并回放历史消息**
- ⚠️ **已知问题：** `session/load` 的 SSE 连接会持续打开等待回放完成，存在挂起风险
- **当前不使用**，未来如有需要再评估

### 3.10 其他 ACP 方法

| 方法 | 说明 |
|------|------|
| `session/set_model` | 切换模型 |
| `session/set_mode` | 切换模式 |
| `session/set_config_option` | 设置配置项（可能用于 systemPrompt） |
| `notifications/list` | 列出通知 |

## 四、斜杠命令与 Skill 查询

### 4.1 斜杠命令列表

**来源：** `session/new` 时的 `available_commands_update` SSE 事件

**格式：**
```json
{
  "type": "available_commands_update",
  "commands": [
    {
      "name": "/commit",
      "description": "Create a git commit",
      "metadata": {}
    },
    {
      "name": "/brainstorming",
      "description": "You MUST use this before any creative work...",
      "metadata": {"source": "skill", "skillName": "brainstorming"}
    },
    {
      "name": "/systematic-debugging",
      "description": "Use when encountering any bug...",
      "metadata": {"source": "plugin", "pluginName": "superpowers"}
    }
  ]
}
```

**已验证的 CodeBuddy 71 个命令分类：**
- 内置命令：`/commit`, `/clear`, `/compact`, `/cost`, `/review`, `/skills`, `/help` 等
- 插件命令：`/superpowers:brainstorm`, `/superpowers:systematic-debugging` 等
- Skill 命令：`/brainstorming`, `/test-driven-development`, `/systematic-debugging` 等

**使用方式：** 在 prompt 中直接发送斜杠命令文本即可，如 `{type: "text", text: "/commit"}`

### 4.2 Skill/Plugin 列表

**API（CodeBuddy）：** `GET /api/v1/plugins`

**请求头：** `x-codebuddy-request: true`

**响应格式：**
```json
{
  "plugins": [
    {
      "id": "plugin-id",
      "name": "Plugin Name",
      "skills": [
        {
          "name": "skill-name",
          "description": "Skill description",
          "triggers": ["trigger phrase 1", "trigger phrase 2"]
        }
      ],
      "commands": [
        {
          "name": "/command-name",
          "description": "Command description"
        }
      ]
    }
  ]
}
```

> ⚠️ `/api/v1/plugins` 是 CodeBuddy 特有 API，非 ACP 标准。其他 Agent 可能通过不同方式暴露 Skill 列表。

### 4.3 MCP 服务器列表

**CLI 命令：** `codebuddy mcp list`

**ACP 方式：** `session/new` 的 `mcpServers` 参数可配置 MCP 服务器

### 4.4 SkillProvider 策略模式

不同 Agent 暴露 Skill 列表的方式不同，需要 `SkillProvider` 接口抽象：

```go
// SkillProvider 抽象不同 Agent 的 Skill 查询方式
type SkillProvider interface {
    // FetchSkills 获取可用 Skill 列表
    FetchSkills(ctx context.Context) ([]SkillItem, error)
    // FetchCommands 获取可用命令列表
    FetchCommands(ctx context.Context) ([]CommandItem, error)
    // FetchMcpServers 获取可用 MCP 服务器列表
    FetchMcpServers(ctx context.Context) ([]McpServerItem, error)
}
```

**实现策略：**

| Agent 传输模式 | SkillProvider 实现 | 数据来源 |
|---------------|-------------------|---------|
| HTTP daemon（CodeBuddy） | `HTTPSkillProvider` | `GET /api/v1/plugins`（配置的 `skills_api`） |
| stdio 子进程（Claude Code 等） | `ACPSessionSkillProvider` | `available_commands_update` 事件中 `metadata.source == "skill"` 的条目 |
| CLI 模式 | `EmptySkillProvider` | 返回空列表 |

**命令列表获取统一方案：** 所有 ACP 模式（HTTP 和 stdio）都通过 `session/new` 的 `available_commands_update` 事件获取命令列表。HTTP daemon 模式下可缓存此列表避免每次 `session/new` 重复获取。

## 五、并发会话支持

已验证：单个 CodeBuddy daemon 支持多个并发 ACP 会话。

测试结果：3 个并发 Runs API 请求在 3.6s 内全部完成，各自拥有独立会话。

ACP 协议中每个 `session/new` 创建独立的 sessionId，互不干扰。

**架构启示：** HTTP 模式下一个 daemon 进程服务多个会话，stdio 模式下每个会话独立子进程。ACPBackend 需抽象两种模式。

## 六、systemPrompt 注入

ACP 协议的 `session/new` 和 `session/prompt` **没有显式的 systemPrompt 参数**。

**决策：采用 prompt 前缀注入方案。**

### 6.1 方案选择

| 方案 | 可行性 | 评估 |
|------|--------|------|
| `session/set_config_option` | ❌ 未验证 | ACP 标准未定义 systemPrompt 配置项，不同 Agent 实现差异大 |
| prompt 前缀注入 | ✅ 通用 | 作为首条 content part 的文本前缀，所有 ACP Agent 都能处理 |
| CLI `--system-prompt` 参数 | ❌ 不适用 | 仅 CLI 模式可用 |

### 6.2 注入实现

在 `session/prompt` 的 content parts 数组最前面注入 systemPrompt：

```json
{
  "method": "session/prompt",
  "params": {
    "sessionId": "sess-xxx",
    "prompt": [
      {"type": "text", "text": "[System Instructions]\n{systemPrompt 内容}\n[/System Instructions]"},
      {"type": "text", "text": "[请使用 brainstorming skill]"},
      {"type": "text", "text": "[Current file: /path/to/file]"},
      {"type": "text", "text": "用户原始输入"}
    ]
  }
}
```

**注入顺序（与 CLI 模式一致）：**
1. systemPrompt（`[System Instructions]...[/System Instructions]` 包裹）
2. Skill/MCP 提示词（`请使用 {name} skill` / `请使用 {name} MCP 服务器`）
3. 文件附件提示词（`[Current file: ...]` / `[Current directory: ...]` / `[User uploaded ...]`）
4. 用户原始输入

**与 CLI 模式的一致性：** CLI 模式通过 `--system-prompt` 参数注入，ACP 模式通过 prompt 前缀注入，效果等价。`rules.md` 模板占位符 `{{PROJECT_PATH}}`、`{{AVAILABLE_AGENTS}}`、`{{PORT}}` 的解析逻辑在 handler 层完成，与传输模式无关。

## 七、与 CLI 模式的对比

| 维度 | CLI 子进程模式 | ACP Serve 模式 |
|------|--------------|----------------|
| 启动 | 每次对话 spawn 新进程 | Daemon 常驻，session/new 即用 |
| 流式 | `stream-json` 格式 stdout | SSE 增量事件 |
| 并发 | 每进程独立 | 单 daemon 多 session |
| 会话恢复 | `--resume --session-id` | `session/resume` |
| 斜杠命令 | 用户手动输入 | `available_commands_update` 枚举 |
| Skill 查询 | 无 API | `/api/v1/plugins`（HTTP）或 `available_commands_update`（stdio） |
| systemPrompt | `--system-prompt` 参数 | prompt 前缀注入（首条 content part） |
| 文件附件 | prompt 文本前缀 | content parts 数组前缀 |
| 资源占用 | 高（每进程独立） | 低（共享 daemon 进程） |
| 延迟 | 冷启动 + CLI 初始化 | 热连接，低延迟 |
| 多 Agent | 各自独立 CLI | 同一协议，统一后端 |
| 定时任务 | ✅ 使用 | ❌ 不使用（始终 CLI） |

## 八、ClawBench 架构设计

### 8.1 核心原则

1. **ACPBackend 是通用实现**，不绑定任何特定 Agent
2. **Agent 差异通过配置抽象**（端口、请求头、Skill 查询 URL 等）
3. **HTTP 和 stdio 两种 ACP 传输都支持**
4. **Skill/Command/MCP 查询通过 SkillProvider 策略模式**适配不同 Agent
5. **定时任务始终用 CLI 模式**，不接入 ACP
6. **AutoResumeBackend 同样包裹 ACPBackend**，ExitPlanMode 在 ACP 中也以 tool_call 事件出现

### 8.2 Agent YAML 配置扩展

```yaml
id: codebuddy
name: CodeBuddy
backend: codebuddy
transport: serve              # "cli" (default) | "serve" (HTTP daemon) | "acp-stdio" (子进程 ACP)
serve_port: 9191              # daemon 端口（transport: serve 时有效）
# acp_command: "claude acp"   # transport: acp-stdio 时的启动命令
# acp_headers:                # per-agent 自定义请求头
#   x-codebuddy-request: "true"
# skills_api: "/api/v1/plugins"  # Skill 查询端点（per-agent，HTTP 模式专用）
```

### 8.3 ACP 会话生命周期管理

ACP HTTP 模式下 session 是持久化的，需要明确生命周期映射：

| ClawBench 事件 | ACP 行为 | 说明 |
|---------------|---------|------|
| 用户发送首条消息 | `session/new` → `session/prompt` | 创建新 ACP session |
| 流式响应完成（收到 `session_end`） | 无需额外操作 | ACP session 保留在 daemon 端，可后续 `session/resume` |
| 用户发送后续消息 | `session/resume` → `session/prompt` | 复用已有 ACP session（ClawBench 的 `Resume: true` 映射） |
| 用户切换到其他 ClawBench 会话 | 无需操作 | ACP session 保持，下次切回时 `session/resume` |
| 用户删除 ClawBench 会话 | `session/end` | 释放 daemon 端资源 |
| ClawBench 服务器关闭 | 各 ACP session 由 daemon 自动清理 | daemon 端检测 SSE 断连 |
| ClawBench 服务器启动 | 清理本 session 的孤儿 ACP session（如果存在） | 避免残留 |
| SSE 流意外断连 | 检测 → 标记 session 异常 → 下次请求时 `session/resume` | 类似现有 CLI 重连逻辑 |

**ClawBench session → ACP session 映射：1:1**

- 每个 ClawBench session 有一个对应的 ACP sessionId
- ACP sessionId 存储在 `chat_sessions.external_session_id` 字段（复用现有机制）
- `session/new` 返回的 sessionId 通过 `session_capture` 事件保存到 `external_session_id`

### 8.4 AutoResumeBackend 与 ACP 的兼容性

**决策：ACPBackend 同样被 AutoResumeBackend 包裹。**

理由：
- ExitPlanMode 在 ACP 中以 `tool_call` 事件出现（`event.Tool.Name == "ExitPlanMode"`）
- 现有 `AutoResumeBackend` 的检测逻辑 `event.Type == "tool_use" && event.Tool.Name == "ExitPlanMode" && event.Tool.Done` 对 ACP 事件流同样适用
- ACP 模式下的 resume 流程：`innerCancel()` → `session/cancel` → 新 `ChatRequest{Resume: true}` → `session/resume` + `session/prompt`
- `resume_split` 事件机制在 ACP 模式下同样需要（用于 DB 消息分割）

**factory.go 修改：**

```go
case "codebuddy":
    if transport == "serve" || transport == "acp-stdio" {
        return &AutoResumeBackend{inner: NewACPBackend(agentConfig)}, nil
    }
    return &AutoResumeBackend{inner: codebuddyBackend}, nil
```

### 8.5 DaemonManager 设计

```go
type DaemonManager struct {
    mu       sync.Mutex
    daemons  map[string]*DaemonInfo  // key: "host:port"
}

type DaemonInfo struct {
    Port       int
    Command    string    // e.g., "codebuddy"
    Healthy    bool
    LastCheck  time.Time
}
```

**健康检查：**
- 端点：`GET /api/v1/health`（CodeBuddy 特有，其他 Agent 可能不同）
- 频率：惰性检查 — 每次 `ExecuteStream` 前检查，而非定时轮询
- 超时：5s HTTP 请求超时

**自动启动流程：**
1. `ExecuteStream` 调用时检查 daemon 健康状态
2. 不健康 → 执行 `{command} daemon start --port {port}`
3. 等待健康检查通过（最多重试 3 次，间隔 2s）
4. 仍不健康 → 返回 `StreamEvent{Type: "error", Error: "daemon unavailable"}`

**崩溃恢复：**
1. SSE 流意外关闭 → `StreamEvent{Type: "error", Reason: "acp_stream_disconnected"}`
2. 不自动重启 daemon（可能是用户主动停止）
3. 下次请求时重新触发健康检查 → 自动启动流程

**端口冲突检测：**
- 启动前检查端口是否已被占用
- 已占用 → 尝试健康检查，健康则复用，不健康则报错
- 不自动更换端口

**多 Agent 共享 daemon：**
- 同一端口的不同 Agent YAML 配置共享 daemon
- ACP session 是隔离的（不同 sessionId），共享 daemon 无问题
- 但不同 Agent 的 systemPrompt、model 等是 per-session 的，互不干扰

### 8.6 后端组件结构

```
internal/ai/
├── acp_backend.go        # 通用 ACP 后端，实现 AIBackend 接口
│   ├── ACPBackend struct
│   ├── ExecuteStream()   # ACP 连接 → session/new → session/prompt → SSE 事件解析
│   ├── connect()         # HTTP 或 stdio 传输建立
│   ├── initialize()      # JSON-RPC initialize
│   ├── newSession()      # session/new + 解析 available_commands_update
│   ├── sendPrompt()      # session/prompt + SSE 流式读取
│   ├── cancelSession()   # session/cancel
│   └── endSession()      # session/end（ClawBench 会话删除时调用）
│
├── acp_http.go           # HTTP 传输实现（Daemon 模式）
│   ├── ACPTransport interface
│   ├── HTTPTransport     # CodeBuddy 等 daemon 模式
│   └── StdioTransport    # Claude Code、Codex 等子进程模式
│
├── acp_stdio.go           # stdio 传输实现（子进程模式）
│
├── daemon.go              # Daemon 管理器（仅 HTTP 模式需要）
│   ├── DaemonManager     # 健康检查、自动启动、端口管理
│   └── per-agent daemon 配置
│
├── acp_events.go          # ACP 事件 → StreamEvent 映射
│   ├── parseACPEvent()   # 解析 SSE 事件
│   ├── mapACPError()     # JSON-RPC 错误码 → StreamEvent.Reason
│   └── 事件映射表
│
├── acp_skills.go          # SkillProvider 策略模式
│   ├── SkillProvider interface
│   ├── HTTPSkillProvider     # HTTP daemon 模式，调用 skills_api
│   ├── ACPSessionSkillProvider  # stdio 模式，从 available_commands_update 解析
│   └── EmptySkillProvider    # CLI 模式，返回空列表
│
└── factory.go             # 修改：transport=="serve"/"acp-stdio" 时返回 AutoResumeBackend{inner: ACPBackend}
```

### 8.7 ACPTransport 接口

```go
// ACPTransport 抽象 HTTP 和 stdio 两种 ACP 传输方式
type ACPTransport interface {
    // Connect 建立连接（HTTP 模式返回 connectionId+token，stdio 模式启动子进程）
    Connect(ctx context.Context) error
    // SendRequest 发送 JSON-RPC 请求并返回 SSE 事件流
    SendRequest(ctx context.Context, req JSONRPCRequest) (<-chan SSEEvent, error)
    // SendNotification 发送 JSON-RPC 通知（无响应）
    SendNotification(ctx context.Context, req JSONRPCRequest) error
    // Close 关闭连接
    Close() error
}
```

### 8.8 ChatRequest 扩展

```go
type ChatRequest struct {
    Prompt                string
    SessionID             string
    WorkDir               string
    SystemPrompt          string
    Model                 string
    Command               string
    AgentID               string
    ThinkingEffort        string
    Resume                bool
    ScheduledExecution    bool
    AssistantMessageCount int
    Skills                []string  // 新增：选中的 Skill 名称列表
    McpServers            []string  // 新增：选中的 MCP 服务器名称列表
}
```

### 8.9 文件附件在 ACP 模式下的映射

**决策：文件附件在 ACP 模式下使用与 CLI 模式相同的文本前缀方式，包装为 content part。**

现有 CLI 模式注入方式（`chat.go` 第 252-261 行）：
```go
prompt = fmt.Sprintf("[Current file: %s]\n%s", files, prompt)
prompt = fmt.Sprintf("[Current directory: %s]\n%s", dirs, prompt)
prompt = fmt.Sprintf("[User uploaded %d file(s): %s]\n%s", len(uploads), uploads, prompt)
```

ACP 模式下等价映射：
```json
[
  {"type": "text", "text": "[Current file: /path/to/file, /path/to/file2]"},
  {"type": "text", "text": "[Current directory: /path/to/dir]"},
  {"type": "text", "text": "[User uploaded 2 file(s): /path/a, /path/b]"},
  {"type": "text", "text": "用户原始输入"}
]
```

**注入逻辑位置：** 在 handler 层完成（`buildChatRequest` 或新的 `buildACPPromptParts` 函数），与 `ChatRequest` 的 `Files`/`FilePaths` 字段无关，仅使用 `Skills`/`McpServers` + 现有附件逻辑生成 content parts 数组。

### 8.10 前端 Skill/Command/MCP 选择器设计

#### 交互模型

| 类型 | 触发方式 | 插入形式 | 可编辑 | 存储方式 |
|------|---------|---------|--------|---------|
| Command | 输入 `/` 自动补全 | 普通文本 | ✅ | prompt 文本字段 |
| Skill | ⚡ 按钮 → BottomSheet | 标签（✨图标，青色） | ❌ 仅可删除 | 消息独立字段 |
| MCP | ⚡ 按钮 → BottomSheet | 标签（🔌图标，紫色） | ❌ 仅可删除 | 消息独立字段 |

- ⚡ 按钮和斜杠补全**仅 Serve/ACP 模式**下可用（CLI 模式无 API）
- Skill/MCP 标签与附件标签**混排在同一行**
- 选择 Skill/MCP 后**不关闭** BottomSheet（允许多选）
- 后端发送时拼接提示词：Skill → `请使用 {name} skill`，MCP → `请使用 {name} MCP 服务器`
- 标签**跟随消息**（message 级别），发送后清空选择

#### SkillMcpSheet 组件

```
BottomSheet (auto 模式)
├── Tab 栏: [✨ Skills] [🔌 MCP]
├── 搜索框
└── 列表
    └── 列表项: 图标 + 名称 + 描述 + ✓已选中
```

#### 斜杠命令补全

- 输入 `/` 立即弹出 PopupMenu
- 实时过滤匹配命令
- 每项：命令名称（粗体）+ 描述（灰色）
- 选择后作为普通文本插入输入框

#### 消息气泡展示

用户消息中渲染只读 Skill/MCP 标签（类似附件标签，无删除按钮）。

### 8.11 数据存储

**chat_history 表新增列：**
```sql
ALTER TABLE chat_history ADD COLUMN skills TEXT DEFAULT '[]';       -- JSON: ["brainstorming", ...]
ALTER TABLE chat_history ADD COLUMN mcp_servers TEXT DEFAULT '[]';  -- JSON: ["tavily", ...]
```

**迁移方式：** 使用现有 `pragma_table_info` 检查模式（与 `thinking_effort` 迁移一致）：
```go
var hasSkills int
DB.QueryRow("SELECT COUNT(*) FROM pragma_table_info('chat_history') WHERE name='skills'").Scan(&hasSkills)
if hasSkills == 0 {
    DB.Exec("ALTER TABLE chat_history ADD COLUMN skills TEXT DEFAULT '[]'")
}
```

### 8.12 后端 API 新增

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/ai/commands` | GET | 获取当前 agent 可用的斜杠命令列表 |
| `/api/ai/skills` | GET | 获取当前 agent 可用的 Skill 列表 |
| `/api/ai/mcp-servers` | GET | 获取当前 agent 可用的 MCP 服务器列表 |

共同参数：`?agent_id=xxx`，仅 Serve/ACP 模式可用，CLI 模式返回空列表。

**命令列表缓存：** `available_commands_update` 事件中的命令列表按 agent_id 缓存在后端内存中，避免每次查询都创建 ACP session。缓存失效条件：
- daemon 重启
- 可配置 TTL（默认 30 分钟）

## 九、实现计划

### 阶段零：前置准备

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 0a | Agent 模型扩展 | `internal/model/agent.go` | 新增 `Transport`、`ServePort`、`AcpCommand`、`AcpHeaders`、`SkillsAPI` 字段 |
| 0b | ChatRequest 扩展 | `internal/ai/interface.go` | 新增 `Skills`、`McpServers` 字段 |
| 0c | Factory 签名扩展 | `internal/ai/factory.go` | `NewBackend` 需接收 agent 配置（transport、port 等） |

### 阶段一：后端 ACP 基础设施

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 1 | DaemonManager | `internal/ai/daemon.go` | 健康检查、自动启动、端口管理（先于 HTTP 传输，因为传输依赖 daemon） |
| 2 | HTTP 传输 | `internal/ai/acp_http.go` | Daemon 模式 HTTP+SSE 传输 |
| 3 | stdio 传输 | `internal/ai/acp_stdio.go` | 子进程模式 stdio 传输 |
| 4 | 事件解析 | `internal/ai/acp_events.go` | ACP SSE 事件 → StreamEvent 映射 + 错误码映射 |
| 5 | ACPBackend 实现 | `internal/ai/acp_backend.go` | 通用 ACP 后端，实现 AIBackend 接口（含 session 生命周期管理） |
| 6 | SkillProvider | `internal/ai/acp_skills.go` | SkillProvider 接口 + 三种实现 |
| 7 | Factory 集成 | `internal/ai/factory.go` | transport=="serve"/"acp-stdio" 时返回 `AutoResumeBackend{inner: ACPBackend}` |
| 8 | Handler 传输选择 | `internal/handler/chat.go` | `resolveAgentConfig` 读取 transport，传递给 factory |

### 阶段二：后端 Skill/Command/MCP API + 数据存储

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 9 | 数据库迁移 | `internal/service/database.go` | chat_history 表新增 skills、mcp_servers 列（先于 Chat 请求扩展） |
| 10 | 消息存储/读取 | `internal/service/chat.go` | 保存和返回 skills/mcp_servers JSON |
| 11 | Chat 请求扩展 | `internal/handler/chat.go` | 解析请求中 skills/mcp_servers 字段，构建 content parts |
| 12 | 命令列表 API | `internal/handler/ai_commands.go` | `GET /api/ai/commands`，含缓存 |
| 13 | Skill 列表 API | `internal/handler/ai_commands.go` | `GET /api/ai/skills`，通过 SkillProvider |
| 14 | MCP 列表 API | `internal/handler/ai_commands.go` | `GET /api/ai/mcp-servers`，通过 SkillProvider |
| 15 | 路由注册 | `internal/handler/routes.go` | 注册 3 个新端点 |

### 阶段三：前端 Skill/MCP 选择器

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 16 | 类型定义 | `web/src/types/index.ts` | CommandItem、SkillItem、McpServerItem |
| 17 | Store 扩展 | `web/src/stores/app.ts` | availableCommands/Skills/Mcp、selectedSkills/Mcp |
| 18 | API composable | `web/src/composables/useAiCommands.ts` | 封装 3 个 GET 请求，serve 模式检测 |
| 19 | SkillMcpSheet | `web/src/components/chat/SkillMcpSheet.vue` | BottomSheet + 双 Tab + 搜索 + 列表 |
| 20 | ChatInputBar 改造 | `web/src/components/chat/ChatInputBar.vue` | ⚡ 按钮、标签行混排 |
| 21 | 斜杠补全 | ChatInputBar 内 | 输入 `/` 触发 PopupMenu，实时过滤 |

### 阶段四：前端消息展示

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 22 | 消息类型扩展 | `web/src/types/index.ts` | Message 新增 skills、mcp_servers |
| 23 | 消息气泡标签 | `web/src/components/chat/ChatMessageItem.vue` | 用户消息渲染只读 Skill/MCP 标签 |
| 24 | 发送逻辑 | ChatPanelContent / useChatStream | 发送时附加 selectedSkills/McpServers |

### 阶段五：测试与收尾

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 25 | 后端测试 | `internal/ai/acp_backend_test.go` | ACPBackend、SkillProvider 单元测试 |
| 26 | 前端测试 | `web/src/components/chat/__tests__/` | SkillMcpSheet、斜杠补全测试 |
| 27 | Agent YAML 示例 | `config/agents/codebuddy-serve.yaml.example` | 带 transport/serve_port 的示例 |
| 28 | 文档更新 | 本文件 | 补充实现结果 |

## 十、ClawBench 集成状态

### 待实现

所有任务均未开始，从阶段零开始。

### 评审修订记录

**v2（2026-05-16）：解决评审问题**

| 评审编号 | 问题 | 修复内容 |
|---------|------|---------|
| C1 | Transport/ServePort 字段声称已完成但不存在 | 移至阶段零任务 #0a，标注为待实现 |
| C2 | ACP session 生命周期管理未定义 | 新增 §8.3 ACP 会话生命周期管理，定义所有场景映射 |
| C3 | AutoResumeBackend 与 ACP 兼容性未明确 | 新增 §8.4，明确 ACPBackend 被 AutoResumeBackend 包裹，ExitPlanMode 检测逻辑通用 |
| C4 | systemPrompt 注入策略未决 | 新增 §6，决策为 prompt 前缀注入，详细定义注入顺序和格式 |
| I1 | DaemonManager 健康检查/重启策略未定义 | 新增 §8.5 DaemonManager 设计，含健康检查、自动启动、崩溃恢复、端口冲突处理 |
| I2 | Skill 查询缺少 per-agent 抽象 | 新增 §4.4 SkillProvider 策略模式 + §8.6 acp_skills.go 组件 |
| I3 | 表名错误（应为 chat_history） | §8.11 修正为 chat_history，迁移方式使用现有 pragma_table_info 模式 |
| I4 | ChatRequest 需扩展 Skills/McpServers | 新增 §8.8 ChatRequest 扩展，阶段零任务 #0b |
| I5 | ACP 模式下文件附件映射未说明 | 新增 §8.9，定义文件附件使用 content parts 文本前缀方式 |
| S2 | 错误事件映射缺失 | §3.6 新增 JSON-RPC 错误码映射表 + SSE 断连处理 |
| S4 | 阶段二任务顺序调整 | DB 迁移（#9）移至 Chat 请求扩展（#11）之前 |
| — | Factory.NewBackend 签名需扩展 | 新增阶段零任务 #0c，NewBackend 需接收 agent 配置 |
