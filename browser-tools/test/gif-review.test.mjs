import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REVIEW_COLUMNS,
  DEFAULT_REVIEW_FPS,
  DEFAULT_REVIEW_ROWS,
  DEFAULT_REVIEW_WIDTH,
  contactSheetSampleFps,
  parseReviewOptions,
} from '../scripts/review-gif.mjs';

test('contact sheet sampling covers long GIFs within the tile capacity', () => {
  assert.equal(contactSheetSampleFps({
    requestedFps: 2,
    durationSeconds: 10,
    columns: 4,
    rows: 4,
  }), 1.6);
  assert.equal(contactSheetSampleFps({
    requestedFps: 2,
    durationSeconds: 4,
    columns: 4,
    rows: 4,
  }), 2);
});

test('GIF review options use visual review defaults and validate bounds', () => {
  assert.deepEqual(parseReviewOptions([]), {
    outDir: null,
    fps: DEFAULT_REVIEW_FPS,
    width: DEFAULT_REVIEW_WIDTH,
    columns: DEFAULT_REVIEW_COLUMNS,
    rows: DEFAULT_REVIEW_ROWS,
  });
  assert.deepEqual(parseReviewOptions([
    '--out-dir', './review',
    '--fps', '1.5',
    '--width', '320',
    '--columns', '3',
    '--rows', '2',
  ]), {
    outDir: './review',
    fps: 1.5,
    width: 320,
    columns: 3,
    rows: 2,
  });
  assert.throws(() => parseReviewOptions(['--columns', '0']), /from 1 to 10/);
  assert.throws(() => parseReviewOptions(['--width', '100.5']), /expected an integer/);
});
