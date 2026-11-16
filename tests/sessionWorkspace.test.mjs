import assert from "node:assert/strict";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";
import { mountSessionWorkspace } from "./helpers/sessionWorkspaceHarness.mjs";

const records=Object.fromEntries(["a","b","c","d"].map(id=>[id,{id,projectId:id==="d"?"other":"p"}]));
const props=(id="a",projectId="p")=>({currentSessionId:id,activeProjectId:projectId});
const edge=(sessionId,side="right")=>({kind:"session-edge",sessionId,edge:side});
const ids=(workspace)=>Array.from(workspace.mounted.result().splitLayout?.panels.flatMap(p=>p.kind==="session"?[p.sessionId]:[p.first,p.second]) ?? []);

test("consecutive sidebar drops use the latest layout even within one React batch",async()=>withHookHost(async host=>{
 const w=await mountSessionWorkspace(host,props(),records);
 await host.act(async()=>{
   w.mounted.result().dropSplit("b",edge("a"));
   w.mounted.result().dropSplit("c",edge("b"));
 });
 assert.deepEqual(ids(w),["a","b","c"]);
 assert.deepEqual(w.focusCalls,[]);
}));

test("sidebar navigation preserves the split, and stale hidden-pane drops are ignored",async()=>withHookHost(async host=>{
 const w=await mountSessionWorkspace(host,props(),records);
 await host.act(async()=>w.mounted.result().dropSplit("b",edge("a")));
 await w.mounted.rerender(props("d","other"));
 await host.act(async()=>w.mounted.result().dropSplit("c",edge("a")));
 assert.deepEqual(ids(w),["a","b"]);
 await host.act(async()=>w.mounted.result().dropSplit("c",edge("d","left")));
 assert.deepEqual(ids(w),["c","d"]);
 assert.deepEqual(w.focusCalls,[]);
}));

test("center replacement transfers focus only when replacing the focused pane",async()=>withHookHost(async host=>{
 const w=await mountSessionWorkspace(host,props(),records);
 await host.act(async()=>w.mounted.result().dropSplit("b",edge("a")));
 await host.act(async()=>w.mounted.result().dropSplit("c",{kind:"session-center",sessionId:"b"}));
 assert.deepEqual(w.focusCalls,[]);
 await host.act(async()=>w.mounted.result().dropSplit("d",{kind:"session-center",sessionId:"a"}));
 assert.deepEqual(w.focusCalls,[{projectId:"other",sessionId:"d"}]);
 assert.deepEqual(ids(w),["d","c"]);
}));

test("deleted drag records and duplicate sessions cannot create panes",async()=>withHookHost(async host=>{
 const w=await mountSessionWorkspace(host,props(),records);
 await host.act(async()=>w.mounted.result().dropSplit("missing",edge("a")));
 await host.act(async()=>w.mounted.result().dropSplit("a",edge("a")));
 assert.deepEqual(ids(w),[]);
 await host.act(async()=>w.mounted.result().dropSplit("b",edge("a")));
 await host.act(async()=>w.mounted.result().dropSplit("b",edge("a","bottom")));
 assert.deepEqual(ids(w),["a","b"]);
}));

test("deleting the focused split session selects a surviving pane",async()=>withHookHost(async host=>{
 const w=await mountSessionWorkspace(host,props(),records);
 await host.act(async()=>w.mounted.result().dropSplit("b",edge("a")));
 const {a,...remaining}=records;
 await w.setRecords(remaining);
 assert.deepEqual(ids(w),[]);
 assert.deepEqual(w.focusCalls,[{projectId:"p",sessionId:"b"}]);
}));

test("exiting a nonfocused split pane expands that session without stopping its runtime",async()=>withHookHost(async host=>{
 const w=await mountSessionWorkspace(host,props(),records);
 await host.act(async()=>w.mounted.result().dropSplit("b",edge("a")));
 await host.act(async()=>w.mounted.result().exitSplit("b"));
 assert.deepEqual(ids(w),[]);
 assert.deepEqual(w.focusCalls,[{projectId:"p",sessionId:"b"}]);
 assert.deepEqual(w.store.get(w.atoms.sessionRecordsAtom),records);
}));
