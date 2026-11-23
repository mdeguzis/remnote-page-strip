import { declareIndexPlugin, WidgetLocation, type ReactRNPlugin } from '@remnote/plugin-sdk';

import { describeError, log, setDebugLogging } from '../lib/log.ts';

/*
 * SPIKE BUILD (Task 1). Throwaway probes that answer the spec's open questions
 * against the live app. Nothing here ships: the probes are deleted once
 * docs/spike-findings.md is written.
 *
 * Run "Page Strip: run spike probes" from the omnibar with a reader open. The
 * report is copied to the clipboard (or logged when the clipboard is refused).
 */

// Selectors known from the Sakura theme work on the PDF route (2026-08-19).
// The HTML reader has never been surveyed, so it gets a broad sweep instead.
const KNOWN = [
  '.drawing-pdf-viewer',
  '.rn-drawing-canvas-pdf-page',
  '.drawing-page-page-number',
  '.drawing-canvas',
  '.editor-drawing-canvas',
  '.drawing-canvas-bounds-display',
  '.rn-drawing-canvas-fake-scrollbar',
];

function isNative(): boolean {
  try {
    return window.self === window.top;
  } catch {
    return false;
  }
}

function classesOf(el: Element): string {
  const c = typeof el.className === 'string' ? el.className : '';
  return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${c ? '.' + c.trim().split(/\s+/).slice(0, 6).join('.') : ''}`;
}

/** Ancestors that can actually scroll, nearest first. */
function scrollableAncestors(el: Element): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let node: Element | null = el; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) {
      out.push({
        el: classesOf(node),
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
      });
    }
  }
  return out;
}

/** A compact outline of the tree above and around an element. */
function ancestry(el: Element, depth = 12): string[] {
  const out: string[] = [];
  for (let node: Element | null = el, i = 0; node && i < depth; node = node.parentElement, i++) {
    const r = node.getBoundingClientRect();
    out.push(`${classesOf(node)} [${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}]`);
  }
  return out;
}

function probePdfDom() {
  const counts = Object.fromEntries(KNOWN.map((s) => [s, document.querySelectorAll(s).length]));
  const viewers = [...document.querySelectorAll('.drawing-pdf-viewer')];
  const perViewer = viewers.map((viewer) => {
    const pages = [...viewer.querySelectorAll('.rn-drawing-canvas-pdf-page')];
    const numbers = [...viewer.querySelectorAll('.drawing-page-page-number')].map((n) => n.textContent?.trim());
    return {
      ancestry: ancestry(viewer),
      pageElements: pages.length,
      pageNumbersShown: numbers.slice(0, 5).concat(numbers.length > 5 ? [`...${numbers.length} total`] : []),
      // Do pages hold a canvas each, or only the ones near the viewport?
      pagesWithCanvas: pages.filter((p) => p.querySelector('canvas')).length,
      firstPages: pages.slice(0, 3).map((p) => {
        const r = p.getBoundingClientRect();
        const style = (p as HTMLElement).getAttribute('style') ?? '';
        return { el: classesOf(p), rect: [Math.round(r.top), Math.round(r.width), Math.round(r.height)], style: style.slice(0, 160) };
      }),
      scrollFromFirstPage: pages[0] ? scrollableAncestors(pages[0]) : [],
    };
  });
  return { counts, viewers: perViewer };
}

/** Broad sweep for the HTML reader, whose markup is unknown. */
function probeHtmlDom() {
  const readerish = [...document.querySelectorAll('[class*="reader" i], [class*="web-reader" i], [class*="html" i]')]
    .slice(0, 25)
    .map(classesOf);
  const iframes = [...document.querySelectorAll('iframe')].map((f) => ({
    src: (f.getAttribute('src') ?? '').slice(0, 120),
    el: classesOf(f),
    sameOrigin: (() => {
      try {
        return Boolean(f.contentDocument);
      } catch {
        return false;
      }
    })(),
  }));
  // Headings outside the editor are the reader's content, if it renders inline.
  const headings = [...document.querySelectorAll('h1, h2, h3')]
    .filter((h) => !h.closest('.rem-container, .rn-editor, [contenteditable="true"]'))
    .slice(0, 15)
    .map((h) => ({ tag: h.tagName, text: (h.textContent ?? '').trim().slice(0, 60), ancestry: ancestry(h, 6) }));
  return { readerish, iframes, headings, scrollFromFirstHeading: headings.length ? scrollableAncestors(document.querySelectorAll('h1, h2, h3')[0]) : [] };
}

/** Which powerups the open document carries, and what its file slots hold. */
async function probeDocument(plugin: ReactRNPlugin) {
  const paneId = await plugin.window.getFocusedPaneId();
  const remId = await plugin.window.getOpenPaneRemId(paneId);
  if (!remId) return { paneId, remId: null };
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return { paneId, remId, found: false };
  const read = async (code: string, slot: string) => {
    try {
      return (await rem.getPowerupProperty(code as never, slot as never)) ?? null;
    } catch (err) {
      return `error: ${describeError(err).message}`;
    }
  };
  const uploaded = {
    has: await rem.hasPowerup('f'),
    Type: await read('f', 'Type'),
    URL: await read('f', 'URL'),
    Name: await read('f', 'Name'),
    ViewerDataLength: String((await read('f', 'ViewerData')) ?? '').length,
  };
  const link = { has: await rem.hasPowerup('b'), URL: await read('b', 'URL'), FileURL: await read('b', 'FileURL') };

  // Can a native plugin actually fetch the bytes?
  const tryFetch = async (url: unknown) => {
    if (typeof url !== 'string' || !url) return null;
    try {
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      return { status: res.status, type: res.headers.get('content-type'), bytes: buf.byteLength };
    } catch (err) {
      return { error: describeError(err).message };
    }
  };
  return {
    paneId,
    remId,
    uploaded,
    link,
    fetchUploaded: await tryFetch(uploaded.URL),
    fetchLinkFile: await tryFetch(link.FileURL),
  };
}

/** Scroll method A: set scrollTop on the nearest scrollable ancestor. */
function tryScrollTop(pageIndex: number) {
  const pages = [...document.querySelectorAll('.rn-drawing-canvas-pdf-page')];
  const page = pages[pageIndex];
  if (!page) return { method: 'scrollTop', ok: false, reason: `no page element at index ${pageIndex}`, pages: pages.length };
  const scroller = (() => {
    for (let n: Element | null = page.parentElement; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 1) return n;
    }
    return null;
  })();
  if (!scroller) return { method: 'scrollTop', ok: false, reason: 'no scrollable ancestor' };
  const before = page.getBoundingClientRect().top;
  scroller.scrollTop += before - scroller.getBoundingClientRect().top;
  const after = page.getBoundingClientRect().top;
  return { method: 'scrollTop', ok: Math.abs(after - scroller.getBoundingClientRect().top) < 4, scroller: classesOf(scroller), before, after };
}

/** Scroll method B: synthetic wheel events on the canvas. */
function tryWheel(deltaY: number) {
  const target = document.querySelector('.drawing-canvas') ?? document.querySelector('.editor-drawing-canvas');
  if (!target) return { method: 'wheel', ok: false, reason: 'no .drawing-canvas' };
  const page = document.querySelector('.rn-drawing-canvas-pdf-page');
  const before = page?.getBoundingClientRect().top ?? null;
  const r = target.getBoundingClientRect();
  target.dispatchEvent(
    new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }),
  );
  return new Promise((resolve) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const after = page?.getBoundingClientRect().top ?? null;
        resolve({ method: 'wheel', target: classesOf(target), before, after, moved: before !== after });
      }),
    ),
  );
}

async function runAll(plugin: ReactRNPlugin) {
  const report: Record<string, unknown> = { native: isNative(), sdk: '0.0.46', url: await plugin.window.getURL() };
  if (!report.native) {
    // Everything below needs the host page. Say so loudly rather than report
    // zero matches that look like a missing reader.
    report.warning = 'index widget is SANDBOXED: requestNative was not granted, DOM probes cannot see RemNote';
  }
  for (const [name, fn] of [
    ['pdf', () => probePdfDom()],
    ['html', () => probeHtmlDom()],
    ['document', () => probeDocument(plugin)],
  ] as const) {
    try {
      report[name] = await fn();
    } catch (err) {
      report[name] = { error: describeError(err) };
    }
  }
  return report;
}

async function deliver(plugin: ReactRNPlugin, label: string, data: unknown) {
  const text = JSON.stringify(data, null, 2);
  console.log(`[strip] ${label}\n${text}`);
  try {
    await navigator.clipboard.writeText(text);
    await plugin.app.toast(`${label}: copied to the clipboard.`);
  } catch {
    await plugin.app.toast(`${label}: clipboard refused, see the console.`);
  }
}

/*
 * Spike 2: native mode is not granted, so the only reader navigation left is
 * through the SDK. Find this PDF's highlights and see what moves the reader.
 */
async function pdfHighlights(plugin: ReactRNPlugin) {
  const paneId = await plugin.window.getFocusedPaneId();
  const docId = await plugin.window.getOpenPaneRemId(paneId);
  const powerup = await plugin.powerup.getPowerupByCode('n');
  const tagged = powerup ? await powerup.taggedRem() : [];
  // Second route: highlights may live under the PDF rem without showing up as
  // tagged with the powerup. Search the document's own descendants too.
  const doc = docId ? await plugin.rem.findOne(docId) : undefined;
  const descendants = doc ? await doc.getDescendants() : [];
  const seen = new Set<string>();
  const mine = [];
  for (const rem of [...tagged, ...descendants]) {
    if (seen.has(rem._id)) continue;
    seen.add(rem._id);
    if (!(await rem.hasPowerup('n'))) continue;
    const pdfId = await rem.getPowerupProperty('n' as never, 'PdfId' as never);
    if (pdfId === docId || descendants.includes(rem)) mine.push(rem);
  }
  return { docId, totalHighlightsInKb: tagged.length, descendantsOfPdf: descendants.length, mine };
}

async function describeHighlights(plugin: ReactRNPlugin) {
  const { docId, totalHighlightsInKb, descendantsOfPdf, mine } = await pdfHighlights(plugin);
  const samples = [];
  for (const rem of mine.slice(0, 3)) {
    const data = String((await rem.getPowerupProperty('n' as never, 'Data' as never)) ?? '');
    // The page number sits past the first 600 chars, so parse and show the
    // position without the per-line rects (which are long and repeat it).
    let position: unknown = 'unparsed';
    try {
      const parsed = JSON.parse(data) as { position?: Record<string, unknown> };
      const { rects, ...rest } = parsed.position ?? {};
      position = { ...rest, rectCount: Array.isArray(rects) ? rects.length : null };
    } catch (err) {
      position = `parse error: ${describeError(err).message}`;
    }
    samples.push({ remId: rem._id, dataLength: data.length, position });
  }
  return { docId, totalHighlightsInKb, descendantsOfPdf, inThisPdf: mine.length, samples };
}

/** Which SDK calls actually move the reader, tried on the LAST highlight. */
async function jumpViaHighlight(plugin: ReactRNPlugin, how: 'scrollToReaderHighlight' | 'openRem') {
  const { mine } = await pdfHighlights(plugin);
  const target = mine[mine.length - 1];
  if (!target) return { how, ok: false, reason: 'no highlights in this PDF; make one on a later page first' };
  try {
    if (how === 'scrollToReaderHighlight') await target.scrollToReaderHighlight();
    else await plugin.window.openRem(target);
    return { how, called: true, remId: target._id, note: 'did the reader move to that highlight? tell Claude' };
  } catch (err) {
    return { how, called: false, error: describeError(err) };
  }
}

/** Spike 1b: where an HTML document's markup comes from, and its highlights. */
async function probeHtmlDocument(plugin: ReactRNPlugin) {
  const paneId = await plugin.window.getFocusedPaneId();
  const docId = await plugin.window.getOpenPaneRemId(paneId);
  const rem = docId ? await plugin.rem.findOne(docId) : undefined;
  if (!rem) return { docId: docId ?? null, found: false };
  const read = async (code: string, slot: string) => {
    try {
      return (await rem.getPowerupProperty(code as never, slot as never)) ?? null;
    } catch (err) {
      return `error: ${describeError(err).message}`;
    }
  };
  const slots = {
    linkURL: await read('b', 'URL'),
    linkFileURL: await read('b', 'FileURL'),
    uploadedURL: await read('f', 'URL'),
    uploadedName: await read('f', 'Name'),
  };
  const fetchHeadings = async (url: unknown) => {
    if (typeof url !== 'string' || !url) return null;
    try {
      const res = await fetch(url);
      const text = await res.text();
      const doc = new DOMParser().parseFromString(text, 'text/html');
      const headings = [...doc.querySelectorAll('h1, h2, h3')]
        .slice(0, 10)
        .map((h) => `${h.tagName} ${(h.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60)}`);
      return { status: res.status, type: res.headers.get('content-type'), chars: text.length, headings };
    } catch (err) {
      return { error: describeError(err).message };
    }
  };
  const descendants = await rem.getDescendants();
  const htmlHighlights = [];
  for (const d of descendants) if (await d.hasPowerup('hh')) htmlHighlights.push(d);
  let sample: unknown = null;
  if (htmlHighlights[0]) {
    const data = String((await htmlHighlights[0].getPowerupProperty('hh' as never, 'Data' as never)) ?? '');
    try {
      sample = { keys: Object.keys(JSON.parse(data)), data: data.slice(0, 500) };
    } catch {
      sample = { unparsed: data.slice(0, 500) };
    }
  }
  return {
    docId,
    slots,
    fetchLinkFile: await fetchHeadings(slots.linkFileURL),
    fetchUploaded: await fetchHeadings(slots.uploadedURL),
    descendants: descendants.length,
    htmlHighlights: htmlHighlights.length,
    sample,
  };
}

/** Spike 1b: does scrollToReaderHighlight move the HTML reader too? */
async function jumpHtmlHighlight(plugin: ReactRNPlugin) {
  const paneId = await plugin.window.getFocusedPaneId();
  const docId = await plugin.window.getOpenPaneRemId(paneId);
  const rem = docId ? await plugin.rem.findOne(docId) : undefined;
  const descendants = rem ? await rem.getDescendants() : [];
  let target;
  for (const d of descendants) if (await d.hasPowerup('hh')) target = d;
  if (!target) return { ok: false, reason: 'no HTML highlights in this document; make one lower down first' };
  try {
    await target.scrollToReaderHighlight();
    return { called: true, remId: target._id, note: 'did the page move? tell Claude' };
  } catch (err) {
    return { called: false, error: describeError(err) };
  }
}

async function onActivate(plugin: ReactRNPlugin) {
  setDebugLogging(true);
  log('INFO', 'Page Strip spike activated', { native: isNative(), source: 'onActivate' });

  // Exposed for poking at from devtools between commands.
  (window as unknown as Record<string, unknown>).__pageStripSpike = {
    probePdfDom,
    probeHtmlDom,
    probeDocument: () => probeDocument(plugin),
    tryScrollTop,
    tryWheel,
  };

  await plugin.app.registerCommand({
    id: 'strip-spike-probe',
    name: 'Page Strip: run spike probes',
    action: async () => deliver(plugin, 'Spike probes', await runAll(plugin)),
  });
  await plugin.app.registerCommand({
    id: 'strip-spike-scroll',
    name: 'Page Strip: spike scroll to page 10',
    action: async () => deliver(plugin, 'Scroll test', { scrollTop: tryScrollTop(9), wheel: await tryWheel(800) }),
  });
  await plugin.app.registerCommand({
    id: 'strip-spike-highlights',
    name: 'Page Strip: spike list highlights',
    action: async () => deliver(plugin, 'Highlights', await describeHighlights(plugin)),
  });
  await plugin.app.registerCommand({
    id: 'strip-spike-jump-scroll',
    name: 'Page Strip: spike jump A (scrollToReaderHighlight)',
    action: async () => deliver(plugin, 'Jump A', await jumpViaHighlight(plugin, 'scrollToReaderHighlight')),
  });
  await plugin.app.registerCommand({
    id: 'strip-spike-jump-open',
    name: 'Page Strip: spike jump B (openRem)',
    action: async () => deliver(plugin, 'Jump B', await jumpViaHighlight(plugin, 'openRem')),
  });
  await plugin.app.registerCommand({
    id: 'strip-spike-html',
    name: 'Page Strip: spike HTML document',
    action: async () => deliver(plugin, 'HTML document', await probeHtmlDocument(plugin)),
  });
  await plugin.app.registerCommand({
    id: 'strip-spike-html-jump',
    name: 'Page Strip: spike HTML jump',
    action: async () => deliver(plugin, 'HTML jump', await jumpHtmlHighlight(plugin)),
  });
  await plugin.app.registerWidget('page_strip', WidgetLocation.RightSidebar, {
    dimensions: { height: 'auto', width: '100%' },
    widgetTabTitle: 'Pages',
    widgetTabIcon: `${plugin.rootURL}pages.svg`,
  });
  await plugin.app.registerCommand({
    id: 'strip-open',
    name: 'Page Strip: open pages',
    action: async () => {
      await plugin.window.openWidgetInRightSidebar('page_strip');
    },
  });
  // Is ReaderMenu the "..." inside the reader? Seeing this entry there answers it.
  await plugin.app.registerMenuItem({
    id: 'strip-spike-reader-menu',
    name: 'Page Strip (spike)',
    location: 'ReaderMenu' as never,
    action: async (args: unknown) => deliver(plugin, 'ReaderMenu args', args ?? null),
  });
}

async function onDeactivate(_: ReactRNPlugin) {}

declareIndexPlugin(onActivate, onDeactivate);
