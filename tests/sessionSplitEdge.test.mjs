import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSplitLayoutFromDrop, canAcceptSplitDrop, edgeToOrientation,
  insertRootPaneFromDrop, nestSplitPaneFromDrop, replaceSplitPaneFromDrop,
  resolveSessionSplitEdge, resolveSplitAfterClose, pruneSessionSplitLayout,
  splitLayoutSessionIds, SESSION_DRAG_MIME,
} from "../src/renderer/src/utils/sessionSplitEdge.ts";

const pair = () => buildSplitLayoutFromDrop({ hostSessionId: "a", draggedSessionId: "b", edge: "right" });
const nested = () => nestSplitPaneFromDrop({ layout: pair(), draggedSessionId: "c", sessionId: "a", edge: "bottom" });
const grid = () => nestSplitPaneFromDrop({ layout: nested(), draggedSessionId: "d", sessionId: "b", edge: "top" });

// These tests execute the production layout functions, not copies of their algorithms.
test("sidebar drag identity and edge geometry work without an open-session registry", () => {
  assert.equal(SESSION_DRAG_MIME, "text/pideck-session");
  const rect = { left: 100, top: 50, width: 1000, height: 800 };
  for (const [x, y, expected] of [[110,450,"left"],[1090,450,"right"],[600,60,"top"],[600,840,"bottom"],[600,450,null],[99,450,null],[1101,450,null]]) {
    assert.equal(resolveSessionSplitEdge(x,y,rect),expected);
  }
  assert.equal(resolveSessionSplitEdge(100,50,{...rect,width:0}),null);
  assert.equal(resolveSessionSplitEdge(100,50,{...rect,height:0}),null);
  assert.equal(canAcceptSplitDrop({layout:null,draggedSessionId:"a",sessionId:"a",edge:"left"}),false);
  assert.equal(canAcceptSplitDrop({layout:null,draggedSessionId:"b",sessionId:"a",edge:null}),false);
});

for (const edge of ["left","right","top","bottom"]) {
  test(`a sidebar session creates a two-pane ${edge} split`, () => {
    const layout=buildSplitLayoutFromDrop({hostSessionId:"a",draggedSessionId:"b",edge});
    assert.equal(layout.orientation,edgeToOrientation(edge));
    assert.deepEqual(splitLayoutSessionIds(layout),["left","top"].includes(edge)?["b","a"]:["a","b"]);
    assert.equal(buildSplitLayoutFromDrop({hostSessionId:"a",draggedSessionId:"a",edge}),null);
  });
}

test("root insertion, nested splits and center replacement preserve order and input", () => {
  const layout=pair(); const before=structuredClone(layout);
  const three=insertRootPaneFromDrop({layout,draggedSessionId:"c",sessionId:"b",edge:"left"});
  assert.deepEqual(splitLayoutSessionIds(three),["a","c","b"]);
  const four=nestSplitPaneFromDrop({layout:three,draggedSessionId:"d",sessionId:"c",edge:"bottom"});
  assert.deepEqual(splitLayoutSessionIds(four),["a","c","d","b"]);
  assert.deepEqual(splitLayoutSessionIds(replaceSplitPaneFromDrop({layout:four,draggedSessionId:"e",sessionId:"d"})),["a","c","e","b"]);
  assert.deepEqual(layout,before);
});

test("drop preview agrees with the actual transition for all edges, limits and stale targets", () => {
  const layouts=[pair(),nested(),grid(),insertRootPaneFromDrop({layout:pair(),draggedSessionId:"c",sessionId:"b",edge:"right"})];
  for(const layout of layouts) for(const draggedSessionId of ["a","c","e",""]) for(const sessionId of ["a","b","c","missing"]) for(const edge of [null,"left","right","top","bottom"]) {
    const accepted=canAcceptSplitDrop({layout,draggedSessionId,sessionId,edge});
    const input={layout,draggedSessionId,sessionId,edge};
    const changed=edge===null ? replaceSplitPaneFromDrop(input) : edgeToOrientation(edge)===layout.orientation ? insertRootPaneFromDrop(input) : nestSplitPaneFromDrop(input);
    assert.equal(accepted,Boolean(changed),JSON.stringify(input));
    if(changed) {
      const ids=splitLayoutSessionIds(changed);
      assert.equal(ids.length,new Set(ids).size);
      assert.ok(ids.length<=4);
      assert.ok(changed.panels.length<=3);
    }
  }
});

test("removing a pane collapses the nested pair or returns its surviving solo session", () => {
  assert.deepEqual(resolveSplitAfterClose(pair(),"a"),{soloSessionId:"b"});
  assert.deepEqual(splitLayoutSessionIds(resolveSplitAfterClose(nested(),"c").layout),["a","b"]);
  const remaining=resolveSplitAfterClose(nested(),"b").layout;
  assert.equal(remaining.orientation,"vertical");
  assert.deepEqual(splitLayoutSessionIds(remaining),["a","c"]);
});

test("catalog deletion prunes all missing panes without removing surviving sessions", () => {
  const layout=grid();
  assert.equal(pruneSessionSplitLayout(layout,new Set(["a","b","c","d"])),layout);
  const remaining=pruneSessionSplitLayout(layout,new Set(["c","d"]));
  assert.deepEqual(splitLayoutSessionIds(remaining),["c","d"]);
  assert.equal(pruneSessionSplitLayout(layout,new Set(["c"])),null);
  assert.equal(pruneSessionSplitLayout(layout,new Set()),null);
});
