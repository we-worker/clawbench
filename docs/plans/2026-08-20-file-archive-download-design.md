# File Archive Download Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add zip archive download support to the file manager — both from multi-select batch action bar and from directory context menu (long-press).

**Architecture:** Backend adds a `POST /api/file/archive` endpoint that accepts an array of paths, streams a zip archive using Go's `archive/zip` + `filepath.Walk`, and writes directly to the HTTP response. Frontend adds a "Pack & Download" button to the multi-select action bar and a "Pack & Download" item to the directory context menu, both calling a shared `doArchive()` function that POSTs to the new endpoint and triggers a blob download.

**Tech Stack:** Go `archive/zip`, `filepath.Walk`; Vue 3, `fetch` + `Blob` + `<a>` click download; i18n (en/zh)

---

### Task 1: Backend — Add archive endpoint handler

**Files:**
- Create: `internal/handler/file_archive.go`
- Modify: `internal/handler/handler.go` (register new route)

**Step 1: Create the handler file**

```go
package handler

import (
	"archive/zip"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"clawbench/internal/middleware"
	"clawbench/internal/model"
)

// ServeFileArchive handles POST /api/file/archive
// Accepts { paths: ["rel/path1", "rel/path2"] } and streams a zip archive.
// Paths can be files or directories; each is walked and added to the zip.
func ServeFileArchive(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	var req struct {
		Paths []string `json:"paths"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if len(req.Paths) == 0 {
		writeLocalizedErrorf(w, r, http.StatusBadRequest, "MissingPath")
		return
	}

	// Resolve all paths to absolute, validate access
	watchAbs, _ := filepath.Abs(model.WatchDir)
	type absEntry struct {
		absPath string
		relPath string // original relative path for zip entry prefix
	}
	var entries []absEntry
	for _, p := range req.Paths {
		absPath, ok := resolveAbsPath(w, r, p)
		if !ok {
			return
		}
		entries = append(entries, absEntry{absPath: absPath, relPath: p})
	}

	// Compute a friendly zip filename from the first entry
	zipName := "archive.zip"
	if len(entries) == 1 {
		base := filepath.Base(entries[0].relPath)
		// Remove trailing slash for directories
		base = strings.TrimRight(base, "/")
		if base != "" && base != "." {
			zipName = base + ".zip"
		}
	}

	// Set response headers before writing any data
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, zipName))
	// Prevent caching of dynamic archive
	w.Header().Set("Cache-Control", "no-store")

	// Stream zip directly to response writer
	zw := zip.NewWriter(w)
	defer zw.Close()

	written := 0
	for _, entry := range entries {
		info, err := os.Stat(entry.absPath)
		if err != nil {
			slog.Warn("archive: skip missing path", "path", entry.absPath, "err", err)
			continue
		}

		if info.IsDir() {
			// Walk directory, adding all files
			base := filepath.Base(entry.absPath)
			err := filepath.Walk(entry.absPath, func(path string, fi os.FileInfo, err error) error {
				if err != nil {
					return err
				}
				// Compute the zip entry path relative to the parent of the dir
				rel, err := filepath.Rel(filepath.Dir(entry.absPath), path)
				if err != nil {
					return err
				}
				// Normalize to forward slashes for zip spec
				rel = filepath.ToSlash(rel)

				if fi.IsDir() {
					// Add directory entry (trailing slash)
					_, err = zw.Create(rel + "/")
					return err
				}
				return addFileToZip(zw, path, rel, fi)
			})
			if err != nil {
				slog.Warn("archive: walk error", "dir", entry.absPath, "err", err)
			}
		} else {
			// Single file — use its base name in the zip root
			rel := filepath.Base(entry.absPath)
			// If multiple paths, prefix with parent dir to avoid name collisions
			if len(entries) > 1 {
				parentRel := filepath.Dir(entry.relPath)
				if parentRel != "." {
					rel = filepath.ToSlash(parentRel) + "/" + filepath.Base(entry.absPath)
				}
			}
			if err := addFileToZip(zw, entry.absPath, rel, info); err != nil {
				slog.Warn("archive: add file error", "path", entry.absPath, "err", err)
			}
		}
		written++
	}

	if written == 0 {
		// Nothing was written — the zip would be invalid; return error instead
		// We already set headers, so just close the zip (empty but valid)
		slog.Warn("archive: no files written")
	}
}

