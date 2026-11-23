# Page Strip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A RemNote marketplace plugin that puts a Firefox-style page thumbnail strip, with a Pages/Bookmarks switcher, in RemNote's right sidebar for the PDF or HTML document in the focused pane.

**Architecture:** Everything runs sandboxed in one `RightSidebar` widget (RemNote does not grant native mode; see `docs/spike-findings.md`). The widget follows the focused pane's document, renders thumbnails with pdf.js from the document's `UploadedFile` URL, and jumps by calling `scrollToReaderHighlight()` on the user's own highlights, which it indexes by page. Pure logic (bookmarks, highlight index, headings, render queue) lives in `src/lib` and is unit tested with `node --test`.

**Tech Stack:** TypeScript, React 17, `@remnote/plugin-sdk` 0.0.46, webpack 5 + esbuild-loader, `pdfjs-dist` 6.4.299, `node --test` running `.ts` directly.

**Spec:** `docs/superpowers/specs/2026-11-22-page-strip-design.md` (read with `docs/spike-findings.md`)

## Global Constraints

- PDF and HTML are equal first-class targets; v1 does not ship with HTML missing.
- **No writes to the knowledge base, of any kind** (owner, twice). Bookmarks go only in `plugin.storage.setSynced`. Scope stays `All / Read` or narrower.
- Bookmark value shape: `{ page: number }` (PDF), `{ headingIndex: number, text: string }` (HTML), keyed per document rem id.
- Placement: RemNote's right sidebar, own tab "Pages" (`WidgetLocation.RightSidebar`), following the focused pane's document.
- Jump rule: a tile or bookmark jumps to the first highlight on its page; with none, to the last highlighted page before it, with a toast "Page N: scroll down N - M pages"; with no highlights in the document, a toast "Page N". Never a silent click.
- No current-page indicator (not readable sandboxed).
- Firefox look: rounded panel, header with grid+chevron switcher left and centred title ("Pages" / "Bookmarks"), white page tiles with rounded corners, number pill centred on the bottom edge, bookmark icon top-right of each tile (faint on hover, filled when set), a small "jumps here" dot on tiles whose page has a highlight. Colours from `--rn-clr-*` tokens.
- No page-editing controls (checkboxes, "Manage", "+").
- Tiles fill the sidebar width, two columns above ~360px; current view (Pages/Bookmarks) in local storage.
- Every SDK read, fetch, fallback branch and storage call logs source + outcome via `log()` (prefix `[strip]`).
- Commits: Conventional Commits, author `mdeguzis <mdeguzis@gmail.com>`, no `Co-Authored-By` trailer, and **only after the owner approves the commit message**. Version bumps only at release.
- ASCII only in code comments, docs and commit messages.

## Review Focus

1. **A 500+ page PDF.** Opening it must not freeze RemNote; only tiles near the strip's viewport render, at most 2 renders in flight. Test in Task 4.
2. **RemNote synced storage returns `{}` for a never-set key.** That is "no bookmarks", not corruption. Test in Task 2.
3. **A highlight whose `Data` is not JSON or has no `position.pageNumber`.** It is skipped and logged once with its rem id; the rest still index. Test in Task 3.
4. **Switching documents or panes.** The panel switches to the newly focused document, cancels the old PDF load, and a non-reader document shows "Open a PDF or web page to see its pages". Focus moving into the sidebar keeps the last document. Test in Task 5.
5. **HTML page with no headings, or a bookmarked heading whose text changed.** No headings shows "No headings on this page"; a changed heading re-finds by text, else the bookmark shows "not found" rather than being dropped. Test in Task 3.

---

### Task 1: Scaffold and live-app spike (DONE except 1b)

Done 2026-11-22: scaffold, PDF probes, highlight probes, findings in `docs/spike-findings.md`, memory updated. The prototype `src/widgets/page_strip.tsx` shows real thumbnails.

- [ ] **Step 1b: HTML probe.** Add a probe command that, for the focused document, reports `Link` (`b`) `URL`/`FileURL` and `UploadedFile` (`f`) `URL`, fetches whichever exists and reports status, content type, byte length and the first 10 `h1`-`h3` from `new DOMParser().parseFromString(text, 'text/html')`; plus the document's descendants with `hasPowerup('hh')` and the first sample's parsed `Data` keys. Owner runs it on an imported web page and an uploaded `.html`, and tries "jump A" against an HTML highlight. Record in `docs/spike-findings.md` section 5 and memory.
- [ ] **Step 1c: Remove the spike.** Delete probe commands and `__pageStripSpike`; keep the prototype widget until Task 5 replaces it. Propose a commit message to the owner, commit on approval: `chore: scaffold plugin and record reader spike findings`.

