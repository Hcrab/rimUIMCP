import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, openSync, closeSync, writeFileSync, statfsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DEFAULT_FFMPEG} from './recording.ts';
import {saveRecordingManifest} from './recording-manifest.ts';

export type ContinuousRecordingOptions = {
  seconds: number;
  directory: string;
  segmentSeconds?: number;
  ffmpeg?: string;
  monitorHandle?: number;
  onSessionCreated?: (session: {directory: string; manifestFile: string; stopFile: string}) => void;
};

/** One capture/encoder process; FFmpeg rotates the containers without recapturing the window. */
export async function recordContinuous(options: ContinuousRecordingOptions) {
  const segmentSeconds = options.segmentSeconds ?? 300;
  if (!Number.isFinite(options.seconds) || options.seconds < 1 || options.seconds > 43200) throw Error('seconds must be 1..43200');
  if (!Number.isInteger(segmentSeconds) || segmentSeconds < 2 || segmentSeconds > 3600) throw Error('segmentSeconds must be 2..3600');
  if (options.monitorHandle !== undefined && (!Number.isSafeInteger(options.monitorHandle) || options.monitorHandle <= 0)) throw Error('monitorHandle must be a positive native monitor handle');
  const captureSource = options.monitorHandle === undefined
    ? 'gfxcapture=window_exe=RimWorldWin64.exe:max_framerate=30'
    : `gfxcapture=hmonitor=${options.monitorHandle}:max_framerate=30:capture_cursor=0:output_fmt=bgra`;
  mkdirSync(options.directory, {recursive: true});
  const disk = statfsSync(options.directory);
  if (disk.bavail * disk.bsize < 12 * 1024 ** 3) throw Error('Recording disk has less than 12 GiB free');
  const directory = mkdtempSync(path.join(path.resolve(options.directory), 'continuous-'));
  const manifestFile = path.join(directory, 'manifest.json'), stopFile = path.join(directory, 'stop');
  const started = Date.now(), deadline = started + options.seconds * 1000;
  const manifest = {
    version: 1, source: options.monitorHandle === undefined ? 'Windows.Graphics.Capture RimWorld window; no audio' : 'Windows.Graphics.Capture explicit monitor; no audio', captureSource,
    directory, startedAt: new Date(started).toISOString(), deadlineAt: new Date(deadline).toISOString(),
    requestedSeconds: options.seconds, segmentSeconds, status: 'recording',
    playlist: 'playlist.ffconcat', stopFile, lastProgressAt: null as string | null,
    frames: 0, mediaSeconds: 0, lastFrameAt: null as string | null, exitCode: null as number | null,
    completionReason: null as string | null, error: null as string | null, endedAt: null as string | null,
  };
  let manifestBlocked = false;
  const save = () => {
    const saved=saveRecordingManifest(manifestFile,manifest);
    if(!saved&&!manifestBlocked)console.warn('Recording manifest is locked; capture continues and snapshot write will retry.');
    if(saved&&manifestBlocked)console.warn('Recording manifest write recovered.');
    manifestBlocked=!saved;
    return saved;
  };
  save(); options.onSessionCreated?.({directory,manifestFile,stopFile});
  const logFd = openSync(path.join(directory,'capture.log'),'wx');
  const child = spawn(options.ffmpeg ?? DEFAULT_FFMPEG, [
    '-hide_banner','-loglevel','warning','-stats_period','1','-progress','pipe:1',
    '-f','lavfi','-i',captureSource,
    '-t',String(options.seconds),'-vf','hwdownload,format=bgra,format=nv12',
    '-c:v','h264_nvenc','-preset','p4','-cq','23','-g','60',
    '-force_key_frames',`expr:gte(t,n_forced*${segmentSeconds})`,
    '-f','segment','-segment_time',String(segmentSeconds),'-reset_timestamps','1',
    '-segment_format','matroska','-segment_list',path.join(directory,'playlist.ffconcat'),
    '-segment_list_type','ffconcat',path.join(directory,'segment-%04d.mkv'),
  ], {windowsHide:true,shell:false,stdio:['pipe','pipe',logFd]});
  closeSync(logFd);
  let pending = '', stopping = false, forceTimer: NodeJS.Timeout | undefined;
  let lastFrameTime = started;
  const stop = (reason: string) => {
    if (stopping) return;
    stopping = true; manifest.completionReason = reason;
    child.stdin?.write('q\n',()=>{});
    forceTimer = setTimeout(()=>child.kill(),5000);
  };
  child.stdin?.on('error',()=>{});
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data',(chunk:string)=>{
    pending += chunk; const lines = pending.split(/\r?\n/); pending = lines.pop() ?? '';
    for (const line of lines) {
      const [key,value] = line.split('=');
      if (key === 'frame') {
        const frames = Number(value);
        if (frames > manifest.frames) { lastFrameTime = Date.now(); manifest.lastFrameAt = new Date(lastFrameTime).toISOString(); }
        manifest.frames = frames;
      }
      if (key === 'out_time_us') manifest.mediaSeconds = Number(value)/1e6;
      if (key === 'progress') manifest.lastProgressAt = new Date().toISOString();
    }
  });
  const interval = setInterval(()=>{
    try {
      if (existsSync(stopFile)) stop('stop-file');
      else if (Date.now() >= deadline) stop('deadline');
      else if (Date.now() - lastFrameTime > 60000) {manifest.error='No encoded frame progress for 60 seconds';stop('frame-stall');}
      const current = statfsSync(directory);
      if (current.bavail*current.bsize < 12*1024**3) stop('low-disk-space');
      save();
    } catch (error) {manifest.error=String(error);stop('monitor-error');}
  },1000);
  const interrupt = () => stop('signal'); process.once('SIGINT',interrupt);
  try {
    manifest.exitCode = await new Promise<number|null>(resolve=>{
      child.once('error',error=>{manifest.error=String(error);resolve(null);});
      child.once('close',code=>resolve(code));
    });
  } finally {
    clearInterval(interval); if(forceTimer)clearTimeout(forceTimer);process.removeListener('SIGINT',interrupt);
    manifest.endedAt = new Date().toISOString();
    manifest.completionReason ??= manifest.exitCode === 0 ? (Date.now() >= deadline-500 ? 'encoder-duration' : 'encoder-early-exit') : 'encoder-error';
    manifest.status = manifest.exitCode === 0 && manifest.frames > 0 ? (['deadline','encoder-duration'].includes(manifest.completionReason)?'completed':'stopped') : 'failed';
    if(manifest.completionReason==='encoder-early-exit')manifest.status='failed';
    let saved=save();
    for(let i=0;!saved&&i<8;i++){await new Promise(resolve=>setTimeout(resolve,250));saved=save();}
    if(!saved)writeFileSync(path.join(directory,'manifest-final.json'),JSON.stringify(manifest,null,2)+'\n');
  }
  return manifest;
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await recordContinuous({seconds:Number(process.argv[2]??3600),directory:process.argv[3]??path.resolve('runs/media'),segmentSeconds:Number(process.argv[4]??300),onSessionCreated:session=>console.log(JSON.stringify(session))});
  console.log(JSON.stringify(result)); if(result.status==='failed')process.exitCode=1;
}
