import assert from 'node:assert/strict';
import test from 'node:test';
import {runBackendRpcWiring} from './helpers/l3_ipcHarness.mjs';

test('backend scan ownership and first-scan state are per registration', async () => {
 const timers=[];
 const a=runBackendRpcWiring({timers});
 const b=runBackendRpcWiring({timers});
 const sa=a.captured.get('session').deps.catalogScans;
 const sb=b.captured.get('session').deps.catalogScans;
 assert.ok(sa && sb, 'session IPC receives the owning backend scan scope');
 assert.notEqual(sa,sb);
 let runs=0;
 sa.schedule('a', async()=>{});
 sb.schedule('b', async()=>{runs++;});
 assert.equal(sa.hasScanned('a'),true);
 assert.equal(sb.hasScanned('a'),false);
 // Only run coordinator callbacks, not unrelated startup work.
 const queued=timers.slice(-2);
 a.dispose(); queued[0](); queued[1]();
 await new Promise(r=>setImmediate(r));
 assert.equal(runs,1,'disposing A must leave B queued scan alive');
 b.dispose();
});
