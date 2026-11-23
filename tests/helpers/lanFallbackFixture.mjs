import { readFileSync } from "node:fs";

// Browser output captured before retiring the old backend. This is test data,
// independent of the native HTML builder and its escaping rules.
const fixture = JSON.parse(readFileSync(new URL("../fixtures/lan-fallback-document.json", import.meta.url), "utf8"));
export function expectedFallbackPage() {
  return { prefix: fixture.prefix, suffix: fixture.suffix, interpolations: fixture.interpolations };
}
export function expectedWebClientCopy() {
  return fixture.dictionaries;
}
