# Code Review 修复执行计划

> 创建日期: 2026-05-05
> 来源: docs/reviews/ 全面代码 Review (2026-05-05)
> 前置验证: 5个P0问题全部真实存在，但无一导致功能不可用，严重程度重新定级
> 预计总工时: 2-3小时

## 修复优先级总览

| 序号 | Issue ID | 标题 | 原评级 | 实际评级 | 预计工时 |
|------|----------|------|--------|---------|---------|
| 1 | R10-002 | 两个API绕过Auth中间件 | P0 | **P1** | 15min |
| 2 | R7-001 | SSH无暴力破解防护+信息泄露 | P0 | **P1** | 45min |
| 3 | R4-001 | SSE断开不杀AI进程，资源泄漏 | P0 | **P1** | 20min |
| 4 | R5-008 | 手动触发与cron并发时run_count丢失+1 | P0 | **P2** | 15min |
| 5 | R5-001 | WithSeconds()是死代码 | P0 | **P2** | 5min |

---

## Step 1: R10-002 — 两个API绕过Auth

**严重度**: P1（有密码时是安全漏洞，无密码模式本就全放行）

**问题**:
- `/api/watch-dir` (handler.go:113) — 无 `middleware.Auth()` 包装，暴露服务器路径、上传限制、聊天配置等
- `/api/project` (handler.go:115) — 无 `middleware.Auth()` 包装，GET返回项目路径，POST可切换项目目录

**修复方案**: 给两个路由加上 `middleware.Auth()` 包装

**文件**: `internal/handler/handler.go`

**具体改动**:
```go
// 修改前 (line ~113):
register("/api/watch-dir", ServeWatchDir)
register("/api/project", ServeProjectSet)

// 修改后:
register("/api/watch-dir", middleware.Auth(ServeWatchDir))
register("/api/project", middleware.Auth(ServeProjectSet))
```

**验证**: 
- 有密码模式下，未登录访问 `/api/watch-dir` 和 `/api/project` 应返回 401
- 无密码模式下，行为不变（Auth中间件 `SessionToken==""` 时直接放行）
- 前端已登录状态下功能正常

---

## Step 2: R7-001 — SSH暴力破解防护

**严重度**: P1（安全加固缺失，非功能性Bug）

**问题**:
- `internal/ssh/server.go:66-73` — PasswordCallback 无任何限速/重试限制
- `internal/ssh/server.go:100` — handleConn 无条件接受所有连接
- 错误信息 `ssh: authentication failed for user %q` 泄露用户名枚举

**修复方案**: 在SSH Server中增加认证限速和失败计数

**文件**: `internal/ssh/server.go`

**具体改动**:

1. **新增认证限速结构**:
```go
// 在 Server 结构体中新增字段
type authTracker struct {
    mu       sync.Mutex
    attempts map[string]*ipRecord // key: IP地址
}

type ipRecord struct {
    failCount  int
    lastFail   time.Time
    blockedUntil time.Time
}
```

2. **PasswordCallback 中增加限速逻辑**:
```go
PasswordCallback: func(c gossh.ConnMetadata, pass []byte) (*gossh.Permissions, error) {
    remoteIP := extractIP(c.RemoteAddr())
    
    // 检查是否被封禁
    if s.authTracker.isBlocked(remoteIP) {
        return nil, fmt.Errorf("ssh: too many authentication failures")
    }
    
    if c.User() == "clawbench" && string(pass) == s.password {
        s.authTracker.reset(remoteIP)
        return nil, nil
    }
    
    // 记录失败
    s.authTracker.recordFailure(remoteIP)
    return nil, fmt.Errorf("ssh: authentication failed")  // 不再泄露用户名
}
```

3. **限速参数**:
- 同一IP连续5次失败后封禁
- 封禁时长: 指数退避，初始5分钟，翻倍至最长1小时
- 成功认证后重置计数

4. **定期清理过期记录** (在Server.Start中启动清理goroutine):
- 每10分钟清理过期IP记录

**验证**:
- 正常认证不受影响
- 连续5次错误密码后IP被封禁
- 封禁期间认证请求被立即拒绝
- 封禁超时后自动解封
- 成功认证后计数器重置

---

## Step 3: R4-001 — SSE断开不杀AI进程

**严重度**: P1（资源泄漏，进程自然结束后自行清理，但不主动回收）

**问题**:
- `internal/handler/chat_stream.go:164-169` — SSE客户端断开时只记录日志，不调用 `ForceCancelSession`
- `ForceCancelSession` 已正确实现（session_runtime.go:119-129），但从未在SSE断开路径被调用

**修复方案**: SSE断开时调用 `service.ForceCancelSession(sessionID)`

**文件**: `internal/handler/chat_stream.go`

**具体改动**:
```go
// 修改前 (line ~164-169):
case <-r.Context().Done():
    slog.Info("sse client disconnected, ai session continues",
        slog.String("session_id", sessionID),
    )
    return

// 修改后:
case <-r.Context().Done():
    slog.Info("sse client disconnected, cancelling ai session",
        slog.String("session_id", sessionID),
    )
    service.ForceCancelSession(sessionID)
    return
```

