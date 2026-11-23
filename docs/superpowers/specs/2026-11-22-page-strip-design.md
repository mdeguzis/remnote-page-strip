# Page Strip for RemNote: design

Date: 2026-11-22
Status: draft, awaiting owner approval

## Why

Long PDFs in RemNote (hundreds of pages) have no way to jump to a page. The
owner's last attempt at finding a section was scrolling until it turned up.
RemNote's reader has no thumbnail view, and as of 2026-11-22 no marketplace or
GitHub plugin adds one (searched web, GitHub repos, and code search over
`@remnote/plugin-sdk` users). The closest thing, bjsi/incremental-everything's
`pdf_bookmark_popup`, is a reading-position history, not a page strip.

**PDF and HTML documents are equal first-class targets.** Everything below
(panel, placement, Pages/Bookmarks switcher, focused-pane following,
diagnostics, README) applies to both, and v1 does not ship with HTML missing.
Where the two differ it is only in what a tile represents: a page for PDF, a
heading section for HTML.

The target is Firefox's built-in PDF sidebar (pdf.js). Reference screenshots
from the owner are the source of truth for the look:

- A rounded panel (in RemNote's right sidebar tab, see Decided).
- Header: a view switcher button (2x2 grid icon + chevron) on the left, the
  view title ("Pages") centred.
- A vertical column of page thumbnails, each a white page with rounded corners
  and a page number pill centred on the bottom edge.
- The current page has a thick accent (purple in Firefox) border.

## Goals

1. **Pages view.** A thumbnail strip in the right sidebar for the open PDF. Clicking a
   tile scrolls the reader to that page. The tile for the page currently in
   view is highlighted and the strip follows as the user scrolls the PDF.
2. **Works on hundreds of pages.** Thumbnails render lazily, only near the
   visible part of the strip, and the strip stays responsive on a 500 page PDF.
3. **Bookmarks.** A small bookmark icon in the top right corner of each tile:
   faint on hover, filled when the page is bookmarked. Clicking toggles it.
4. **Bookmarks view.** The header switcher flips the panel between "Pages" and
   "Bookmarks". Bookmarks shows only bookmarked pages, as the same tiles, in
   page order. Empty state says how to add one.
5. **HTML documents.** Same panel and switcher on HTML documents opened in
   the RemNote reader, but with one tile per heading (h1-h3): the heading text
   and a line of preview text. Bookmarks work the same way, keyed by heading.
6. **Opened like any sidebar tab.** Its tab in the right sidebar, an omnibar
   command, and a "Page Strip" entry on the reader's menu if ReaderMenu turns
   out to be that menu. (Replaces the collapse handle, which the sidebar
   provides.)
7. **Stays visible when RemNote changes.** README section (below) plus
   in-app diagnostics.

## Non-goals

- Firefox's page editing controls: selection checkboxes, "Manage", the "+"
  button. RemNote cannot reorder or insert PDF pages. (Owner approved leaving
  these out.)
- Editing the PDF's own embedded outline.
- Bookmarks stored as rems or highlights in the user's notes.
- Mobile layout. Desktop and web first; `enableOnMobile` can be false at v1.

## Anti-goals (would count as failure even if it technically works)

- Freezing or visibly slowing RemNote when opening a large PDF.
- Writing anything into the user's knowledge base.
- Failing silently when RemNote's DOM changes: the strip must log what it
  could not find and show a short "can't find the reader" message rather than
  an empty panel.
- Asking for `All / ReadCreateModify` when a narrower scope works.

## Constraints (verified 2026-11-22)

- `@remnote/plugin-sdk` 0.0.46 is the latest published version (last publish
  2024-08). It has **no reader navigation API**: `plugin.reader` has only
  `addHighlight()`, and the only scroll is `rem.scrollToReaderHighlight()`,
  which needs an existing highlight rem. There is no widget location beside
  the reader.
- Therefore jumping and current-page tracking need `requestNative: true`
  and the host DOM: read which page is in view and scroll the reader. The
  panel itself is an ordinary sandboxed RightSidebar widget and talks to the
  native index widget through session storage / events. If RemNote does not
  grant native mode (In The Margins' own diagnostics reported its index widget
  "sandboxed" on 2026-11-22), the panel still shows thumbnails and bookmarks
  but cannot jump; the spike decides which.
- Known PDF route hooks (from the Sakura theme work, see
  `platform-remnote` memory): `.drawing-pdf-viewer` (present only when a PDF
  is open), `.rn-drawing-canvas-pdf-page` (each page),
  `.drawing-page-page-number`, `.drawing-canvas` /
  `.editor-drawing-canvas` (the workspace),
  `.rn-drawing-canvas-fake-scrollbar` (the canvas draws its own scrollbar).
  The HTML reader's DOM has not been surveyed yet.
- Some RemNote chrome sets inline backgrounds; styling that must win over
  those needs `!important`.
- Dev loop: webpack dev server must send CORS `Access-Control-Allow-Headers`
  including `user-agent` and bind to `127.0.0.1` (copy from In The Margins).
  Scopes can only be tested with an uploaded zip, since "Develop from
  localhost" shows no permission prompt.

## Decided

- **New standalone repo**, `~/src/remnote-page-strip` (name is Claude's
  call, easy to change), scaffolded from `~/src/remnote-in-the-margins`:
  same package.json scripts (`dev`, `test` with `node --test`,
  `check-types`, `verify`, `build` producing a zip), webpack config with the
  CORS fix, `src/lib` + `src/ui` + `src/widgets` layout, a log helper in the
  style of `src/lib/log.ts`, synced storage helpers in the style of
  `src/lib/storage.ts`, and a Diagnostics view.
- **Bookmarks in `plugin.storage.setSynced`**, keyed per document rem id.
  Value: list of `{ page: number }` for PDFs, `{ headingId, text }` for HTML.
  Nothing written to notes.
- **HTML docs show heading tiles**, not page-sized slices.
- **Look copies Firefox's sidebar** but takes colours from RemNote's
  `--rn-clr-*` tokens so it matches light and dark mode and themes like Sakura.
- **README section "How this works and what can break it"**, kept current:
  why the plugin reads RemNote's page (no SDK API), the selectors it relies
  on, the SDK version last checked, and what the user sees if RemNote changes.
  Agent memory (`feedback-sdk-watch`) already requires rechecking the SDK
  version and those selectors at the start of each session.

- **HTML is in scope for v1, not later.** (Owner decided, restated after
  the first draft.)
- **Placement: RemNote's right sidebar**, as its own tab (WidgetLocation
  `RightSidebar`, same pattern as In The Margins' Comments panel). It follows
  the document open in the focused pane. (Owner decided 2026-11-22, replacing
  the earlier "between Notes and the document" placement: a supported SDK
  location cannot be broken by RemNote reshuffling the reader's layout, and it
  removes all panel-injection work.) The panel keeps the Firefox look inside
  the tab. Click-to-jump and current-page tracking still need host DOM access
  (see Constraints); placement no longer does.
- **Distribution:** RemNote marketplace, same release pattern as In The
  Margins: narrowest workable scope, README, version in manifest and
  package.json, zip upload. Bundling pdf.js and its worker (~1 MB) is
  acceptable. (Owner decided.)

- **Jumping (decided 2026-11-22 after the spikes).** Native mode is not
  granted, so the only way to move the reader is
  `highlightRem.scrollToReaderHighlight()` (verified working sandboxed;
  `window.openRem` on a highlight does not move the reader). The plugin never
  writes to the knowledge base, not even a temporary or user-requested
  highlight (owner decided, twice). So a tile jumps only when the page carries
  one of the user's own highlights; otherwise it jumps to the nearest
  highlighted page before it and says "Page N: scroll down to it", or, with no
  highlights at all, just shows the page number. Bookmarks are page numbers in
  synced plugin storage and jump under the same rule. Scope stays read-only.
- **Current-page tracking is out.** Nothing sandboxed can read the reader's
  scroll position, so there is no "current page" highlight on the tiles unless
  a later spike finds a source (ReaderMenu action args are the last untested
  lead).

## Claude's calls (owner can override)

- **Contexts:** one sidebar panel, showing the PDF or HTML document in the
  focused pane and switching when focus moves to another pane. With two PDFs
  side by side, click into one to see its pages. (Superseded the earlier
  one-strip-per-viewer call when placement moved to the sidebar.)

- Lazy rendering with an IntersectionObserver over placeholder tiles sized to
  each page's aspect ratio, so the strip's scroll height is right before any
  thumbnail exists.
- Thumbnail source, in order of preference, to be settled by the spike below:
  (a) render from the PDF file with pdf.js at thumbnail scale; (b) downscale
  the reader's own rendered page canvases when they exist. (a) is preferred
  because the reader probably only renders pages near the viewport.
- Current-page tracking from the reader's scroll position against page
  element offsets, throttled to animation frames.
- Tiles fill the sidebar's width (two columns when the sidebar is wider than
  ~360px); view (Pages/Bookmarks) remembered in `plugin.storage` local.
