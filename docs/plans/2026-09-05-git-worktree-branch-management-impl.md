# Git Worktree & Branch Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Worktree & Branch management views to the Git history tab, navigable via breadcrumb drill-down from the existing commit list.

**Architecture:** Add 3 backend API endpoints (`GET /api/git/worktrees`, `GET /api/git/branches`, `POST /api/git/checkout`) in the existing `git.go` handler pattern. Frontend adds a `manage` view to `GitHistoryContent`'s breadcrumb navigation, with two new components (`GitWorktreeList`, `GitBranchList`) inside a `GitManageContent` container. Store adds `gitWorktrees`, `gitBranches`, `gitStashCount` state.

**Tech Stack:** Go (os/exec for git CLI), Vue 3 Composition API, vue-i18n, existing BottomSheet + useDialog patterns.

---

### Task 1: Backend — `GET /api/git/worktrees`

**Files:**
- Modify: `internal/handler/git.go` (add `ServeGitWorktrees` handler)
- Modify: `internal/handler/handler.go` (register route)

**Step 1: Add data types for worktree response**

Add to `internal/handler/git.go` (after `commitInfo` struct around line 21):

```go
// worktreeInfo represents a git worktree in API responses.
type worktreeInfo struct {
	Path         string `json:"path"`
	DisplayPath  string `json:"displayPath"`
	Branch       string `json:"branch"`
	IsCurrent    bool   `json:"isCurrent"`
	Dirty        bool   `json:"dirty"`
	UntrackedCnt int    `json:"untrackedCount"`
	Locked       bool   `json:"locked"`
}
```

**Step 2: Implement `ServeGitWorktrees` handler**

Add to `internal/handler/git.go`:

```go
// ServeGitWorktrees returns all git worktrees for the project.
func ServeGitWorktrees(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	projectPath, ok := requireProject(w, r)
	if !ok {
		return
	}
	if !isGitRepo(projectPath) {
		writeJSON(w, http.StatusOK, map[string]interface{}{"isGit": false, "worktrees": []worktreeInfo{}})
		return
	}

	// Parse git worktree list --porcelain
	cmd := exec.Command("git", "worktree", "list", "--porcelain")
	cmd.Dir = projectPath
	output, err := cmd.CombinedOutput()
	if err != nil {
		writeLocalizedErrorf(w, r, http.StatusInternalServerError, "git.worktreeListFailed")
		return
	}

	worktrees := parseWorktreePorcelain(string(output), projectPath)

	// Check dirty status for each worktree in parallel
	type dirtyResult struct {
		idx   int
		dirty bool
		count int
	}
	ch := make(chan dirtyResult, len(worktrees))
	for i, wt := range worktrees {
		go func(idx int, path string) {
			statusCmd := exec.Command("git", "-C", path, "status", "--porcelain")
			out, _ := statusCmd.CombinedOutput()
			lines := strings.Count(strings.TrimSpace(string(out)), "\n") + 1
			trimmed := strings.TrimSpace(string(out))
			dirty := trimmed != ""
			cnt := 0
			if dirty {
				cnt = len(strings.Split(trimmed, "\n"))
			}
			ch <- dirtyResult{idx, dirty, cnt}
		}(i, wt.Path)
	}
	for range worktrees {
		res := <-ch
		worktrees[res.idx].Dirty = res.dirty
		worktrees[res.idx].UntrackedCnt = res.count
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"isGit": true, "worktrees": worktrees})
}

// parseWorktreePorcelain parses "git worktree list --porcelain" output.
// Format per worktree (separated by blank lines):
//
//	worktree /abs/path
//	HEAD abc123...
//	branch refs/heads/main
//	locked
//	prunable
func parseWorktreePorcelain(output string, projectPath string) []worktreeInfo {
	var worktrees []worktreeInfo
	blocks := strings.Split(strings.TrimSpace(output), "\n\n")
	for _, block := range blocks {
		var wt worktreeInfo
		for _, line := range strings.Split(block, "\n") {
			if strings.HasPrefix(line, "worktree ") {
				wt.Path = strings.TrimPrefix(line, "worktree ")
				// Compute displayPath relative to projectPath
				rel := strings.TrimPrefix(wt.Path, projectPath)
				if rel != wt.Path && strings.HasPrefix(rel, "/") {
					wt.DisplayPath = "." + rel
				} else {
					wt.DisplayPath = wt.Path
				}
			} else if strings.HasPrefix(line, "HEAD ") {
				// Not needed in response for now
			} else if strings.HasPrefix(line, "branch refs/heads/") {
				wt.Branch = strings.TrimPrefix(line, "branch refs/heads/")
			} else if line == "locked" || strings.HasPrefix(line, "locked ") {
				wt.Locked = true
			}
		}
		// Detect if this is the current worktree
		wt.IsCurrent = wt.Path == projectPath
		if wt.Path != "" {
			worktrees = append(worktrees, wt)
		}
	}
	return worktrees
}
```

**Step 3: Register route**

In `internal/handler/handler.go`, add in the git routes block (after the `verify-commits` line):

```go
register("/api/git/worktrees", middleware.Auth(ServeGitWorktrees))
```

**Step 4: Build and verify**

Run: `go build -o clawbench ./cmd/server`
Expected: Compiles without errors.

**Step 5: Manual test**

