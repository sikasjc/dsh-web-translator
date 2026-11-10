/**
 * Plugin version reported by `GET /health`.
 *
 * Kept as a source constant so the host half imports no JSON module; a unit
 * test asserts it matches `package.json` so the two cannot drift.
 */
export const VERSION = '1.12.3';
