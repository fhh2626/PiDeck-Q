import { performance } from "node:perf_hooks";
import { withHistoryFixture } from "../tests/helpers/performanceFixtures.mjs";
import { loadTsCommonJs } from "../tests/helpers/loadTsCommonJs.mjs";

// Run separately from CI: time is diagnostic, not a pass/fail threshold.
console.log(JSON.stringify({ node: process.version, note: "isolated fixtures; not WSL/Qt profiling" }));
const { buildActiveBranchEntryIds } = loadTsCommonJs("src/main/pi/sessionEntryIds.ts");
for (const count of [10_000, 30_000, 60_000]) {
  const entries = Array.from({ length: count }, (_, i) => ({ id: `e${i}`, parentId: i ? `e${i - 1}` : null, type: "message" }));
  const times = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const result = buildActiveBranchEntryIds(entries, `e${count - 1}`);
    if (result.length !== count) throw new Error("branch result mismatch");
    times.push(performance.now() - start);
  }
  console.log(JSON.stringify({ case: "active-branch", count, medianMs: times.sort((a, b) => a - b)[2] }));
}
for (const size of [10, 50]) {
  await withHistoryFixture(size, async ({ reader, path, metrics, fileBytes, count }) => {
    const start = performance.now();
    await reader.readRecentMessages(path, 3);
    await reader.getActiveEntryCount(path);
    await reader.scanCompactions(path);
    console.log(JSON.stringify({ case: "cold-history", fileBytes, count, ...metrics, ms: performance.now() - start }));
    metrics.bytes = metrics.fullReads = metrics.opens = 0;
    await reader.readMessageFullText(path, "m0", "e0");
    console.log(JSON.stringify({ case: "warm-full-text", fileBytes, ...metrics }));
  });
}
