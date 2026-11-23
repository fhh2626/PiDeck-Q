import "./polyfills.mjs";

// The native bundle and settings editor must publish the same portable patterns.
export { isValidSecurityPattern as validatePattern } from "../../src/shared/securityRegex.ts";
