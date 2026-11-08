/**
 * Key handling for the extension side of pairing.
 *
 * The extension generates an ECDSA P-256 pair once and keeps the private key in
 * chrome.storage.local. The runtime stores only the public key, so a copy of the
 * runtime's state file cannot impersonate this browser.
 */

export interface KeyPairJwk {
  publicKeyJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  privateKeyJwk: JsonWebKey;
}

export async function generateKeyPair(): Promise<KeyPairJwk> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKeyJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    publicKeyJwk: { kty: 'EC', crv: 'P-256', x: publicKeyJwk.x!, y: publicKeyJwk.y! },
    privateKeyJwk,
  };
}

function base64Url(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Sign `${clientId}:${nonce}`; the runtime verifies it against the stored public key. */
export async function signChallenge(privateKeyJwk: JsonWebKey, clientId: string, nonce: string): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', privateKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const data = new TextEncoder().encode(`${clientId}:${nonce}`);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data);
  return base64Url(signature);
}
