import {spawn as nodeSpawn, type ChildProcess} from 'node:child_process';
import {closeSync, existsSync, mkdirSync, mkdtempSync, openSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';

export const DEFAULT_FFMPEG = process.env.RIMUIMCP_FFMPEG ?? 'ffmpeg';
export const SEGMENT_SECONDS = 60;
const MAX_EMPTY_SEGMENTS = 3;

export type SessionStatus = 'recording' | 'completed' | 'stopped' | 'failed';

export interface SegmentManifest {
  file: string;
  log: string;
  startedAt: string;
  endedAt: string;
  requestedSeconds: number;
  durationSeconds: number | null;
  exitCode: number | null;
  status: 'complete' | 'early-exit' | 'unplayable';
  unrecordedWallSeconds: number;
  missingFromRequestedSeconds: number;
}

export interface RecordingGap {
  afterSegment: string;
  beforeSegment: string;
  seconds: number;
}

export interface RecordingManifest {
  version: 1;
  source: string;
  requestedSeconds: number;
  startedAt: string;
  endedAt?: string;
  status: SessionStatus;
  sessionDirectory: string;
  stopFile: string;
  segments: SegmentManifest[];
  gaps: RecordingGap[];
  recordedSeconds?: number;
  coverage?: number;
  containsGaps?: boolean;
  completionReason?: 'deadline-reached' | 'stop-file' | 'failure';
  failure?: string;
}

export interface SegmentRequest {
  output: string;
  logFile: string;
  seconds: number;
  deadlineAt: number;
  shouldStop: () => boolean;
}

export interface SegmentRun {
  exitCode: number | null;
  startedAt: string;
  endedAt: string;
}

export interface RecordingDependencies {
  now?: () => Date;
  exists?: (file: string) => boolean;
  launch?: (request: SegmentRequest) => Promise<SegmentRun>;
  probe?: (file: string) => Promise<number | null>;
  writeManifest?: (file: string, manifest: RecordingManifest) => void;
}

export interface RecordingOptions {
  seconds: number;
  directory?: string;
  ffmpeg?: string;
  onSessionCreated?: (session: {sessionDirectory: string; manifestFile: string; stopFile: string}) => void;
}

function iso(now: () => Date): string { return now().toISOString(); }

function atomicJson(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, file);
}

function makeSessionDirectory(directory: string): string {
  mkdirSync(directory, {recursive: true});
  return mkdtempSync(path.join(directory, 'rimplay-'));
}

function waitForClose(child: ChildProcess): Promise<number | null> {
  return new Promise(resolve => {
    child.once('error', () => resolve(null));
    child.once('close', code => resolve(code));
  });
}

function defaultLauncher(ffmpeg: string, now: () => Date): (request: SegmentRequest) => Promise<SegmentRun> {
  return async request => {
    const startedAt = iso(now);
    const logFd = openSync(request.logFile, 'wx');
    let child: ChildProcess;
    try {
      child = nodeSpawn(ffmpeg, [
        '-hide_banner', '-loglevel', 'warning',
        '-f', 'lavfi', '-i', 'gfxcapture=window_exe=RimWorldWin64.exe:max_framerate=30',
        '-t', String(request.seconds),
        '-vf', 'hwdownload,format=bgra,format=nv12',
        '-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '23',
        '-f', 'matroska', request.output,
      ], {windowsHide: true, shell: false, stdio: ['pipe', 'ignore', logFd]});
    } finally {
      closeSync(logFd);
    }
    let askedToStop = false;
    let forceStopTimer: NodeJS.Timeout | undefined;
    const askToStop = () => {
      if (!askedToStop) {
        askedToStop = true;
        child.stdin?.on('error', () => {}); // ffmpeg may have already closed stdin (EPIPE).
        try {
          child.stdin?.write('q\n', () => {});
        } catch {
          // A closed stdin cannot prevent the deadline fallback below.
        }
        forceStopTimer = setTimeout(() => { child.kill(); }, 5000);
      }
    };
    const stopTimer = setInterval(() => { if (request.shouldStop()) askToStop(); }, 200);
    const deadlineTimer = setTimeout(askToStop, Math.max(0, request.deadlineAt - now().getTime()));
    try {
      const exitCode = await waitForClose(child);
      return {exitCode, startedAt, endedAt: iso(now)};
    } finally {
      clearInterval(stopTimer);
      clearTimeout(deadlineTimer);
      if (forceStopTimer) clearTimeout(forceStopTimer);
    }
  };
}

function defaultProbe(ffprobe: string): (file: string) => Promise<number | null> {
  return async file => new Promise(resolve => {
    const child = nodeSpawn(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], {
      windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (duration: number | null) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(duration);
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { output += chunk; });
    child.once('error', () => finish(null));
    child.once('close', code => {
      const duration = Number(output.trim());
      finish(code === 0 && Number.isFinite(duration) && duration >= 0 ? duration : null);
    });
    timeout = setTimeout(() => {
      child.kill();
      finish(null);
    }, 10000);
  });
}