Start server, hit `GET /api/git/worktrees` with auth cookie. Verify JSON response contains worktree list.

**Step 6: Commit**

```bash
git add internal/handler/git.go internal/handler/handler.go
git commit -m "feat: add GET /api/git/worktrees endpoint"
```

---

### Task 2: Backend — `GET /api/git/branches`

**Files:**
- Modify: `internal/handler/git.go` (add `ServeGitBranches` handler + types)
- Modify: `internal/handler/handler.go` (register route)

**Step 1: Add data types for branch response**

Add to `internal/handler/git.go`:

```go
// branchInfo represents a git branch in API responses.
type branchInfo struct {
	Name           string `json:"name"`
	IsCurrent      bool   `json:"isCurrent"`
	IsDefault      bool   `json:"isDefault"`
	Ahead          int    `json:"ahead"`
	Behind         int    `json:"behind"`
	RemoteTracking string `json:"remoteTracking"`
}
```

**Step 2: Implement `ServeGitBranches` handler**

Add to `internal/handler/git.go`:

```go
// ServeGitBranches returns all local branches for the project.
func ServeGitBranches(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	projectPath, ok := requireProject(w, r)
	if !ok {
		return
	}
	if !isGitRepo(projectPath) {
		writeJSON(w, http.StatusOK, map[string]interface{}{"isGit": false, "branches": []branchInfo{}, "defaultBranch": ""})
		return
	}

	// Use git for-each-ref for structured, parseable output
	cmd := exec.Command("git", "for-each-ref",
		"--format=%(refname:short)|%(upstream:short)|%(upstream:track)",
		"refs/heads/",
	)
	cmd.Dir = projectPath
	output, err := cmd.CombinedOutput()
	if err != nil {
		writeLocalizedErrorf(w, r, http.StatusInternalServerError, "git.branchListFailed")
		return
	}

	branches := parseBranchForEachRef(string(output))

	// Detect current branch
	headCmd := exec.Command("git", "symbolic-ref", "--short", "HEAD")
	headCmd.Dir = projectPath
	headOut, headErr := headCmd.CombinedOutput()
	currentBranch := ""
	if headErr == nil {
		currentBranch = strings.TrimSpace(string(headOut))
	}

	// Detect default branch with fallback chain
	defaultBranch := detectDefaultBranch(projectPath)

	for i := range branches {
		branches[i].IsCurrent = branches[i].Name == currentBranch
		branches[i].IsDefault = branches[i].Name == defaultBranch
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"isGit":         true,
		"branches":      branches,
		"defaultBranch":  defaultBranch,
		"currentBranch": currentBranch,
	})
}

// parseBranchForEachRef parses git for-each-ref output.
// Format per line: branchName|upstreamShort|[ahead N, behind M]
func parseBranchForEachRef(output string) []branchInfo {
	var branches []branchInfo
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 3)
		b := branchInfo{Name: parts[0]}
		if len(parts) >= 2 && parts[1] != "" {
			b.RemoteTracking = parts[1]
		}
		if len(parts) >= 3 {
			b.Ahead, b.Behind = parseTrackInfo(parts[2])
		}
		branches = append(branches, b)
	}
	return branches
}

// parseTrackInfo parses "[ahead N, behind M]" or "[ahead N]" or "[behind M]" or "".
func parseTrackInfo(s string) (ahead, behind int) {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "[")
	s = strings.TrimSuffix(s, "]")
	if s == "" {
		return 0, 0
	}
	for _, part := range strings.Split(s, ", ") {
		part = strings.TrimSpace(part)
		if strings.HasPrefix(part, "ahead ") {
			fmt.Sscanf(part, "ahead %d", &ahead)
		} else if strings.HasPrefix(part, "behind ") {
			fmt.Sscanf(part, "behind %d", &behind)
		}
	}
	return
}

// detectDefaultBranch tries to detect the default branch name.
func detectDefaultBranch(projectPath string) string {
	// 1. Try git symbolic-ref refs/remotes/origin/HEAD
	cmd := exec.Command("git", "symbolic-ref", "refs/remotes/origin/HEAD")
	cmd.Dir = projectPath
	out, err := cmd.CombinedOutput()
	if err == nil {
		ref := strings.TrimSpace(string(out))
		// refs/remotes/origin/main → main
		return strings.TrimPrefix(ref, "refs/remotes/origin/")
	}

	// 2. Check if "main" exists
	checkCmd := exec.Command("git", "rev-parse", "--verify", "main")
	checkCmd.Dir = projectPath
	if _, err := checkCmd.CombinedOutput(); err == nil {
		return "main"
	}

	// 3. Check if "master" exists
	checkCmd = exec.Command("git", "rev-parse", "--verify", "master")
	checkCmd.Dir = projectPath
	if _, err := checkCmd.CombinedOutput(); err == nil {
		return "master"
	}

	return ""
}
```

**Step 3: Register route**

In `internal/handler/handler.go`, add:

```go
register("/api/git/branches", middleware.Auth(ServeGitBranches))
```

**Step 4: Build and verify**

Run: `go build -o clawbench ./cmd/server`
Expected: Compiles without errors.

**Step 5: Commit**

```bash
git add internal/handler/git.go internal/handler/handler.go
git commit -m "feat: add GET /api/git/branches endpoint"
```

---

### Task 3: Backend — `POST /api/git/checkout`

