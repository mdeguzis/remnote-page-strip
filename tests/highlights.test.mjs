import { test } from 'node:test';
import assert from 'node:assert/strict';

import { indexByPage, jumpTarget, pageOfHighlightData } from '../src/lib/highlights.ts';

/*
 * The shape below is copied from a real highlight on jetta.pdf (spike,
 * 2026-11-22), trimmed. RemNote stores react-pdf-highlighter JSON in the `n`
 * powerup's Data slot, and the page is position.pageNumber, 1-based.
 */
const real = JSON.stringify({
  content: { text: '26-519462067-01', textBefore: '...', textAfter: '...' },
  position: {
    boundingRect: { x1: 24.48, y1: 262.16, x2: 103.79, y2: 272.16, width: 612, height: 792, pageNumber: 1 },
    rects: [{ x1: 24.48, y1: 262.16, x2: 103.79, y2: 272.16, width: 612, height: 792, pageNumber: 1 }],
    pageNumber: 1,
  },
});

test('reads the page from a real highlight', () => {
  assert.equal(pageOfHighlightData(real), 1);
});

test('data that is not JSON has no page', () => {
  assert.equal(pageOfHighlightData('{'), null);
  assert.equal(pageOfHighlightData(''), null);
});

test('missing or nonsense pageNumber has no page', () => {
  assert.equal(pageOfHighlightData(JSON.stringify({ position: {} })), null);
  assert.equal(pageOfHighlightData(JSON.stringify({ position: { pageNumber: 0 } })), null);
  assert.equal(pageOfHighlightData(JSON.stringify({ position: { pageNumber: 2.5 } })), null);
  assert.equal(pageOfHighlightData(JSON.stringify({ position: { pageNumber: '3' } })), null);
});

test('falls back to boundingRect.pageNumber when position.pageNumber is absent', () => {
  const data = JSON.stringify({ position: { boundingRect: { y1: 10, pageNumber: 4 } } });
  assert.equal(pageOfHighlightData(data), 4);
});

test('the index keeps the highest highlight on each page', () => {
  const index = indexByPage([
    { remId: 'low', page: 1, y: 300 },
    { remId: 'high', page: 1, y: 100 },
    { remId: 'two', page: 2, y: 50 },
  ]);
  assert.equal(index.get(1)?.remId, 'high');
  assert.equal(index.get(2)?.remId, 'two');
  assert.equal(index.size, 2);
});

test('a page with a highlight jumps exactly', () => {
  const index = indexByPage([{ remId: 'a', page: 2, y: 0 }]);
  assert.deepEqual(jumpTarget(2, index), { kind: 'exact', ref: { remId: 'a', page: 2, y: 0 } });
});

test('a page without one jumps to the nearest highlighted page before it', () => {
  const index = indexByPage([
    { remId: 'one', page: 1, y: 0 },
    { remId: 'two', page: 2, y: 0 },
  ]);
  assert.deepEqual(jumpTarget(5, index), { kind: 'before', ref: { remId: 'two', page: 2, y: 0 }, pagesBelow: 3 });
});

test('nothing before the page means no jump, even with highlights after it', () => {
  const index = indexByPage([{ remId: 'three', page: 3, y: 0 }]);
  assert.deepEqual(jumpTarget(1, index), { kind: 'none' });
});

test('no highlights at all means no jump', () => {
  assert.deepEqual(jumpTarget(4, indexByPage([])), { kind: 'none' });
});
