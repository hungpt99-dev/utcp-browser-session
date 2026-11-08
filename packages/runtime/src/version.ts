/**
 * The runtime version, in one place.
 *
 * `tests/unit/version.test.ts` asserts it matches package.json and the extension
 * manifest, so a release cannot ship a `/health` that lies about itself.
 */
export const VERSION = '0.3.0';
