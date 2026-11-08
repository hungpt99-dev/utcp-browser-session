import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Token handling for local clients.
 *
 * The runtime token is the only credential that grants control of the runtime.
 * It is generated on first start, stored with 0600 permissions inside the data
 * dir, and printed once as part of the dashboard bootstrap URL.
 */
export function tokenPath(dataDir: string): string {
  return path.join(dataDir, 'runtime-token');
}

export function ensureToken(dataDir: string, override?: string | null): string {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (override && override.length >= 16) return override;
  const file = tokenPath(dataDir);
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 16) return existing;
  }
  const token = randomBytes(32).toString('hex');
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Short, unambiguous pairing code (no 0/O/1/I) so it can be read aloud. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generatePairingCode(length = 8): string {
  const bytes = randomBytes(length);
  let code = '';
  for (let index = 0; index < length; index += 1) code += CODE_ALPHABET[bytes[index] % CODE_ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}
