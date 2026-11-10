import { createHash, timingSafeEqual } from 'node:crypto';
import type { ProposedAction } from './catalog.js';

/** JSON with object keys sorted at every level, so equal content always hashes equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * The hash a button carries. It covers everything an approver was shown and everything
 * approval would run, so an approval is valid only for that exact payload.
 */
export function actionHash(content: { title: string; body: string; action: ProposedAction }): string {
  return createHash('sha256')
    .update(canonicalJson({ title: content.title, body: content.body, action: content.action }))
    .digest('hex');
}

export function hashesMatch(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