**注意事项**:
- `ForceCancelSession` 会将取消原因设为 `"disconnect"`（而非 `"user"`），前端可据此区分显示
- `ForceCancelSession` 使用 `sync.Map.LoadAndDelete`，幂等安全，重复调用无副作用
- 需确认前端对 `disconnect` 取消原因的处理逻辑是否正确（useChatStream.ts 中重连逻辑不应在主动断开时触发）

**验证**:
- 打开聊天 → SSE连接建立 → 关闭浏览器标签 → CLI进程应被终止
- 重新连接后，会话状态应为 "已断开" 而非 "运行中"
- 用户主动取消和SSE断开的取消原因应不同（"user" vs "disconnect"）

---

## Step 4: R5-008 — run_count并发竞态

**严重度**: P2（仅手动+自动重叠时出问题，实际低频）

**问题**:
- `internal/service/scheduler.go:317` — `runCount := task.RunCount + 1` 读取后写入非原子
- 数据库UPDATE使用 `run_count = ?`（赋值）而非 `run_count = run_count + 1`（原子递增）
- 手动触发（`go s.executeTask()`）与cron触发可并发执行同一任务

**修复方案**: 使用SQL原子递增替代Go侧计算

**文件**: `internal/service/scheduler.go`

**具体改动**:

1. **executeTask 中修改 run_count 更新逻辑**:
```go
// 修改前 (line ~316-317):
now := time.Now()
runCount := task.RunCount + 1

// ... 后续在 UPDATE 中:
// run_count = ?, ... runCount

// 修改后:
now := time.Now()
// 不再在Go侧计算runCount，改用SQL原子递增
```

2. **修改UPDATE语句**:
```go
// 修改前:
DB.Exec("UPDATE scheduled_tasks SET last_run_at = ?, next_run_at = ?, run_count = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    now, nextRunAt, runCount, newStatus, task.ID)

// 修改后:
DB.Exec("UPDATE scheduled_tasks SET last_run_at = ?, next_run_at = ?, run_count = run_count + 1, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    now, nextRunAt, newStatus, task.ID)
```

3. **清理executeTask中不再需要的runCount局部变量**

**验证**:
- 手动触发 → run_count正确+1
- cron自动触发 → run_count正确+1
- 手动+cron并发 → run_count正确+2（不再丢失）
- 现有测试通过

---

## Step 5: R5-001 — WithSeconds()死代码

**严重度**: P2（定时任务执行完全正确，只是代码误导）

**问题**:
- `internal/service/scheduler.go:31` — `cron.New(cron.WithSeconds())` 配置6位解析
- 但所有解析使用 `cron.ParseStandard()` (5位)，WithSeconds()从未生效
- 若有人传入6位cron表达式会被拒绝

**修复方案**: 移除 `WithSeconds()` 选项

**文件**: `internal/service/scheduler.go`

**具体改动**:
```go
// 修改前 (line ~31):
cron: cron.New(cron.WithSeconds()), // support second-level precision

// 修改后:
cron: cron.New(),
```

**验证**:
- 现有5位cron表达式正常解析（`0 9 * * *` 等）
- 6位表达式正常报错（与之前行为一致，因为ParseStandard一直是5位）
- 现有测试通过

---

## 执行顺序

```
Step 1 (R10-002, 15min) ─→ Step 3 (R4-001, 20min)
         ↓                          ↓
Step 2 (R7-001, 45min)    Step 4 (R5-008, 15min) ─→ Step 5 (R5-001, 5min)
```

- Step 1 和 Step 3 无依赖，可并行
- Step 2 独立，可与 Step 4/5 并行
- Step 4 和 Step 5 改同一文件(scheduler.go)，需串行

## 不在本计划范围内

以下Review中发现的问题本次不修复（需单独评估）：

- R1-001 ~ R1-006 (Chat主流程P2/P3问题)
- R2-001 ~ R2-005 (SSE流式P2/P3问题)
- R3-001 ~ R3-003 (Auto-Resume P2/P3问题)
- R4-002 ~ R4-006 (Session管理P2/P3问题)
- R5-002 ~ R5-007 (定时任务P2/P3问题)
- R6-001 ~ R6-005 (TTS语音P2/P3问题)
- R7-002 ~ R7-005 (SSH/P2/P3问题)
- R8-001 ~ R8-005 (文件管理P2/P3问题)
- R9-001 ~ R9-004 (Git历史P2/P3问题)
- R10-001, R10-003 (认证P2/P3问题)
- R11-001 ~ R11-004 (配置P2/P3问题)
- R12-001 ~ R12-004 (Android Bridge P2/P3问题)

## 完成标准

- [ ] 5个修改全部完成，代码编译通过 (`go build ./...`)
- [ ] Go测试全部通过 (`go test ./...`)
- [ ] 有密码模式下未认证访问 `/api/watch-dir` 和 `/api/project` 返回401
- [ ] SSH连续5次错误密码后IP被封禁
- [ ] SSE断开后CLI进程被终止
- [ ] run_count并发更新不丢失
- [ ] cron.New() 无 WithSeconds()，5位表达式正常工作
