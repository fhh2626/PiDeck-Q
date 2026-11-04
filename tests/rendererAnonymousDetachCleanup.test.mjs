import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const atoms = loadTsCommonJs("src/renderer/src/atoms/index.ts");

/** Execute the real runtime event bridge against a real Jotai store, faking only desktop transport. */
function harness({ anonymous = true } = {}) {
  const store = createStore();
  store.set(atoms.sessionRecordsAtom, { session: { id: "session", projectId: "project", title: "Title", noSession: anonymous, createdAt: 1, updatedAt: 1, source: "pi", environment: "native" } });
  store.set(atoms.sessionRuntimeByIdAtom, { session: { agentId: "agent", runtimeGeneration: 2, status: "idle", updatedAt: 1 } });
  store.set(atoms.sessionDraftByIdAtom, { session: "private draft", other: "preserve" });
  store.set(atoms.sessionAttachmentsByIdAtom, { session: [{ type: "image", data: "large", mimeType: "image/png" }] });
  store.set(atoms.sessionSendStateByIdAtom, { session: { status: "unknown", unknownSnapshot: { message: "private snapshot" } } });
  let receive;
  let dispose;
  const { useSessionRuntimeBridge } = loadTsCommonJs("src/renderer/src/hooks/useSessionRuntimeBridge.ts", {
    stubs: {
      react: { useRef: (value) => ({ current: value }), useEffect: (fn) => { dispose = fn(); } },
      jotai: { useStore: () => store },
      "../atoms": atoms,
      "../atoms/runtime-atoms": atoms,
      "../desktopApi": { desktopApi: { sessions: { listRuntimes: () => new Promise(() => {}), onRuntimeEvent: (fn) => { receive = fn; return () => {}; } } } },
      "../i18n": { t: (key) => key },
      "../utils/notice": { showNotice() {} },
    },
  });
  useSessionRuntimeBridge();
  return { store, dispose, emit: (event) => receive(event), detach: (overrides = {}) => receive({ kind: "detach", sessionId: "session", agentId: "agent", runtimeGeneration: 2, sourceChannel: "sessions:runtime", ...overrides }) };
}

test("anonymous detach releases draft, attachments and unknown-delivery snapshots", () => {
  const h = harness();
  try {
    h.detach();
    assert.equal(h.store.get(atoms.sessionRecordsAtom).session, undefined);
    for (const a of [atoms.sessionDraftByIdAtom, atoms.sessionAttachmentsByIdAtom, atoms.sessionSendStateByIdAtom]) assert.equal(h.store.get(a).session, undefined);
    assert.equal(h.store.get(atoms.sessionDraftByIdAtom).other, "preserve");
  } finally { h.dispose(); }
});

test("stale anonymous detach does not erase the replacement runtime's composer", () => {
  const h = harness();
  try {
    h.detach({ agentId: "old-agent", runtimeGeneration: 1 });
    assert.equal(h.store.get(atoms.sessionDraftByIdAtom).session, "private draft");
    assert.equal(h.store.get(atoms.sessionRuntimeByIdAtom).session.runtimeGeneration, 2);
  } finally { h.dispose(); }
});

test("persistent detach preserves the resumable session's unsent draft", () => {
  const h = harness({ anonymous: false });
  try {
    h.detach();
    assert.equal(h.store.get(atoms.sessionDraftByIdAtom).session, "private draft");
    assert.equal(h.store.get(atoms.sessionRecordsAtom).session.id, "session");
  } finally { h.dispose(); }
});

const agentFamilies = [atoms.agentByIdAtomFamily, atoms.runtimeCapabilityByAgentIdAtomFamily, atoms.sessionIdByRuntimeAgentIdAtomFamily];
for (const kind of ['closed', 'detach', 'replace']) test(`canonical ${kind} reclaims the old agent's family instances`, () => {
  const h = harness({anonymous:false});
  const prior = agentFamilies.map(family => family('agent'));
  try {
    if (kind === 'detach') h.detach();
    else h.emit({kind:'event',sessionId:'session',agentId:kind==='replace'?'new-agent':'agent',runtimeGeneration:kind==='replace'?3:2,sourceChannel:'agents:state',payload:{id:'agent',status:kind==='closed'?'closed':'idle'}});
    agentFamilies.forEach((family,index)=>assert.notEqual(family('agent'),prior[index]));
  } finally { h.dispose(); }
});

test('stale single-object closed event does not reclaim current binding family instances', () => {
 const h=harness(); const prior=agentFamilies.map(f=>f('agent'));
 try {
  h.emit({kind:'event',sessionId:'session',agentId:'agent',runtimeGeneration:1,sourceChannel:'agents:state',payload:{id:'agent',status:'closed'}});
  agentFamilies.forEach((family,index)=>assert.equal(family('agent'),prior[index]));
  assert.equal(h.store.get(atoms.sessionRuntimeByIdAtom).session.agentId,'agent');
 } finally {h.dispose();}
});