**Files:**
- Modify: `internal/handler/git.go` (add `ServeGitCheckout` handler + mutex)
- Modify: `internal/handler/handler.go` (register route)

**Step 1: Add checkout mutex and handler**

Add to `internal/handler/git.go`:

```go
import (
	"sync"
	// ... existing imports
)

// checkoutMu prevents concurrent git checkout operations per project path.
var checkoutMu sync.Mutex

// ServeGitCheckout switches to a different branch.
func ServeGitCheckout(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	projectPath, ok := requireProject(w, r)
	if !ok {
		return
	}
	if !isGitRepo(projectPath) {
		writeLocalizedErrorf(w, r, http.StatusBadRequest, "git.notRepo")
		return
	}

	// Acquire checkout lock
	if !checkoutMu.TryLock() {
		writeJSON(w, http.StatusConflict, map[string]interface{}{
			"success": false,
			"error":   "checkout_in_progress",
		})
		return
	}
	defer checkoutMu.Unlock()

	var req struct {
		Branch string `json:"branch"`
		Stash  bool   `json:"stash"`
		Force  bool   `json:"force"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Branch == "" {
		writeLocalizedErrorf(w, r, http.StatusBadRequest, "git.branchRequired")
		return
	}

	// Check if working tree is dirty
	statusCmd := exec.Command("git", "status", "--porcelain")
	statusCmd.Dir = projectPath
	statusOut, _ := statusCmd.CombinedOutput()
	isDirty := strings.TrimSpace(string(statusOut)) != ""

	if isDirty && !req.Stash && !req.Force {
		// Return dirty_worktree error so frontend can show options
		lines := strings.Split(strings.TrimSpace(string(statusOut)), "\n")
		writeJSON(http.StatusOK, map[string]interface{}{
			"success":        false,
			"error":          "dirty_worktree",
			"untrackedCount": len(lines),
		})
		return
	}

	// Stash if requested
	stashed := false
	if req.Stash && isDirty {
		stashCmd := exec.Command("git", "stash")
		stashCmd.Dir = projectPath
		if err := stashCmd.Run(); err != nil {
			writeJSON(w, http.StatusOK, map[string]interface{}{
				"success": false,
				"error":   "stash_failed",
			})
			return
		}
		stashed = true
	}

	// Perform checkout using git switch (Git 2.23+)
	args := []string{"switch"}
	if req.Force {
		args = append(args, "-f")
	}
	args = append(args, req.Branch)
	switchCmd := exec.Command("git", args...)
	switchCmd.Dir = projectPath
	switchOut, switchErr := switchCmd.CombinedOutput()

	if switchErr != nil {
		errMsg := strings.TrimSpace(string(switchOut))
		errCode := "checkout_failed"
		if strings.Contains(errMsg, "conflict") {
			errCode = "checkout_conflict"
		} else if strings.Contains(errMsg, "hook") {
			errCode = "hook_rejected"
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"success":    false,
			"error":      errCode,
			"errorDetail": errMsg,
		})
		return
	}

	// Get stash count for response
	stashCount := 0
	stashListCmd := exec.Command("git", "stash", "list")
	stashListCmd.Dir = projectPath
	stashListOut, _ := stashListCmd.CombinedOutput()
	if trimmed := strings.TrimSpace(string(stashListOut)); trimmed != "" {
		stashCount = len(strings.Split(trimmed, "\n"))
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":    true,
		"branch":     req.Branch,
		"stashed":    stashed,
		"stashCount": stashCount,
	})
}
```

**Step 2: Register route**

In `internal/handler/handler.go`, add:

```go
register("/api/git/checkout", middleware.Auth(ServeGitCheckout))
```

**Step 3: Build and verify**

Run: `go build -o clawbench ./cmd/server`

**Step 4: Commit**

```bash
git add internal/handler/git.go internal/handler/handler.go
git commit -m "feat: add POST /api/git/checkout endpoint with stash/force support"
```

---

### Task 4: Frontend — Store state & API functions

**Files:**
- Modify: `web/src/stores/app.ts`

**Step 1: Add new state fields**

In the `AppState` interface (around line 82), add after `isGitRepo`:

```typescript
gitWorktrees: any[]
gitBranches: any[]
gitStashCount: number
```

In the reactive defaults (around line 129), add after `isGitRepo: false`:

```typescript
gitWorktrees: [],
gitBranches: [],
gitStashCount: 0,
```

**Step 2: Add API loading functions**

Add after `loadGitBranch()` function (around line 191):

```typescript
async function loadGitWorktrees(): Promise<void> {
    try {
        const data = await apiGet<{ isGit: boolean; worktrees: any[] }>('/api/git/worktrees')
        if (data.isGit) {
            state.gitWorktrees = data.worktrees || []
        } else {
            state.gitWorktrees = []
        }
    } catch (_) {
        state.gitWorktrees = []
    }
}

