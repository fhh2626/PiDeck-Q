import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentManagerHarness } from './helpers/l2_agentManagerHarness.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));

test('restart does not create a replacement until old process shutdown completes', async () => {
 const h = createAgentManagerHarness();
 const tab = await h.manager.create({projectId: h.project.id, deckSessionId: 'session'});
 let release;
 h.processes[0].stop = () => new Promise(resolve => {release = resolve;});
 const restarting = h.manager.restart(tab.id);
 await flush();
 assert.equal(h.processes.length, 1, 'old process still owns the session file');
 release(true);
 await restarting;
 assert.equal(h.processes.length, 2);
 h.manager.stopAll();
});

test('restart fails closed when old process does not terminate', async () => {
 const h = createAgentManagerHarness();
 const tab = await h.manager.create({projectId: h.project.id, deckSessionId: 'session'});
 h.processes[0].stop = async () => false;
 await assert.rejects(h.manager.restart(tab.id), /did not exit/);
 assert.equal(h.processes.length, 1);
});

test('stopAll waits for every process shutdown', async () => {
 const h = createAgentManagerHarness();
 await h.manager.create({projectId: h.project.id, deckSessionId: 'session'});
 let release;
 h.processes[0].stop = () => new Promise(resolve => {release = resolve;});
 let done = false;
 const stopping = Promise.resolve(h.manager.stopAll()).then(() => {done = true;});
 await flush();
 assert.equal(done, false);
 release(true); await stopping;
});

test('restart suppresses terminal old-runtime events while waiting for shutdown', async () => {
 const h = createAgentManagerHarness();
 const tab = await h.manager.create({projectId:h.project.id,deckSessionId:'session',noSession:true});
 const closed=[];
 h.manager.onOutput((channel,payload)=>{if(channel==='agents:state'&&Array.isArray(payload))for(const item of payload)if(item.id===tab.id&&item.status==='closed')closed.push(item.id);});
 h.processes[0].stop=async()=>{h.processes[0].emit('exit',{code:0,signal:null});return true;};
 await h.manager.restart(tab.id);
 assert.deepEqual(closed, [], 'an anonymous session must not be detached by a terminal event during restart');
 await h.manager.stopAll();
});