### Task 2: Bookmark storage

**Files:**
- Create: `src/lib/types.ts`, `src/lib/bookmarks.ts`
- Test: `tests/bookmarks.test.mjs`

**Interfaces:**
- Produces:
  - `type DocKind = 'pdf' | 'html'`
  - `type PdfBookmark = { page: number }`, `type HtmlBookmark = { headingIndex: number; text: string }`, `type Bookmark = PdfBookmark | HtmlBookmark`
  - `bookmarkKey(docRemId: string): string` returns `` `bookmarks:${docRemId}` ``
  - `normalizeStoredBookmarks(raw: unknown, kind: DocKind): Bookmark[]` (pure)
  - `toggleBookmark(list: Bookmark[], b: Bookmark): Bookmark[]` (pure; sorted by page / headingIndex)
  - `loadBookmarks(plugin, docRemId, kind): Promise<Bookmark[]>`, `saveBookmarks(plugin, docRemId, list): Promise<void>`

- [ ] **Step 1: Write failing tests**: `'unset key {} means empty'` asserts `normalizeStoredBookmarks({}, 'pdf')` deep-equals `[]`; `'undefined means empty'`; `'array of non-objects throws naming the doc kind'`; `'toggle adds then removes'` for `{page: 4}`; `'toggle keeps page order'` (add 9, then 2, expect `[2, 9]`); `'html toggle matches on headingIndex and text'`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `src/lib/bookmarks.ts`. `loadBookmarks`/`saveBookmarks` log `source: 'storage.getSynced'` / `'storage.setSynced'` with `docRemId` and count.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** on owner approval: `feat: store page bookmarks in synced plugin storage`.

### Task 3: Highlight index, jump targets, HTML headings

**Files:**
- Create: `src/lib/highlights.ts`, `src/lib/headings.ts`
- Test: `tests/highlights.test.mjs`, `tests/headings.test.mjs`

**Interfaces:**
- Produces:
  - `pageOfHighlightData(data: string): number | null` (`position.pageNumber`, 1-based; `null` for non-JSON or missing/non-positive integer)
  - `type HighlightRef = { remId: string; page: number; y: number }` (`y` = `position.boundingRect.y1`, for ordering within a page)
  - `indexByPage(refs: HighlightRef[]): Map<number, HighlightRef>` (first highlight per page, smallest `y`)
  - `type JumpTarget = { kind: 'exact'; ref: HighlightRef } | { kind: 'before'; ref: HighlightRef; pagesBelow: number } | { kind: 'none' }`
  - `jumpTarget(page: number, index: Map<number, HighlightRef>): JumpTarget`
  - `type HeadingRecord = { tag: 'H1' | 'H2' | 'H3'; text: string }`, `type StripItem = { index: number; label: string; aspect: number; preview?: string }`
  - `headingsToItems(records: HeadingRecord[]): StripItem[]` (collapses whitespace, drops empty)
  - `refindHeading(items: StripItem[], b: HtmlBookmark): number | null`
  - The HTML highlight equivalents (`hh` powerup) per Task 1b's findings, same shapes.

- [ ] **Step 1: Write failing tests** with the verified sample shape `{"content":{...},"position":{"boundingRect":{"x1":24.48,"y1":262.16,"x2":103.79,"y2":272.16,"width":612,"height":792,"pageNumber":1},"rects":[...],"pageNumber":1}}`: page 1 parsed; `'{'` gives `null`; missing `pageNumber` gives `null`; `pageNumber: 0` gives `null`. `indexByPage` keeps the smallest `y` on a page. `jumpTarget(2, {1,2})` is exact; `jumpTarget(5, {1,2})` is `before` page 2 with `pagesBelow: 3`; `jumpTarget(1, {3})` is `none` (nothing before); empty index is `none`. Headings: drops `"   "`, collapses `"A\n  B"`, `[]` for none; `refindHeading` finds a moved heading by text, `null` when gone.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** on owner approval: `feat: index highlights by page and work out jump targets`.

### Task 4: Thumbnail render queue

