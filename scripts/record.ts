import {recordSession} from './recording.ts';
import {writeFileSync} from 'node:fs';

const seconds = Number(process.argv[2] ?? 120);
let stopFile: string | undefined;
process.on('SIGINT', () => {
  if (stopFile) writeFileSync(stopFile, 'stop\n', 'utf8');
});

recordSession({seconds, onSessionCreated: session => {
  stopFile = session.stopFile;
  console.log(JSON.stringify({
    sessionDirectory: session.sessionDirectory,
    manifest: session.manifestFile,
    stopFile: session.stopFile,
    seconds,
  }));
}}).then(manifest => {
  console.log(JSON.stringify({
    sessionDirectory: manifest.sessionDirectory,
    manifest: `${manifest.sessionDirectory}/manifest.json`,
    status: manifest.status,
    segments: manifest.segments.length,
  }));
  if (manifest.status === 'failed') process.exitCode = 1;
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
