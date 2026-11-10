import { describe, expect, it } from 'vitest';
import { SealedSecretError, generateTokenKeyPair, loadPrivateKey, loadPublicKey, open, seal } from '../src/security/sealed.js';

describe('sealed secrets', () => {
  const pair = generateTokenKeyPair();
  const publicKey = loadPublicKey(pair.publicKey);
  const privateKey = loadPrivateKey(pair.privateKey);

  it('opens with the private key what was sealed with the public key', () => {
    const token = 'xoxp-example-not-a-real-token';
    const sealed = seal(publicKey, token);
    expect(sealed).not.toContain(token);
    expect(open(privateKey, sealed)).toBe(token);
  });

  it('seals the same text differently each time', () => {
    expect(seal(publicKey, 'same')).not.toBe(seal(publicKey, 'same'));
  });

  it('handles long and non-ASCII values', () => {
    const value = 'é✓'.repeat(5000);
    expect(open(privateKey, seal(publicKey, value))).toBe(value);
  });

  it('refuses a value that was changed, truncated, or sealed for another key', () => {
    const sealed = seal(publicKey, 'secret');
    const parts = sealed.split('.');
    const flipped = [...parts];
    const last = flipped.length - 1;
    flipped[last] = (flipped[last]!.startsWith('A') ? 'B' : 'A') + flipped[last]!.slice(1);
    expect(() => open(privateKey, flipped.join('.'))).toThrow(SealedSecretError);
    expect(() => open(privateKey, sealed.slice(0, -8))).toThrow(SealedSecretError);
    expect(() => open(privateKey, 'not sealed')).toThrow(SealedSecretError);

    const other = loadPrivateKey(generateTokenKeyPair().privateKey);
    expect(() => open(other, sealed)).toThrow(SealedSecretError);
  });

  it('cannot be opened with the public key, which is all the public service holds', () => {
    expect(() => loadPrivateKey(pair.publicKey)).toThrow(SealedSecretError);
    expect(() => loadPublicKey('not a key')).toThrow(SealedSecretError);
  });
});