**Files:**
- Create: `src/lib/renderQueue.ts`, `src/lib/pdfThumbs.ts` (move the prototype's queue and render code here)
- Test: `tests/renderQueue.test.mjs`

**Interfaces:**
- Produces:
  - `class RenderQueue { constructor(concurrency: number); request(index: number, job: () => Promise<void>): void; cancel(index: number): void }` (newest request runs first; duplicates ignored; a cancelled job can be requested again)
  - `openPdf(url: string, workerSrc: string): { promise: Promise<PdfHandle>; cancel(): void }`; `PdfHandle = { pageCount: number; aspect: number; renderThumb(i: number, canvas: HTMLCanvasElement, cssWidth: number): Promise<void> }`

- [ ] **Step 1: Write failing tests**: with `concurrency 2` and 10 deferred jobs, at most 2 run at once; the last requested runs before the first queued; `cancel(i)` before start means its job never runs, and a later `request(i)` runs it; a duplicate `request(3)` runs once; a rejecting job is logged and the next job still runs.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement**, fixing the prototype's cancel bug (a cancelled index stays in `known` once started).
- [ ] **Step 4: Run** `npm test && npm run build`. Expected: PASS, `pdf.worker.min.mjs` in `dist/`.
- [ ] **Step 5: Commit** on owner approval: `feat: lazy pdf thumbnail rendering`.

### Task 5: The Pages panel

**Files:**
- Create: `src/lib/document.ts`, `src/ui/Panel.tsx`, `src/ui/Tile.tsx`, `src/ui/Icon.tsx`, `src/ui/css.ts`
- Modify: `src/widgets/page_strip.tsx` (becomes a thin shell over `Panel`), `src/widgets/index.tsx` (widget, "Page Strip: open pages" command)
- Test: `tests/document.test.mjs`

**Interfaces:**
- Consumes: Tasks 2, 3, 4.
- Produces: `resolveDocument(sdk: DocSdk, docId: string | undefined, last: DocSource | undefined): Promise<DocSource | undefined>` where `DocSource = { kind: 'pdf'; docId: string; name: string; url: string } | { kind: 'html'; docId: string; name: string; url: string } | { kind: 'none'; docId: string }` and `DocSdk` wraps the four SDK reads (find rem, `f` slots, `b` slots, descendants with `n`/`hh` data) so tests can fake them. `undefined` docId returns `last`.

- [ ] **Step 1: Write failing tests** for `resolveDocument` with a fake `DocSdk`: a PDF rem resolves to `kind 'pdf'` with its URL; a plain note resolves to `kind 'none'`; `undefined` returns `last` unchanged; an imported web page resolves per Task 1b.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `document.ts`, then the panel to the Global Constraints look and jump rule. Copy: empty bookmarks "No bookmarks yet. Hover a page and click the bookmark in its corner."; HTML without headings "No headings on this page"; non-reader document "Open a PDF or web page to see its pages"; PDF load failure "Could not read this PDF" plus the reason; missing HTML bookmark shows its saved text with "not found". Highlights re-index on `AppEvents.RemChanged` for the document (debounced) so a new highlight becomes a jump target without reopening.
- [ ] **Step 4: Run** `npm test && npm run check-types`. Expected: PASS.
- [ ] **Step 5: Manual check with the owner**: jetta.pdf (tiles 1 and 2 jump exactly; tile 5 jumps to page 2 with the "scroll down" toast), a PDF with no highlights, two panes (click between), a web page, an `.html`; light and dark; Sakura on.
- [ ] **Step 6: Commit** on owner approval: `feat: page strip sidebar with pages and bookmarks views`.

### Task 6: Diagnostics, README, scope, release prep

**Files:**
- Create: `CHANGELOG.md`, `src/ui/Diagnostics.tsx` (behind a "Verbose logging" setting: SDK version, document kind and URL host, highlight count per page, last jump target and outcome)
- Modify: `README.md`, `public/manifest.json`, `src/widgets/index.tsx`

- [ ] **Step 1: Narrow the scope.** Upload zips (patch bump each time) to find the narrowest read-only scope that still reads the document's powerups and descendants. Record the result and why in the README and `platform-remnote` memory.
- [ ] **Step 2: Write the README**: what it does, screenshots, the honest limits (jumping needs your own highlights; no current-page marker; no writes), and **"How this works and what can break it"**: SDK 0.0.46 checked 2026-11-22, the exact calls relied on (`getOpenPaneRemId`, `UploadedFile.URL`, `getDescendants` + `n`/`hh` `Data.position.pageNumber`, `scrollToReaderHighlight`), what the user sees if each breaks. Run the prose through the `humanizer` skill.
- [ ] **Step 3: Verify** `npm run build`. Expected: zip builds and contains `README.md` and the worker.
- [ ] **Step 4: Manual testing checklist** (grouped by PDF, HTML, bookmarks, regressions; flag the jump rule as the item most likely to be wrong) in the PR body or tracking issue. Creating the GitHub repo is the owner's call; ask.
- [ ] **Step 5: Commit** on owner approval: `docs: readme, diagnostics and scope for first release`.