// addFileToZip adds a single file to the zip writer.
func addFileToZip(zw *zip.Writer, absPath, zipRelPath string, fi os.FileInfo) error {
	fh, err := zip.FileInfoHeader(fi)
	if err != nil {
		return err
	}
	fh.Name = zipRelPath
	fh.Method = zip.Deflate // use compression

	w, err := zw.CreateHeader(fh)
	if err != nil {
		return err
	}

	f, err := os.Open(absPath)
	if err != nil {
		return err
	}
	defer f.Close()

	_, err = io.Copy(w, f)
	return err
}
```

**Step 2: Register the route**

In `internal/handler/handler.go`, add after the existing `/api/file/move` line:

```go
register("/api/file/archive", middleware.Auth(ServeFileArchive))
```

**Step 3: Build and verify**

Run: `cd /home/xulongzhe/projects/clawbench && go build -o clawbench ./cmd/server`
Expected: compiles without errors

**Step 4: Commit**

```bash
git add internal/handler/file_archive.go internal/handler/handler.go
git commit -m "feat: add POST /api/file/archive endpoint for zip streaming"
```

---

### Task 2: Backend — Add i18n keys for archive errors

**Files:**
- Modify: `internal/i18n/locales/active.en.yaml`
- Modify: `internal/i18n/locales/active.zh.yaml`

**Step 1: Add English locale entry**

In `active.en.yaml`, add in the appropriate section (near existing file error keys):

```yaml
ArchiveFailed: "Failed to create archive"
```

**Step 2: Add Chinese locale entry**

In `active.zh.yaml`, add in the same position:

```yaml
ArchiveFailed: "打包失败"
```

**Step 3: Commit**

```bash
git add internal/i18n/locales/active.en.yaml internal/i18n/locales/active.zh.yaml
git commit -m "feat: add i18n keys for archive errors"
```

---

### Task 3: Frontend — Add i18n keys for archive UI

**Files:**
- Modify: `web/src/i18n/locales/en.ts`
- Modify: `web/src/i18n/locales/zh.ts`

**Step 1: Add English i18n keys**

In `en.ts`, add inside `file.context` object:

```typescript
archiveDir: 'Pack & download',
```

Add inside `file.multiSelect` object:

```typescript
archive: 'Pack & download',
```

Add inside `file.toast` object:

```typescript
archiving: 'Packing {n} items...',
archiveDone: 'Download ready',
archiveFailed: 'Pack failed',
archiveFailedDetail: 'Pack failed: {error}',
```

**Step 2: Add Chinese i18n keys**

In `zh.ts`, add inside `file.context` object:

```typescript
archiveDir: '打包下载',
```

Add inside `file.multiSelect` object:

```typescript
archive: '打包下载',
```

Add inside `file.toast` object:

```typescript
archiving: '正在打包 {n} 个文件...',
archiveDone: '打包下载完成',
archiveFailed: '打包失败',
archiveFailedDetail: '打包失败: {error}',
```

**Step 3: Commit**

```bash
git add web/src/i18n/locales/en.ts web/src/i18n/locales/zh.ts
git commit -m "feat: add i18n keys for archive download UI"
```

---

### Task 4: Frontend — Add archive download logic to FileManagerContent

**Files:**
- Modify: `web/src/components/file/FileManagerContent.vue`

This is the core task. Changes:

1. **Add `Archive` icon import** from lucide-vue-next (use `Package` icon for "pack")
2. **Add `doArchive(paths)` function** — POST to `/api/file/archive`, download as blob
3. **Add `doArchiveDir()` function** — convenience wrapper for context menu (single directory)
4. **Add `doBatchArchive()` function** — multi-select batch wrapper
5. **Add "Pack & download" button to multi-select action bar** (template)
6. **Add "Pack & download" menu item to directory context menu** (template)

**Step 1: Add icon import**

In the existing import line from lucide-vue-next, add `Package`:

Change:
```typescript
import { Folder, ArrowDownAz, ..., LayoutGrid, FileVideo } from 'lucide-vue-next'
```
To:
```typescript
import { Folder, ArrowDownAz, ..., LayoutGrid, FileVideo, Package } from 'lucide-vue-next'
```

**Step 2: Add the archive download function**

After the `doDownload()` function (~line 780), add:

```javascript
// ── Archive download (zip) ──
async function doArchive(paths, zipName) {
    if (!paths.length) return
    if (toast) toast.show(t('file.toast.archiving', { n: paths.length }), { icon: '📦', type: 'info', duration: 0 })
    try {
        const resp = await fetch('/api/file/archive', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths }),
        })
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ error: 'Unknown error' }))
            if (toast) toast.show(t('file.toast.archiveFailedDetail', { error: err.error || '' }), { icon: '❌', type: 'error', duration: 3000 })
            return
        }
        const blob = await resp.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = zipName || 'archive.zip'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
        if (toast) toast.show(t('file.toast.archiveDone'), { icon: '✅', type: 'success', duration: 1500 })
    } catch (err) {
        if (toast) toast.show(t('file.toast.archiveFailed'), { icon: '❌', type: 'error', duration: 2000 })
    }
}

