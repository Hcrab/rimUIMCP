import {copyFile, mkdir, rename, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {connect} from '../packages/sdk/src/index.ts';

export interface GameFrame {
  index: number;
  file: string;
  capturedAt: string;
  sourcePath: string;
  sizeBytes: number;
  sha256: string;
}

export interface GameFrameManifest {
  version: 1;
  source: 'RimBridge SDK ui.screenshot (low-frame-rate fallback; raw PNG sequence)';
  requestedSeconds: number;
  framesPerSecond: number;
  startedAt: string;
  endedAt?: string;
  status: 'recording' | 'completed' | 'stopped' | 'failed';
  sessionDirectory: string;
  frames: GameFrame[];
  recordedFrameCount?: number;
  observedSpanSeconds?: number;
  failure?: string;
}

export interface GameFrameOptions {
  seconds: number;
  framesPerSecond?: number;
  directory?: string;
  shouldStop?: () => boolean;
}

export interface GameFrameDependencies {
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  screenshot?: (name: string) => Promise<{path: string; sizeBytes?: number}>;
  copy?: (source: string, destination: string) => Promise<void>;
  readFile?: (file: string) => Promise<Buffer>;
  writeManifest?: (file: string, manifest: GameFrameManifest) => Promise<void>;
}

const sleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

async function atomicManifest(file: string, manifest: GameFrameManifest): Promise<void> {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

function checkOptions(options: GameFrameOptions): Required<Pick<GameFrameOptions, 'seconds' | 'framesPerSecond'>> {
  const framesPerSecond = options.framesPerSecond ?? 1;
  if (!Number.isFinite(options.seconds) || options.seconds <= 0) throw new Error('seconds must be positive.');
  if (!Number.isFinite(framesPerSecond) || framesPerSecond < 1 || framesPerSecond > 2) throw new Error('framesPerSecond must be between 1 and 2.');
  return {seconds: options.seconds, framesPerSecond};
}

/**
 * Captures only through RimBridge's observation-only ui.screenshot endpoint.
 * Each destination PNG is a byte-for-byte copy of the game-generated source.
 */
export async function recordGameFrames(options: GameFrameOptions, dependencies: GameFrameDependencies = {}): Promise<GameFrameManifest> {
  const {seconds, framesPerSecond} = checkOptions(options);
  const directory = path.resolve(options.directory ?? 'runs/media/game-frames');
  await mkdir(directory, {recursive: true});
  const manifestFile = path.join(directory, 'manifest.json');
  const now = dependencies.now ?? (() => new Date());
  const game = dependencies.screenshot ? undefined : await connect();
  const capture = dependencies.screenshot ?? (async name => {
    const result = await game!.ui.screenshot(name);
    return result.data as {path: string; sizeBytes?: number};
  });
  const copy = dependencies.copy ?? copyFile;
  const read = dependencies.readFile ?? (file => import('node:fs/promises').then(fs => fs.readFile(file)));
  const save = dependencies.writeManifest ?? atomicManifest;
  const started = now();
  const deadline = started.getTime() + seconds * 1000;
  const intervalMs = 1000 / framesPerSecond;
  const manifest: GameFrameManifest = {
    version: 1,
    source: 'RimBridge SDK ui.screenshot (low-frame-rate fallback; raw PNG sequence)',
    requestedSeconds: seconds,
    framesPerSecond,
    startedAt: started.toISOString(),
    status: 'recording',
    sessionDirectory: directory,
    frames: [],
  };
  await save(manifestFile, manifest);
  try {
    let nextCaptureAt = started.getTime();
    while (now().getTime() < deadline && !options.shouldStop?.()) {
      const source = await capture('rimplay-game-frame');
      const index = manifest.frames.length + 1;
      const file = `frame-${String(index).padStart(4, '0')}.png`;
      const destination = path.join(directory, file);
      await copy(source.path, destination);
      const bytes = await read(destination);
      manifest.frames.push({
        index,
        file,
        capturedAt: now().toISOString(),
        sourcePath: source.path,
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      await save(manifestFile, manifest);
      nextCaptureAt += intervalMs;
      const remaining = deadline - now().getTime();
      const wait = Math.min(Math.max(0, nextCaptureAt - now().getTime()), remaining);
      if (wait > 0) await (dependencies.sleep ?? sleep)(wait);
    }
    manifest.status = options.shouldStop?.() ? 'stopped' : 'completed';
  } catch (error) {
    manifest.status = 'failed';
    manifest.failure = error instanceof Error ? error.message : String(error);
  }
  manifest.recordedFrameCount = manifest.frames.length;
  if (manifest.frames.length > 1) {
    manifest.observedSpanSeconds = (new Date(manifest.frames.at(-1)!.capturedAt).getTime() - new Date(manifest.frames[0].capturedAt).getTime()) / 1000;
  } else {
    manifest.observedSpanSeconds = 0;
  }
  manifest.endedAt = now().toISOString();
  await save(manifestFile, manifest);
  return manifest;
}

async function main(): Promise<void> {
  const seconds = Number(process.argv[2] ?? 10);
  const framesPerSecond = Number(process.argv[3] ?? 1);
  const directory = process.argv[4] ?? 'runs/media/game-frames';
  let stopped = false;
  process.on('SIGINT', () => { stopped = true; });
  const manifest = await recordGameFrames({seconds, framesPerSecond, directory, shouldStop: () => stopped});
  console.log(JSON.stringify({directory: manifest.sessionDirectory, status: manifest.status, frames: manifest.recordedFrameCount, observedSpanSeconds: manifest.observedSpanSeconds}));
  if (manifest.status === 'failed') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
