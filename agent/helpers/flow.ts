import type {Game} from '../../packages/sdk/src/index.ts';
import{readAllPawns}from'./pawns.ts';
/**
 * Configures the simulated-time budget in ticks, and wall-clock limits in milliseconds. It
 * acknowledges already-handled mental states via knownMentalStates, supports custom stop reasons
 * via stopWhen, and extends observation beyond residents using watchedPawnIds. The runAndWatch
 * helper attempts to pause upon completion, requiring the caller to control the next resume
 * explicitly.
 */
export type WatchOptions={ticks:number;timeoutMs?:number;speed?:number;pollMs?:number;stopOnNewLetter?:boolean;signal?:AbortSignal;watchedPawnIds?:string[];knownMentalStates?:Record<string,string>;onObservation?:(observation:any)=>void|Promise<void>;stopWhen?:(observation:any)=>string|undefined|Promise<string|undefined>};

function normalizeWatchedPawnIds(value: unknown): string[] {
 if (value === undefined) return [];
 if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || id.length === 0 || id.trim() !== id))
  throw new Error('watchedPawnIds must be an array of non-empty ID strings.');
 return [...new Set(value)];
}

/** Run normally, observe conditions, and pause in finally. Tick budget can overshoot by one poll. */
export async function runAndWatch(game:Game,options:WatchOptions){
 if(!Number.isInteger(options.ticks)||options.ticks<1)throw new Error('ticks must be a positive integer.');
 const poll=options.pollMs??1000;if(poll<100||poll>5000)throw new Error('pollMs must be 100..5000.');
 const watchedPawnIds=normalizeWatchedPawnIds(options.watchedPawnIds),watched=new Set(watchedPawnIds);
 const start=await game.status(),started=Date.now(),deadline=started+(options.timeoutMs??180000),speed=options.speed??3;
 let cursor=0;
 let reason='timeout',latest:any,lastTick=start.meta.gameTick,lastProgress=Date.now(),missingPawnIds:string[]=[];
 try{
  cursor=(await game.events.poll()).data.cursor;
  // IsColonistPlayerControlled becomes false during a mental break. Membership
  // must survive losing direct control, including a break already in progress.
  const resident=(p:any)=>p.colonist||(p.factionIsPlayer&&p.humanlike);
  const initial=await readAllPawns(game,{colonistsOnly:false,pauseForConsistency:()=>game.runtime.pause()});
  const colonists=initial.data.items.filter(resident).map((p:any)=>p.id);
  const acknowledgedMentalStates={...options.knownMentalStates};
  const newMentalState=(p:any)=>{
   if(!p.mentalState){delete acknowledgedMentalStates[p.id];return false;}
   return acknowledgedMentalStates[p.id]!==p.mentalState;
  };
  const attention=(ps:any[])=>{
   if(ps.some(p=>(resident(p)||colonists.includes(p.id))&&(p.dead||p.downed||newMentalState(p))))return 'colonist-needs-attention';
   if(colonists.some((id:string)=>!ps.some(p=>p.id===id)))return 'colonist-missing';
   if(ps.some(p=>p.spawned&&p.hostile&&!p.dead&&!p.downed))return 'hostile';
   return undefined;
  };
  const watchedAttention=(ps:any[])=>{
   missingPawnIds=watchedPawnIds.filter(id=>!ps.some(p=>p.id===id));
   if(missingPawnIds.length)return 'watched-pawn-missing';
   if(ps.some(p=>watched.has(p.id)&&(p.dead||p.downed||newMentalState(p))))return 'watched-pawn-needs-attention';
   return undefined;
  };
  latest=initial;
  if(initial.meta.sessionId!==start.meta.sessionId||initial.meta.worldEpoch!==start.meta.worldEpoch||initial.meta.mapId!==start.meta.mapId)reason='world-changed';
  else if(options.signal?.aborted)reason='cancelled';
  else {
   const initialStop=watchedAttention(initial.data.items)??attention(initial.data.items)??await options.stopWhen?.(initial);
   if(initialStop)reason=initialStop;
   else {
   await game.runtime.speed(speed);
   while(Date.now()<deadline){
   if(options.signal?.aborted){reason='cancelled';break;}
   await new Promise(resolve=>setTimeout(resolve,poll));
   latest=await readAllPawns(game,{colonistsOnly:false,pauseForConsistency:()=>game.runtime.pause()});
   if(latest.meta.sessionId!==start.meta.sessionId||latest.meta.worldEpoch!==start.meta.worldEpoch||latest.meta.mapId!==start.meta.mapId){reason='world-changed';break;}
   const ps=latest.data.items;
   const watchedStop=watchedAttention(ps);if(watchedStop){reason=watchedStop;break;}
   await options.onObservation?.(latest);
   const observedStop=attention(ps);if(observedStop){reason=observedStop;break;}
   const requestedStop=await options.stopWhen?.(latest);if(requestedStop){reason=requestedStop;break;}
   if(latest.meta.gameTick!==lastTick){lastTick=latest.meta.gameTick;lastProgress=Date.now();}
   else if(Date.now()-lastProgress>5000){reason='simulation-not-advancing';break;}
   const events=(await game.events.poll(cursor)).data;
   if(events.gap){reason='event-gap';break;}
   cursor=events.cursor;
   if(options.stopOnNewLetter!==false&&events.events.some((e:any)=>e.name==='notification.letter')){reason='new-letter';break;}
   if(latest.meta.gameTick-start.meta.gameTick>=options.ticks){reason='tick-budget';break;}
   if(latest.resumeRequired)await game.runtime.speed(speed);
   }
   }
  }
 }finally{await game.runtime.pause();}
 const end=await game.status();
 return{reason,start:start.meta,end:end.meta,elapsedTicks:end.meta.gameTick-start.meta.gameTick,elapsedMs:Date.now()-started,watchedPawnIds,missingPawnIds,pawns:latest?.data.items,pawnObservation:latest};
}
