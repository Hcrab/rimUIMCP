import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {DEFAULT_FFMPEG, probeDurationForTest, recordSession} from '../scripts/recording.ts';

function clock(start = 0): {now: () => Date; advance: (milliseconds: number) => void} {
  let value = start;
  return {now: () => new Date(value), advance: milliseconds => { value += milliseconds; }};
}

test('records a new segment after an early zero-exit and tracks its gap', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rimplay-recording-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const time = clock();
  let launches = 0;
  const manifest = await recordSession({seconds: 4, directory}, {
    now: time.now,
    launch: async request => {
      launches += 1;
      const startedAt = time.now().toISOString();
      const recorded = launches === 1 ? 1 : request.seconds;
      time.advance(recorded * 1000);
      return {exitCode: 0, startedAt, endedAt: time.now().toISOString()};
    },
    probe: async () => launches === 1 ? 1 : 3,
  });
  assert.equal(manifest.status, 'completed');
  assert.equal(manifest.segments.length, 2);
  assert.equal(manifest.segments[0].exitCode, 0);
  assert.equal(manifest.segments[0].status, 'early-exit');
  assert.equal(manifest.segments[0].missingFromRequestedSeconds, 3);
  assert.equal(manifest.segments[0].log, 'segment-0001.log');
  assert.equal(manifest.segments[1].status, 'complete');
  assert.equal(manifest.recordedSeconds, 4);
  assert.equal(manifest.coverage, 1);
  assert.equal(manifest.containsGaps, false);
  assert.equal(manifest.completionReason, 'deadline-reached');
  assert.equal(JSON.parse(readFileSync(path.join(manifest.sessionDirectory, 'manifest.json'), 'utf8')).status, 'completed');
});

test('honours a session stop file before opening another capture', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rimplay-recording-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const time = clock();
  const manifest = await recordSession({seconds: 20, directory}, {
    now: time.now,
    launch: async request => {
      writeFileSync(path.join(path.dirname(request.output), 'stop'), 'stop\n');
      const startedAt = time.now().toISOString();
      time.advance(1000);
      return {exitCode: 0, startedAt, endedAt: time.now().toISOString()};
    },
    probe: async () => 1,
  });
  assert.equal(manifest.status, 'stopped');
  assert.equal(manifest.segments.length, 1);
  assert.equal(manifest.coverage, 0.05);
  assert.equal(manifest.containsGaps, true);
  assert.equal(manifest.completionReason, 'stop-file');
});

test('stops at the wall-clock deadline even after early exits', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rimplay-recording-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const time = clock();
  const manifest = await recordSession({seconds: 2, directory}, {
    now: time.now,
    launch: async () => {
      const startedAt = time.now().toISOString();
      time.advance(2000);
      return {exitCode: 0, startedAt, endedAt: time.now().toISOString()};
    },
    probe: async () => 0.5,
  });
  assert.equal(manifest.status, 'completed');
  assert.equal(manifest.segments.length, 1);
});

test('ffprobe reads a playable offline lavfi segment', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rimplay-recording-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const output = path.join(directory, 'fixture.mkv');
  const result = spawnSync(DEFAULT_FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=10', '-t', '0.5', '-c:v', 'libx264', '-f', 'matroska', output], {windowsHide: true});
  assert.equal(result.status, 0, result.stderr.toString());
  const duration = await probeDurationForTest(output);
  assert.ok(duration !== null && duration > 0.4 && duration < 0.7, `duration was ${duration}`);
});
