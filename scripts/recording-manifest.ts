import {writeFileSync,renameSync} from 'node:fs';

/** A Windows reader may briefly deny delete sharing. Preserve the old snapshot and retry later. */
export function saveRecordingManifest(file: string, value: unknown): boolean {
  writeFileSync(file+'.tmp',JSON.stringify(value,null,2)+'\n');
  try {renameSync(file+'.tmp',file);return true;}
  catch(error) {
    if(['EPERM','EBUSY','EACCES'].includes((error as NodeJS.ErrnoException).code??''))return false;
    throw error;
  }
}