function doArchiveDir() {
    if (!ctxMenu.entry || ctxMenu.entry.type !== 'dir') return
    ctxMenu.visible = false
    const zipName = ctxMenu.entry.name + '.zip'
    doArchive([ctxMenu.entry.path], zipName)
}

function doBatchArchive() {
    const paths = [...multiSelect.selected]
    if (!paths.length) return
    const zipName = paths.length === 1
        ? paths[0].split('/').pop() + '.zip'
        : 'archive.zip'
    doArchive(paths, zipName)
    exitMultiSelect()
}
```

**Step 3: Add "Pack & download" to multi-select action bar**

In the template, the multi-select action bar (around line 184-197) currently has Copy, Cut, Delete buttons. Add the archive button before Delete:

```html
<!-- Multi-select bottom action bar -->
<div v-if="multiSelect.active && multiSelect.selected.size > 0" class="ms-action-bar">
  <button class="ms-action-btn" @click="doBatchCopy">
    <Copy :size="14" />
    {{ t('file.context.copy') }}
  </button>
  <button class="ms-action-btn" @click="doBatchCut">
    <Scissors :size="14" />
    {{ t('file.context.cut') }}
  </button>
  <button class="ms-action-btn" @click="doBatchArchive">
    <Package :size="14" />
    {{ t('file.multiSelect.archive') }}
  </button>
  <button class="ms-action-btn ms-danger" @click="doBatchDelete">
    <Trash2 :size="14" />
    {{ t('common.delete') }}
  </button>
</div>
```

**Step 4: Add "Pack & download" to directory context menu**

In the context menu template (around line 228-246), add the archive item for directories. It should appear after the Download item (which is files-only) and before Delete:

```html
<div class="context-menu-item" v-if="ctxMenu.entry.type !== 'dir'" @click.stop="doDownload">
  <Download :size="14" />
  {{ t('common.download') }}
</div>
<div class="context-menu-item" v-if="ctxMenu.entry.type === 'dir'" @click.stop="doArchiveDir">
  <Package :size="14" />
  {{ t('file.context.archiveDir') }}
</div>
```

**Step 5: Build and test**

Run: `cd /home/xulongzhe/projects/clawbench && ./build.sh`
Expected: builds without errors

**Step 6: Manual test**

1. Start the server: `./server.sh`
2. Open the file manager in browser
3. Test 1: Right-click a directory → "Pack & download" should appear → click it → zip should download
4. Test 2: Click multi-select button → select several files/dirs → "Pack & download" button in action bar → click → zip should download
5. Verify zip contents match the selected items

**Step 7: Commit**

```bash
git add web/src/components/file/FileManagerContent.vue
git commit -m "feat: add archive download to file manager multi-select and context menu"
```

---

### Task 5: Frontend — Android native bridge support

**Files:**
- Modify: `web/src/components/file/FileManagerContent.vue`

The existing `doDownload()` function checks for `isAppMode` and uses `window.AndroidNative.downloadFile()`. For archive downloads, the blob approach works in Android WebView too, so no special native bridge call is needed — the blob download path is universal. However, we should verify this works on Android.

No code changes needed — the `fetch + blob + <a>` pattern works in Android WebView. This task is a verification note.

---

### Task 6: Edge cases and polish

**Files:**
- Modify: `web/src/components/file/FileManagerContent.vue` (if needed)

Edge cases to verify:
1. **Empty selection** — `doBatchArchive` checks `paths.length`, should not fire
2. **Very large files** — zip.Deflate compression handles this, but download may take time; the toast with `duration: 0` stays until completion
3. **Symlinks** — `filepath.Walk` follows symlinks by default; `resolveAbsPath` validates the target, so this is safe
4. **Hidden files** — included in archive (user explicitly selected them)
5. **Duplicate names** — when multiple files have the same base name, the `filepath.Dir` prefix is used for disambiguation in the zip

If any issues found, fix them in this task.

**Step 1: Commit any fixes**

```bash
git add -u
git commit -m "fix: address edge cases in archive download"
```
