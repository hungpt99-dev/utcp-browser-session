/**
 * Chrome derives the id of an *unpacked* extension from the absolute path it was
 * loaded from: SHA-256 of the path, first 16 bytes, each nibble mapped to a-p.
 *
 * `up` uses this to bind its one-time pairing record to the exact extension it
 * launched, so a different extension (or a local process that merely sets the
 * Origin header) cannot claim it.
 */
import { createHash } from 'node:crypto';

export function extensionIdForPath(absolutePath: string): string {
  const digest = createHash('sha256').update(absolutePath).digest('hex').slice(0, 32);
  return [...digest].map((nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16))).join('');
}