async function loadGitBranches(): Promise<void> {
    try {
        const data = await apiGet<{ isGit: boolean; branches: any[]; defaultBranch: string; currentBranch: string }>('/api/git/branches')
        if (data.isGit) {
            state.gitBranches = data.branches || []
        } else {
            state.gitBranches = []
        }
    } catch (_) {
        state.gitBranches = []
    }
}
```

**Step 3: Export new functions**

In the `store` export object (around line 444), add:

```typescript
loadGitWorktrees, loadGitBranches,
```

**Step 4: Commit**

```bash
git add web/src/stores/app.ts
git commit -m "feat: add gitWorktrees/gitBranches state and loaders to store"
```

---

### Task 5: Frontend — i18n keys

**Files:**
- Modify: `web/src/locales/zh.json` (or equivalent Chinese locale file)
- Modify: `web/src/locales/en.json` (or equivalent English locale file)

**Step 1: Add Chinese i18n keys**

Find the git section in the Chinese locale and add:

```json
"git": {
  ...existing keys...,
  "manage": {
    "title": "管理",
    "worktrees": "Worktree",
    "branches": "分支",
    "current": "当前",
    "dirty": "有 {count} 个未提交更改",
    "clean": "干净",
    "noWorktrees": "无 Worktree",
    "noBranches": "无分支",
    "switchWorktree": "切换项目到",
    "switchWorktreeConfirm": "切换项目到 {path}？\n关联分支：{branch}",
    "switchBranch": "切换分支",
    "switchTo": "切换到 {branch}",
    "switchedTo": "已切换到 {branch}",
    "stashSwitch": "Stash 后切换",
    "stashSwitched": "已切换，原更改已 stash（共 {count} 个 stash）",
    "forceSwitch": "强制切换（丢弃更改）",
    "forceSwitchConfirm": "强制切换将丢弃所有未提交更改，确定？",
    "checkoutProgress": "正在切换…",
    "stashCount": "{count} 个 stash",
    "locked": "已锁定",
    "pathMissing": "路径不存在",
    "default": "默认",
    "ahead": "↑{n}",
    "behind": "↓{n}",
    "detachedHead": "detached HEAD at {sha}",
    "refresh": "刷新",
    "loading": "加载中…",
    "loadError": "加载失败",
    "retry": "重试"
  }
}
```

**Step 2: Add English equivalents**

Add corresponding English translations in the English locale file.

**Step 3: Commit**

```bash
git add web/src/locales/
git commit -m "feat: add i18n keys for git management view"
```

---

### Task 6: Frontend — `GitWorktreeCard.vue`

**Files:**
- Create: `web/src/components/git/GitWorktreeCard.vue`

**Step 1: Create component**

```vue
<template>
  <div
    class="git-worktree-card"
    :class="{ current: worktree.isCurrent, locked: worktree.locked, missing: worktree.missing }"
    @click="!worktree.isCurrent && !worktree.missing && $emit('switch', worktree)"
  >
    <div class="wt-card-main">
      <div class="wt-card-path">{{ worktree.displayPath }}</div>
      <div class="wt-card-branch">
        <GitBranchIcon :size="12" />
        <span>{{ worktree.branch || '—' }}</span>
      </div>
    </div>
    <div class="wt-card-status">
      <span v-if="worktree.isCurrent" class="wt-badge wt-badge-current">{{ t('git.manage.current') }}</span>
      <span v-else-if="worktree.dirty" class="wt-badge wt-badge-dirty">{{ t('git.manage.dirty', { count: worktree.untrackedCount }) }}</span>
      <span v-else class="wt-badge wt-badge-clean">{{ t('git.manage.clean') }}</span>
      <span v-if="worktree.locked" class="wt-badge wt-badge-locked">{{ t('git.manage.locked') }}</span>
      <span v-if="worktree.missing" class="wt-badge wt-badge-missing">{{ t('git.manage.pathMissing') }}</span>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { GitBranch as GitBranchIcon } from 'lucide-vue-next'

defineProps({
  worktree: { type: Object, required: true },
})

defineEmits(['switch'])

const { t } = useI18n()
</script>

