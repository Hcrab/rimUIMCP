import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {recordGameFrames} from '../scripts/record-game-frames.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9aQAAAABJRU5ErkJggg==', 'base64');

test('records raw SDK screenshot copies at the requested low frame rate', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rimplay-game-frames-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  let milliseconds = 0;
  let captures = 0;
  const manifest = await recordGameFrames({seconds: 3, directory}, {
    now: () => new Date(milliseconds),
    sleep: async wait => { milliseconds += wait; },
    screenshot: async () => {
      captures += 1;
      const source = path.join(directory, `game-${captures}.png`);
      writeFileSync(source, PNG);
      return {path: source, sizeBytes: PNG.length};
    },
  });
  assert.equal(manifest.status, 'completed');
  assert.equal(manifest.recordedFrameCount, 3);
  assert.equal(manifest.observedSpanSeconds, 2);
  assert.equal(manifest.source, 'RimBridge SDK ui.screenshot (low-frame-rate fallback; raw PNG sequence)');
  for (const frame of manifest.frames) assert.deepEqual(readFileSync(path.join(directory, frame.file)), PNG);
  assert.equal(manifest.frames[0].sha256, createHash('sha256').update(PNG).digest('hex'));
  assert.equal(JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8')).recordedFrameCount, 3);
});

test('rejects a frame rate outside the 1–2 FPS fallback range', async () => {
  await assert.rejects(recordGameFrames({seconds: 1, framesPerSecond: 3}), /between 1 and 2/);
});
