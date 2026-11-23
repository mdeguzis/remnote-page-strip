# Spike findings (2026-11-22)

Probed against the live web app in Firefox, SDK 0.0.46, "Develop from
localhost". Test document: a 6 page PDF (jetta.pdf).

## 1. PDF bytes: reachable

The open document is `plugin.window.getOpenPaneRemId(getFocusedPaneId())`.
Its `UploadedFile` powerup (code `f`) has the file in the `URL` slot, an S3 URL
(`https://remnote-user-data.s3.amazonaws.com/...pdf`). `fetch()` from the
plugin iframe returned 200, `application/pdf`, all 1,630,047 bytes. `Name` gave
`jetta.pdf`; `Type` and `ViewerData` were empty. pdf.js 6.4.299 renders
thumbnails from it in the sidebar widget (prototype confirmed by the owner).

## 2. Native mode: not granted

`requestNative: true` is ignored for this plugin: the index widget runs in an
iframe (`window.self !== window.top`) and every reader selector matched zero
elements. RemNote's docs say native is reserved for "highly-vetted" plugins.
So nothing can read or scroll the reader's DOM. Current-page tracking is out.

## 3. Moving the reader: only through the user's own highlights

- `highlightRem.scrollToReaderHighlight()` moves the reader to that highlight.
  Works sandboxed (owner confirmed).
- `plugin.window.openRem(highlightRem)` does not move the reader.
- Highlights are found with `pdfRem.getDescendants()` filtered by
  `hasPowerup('n')` (4 found). `getPowerupByCode('n').taggedRem()` returned 0
  for the whole KB, so it cannot be used.
- The `n` powerup's `Data` slot is react-pdf-highlighter JSON. The page is
  `position.pageNumber`, 1-based.

The owner ruled out every knowledge-base write, including temporary or
user-requested highlights, so a tile can only jump to pages that already carry
one of the user's highlights.

## 4. Placement

Settled without the DOM: a `RightSidebar` widget tab ("Pages"), following the
focused pane via `AppEvents.URLChange` and `AppEvents.FocusedPaneChange`.

## 5. HTML reader: not yet probed

Open: whether an imported web page or uploaded `.html` exposes its HTML
through `Link.FileURL` / `UploadedFile.URL` for fetch + DOMParser heading
extraction, and whether HTML highlights (`hh` powerup, `Data` slot) scroll with
`scrollToReaderHighlight` the same way. Probe this before Task 3's HTML half.

## 6. ReaderMenu is not the reader's menu

A `registerMenuItem` with `location: ReaderMenu` registered without error but
did not appear in the PDF reader's toolbar menu (the vertical-dots menu with
Text / Box / Circle / Mindmap / Image / Sticky Note); owner checked
2026-11-22. So no right-click or menu "Bookmark this page": bookmarks are set
from the bookmark icon on each tile instead (owner's choice).