export async function recordSession(options: RecordingOptions, dependencies: RecordingDependencies = {}): Promise<RecordingManifest> {
  if (!Number.isFinite(options.seconds) || options.seconds < 1 || options.seconds > 43200) {
    throw new Error('Recording duration must be 1..43200 seconds');
  }
  const now = dependencies.now ?? (() => new Date());
  const exists = dependencies.exists ?? existsSync;
  const directory = options.directory ?? path.resolve('runs/media');
  const sessionDirectory = makeSessionDirectory(directory);
  const manifestFile = path.join(sessionDirectory, 'manifest.json');
  const stopFile = path.join(sessionDirectory, 'stop');
  const ffmpeg = options.ffmpeg ?? process.env.RIMUIMCP_FFMPEG ?? DEFAULT_FFMPEG;
  const ffprobe = path.join(path.dirname(ffmpeg), 'ffprobe.exe');
  const launch = dependencies.launch ?? defaultLauncher(ffmpeg, now);
  const probe = dependencies.probe ?? defaultProbe(ffprobe);
  const writeManifest = dependencies.writeManifest ?? atomicJson;
  const started = now();
  const deadline = started.getTime() + options.seconds * 1000;
  const manifest: RecordingManifest = {
    version: 1,
    source: 'Windows.Graphics.Capture game window',
    requestedSeconds: options.seconds,
    startedAt: started.toISOString(),
    status: 'recording',
    sessionDirectory,
    stopFile,
    segments: [],
    gaps: [],
  };
  const save = () => writeManifest(manifestFile, manifest);
  save();
  options.onSessionCreated?.({sessionDirectory, manifestFile, stopFile});
  let emptySegments = 0;
  try {
    while (now().getTime() < deadline && !exists(stopFile)) {
      const remainingSeconds = Math.max(0, (deadline - now().getTime()) / 1000);
      const requestedSeconds = Math.min(SEGMENT_SECONDS, remainingSeconds);
      if (requestedSeconds <= 0) break;
      const index = String(manifest.segments.length + 1).padStart(4, '0');
      const output = path.join(sessionDirectory, `segment-${index}.mkv`);
      const logFile = path.join(sessionDirectory, `segment-${index}.log`);
      const run = await launch({output, logFile, seconds: requestedSeconds, deadlineAt: deadline, shouldStop: () => exists(stopFile) || now().getTime() >= deadline});
      const durationSeconds = await probe(output);
      const elapsedSeconds = Math.max(0, (new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()) / 1000);
      const early = durationSeconds === null || durationSeconds + 0.25 < requestedSeconds;
      const previous = manifest.segments.at(-1);
      if (previous) {
        const betweenSegments = Math.max(0, (new Date(run.startedAt).getTime() - new Date(previous.endedAt).getTime()) / 1000);
        if (betweenSegments > 0.01) manifest.gaps.push({afterSegment: previous.file, beforeSegment: path.basename(output), seconds: betweenSegments});
      }
      manifest.segments.push({
        file: path.basename(output), log: path.basename(logFile), startedAt: run.startedAt, endedAt: run.endedAt, requestedSeconds,
        durationSeconds, exitCode: run.exitCode,
        status: durationSeconds === null ? 'unplayable' : early ? 'early-exit' : 'complete',
        unrecordedWallSeconds: Math.max(0, elapsedSeconds - (durationSeconds ?? 0)),
        missingFromRequestedSeconds: Math.max(0, requestedSeconds - (durationSeconds ?? 0)),
      });
      save();
      if (durationSeconds === null || durationSeconds < 0.25) {
        emptySegments += 1;
        if (emptySegments >= MAX_EMPTY_SEGMENTS && !exists(stopFile) && now().getTime() < deadline) {
          manifest.status = 'failed';
          manifest.failure = 'Capture produced no playable video repeatedly; the game window may have disappeared.';
          break;
        }
      } else {
        emptySegments = 0;
      }
    }
    if (manifest.status === 'recording') {
      manifest.status = exists(stopFile) ? 'stopped' : 'completed';
      manifest.completionReason = manifest.status === 'stopped' ? 'stop-file' : 'deadline-reached';
    }
  } catch (error) {
    manifest.status = 'failed';
    manifest.completionReason = 'failure';
    manifest.failure = error instanceof Error ? error.message : String(error);
  }
  if (manifest.status === 'failed') manifest.completionReason = 'failure';
  const recordedSeconds = manifest.segments.reduce((total, segment) => total + (segment.durationSeconds ?? 0), 0);
  manifest.recordedSeconds = recordedSeconds;
  manifest.coverage = Math.min(1, recordedSeconds / options.seconds);
  manifest.containsGaps = manifest.gaps.length > 0 || manifest.segments.some(segment => segment.status === 'unplayable' || segment.unrecordedWallSeconds > 0.01) || manifest.coverage < 0.999;
  manifest.endedAt = iso(now);
  save();
  return manifest;
}

export async function probeDurationForTest(file: string): Promise<number | null> {
  return defaultProbe(path.join(path.dirname(DEFAULT_FFMPEG), 'ffprobe.exe'))(file);
}
