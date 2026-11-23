# Page Strip

Page thumbnails and bookmarks for PDF and HTML documents in RemNote, in the
right sidebar.

Work in progress. The design is in `docs/superpowers/specs/`.

## How this works and what can break it

RemNote's plugin SDK (0.0.46, checked 2026-11-22) has no way to move the PDF
reader to a page, and RemNote does not grant plugins the native mode that
would let them reach the reader directly. This section will list exactly which
SDK calls the plugin relies on to jump, and what you will see if RemNote
changes them.