- Scrolling fallback: try the reader's scroll container first, then synthetic
  wheel events on the canvas. If neither moves the reader reliably, stop after
  the spike and bring it back to the owner before building; do not ship a
  strip that can only highlight.
- HTML: support whichever HTML paths the spike finds (imported web page and
  uploaded .html). Heading bookmarks are keyed by heading index plus
  normalised text; if the text no longer matches, re-find by text, else show
  the bookmark as "not found" rather than dropping it. Surviving a re-import
  is not required.
- Scope: start from the narrowest scope that lets the plugin read the open
  document's `UploadedFile` powerup and use synced storage; document the
  final choice and why in the README.

## Spike first (throwaway, before the plan is finalised)

These are unverified and decide the architecture, so the first task is a
short spike in the live app, with findings saved to the `platform-remnote`
memory:

1. Can a native plugin get the PDF bytes? (URL on the `UploadedFile` "f"
   powerup, whether it is a signed or same-origin URL, whether `fetch` from
   the plugin works.)
2. Does the reader render every page element up front, or virtualise? Are
   unrendered pages present as sized placeholders?
3. What element scrolls? Setting `scrollTop`, or the canvas's own scroll
   model behind `.rn-drawing-canvas-fake-scrollbar`? How to scroll to page N.
4. Does RemNote grant native mode to this plugin (index widget's
   `window.self === window.top`)? Without it, items 2, 3 and 5 are moot.
   (Replaces the old panel-insertion question, settled by the sidebar.)
5. The HTML reader: what holds the headings, and what scrolls.

Items 3 and 4 must be answered for the HTML reader as well as the PDF one;
the spike is not done until both readers are surveyed.

If (1) fails, fall back to downscaled reader canvases plus a numbered
placeholder for pages not yet rendered.

## Left to the builder

- Component breakdown, file names inside the scaffold, test structure (follow
  In The Margins: pure logic in `src/lib` with `node --test` coverage for
  bookmark storage, page tracking math, heading extraction).
- Exact icon artwork (simple inline SVGs, matching Firefox's shapes).
- Debug logging per the owner's rules: every DOM lookup, fallback branch, and
  storage call logs its source and outcome.
