import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import {loadPiProcess} from './helpers/loadPiProcess.mjs';
import {trackedTempDirs} from './helpers/trackedTempDirs.mjs';
const temp = trackedTempDirs();
for (const probeFails of [false, true]) test(`auto startup re-probes a replaced binary and discards stale persisted identity (failure=${probeFails})`, async () => {
 const binary = join(temp('pideck-replaced-auto-'), 'pi.exe'); writeFileSync(binary, 'original');
 const spawned=[]; let probes=0;
 const {PiProcess}=loadPiProcess(spawned, {versionResult:()=>{probes++;return probes===1?{error:null,stdout:'1.4.0'}:probeFails?{error:new Error('failed'),stdout:''}:{error:null,stdout:'1.4.0 (Pi-Bolt 1.0.2)'};}});
 const locator={resolveCommand:()=>binary,createInvocation:(command,args)=>({command,args}),createProcessEnv:()=>({})};
 const settings={piRuntimePreference:'auto', piInstall:{command:binary,version:'1.4.0',runtimeKind:'typescript'}};
 await PiProcess.warmVersionCache(settings,locator); writeFileSync(binary,'replacement is bolt');
 const pi=new PiProcess(process.cwd(),settings,locator);
 await pi.start(undefined,undefined,true);
 assert.equal(probes,2);
 assert.equal(spawned[0].options.env.PIDECK_PI_STANDALONE,probeFails?undefined:'1');
 // Failed re-probe must not use stale TypeScript-only offline flags.
 assert.equal(spawned[0].args.includes('--offline'),!probeFails);
 spawned[0].child.emit('exit',0,null);
});
