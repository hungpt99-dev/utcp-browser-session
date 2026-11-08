import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Two credentials, deliberately different:
 *
 *   - `runtime-token` (admin): dashboard, CLI, pairing, domains, approvals.
 *   - `agent-token` (execute): what the UTCP manual hands to an AI client. It can
 *     only run approved tools and read the manual/status — it cannot approve a
 *     tool, enable a domain, change policy or mint a pairing code.
 *
 * Splitting them is what makes "a human approves before anything runs" true:
 * the agent's credential is not the credential that approves.
 */
export function tokenPath(dataDir: string): string {
  return path.join(dataDir, 'runtime-token');
}

export function agentTokenPath(dataDir: string): string {
  return path.join(dataDir, 'agent-token');
}

function readOrCreate(file: string, override?: string | null): string {
  if (override && override.length >= 16) return override;
  if (fs.existsSync(file)) {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort on exotic filesystems */
    }
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 16) return existing;
  }
  const token = randomBytes(32).toString('hex');
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

export function ensureToken(dataDir: string, override?: string | null): string {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return readOrCreate(tokenPath(dataDir), override);
}

export function ensureAgentToken(dataDir: string, override?: string | null): string {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return readOrCreate(agentTokenPath(dataDir), override);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison over fixed-length digests (no length oracle). */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(String(a)).digest();
  const right = createHash('sha256').update(String(b)).digest();
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
