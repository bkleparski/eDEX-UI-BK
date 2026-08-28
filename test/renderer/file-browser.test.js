'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  fileTypeMarker,
  isPreviewableImage,
  matchesFileFilter,
  sortFileEntries,
  __setFileFilterQueryForTest,
  __setFileSortStateForTest
} = require('../../src/renderer/file-browser.js');

test('fileTypeMarker maps known types and falls back to [?] for anything else', () => {
  assert.equal(fileTypeMarker('directory'), '[D]');
  assert.equal(fileTypeMarker('link'), '[L]');
  assert.equal(fileTypeMarker('file'), '[F]');
  assert.equal(fileTypeMarker('socket'), '[?]');
  assert.equal(fileTypeMarker(undefined), '[?]');
  assert.equal(fileTypeMarker(null), '[?]');
});

test('isPreviewableImage requires type file and an image extension, case-insensitively', () => {
  assert.equal(isPreviewableImage({ type: 'file', fullPath: '/tmp/photo.png' }), true);
  assert.equal(isPreviewableImage({ type: 'file', fullPath: '/tmp/PHOTO.PNG' }), true);
  assert.equal(isPreviewableImage({ type: 'file', fullPath: '/tmp/scan.jpeg' }), true);
  assert.equal(isPreviewableImage({ type: 'file', fullPath: '/tmp/icon.svg' }), true);
  assert.equal(isPreviewableImage({ type: 'file', fullPath: '/tmp/notes.txt' }), false);
  assert.equal(isPreviewableImage({ type: 'directory', fullPath: '/tmp/photo.png' }), false);
  assert.equal(isPreviewableImage({ type: 'file' }), false);
  assert.equal(isPreviewableImage(undefined), false);
  assert.equal(isPreviewableImage(null), false);
});

test('matchesFileFilter: empty query always matches, non-empty query is case-insensitive', () => {
  // Real caller (the filter input handler) lowercases the query before
  // storing it, so matchesFileFilter itself only lowercases entry.name.
  __setFileFilterQueryForTest('');
  assert.equal(matchesFileFilter({ name: 'anything at all' }), true);

  __setFileFilterQueryForTest('rep');
  assert.equal(matchesFileFilter({ name: 'Report.txt' }), true);
  assert.equal(matchesFileFilter({ name: 'REPORT.TXT' }), true);
  assert.equal(matchesFileFilter({ name: 'summary.txt' }), false);

  __setFileFilterQueryForTest('');
});

test('sortFileEntries always groups directories before files, in both sort directions', () => {
  const entries = [
    { name: 'zeta.txt', type: 'file' },
    { name: 'Apple', type: 'directory' },
    { name: 'banana.txt', type: 'file' },
    { name: 'Zoo', type: 'directory' }
  ];

  __setFileSortStateForTest('name', true);
  assert.deepEqual(
    sortFileEntries(entries).map((e) => e.name),
    ['Apple', 'Zoo', 'banana.txt', 'zeta.txt']
  );

  __setFileSortStateForTest('name', false);
  assert.deepEqual(
    sortFileEntries(entries).map((e) => e.name),
    ['Zoo', 'Apple', 'zeta.txt', 'banana.txt']
  );
});

test('sortFileEntries by size treats a missing sizeBytes as -1 (smallest)', () => {
  const entries = [
    { name: 'b.txt', type: 'file', sizeBytes: 500 },
    { name: 'a.txt', type: 'file' }, // no sizeBytes
    { name: 'c.txt', type: 'file', sizeBytes: 100 }
  ];

  __setFileSortStateForTest('size', true);
  assert.deepEqual(sortFileEntries(entries).map((e) => e.name), ['a.txt', 'c.txt', 'b.txt']);

  __setFileSortStateForTest('size', false);
  assert.deepEqual(sortFileEntries(entries).map((e) => e.name), ['b.txt', 'c.txt', 'a.txt']);
});

test('sortFileEntries by modified treats a missing modifiedMs as 0 (oldest)', () => {
  const entries = [
    { name: 'y.txt', type: 'file', modifiedMs: 2_000 },
    { name: 'x.txt', type: 'file' }, // no modifiedMs
    { name: 'z.txt', type: 'file', modifiedMs: 1_000 }
  ];

  __setFileSortStateForTest('modified', true);
  assert.deepEqual(sortFileEntries(entries).map((e) => e.name), ['x.txt', 'z.txt', 'y.txt']);
});

test('sortFileEntries returns a new array and never mutates the input order', () => {
  const original = [
    { name: 'b.txt', type: 'file' },
    { name: 'a.txt', type: 'file' }
  ];
  __setFileSortStateForTest('name', true);
  const sorted = sortFileEntries(original);
  assert.notEqual(sorted, original);
  assert.deepEqual(sorted.map((e) => e.name), ['a.txt', 'b.txt']);
  assert.deepEqual(original.map((e) => e.name), ['b.txt', 'a.txt']);
});
