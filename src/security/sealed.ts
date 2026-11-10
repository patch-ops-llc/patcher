import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  constants,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/**
 * Design sections 3.4 and 12.3: secrets added at run time through the UI are encrypted with
 * a public key held by `web` and can be decrypted only by `worker`, which holds the private
 * key. A compromise of the public-facing service therefore does not expose them.
 *
 * Format: `v1.<wrapped key>.<iv>.<ciphertext>.<tag>`, each part base64url. A fresh AES-256-GCM
 * key encrypts the value; RSA-OAEP (SHA-256) wraps that key.
 */
const VERSION = 'v1';
const OAEP = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' } as const;

export class SealedSecretError extends Error {}

/** `TOKEN_PUBLIC_KEY`: base64 of the DER-encoded SPKI public key. */
export function loadPublicKey(base64Der: string): KeyObject {
  try {
    const key = createPublicKey({ key: Buffer.from(base64Der, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'rsa') throw new Error('not an RSA key');
    return key;
  } catch {
    throw new SealedSecretError('TOKEN_PUBLIC_KEY is not a base64 DER RSA public key');
  }
}

/** `TOKEN_PRIVATE_KEY`: base64 of the DER-encoded PKCS#8 private key. */
export function loadPrivateKey(base64Der: string): KeyObject {
  try {
    const key = createPrivateKey({ key: Buffer.from(base64Der, 'base64'), format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'rsa') throw new Error('not an RSA key');
    return key;
  } catch {
    throw new SealedSecretError('TOKEN_PRIVATE_KEY is not a base64 DER RSA private key');
  }
}

export function seal(publicKey: KeyObject, plaintext: string): string {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const wrapped = publicEncrypt({ key: publicKey, ...OAEP }, key);
  return [VERSION, wrapped, iv, ciphertext, cipher.getAuthTag()]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

export function open(privateKey: KeyObject, sealed: string): string {
  const parts = sealed.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) throw new SealedSecretError('Not a sealed secret');
  const [wrapped, iv, ciphertext, tag] = parts.slice(1).map((p) => Buffer.from(p, 'base64url')) as [
    Buffer,
    Buffer,
    Buffer,
    Buffer,
  ];
  try {
    const key = privateDecrypt({ key: privateKey, ...OAEP }, wrapped);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new SealedSecretError('Sealed secret could not be opened');
  }
}

export function generateTokenKeyPair(): { publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
  return {
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}
