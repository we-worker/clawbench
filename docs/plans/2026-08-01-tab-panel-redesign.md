# Tab Panel Architecture Redesign

## Summary

Replace the current BottomSheet drawer overlay pattern with a full-screen tab panel system. All major feature modules become equal tab panels occupying the full content area, switched via the bottom Dock acting as a tab bar. File browsing becomes its own tab, making the architecture consistent and clearer.

## Current Architecture

- 5 BottomSheet drawers (Chat, Files, History, Proxy, Terminal) slide up from bottom, covering the main content area
- FileViewer renders inline in `.content-area` (not a drawer)
- Only one drawer open at a time (mutual exclusion via `drawerStates` map)
- Auxiliary panels (Session, Task, Toc, Search, file-level GitHistory) are compact BottomSheet overlays
- Bottom Dock has 5 buttons for drawer toggling
- No tab component exists; BottomSheet compact mode CSS hints at anticipated tab bar support

## New Architecture

### Layout Model

- All panels are full-screen tab panels occupying the entire space between header and dock
- Bottom Dock becomes the tab bar with 6 buttons
- Panels switch with fade in/out animation (150-200ms)
- All previously opened panels preserved via `v-show` (no DOM destruction)
- Auxiliary panels remain as BottomSheet compact overlays, rendered as children of their parent tab

### Tab Inventory

| Order | Icon | activeTab | Panel Content | Auxiliary Overlays |
|-------|------|-----------|---------------|--------------------|
| 1 | MessageSquare | `chat` | ChatPanel | SessionDrawer, TaskDrawer |
| 2 | FolderOpen | `browse` | FileManager (directory list) | None |
| 3 | FileText | `viewer` | FileViewer / WelcomeView | TocDrawer, SearchDrawer, file-level GitHistory |
| 4 | GitBranch | `history` | GitHistoryDrawer (project-level) | None |
| 5 | EthernetPort | `proxy` | ProxyPanel | None |
| 6 | Terminal | `terminal` | TerminalPanel | None |

### Component Changes

#### New: TabPanel Component

Simple container component that visually replicates BottomSheet's internal layout:
- `v-show` based on `activeTab === tabId`
- Fade transition via CSS (`transition: opacity 150ms`)
- `everOpened` flag for lazy mounting (render content only after first activation, then `v-show`)
- No overlay, no slide animation, no teleport
- **Internal structure mirrors BottomSheet full mode**: same `bs-header` (28px sticky header with icon/title/description slots), same `bs-body` (flex: 1, overflow hidden), same `bs-footer` slot. Extract the internal layout CSS from BottomSheet into shared classes so TabPanel panels look identical to the current drawer content
- Panel background, padding, header styling all inherited from BottomSheet's internal CSS — users see zero visual difference inside the panel

#### Removed: BottomSheet Full Mode

- 6 main panels no longer wrapped in `<BottomSheet>`
- BottomSheet compact mode remains for auxiliary overlays (Session, Task, Toc, Search, GitHistory)
- BottomSheet full mode CSS/code can be cleaned up after migration
- **Visual continuity**: TabPanel reuses BottomSheet's internal layout CSS (header, body, footer slots, background, padding). The internal content looks exactly the same — only the outer shell (overlay, slide animation, teleport) is removed

#### Modified: App.vue

- `xxxOpen` boolean refs → single `activeTab` string ref (`chat` / `browse` / `viewer` / `history` / `proxy` / `terminal`)
- `drawerStates` map and `ensureDrawerOpen` logic removed
- `openDrawer(name)` → `activeTab = name`
- `.content-area` becomes tab container with multiple TabPanel children
- Dock buttons: 5 → 6, `activeTab` drives `.active` class
- QuoteQuestionBar stays in App.vue unchanged
- Global dialogs (ProjectDialog, FileDetailsDialog) stay in App.vue

#### Modified: FileManager

- Remove `<BottomSheet>` wrapper, expose content directly as tab panel
- Clicking a file sets `activeTab = 'viewer'` and passes file info (same as current `selectFile` emit, just changes the target)

#### Modified: FileViewer

- No longer conditionally rendered in `.content-area` alongside WelcomeView
- Becomes its own TabPanel (`activeTab = 'viewer'`)
- When no file is open, shows WelcomeView content inside the viewer tab
- FileHeader back button sets `activeTab = 'browse'`

#### Modified: ChatPanel

- Remove `<BottomSheet>` wrapper
- SessionDrawer and TaskDrawer become internal children (their open state managed within ChatPanel, not App.vue)

#### Modified: GitHistoryDrawer

- Project-level GitHistory becomes the `history` tab panel content (remove BottomSheet wrapper)
- File-level GitHistory remains a compact overlay, moved into the viewer tab panel as a child component