<style scoped>
.git-worktree-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--border-color, #e0e0e0);
  border-radius: 8px;
  background: var(--bg-primary, #fff);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  min-height: 44px;
}
.git-worktree-card:hover {
  border-color: var(--accent-color, #4a90d9);
}
.git-worktree-card.current {
  border-color: var(--accent-color, #4a90d9);
  background: var(--bg-accent-subtle, rgba(74, 144, 217, 0.06));
  cursor: default;
}
.git-worktree-card.missing {
  opacity: 0.6;
  cursor: not-allowed;
}
.wt-card-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.wt-card-path {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary, #1a1a1a);
  word-break: break-all;
}
.wt-card-branch {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary, #666);
}
.wt-card-status {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.wt-badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  white-space: nowrap;
}
.wt-badge-current {
  background: var(--accent-color, #4a90d9);
  color: #fff;
}
.wt-badge-dirty {
  background: var(--warning-bg, #fff3cd);
  color: var(--warning-color, #856404);
}
.wt-badge-clean {
  background: var(--success-bg, #d4edda);
  color: var(--success-color, #155724);
}
.wt-badge-locked {
  background: var(--bg-secondary, #e0e0e0);
  color: var(--text-muted, #999);
}
.wt-badge-missing {
  background: var(--danger-bg, #f8d7da);
  color: var(--danger-color, #721c24);
}
</style>
```

**Step 2: Commit**

```bash
git add web/src/components/git/GitWorktreeCard.vue
git commit -m "feat: add GitWorktreeCard component"
```

---

### Task 7: Frontend — `GitWorktreeList.vue`

**Files:**
- Create: `web/src/components/git/GitWorktreeList.vue`

**Step 1: Create component**

```vue
<template>
  <div class="git-worktree-list" :class="{ collapsed }">
    <div class="section-header" @click="toggleCollapse">
      <span class="section-title">{{ t('git.manage.worktrees') }}</span>
      <span v-if="worktrees.length > 0" class="section-count">{{ worktrees.length }}</span>
      <ChevronDown v-if="!collapsed" :size="14" class="section-chevron" />
      <ChevronRight v-else :size="14" class="section-chevron" />
    </div>
    <div v-if="!collapsed" class="section-body">
      <div v-if="loading" class="section-loading">
        <div class="spinner" style="width:18px;height:18px;border-width:2px;" />
      </div>
      <div v-else-if="error" class="section-error">
        <span>{{ t('git.manage.loadError') }}</span>
        <button class="retry-btn" @click="$emit('retry')">{{ t('git.manage.retry') }}</button>
      </div>
      <div v-else-if="worktrees.length === 0" class="section-empty">
        {{ t('git.manage.noWorktrees') }}
      </div>
      <div v-else class="wt-card-grid">
        <GitWorktreeCard
          v-for="wt in worktrees"
          :key="wt.path"
          :worktree="wt"
          @switch="$emit('switch-worktree', $event)"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronRight } from 'lucide-vue-next'
import GitWorktreeCard from './GitWorktreeCard.vue'

const props = defineProps({
  worktrees: { type: Array, default: () => [] },
  loading: Boolean,
  error: Boolean,
  initialCollapsed: Boolean,
})

defineEmits(['switch-worktree', 'retry'])

const { t } = useI18n()
const collapsed = ref(props.initialCollapsed)

function toggleCollapse() {
  collapsed.value = !collapsed.value
  try {
    localStorage.setItem('git-worktree-collapsed', collapsed.value ? '1' : '0')
  } catch (_) {}
}

// Initialize from localStorage
watch(() => props.initialCollapsed, (val) => {
  try {
    const stored = localStorage.getItem('git-worktree-collapsed')
    if (stored !== null) collapsed.value = stored === '1'
  } catch (_) {}
}, { immediate: true })
</script>

<style scoped>
.git-worktree-list {
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--border-color, #e0e0e0);
}
.git-worktree-list.collapsed .section-header {
  border-bottom: none;
}
.section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
  border-bottom: 1px solid var(--border-color, #e0e0e0);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary, #666);
}
.section-header:hover {
  background: var(--bg-secondary, #f5f5f5);
}
.section-count {
  font-size: 11px;
  background: var(--bg-secondary, #e0e0e0);
  padding: 0 6px;
  border-radius: 10px;
  color: var(--text-muted, #999);
  font-weight: 400;
}
.section-chevron {
  margin-left: auto;
  color: var(--text-muted, #999);
}
.section-body {
  padding: 8px 12px;
}
.section-loading, .section-empty, .section-error {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px 0;
  font-size: 13px;
  color: var(--text-muted, #999);
}
.section-error {
  flex-direction: column;
  gap: 8px;
}
.retry-btn {
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 4px;
  border: 1px solid var(--border-color, #e0e0e0);
  background: var(--bg-primary, #fff);
  cursor: pointer;
  color: var(--accent-color, #4a90d9);
}
.wt-card-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
```

**Step 2: Commit**

```bash
git add web/src/components/git/GitWorktreeList.vue
git commit -m "feat: add GitWorktreeList component with collapsible section"
```

---

### Task 8: Frontend — `GitBranchRow.vue`

**Files:**
- Create: `web/src/components/git/GitBranchRow.vue`

**Step 1: Create component**

```vue
<template>
  <div
    class="git-branch-row"
    :class="{ current: branch.isCurrent, switching }"
    @click="handleClick"
  >
    <div class="branch-main">
      <span v-if="branch.isDefault" class="branch-default-badge">{{ t('git.manage.default') }}</span>
      <span class="branch-name">{{ branch.name }}</span>
      <span v-if="branch.isCurrent" class="branch-current-indicator">{{ t('git.manage.current') }}</span>
    </div>
    <div class="branch-track">
      <span v-if="branch.ahead > 0" class="track-ahead">{{ t('git.manage.ahead', { n: branch.ahead }) }}</span>
      <span v-if="branch.behind > 0" class="track-behind">{{ t('git.manage.behind', { n: branch.behind }) }}</span>
    </div>
    <div v-if="switching" class="branch-spinner">
      <div class="spinner" style="width:14px;height:14px;border-width:2px;" />
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  branch: { type: Object, required: true },
  disabled: Boolean,
})

const emit = defineEmits(['switch'])
const { t } = useI18n()
const switching = ref(false)

function handleClick() {
  if (props.branch.isCurrent || props.disabled || switching.value) return
  switching.value = true
  emit('switch', props.branch)
  // Parent will reset switching after response, or timeout after 5s
  setTimeout(() => { switching.value = false }, 5000)
}
</script>

<style scoped>
.git-branch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  min-height: 44px;
  cursor: pointer;
  transition: background 0.15s;
  border-bottom: 1px solid var(--border-color, #f0f0f0);
}
.git-branch-row:hover:not(.current):not(.switching) {
  background: var(--bg-secondary, #f5f5f5);
}
.git-branch-row.current {
  background: var(--bg-accent-subtle, rgba(74, 144, 217, 0.06));
  cursor: default;
}
.git-branch-row.switching {
  opacity: 0.7;
  cursor: wait;
}
.branch-main {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}
.branch-default-badge {
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--accent-color, #4a90d9);
  color: #fff;
  white-space: nowrap;
  flex-shrink: 0;
}
.branch-name {
  font-size: 13px;
  color: var(--text-primary, #1a1a1a);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.branch-current-indicator {
  font-size: 11px;
  color: var(--accent-color, #4a90d9);
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
}
.branch-track {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.track-ahead, .track-behind {
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}
.track-ahead {
  color: var(--success-color, #28a745);
}
.track-behind {
  color: var(--warning-color, #c69500);
}
.branch-spinner {
  flex-shrink: 0;
}
</style>
```

**Step 2: Commit**

```bash
git add web/src/components/git/GitBranchRow.vue
git commit -m "feat: add GitBranchRow component"
```

---

### Task 9: Frontend — `GitBranchList.vue`

**Files:**
- Create: `web/src/components/git/GitBranchList.vue`

**Step 1: Create component**

```vue
<template>
  <div class="git-branch-list" :class="{ collapsed }">
    <div class="section-header" @click="toggleCollapse">
      <span class="section-title">{{ t('git.manage.branches') }}</span>
      <span v-if="branches.length > 0" class="section-count">{{ branches.length }}</span>
      <span v-if="stashCount > 0" class="section-stash-badge" :title="t('git.manage.stashCount', { count: stashCount })">📦 {{ stashCount }}</span>
      <ChevronDown v-if="!collapsed" :size="14" class="section-chevron" />
      <ChevronRight v-else :size="14" class="section-chevron" />
    </div>
    <div v-if="!collapsed" class="section-body">
      <div v-if="loading" class="section-loading">
        <div class="spinner" style="width:18px;height:18px;border-width:2px;" />
      </div>
      <div v-else-if="error" class="section-error">
        <span>{{ t('git.manage.loadError') }}</span>
        <button class="retry-btn" @click="$emit('retry')">{{ t('git.manage.retry') }}</button>
      </div>
      <div v-else-if="branches.length === 0" class="section-empty">
        {{ t('git.manage.noBranches') }}
      </div>
      <div v-else class="branch-list">
        <GitBranchRow
          v-for="b in sortedBranches"
          :key="b.name"
          :branch="b"
          :disabled="checkoutInProgress"
          @switch="$emit('switch-branch', $event)"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronRight } from 'lucide-vue-next'
import GitBranchRow from './GitBranchRow.vue'

const props = defineProps({
  branches: { type: Array, default: () => [] },
  stashCount: { type: Number, default: 0 },
  loading: Boolean,
  error: Boolean,
  checkoutInProgress: Boolean,
  initialCollapsed: Boolean,
})

defineEmits(['switch-branch', 'retry'])

const { t } = useI18n()
const collapsed = ref(props.initialCollapsed)

// Sort: default branch first, current branch next, then alphabetical
const sortedBranches = computed(() => {
  const arr = [...props.branches]
  arr.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return arr
})

function toggleCollapse() {
  collapsed.value = !collapsed.value
  try {
    localStorage.setItem('git-branch-collapsed', collapsed.value ? '1' : '0')
  } catch (_) {}
}

watch(() => props.initialCollapsed, (val) => {
  try {
    const stored = localStorage.getItem('git-branch-collapsed')
    if (stored !== null) collapsed.value = stored === '1'
  } catch (_) {}
}, { immediate: true })
</script>

<style scoped>
.git-branch-list {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}
.section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary, #666);
  flex-shrink: 0;
}
.section-header:hover {
  background: var(--bg-secondary, #f5f5f5);
}
.section-count {
  font-size: 11px;
  background: var(--bg-secondary, #e0e0e0);
  padding: 0 6px;
  border-radius: 10px;
  color: var(--text-muted, #999);
  font-weight: 400;
}
.section-stash-badge {
  font-size: 11px;
  color: var(--text-muted, #999);
  cursor: default;
}
.section-chevron {
  margin-left: auto;
  color: var(--text-muted, #999);
}
.section-body {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.section-loading, .section-empty, .section-error {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px 0;
  font-size: 13px;
  color: var(--text-muted, #999);
}
.section-error {
  flex-direction: column;
  gap: 8px;
}
.retry-btn {
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 4px;
  border: 1px solid var(--border-color, #e0e0e0);
  background: var(--bg-primary, #fff);
  cursor: pointer;
  color: var(--accent-color, #4a90d9);
}
.branch-list {
  padding: 0 0 8px 0;
}
</style>
```

**Step 2: Commit**

```bash
git add web/src/components/git/GitBranchList.vue
git commit -m "feat: add GitBranchList component with collapsible section and sorting"
```

---

### Task 10: Frontend — `GitManageContent.vue` (container)

**Files:**
- Create: `web/src/components/git/GitManageContent.vue`

**Step 1: Create component**

This is the main container that orchestrates worktree list + branch list + checkout logic + worktree switch dialog.

```vue
<template>
  <div class="git-manage-content">
    <GitWorktreeList
      :worktrees="store.state.gitWorktrees"
      :loading="worktreesLoading"
      :error="worktreesError"
      :initial-collapsed="worktreesCollapsed"
      @switch-worktree="onSwitchWorktree"
      @retry="loadWorktrees"
    />
    <GitBranchList
      :branches="store.state.gitBranches"
      :stash-count="store.state.gitStashCount"
      :loading="branchesLoading"
      :error="branchesError"
      :checkout-in-progress="checkoutInProgress"
      :initial-collapsed="false"
      @switch-branch="onSwitchBranch"
      @retry="loadBranches"
    />

    <!-- Checkout options BottomSheet (dirty worktree) -->
    <BottomSheet :open="showCheckoutSheet" compact @close="showCheckoutSheet = false" :title="t('git.manage.switchBranch')">
      <div class="checkout-sheet-body">
        <p class="checkout-sheet-msg">{{ t('git.manage.dirty', { count: dirtyCount }) }}</p>
        <button class="checkout-option-btn stash-btn" @click="doCheckout('stash')" :disabled="checkoutInProgress">
          <span v-if="checkoutInProgress" class="spinner" style="width:14px;height:14px;border-width:2px;" />
          {{ t('git.manage.stashSwitch') }}
        </button>
        <button class="checkout-option-btn force-btn" @click="confirmForceCheckout" :disabled="checkoutInProgress">
          {{ t('git.manage.forceSwitch') }}
        </button>
      </div>
      <template #footer>
        <button class="checkout-cancel-btn" @click="showCheckoutSheet = false">{{ t('common.cancel') }}</button>
      </template>
    </BottomSheet>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { store } from '@/stores/app.ts'
import { apiPost } from '@/utils/api.ts'
import { useDialog } from '@/composables/useDialog.ts'
import BottomSheet from '@/components/common/BottomSheet.vue'
import GitWorktreeList from './GitWorktreeList.vue'
import GitBranchList from './GitBranchList.vue'

const { t } = useI18n()
const dialog = useDialog()

const worktreesLoading = ref(false)
const worktreesError = ref(false)
const branchesLoading = ref(false)
const branchesError = ref(false)
const checkoutInProgress = ref(false)

// Checkout sheet state
const showCheckoutSheet = ref(false)
const pendingBranch = ref(null)
const dirtyCount = ref(0)

// Worktree section: auto-collapse if only 1 worktree
const worktreesCollapsed = ref(false)

async function loadWorktrees() {
  worktreesLoading.value = true
  worktreesError.value = false
  try {
    await store.loadGitWorktrees()
    // Auto-collapse if only 1 worktree
    worktreesCollapsed.value = store.state.gitWorktrees.length <= 1
  } catch (_) {
    worktreesError.value = true
  } finally {
    worktreesLoading.value = false
  }
}

async function loadBranches() {
  branchesLoading.value = true
  branchesError.value = false
  try {
    await store.loadGitBranches()
  } catch (_) {
    branchesError.value = true
  } finally {
    branchesLoading.value = false
  }
}

onMounted(async () => {
  await Promise.all([loadWorktrees(), loadBranches()])
})

// --- Worktree switch ---
async function onSwitchWorktree(wt) {
  const confirmed = await dialog.confirm(
    t('git.manage.switchWorktreeConfirm', { path: wt.displayPath, branch: wt.branch }),
    { title: t('git.manage.switchWorktree') }
  )
  if (!confirmed) return
  await store.setProject(wt.path)
  // setProject does window.location.reload(), this line is unreachable
}

// --- Branch switch ---
async function onSwitchBranch(branch) {
  checkoutInProgress.value = true
  try {
    const result = await apiPost('/api/git/checkout', { branch: branch.name })
    if (result.success) {
      // Success — refresh state
      await store.loadGitBranch()
      await Promise.all([loadBranches(), loadWorktrees()])
    } else if (result.error === 'dirty_worktree') {
      // Show checkout options sheet
      pendingBranch.value = branch
      dirtyCount.value = result.untrackedCount || 0
      showCheckoutSheet.value = true
    }
  } catch (_) {
    // Network error, ignore
  } finally {
    checkoutInProgress.value = false
  }
}

async function doCheckout(mode) {
  if (!pendingBranch.value) return
  checkoutInProgress.value = true
  showCheckoutSheet.value = false
  try {
    const result = await apiPost('/api/git/checkout', {
      branch: pendingBranch.value.name,
      stash: mode === 'stash',
      force: mode === 'force',
    })
    if (result.success) {
      await store.loadGitBranch()
      await Promise.all([loadBranches(), loadWorktrees()])
    }
  } catch (_) {
    // Ignore
  } finally {
    checkoutInProgress.value = false
    pendingBranch.value = null
  }
}

async function confirmForceCheckout() {
  const confirmed = await dialog.confirm(
    t('git.manage.forceSwitchConfirm'),
    { dangerous: true }
  )
  if (!confirmed) return
  await doCheckout('force')
}
</script>

<style scoped>
.git-manage-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.checkout-sheet-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 8px 0;
}
.checkout-sheet-msg {
  font-size: 13px;
  color: var(--text-secondary, #666);
  margin: 0;
}
.checkout-option-btn {
  width: 100%;
  padding: 10px;
  border-radius: 6px;
  border: 1px solid var(--border-color, #e0e0e0);
  background: var(--bg-primary, #fff);
  font-size: 14px;
  cursor: pointer;
  text-align: center;
}
.checkout-option-btn:disabled {
  opacity: 0.6;
  cursor: wait;
}
.stash-btn {
  color: var(--accent-color, #4a90d9);
  border-color: var(--accent-color, #4a90d9);
}
.force-btn {
  color: var(--danger-color, #dc3545);
  border-color: var(--danger-color, #dc3545);
}
.checkout-cancel-btn {
  width: 100%;
  padding: 10px;
  border-radius: 6px;
  border: none;
  background: var(--bg-secondary, #f5f5f5);
  font-size: 14px;
  cursor: pointer;
}
</style>
```

**Step 2: Commit**

```bash
git add web/src/components/git/GitManageContent.vue
git commit -m "feat: add GitManageContent container with worktree/branch switch logic"
```

---

### Task 11: Frontend — Integrate into `GitHistoryContent.vue` breadcrumb navigation

**Files:**
- Modify: `web/src/components/git/GitHistoryContent.vue`
- Modify: `web/src/components/git/GitBreadcrumb.vue`

**Step 1: Add `manage` view to GitHistoryContent**

In `GitHistoryContent.vue`, add a `manage` entry button in the commit list header area. Add a new `v-else-if="currentView === 'manage'"` template section.

Key changes:
1. Import `GitManageContent` component
2. Add a manage button next to the refresh button in `GitCommitList` (emit a new `manage` event), OR add a button directly in the commit list header
3. Add the manage view template
4. Add `navigateToManage()` function that sets `currentView.value = 'manage'`
5. In `drillBack()`, handle `'manage'` → `'commits'`

**In the template**, after the `diff` view block, add:

```html
<!-- View: worktree & branch management -->
<div v-else-if="currentView === 'manage'" class="drilldown-page">
  <div class="drilldown-header">
    <GitBreadcrumb mode="project" current-view="manage" @navigate="drillBack" />
  </div>
  <GitManageContent />
</div>
```

**In the script**, add:
- Import `GitManageContent`
- Add a function `navigateToManage() { currentView.value = 'manage' }`
- In `drillBack()`, add case: if `view === 'commits'` and current view is `manage`, go to `commits`

**Step 2: Update GitBreadcrumb to handle `manage` view**

In `GitBreadcrumb.vue`, update the root crumb to also be active when currentView is `commits` (not when it's `manage`):

In the template, the existing root crumb click already navigates to `'commits'`. Add a new crumb for the manage view:

After the root crumb, add:

```html
<!-- Manage crumb (shown when in manage view) -->
<template v-if="currentView === 'manage'">
  <span class="git-crumb-sep">›</span>
  <span class="git-crumb current">{{ t('git.manage.title') }}</span>
</template>
```

**Step 3: Add manage entry point in GitCommitList**

In `GitCommitList.vue`, add a new button in the header next to the refresh button:

```html
<button
  v-if="commits.length > 0 || isGit"
  class="drilldown-refresh-btn"
  :title="t('git.manage.title')"
  @click.stop="$emit('manage')"
>
  <GitBranch :size="14" />
</button>
```

Import `GitBranch` from `lucide-vue-next`. Add `'manage'` to emits.

Then in `GitHistoryContent.vue`, handle the `@manage` event:

```html
<GitCommitList ... @manage="navigateToManage" />
```

**Step 4: Test manually**

Run dev server, navigate to history tab, click the GitBranch icon button, verify manage view loads with worktree and branch lists. Click breadcrumb "提交列表" to go back.

**Step 5: Commit**

```bash
git add web/src/components/git/GitHistoryContent.vue web/src/components/git/GitBreadcrumb.vue web/src/components/git/GitCommitList.vue
git commit -m "feat: integrate GitManageContent into breadcrumb navigation"
```

---

### Task 12: Backend — Fix writeJSON call in checkout handler

**Files:**
- Modify: `internal/handler/git.go`

**Step 1: Fix bug**

In the `ServeGitCheckout` handler, the `dirty_worktree` error response is missing the `w` parameter:

```go
// Before (broken):
writeJSON(http.StatusOK, map[string]interface{}{...})

// After (fixed):
writeJSON(w, http.StatusOK, map[string]interface{}{...})
```

**Step 2: Commit**

```bash
git add internal/handler/git.go
git commit -m "fix: add missing http.ResponseWriter in checkout dirty_worktree response"
```

---

### Task 13: End-to-end manual testing & polish

**Step 1: Build and start server**

```bash
./build.sh && ./server.sh
```

**Step 2: Test scenarios**

1. **Single worktree, clean repo** — Verify manage view shows 1 worktree (collapsed) + branch list with current branch highlighted
2. **Single worktree, dirty repo** — Verify worktree shows dirty badge
3. **Branch switch (clean)** — Click a different branch, verify toast + branch list refreshes
4. **Branch switch (dirty)** — Click a branch with dirty working tree, verify BottomSheet with stash/force/cancel options
5. **Force checkout** — Verify second confirm dialog (dangerous)
6. **Breadcrumb navigation** — Click manage button → see manage view → click "提交列表" breadcrumb → return to commit list → data still there
7. **Non-git directory** — Verify manage view shows git init prompt
8. **Multiple worktrees** — (if available) Verify worktree cards + switch dialog + page reload

**Step 3: Fix any issues found during testing**

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete git worktree & branch management view"
```