#### Modified: TerminalPanel

- Remove `<BottomSheet>` wrapper, expose content directly as tab panel

#### Modified: ProxyPanel

- Remove `<BottomSheet>` wrapper, expose content directly as tab panel

### State Management

- `activeTab: Ref<string>` — single source of truth for which panel is visible
- `everOpened: Record<string, boolean>` — lazy mount tracking per tab
- Auxiliary overlay open states sink into their parent tab components:
  - SessionDrawer `open` → ChatPanel internal state
  - TaskDrawer `open` → ChatPanel internal state
  - TocDrawer `open` → viewer panel internal state
  - SearchDrawer `open` → viewer panel internal state
  - File-level GitHistory `open` → viewer panel internal state
- QuoteQuestionBar state remains in App.vue (cross-panel interaction preserved as-is)

### CSS & Layout

- Extract BottomSheet internal layout CSS into shared classes (`.panel-header`, `.panel-body`, `.panel-footer`) that both TabPanel and BottomSheet compact mode can use
- TabPanel panels reuse the same header/body/footer structure and styling as current BottomSheet full mode — no visual regression
- Remove BottomSheet full-mode overlay/slide CSS (the outer shell only; internal layout CSS preserved via shared classes)
- `.content-area` becomes `position: relative` container for TabPanel children
- Each TabPanel: `position: absolute, inset: 0`, `v-show` toggle, `transition: opacity 150ms`
- Dock: 6 buttons with slightly reduced spacing; active state enhanced (bottom indicator bar or filled background) for tab bar feel
- WelcomeView renders inside the viewer TabPanel when no file is open

### Cross-Panel Interactions

- **File browse → view:** Clicking a file in `browse` tab sets `activeTab = 'viewer'` and passes file info
- **File view → browse:** FileHeader back button sets `activeTab = 'browse'`
- **QuoteQuestionBar:** Preserved as-is in App.vue, cross-panel interaction unchanged
- **Chat unread badge:** Dock Chat button badge remains, driven by store state
- **Task running indicator:** Dock Chat button running animation remains

### Animation

- Panel switch: `opacity 0 → 1` over 150ms (fade in), leaving panel `1 → 0` over 150ms (fade out)
- No slide, no overlay backdrop
- Auxiliary compact overlays keep existing slide-up animation

### Default Behavior

- App starts with `activeTab = 'browse'` (file browser as landing view)
- No file open → viewer tab shows WelcomeView content

## Migration Steps

1. **Create TabPanel component** — Container with `v-show`, fade transition, `everOpened` lazy mount. Extract BottomSheet internal layout CSS into shared classes so TabPanel panels look identical to current drawer content
2. **Refactor App.vue state** — `xxxOpen` → `activeTab`, simplify Dock click handlers
3. **Migrate panels one by one** (each as a separate commit):
   - ChatPanel: remove BottomSheet, wrap in TabPanel, internalize SessionDrawer/TaskDrawer
   - FileManager: remove BottomSheet, wrap in TabPanel, update file click to set `activeTab = 'viewer'`
   - FileViewer: move from `.content-area` inline to TabPanel, integrate WelcomeView
   - GitHistoryDrawer: remove BottomSheet, wrap in TabPanel; file-level GitHistory moves into viewer panel
   - ProxyPanel: remove BottomSheet, wrap in TabPanel
   - TerminalPanel: remove BottomSheet, wrap in TabPanel
4. **Migrate auxiliary overlays** — Move Session/Task into ChatPanel, Toc/Search/file-GitHistory into viewer panel
5. **Dock visual upgrade** — 6 buttons layout, active state enhancement
6. **Cleanup** — Remove BottomSheet full-mode code/CSS, remove `drawerStates` map, remove unused `xxxOpen` refs

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| ChatPanel/TerminalPanel may depend on BottomSheet events/props | Audit each panel's BottomSheet usage before unwrapping; check `@close`, `:open`, slot usage |
| Auxiliary overlay event chains break when moved into child components | Verify emit chains; parent may need to pass down callbacks instead of App.vue handling directly |
| QuoteQuestionBar refs break after layout restructure | Test quote-question flow end-to-end after migration |
| 6 Dock buttons feel cramped on narrow screens | Reduce icon size slightly, reduce gap; test on 320px viewport |
| Fade animation causes brief flash if panels have different background colors | Ensure all TabPanel backgrounds match; or use `will-change: opacity` for GPU compositing |

## Scope Exclusions

- No new features (History tab keeps existing commit/diff only)
- No routing changes (still no Vue Router)
- No changes to auxiliary overlay visual style (BottomSheet compact stays as-is)
- QuoteQuestionBar interaction unchanged
