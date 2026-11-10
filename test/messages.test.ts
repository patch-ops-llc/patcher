import { describe, expect, it } from 'vitest';
import { actionHash, canonicalJson, hashesMatch } from '../src/recommendations/hash.js';
import type { Recommendation, RecommendationStatus } from '../src/recommendations/types.js';
import {
  MAX_BUTTONS,
  MAX_LINES,
  clip,
  decodeRef,
  detailsReply,
  editModal,
  encodeRef,
  escapeMrkdwn,
  homeView,
  outcomeReply,
  recommendationMessage,
} from '../src/slack/messages.js';

const HASH = 'a'.repeat(64);
const ID = '11111111-1111-4111-8111-111111111111';

function rec(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id: ID,
    kind: 'test',
    reportType: 'calls',
    sourceType: 'test',
    sourceId: null,
    title: 'Add CSV export',
    body: 'One\nTwo',
    evidence: [{ quote: 'Can we get CSV?', source: 'Acme sync 12:04' }],
    action: { type: 'acknowledge', params: {} },
    actionHash: HASH,
    version: 1,
    risk: 'low',
    status: 'posted',
    slackTeam: 'T0HUB',
    slackChannel: 'C0CALLS',
    slackTs: '1700000000.000001',
    postedAt: new Date(),
    expiresAt: new Date(),
    remindedAt: null,
    decidedAt: null,
    decidedBy: null,
    detailsTs: null,
    lastError: null,
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Recommendation;
}

const textOf = (m: { blocks?: unknown[] }) => (m.blocks![0] as { text: { text: string } }).text.text;
const buttonsOf = (m: { blocks?: unknown[] }) =>
  (m.blocks as { type: string; elements?: { text: { text: string }; value: string }[] }[])
    .filter((b) => b.type === 'actions')
    .flatMap((b) => b.elements!);

describe('message rules', () => {
  it('never exceeds five lines or four buttons, whatever the content', () => {
    const long = rec({
      title: 'T'.repeat(500),
      body: Array.from({ length: 40 }, (_, i) => `Line ${i} ${'x'.repeat(400)}`).join('\n'),
    });
    const m = recommendationMessage(long, 'Test');
    expect(textOf(m).split('\n').length).toBeLessThanOrEqual(MAX_LINES);
    expect(buttonsOf(m).length).toBeLessThanOrEqual(MAX_BUTTONS);
    expect(textOf(m).length).toBeLessThan(1500);
    expect(m.blocks!.filter((b) => (b as { type: string }).type === 'actions')).toHaveLength(1);
  });

  it('is one line with no buttons once decided', () => {
    const cases: [RecommendationStatus, string, string[]][] = [
      ['approved', '*Test* · Add CSV export · approved by <@U1> · running', []],
      ['executing', '*Test* · Add CSV export · approved by <@U1> · running', []],
      ['done', '*Test* · Add CSV export · approved by <@U1> · done', []],
      ['failed', '*Test* · Add CSV export · approved by <@U1> · failed', ['Retry', 'Details']],
      ['dismissed', '*Test* · Add CSV export · dismissed by <@U1>', []],
      ['expired', '*Test* · Add CSV export · expired with no decision', []],
    ];
    for (const [status, text, buttons] of cases) {
      const m = recommendationMessage(rec({ status, decidedBy: status === 'expired' ? null : 'U1' }), 'Test');
      expect(textOf(m)).toBe(text);
      expect(buttonsOf(m).map((b) => b.text.text)).toEqual(buttons);
    }
  });

  it('puts the recommendation id and hash in every button', () => {
    for (const b of buttonsOf(recommendationMessage(rec(), 'Test'))) expect(b.value).toBe(`${ID}|${HASH}`);
  });

  it('gives a notification fallback text without markup', () => {
    expect(recommendationMessage(rec(), 'Test').text).toBe('Test · Add CSV export');
  });

  it('escapes the characters Slack treats as control sequences', () => {
    expect(escapeMrkdwn('<!channel> & <@U1> <https://x|y>')).toBe('&lt;!channel&gt; &amp; &lt;@U1&gt; &lt;https://x|y&gt;');
  });

  it('clips long text with an ellipsis', () => {
    expect(clip('short', 10)).toBe('short');
    expect(clip('x'.repeat(20), 10)).toHaveLength(10);
    expect(clip('x'.repeat(20), 10).endsWith('…')).toBe(true);
  });

  it('keeps the detail in the thread reply, with evidence and the exact action', () => {
    const reply = detailsReply(
      rec({ evidence: Array.from({ length: 5 }, (_, i) => ({ quote: `Quote ${i} <b>`, source: 'Call' })) }),
      'Record the approval only.',
      'https://patcher.test',
    );
    const lines = reply.text.split('\n');
    expect(lines.filter((l) => l.startsWith('>'))).toHaveLength(3);
    expect(reply.text).toContain('…and 2 more in the full view.');
    expect(reply.text).toContain('Quote 0 &lt;b&gt;');
    expect(lines.at(-1)).toBe(`<https://patcher.test/approvals/${ID}|Open in Patcher>`);
  });

  it('reports outcomes in one line', () => {
    expect(outcomeReply({ status: 'done', dryRun: false, lastError: null, externalRef: 'PR #41' })).toBe('Done. PR #41');
    expect(outcomeReply({ status: 'done', dryRun: true, lastError: null, externalRef: null })).toBe('Dry run: logged, nothing was executed.');
    expect(outcomeReply({ status: 'failed', dryRun: false, lastError: 'x\ny', externalRef: null }).split('\n').length).toBeLessThanOrEqual(2);
  });

  it('builds an edit modal that carries the hash it was opened against', () => {
    const view = editModal(rec()) as { private_metadata: string; blocks: unknown[]; callback_id: string };
    expect(view.private_metadata).toBe(`${ID}|${HASH}`);
    expect(view.callback_id).toBe('rec_edit_modal');
  });

  it('shows at most a handful of pending items on the home tab', () => {
    const many = Array.from({ length: 30 }, (_, i) => rec({ title: `Item ${i}` }));
    const view = homeView(many, () => 'Test', 'https://patcher.test', false) as { blocks: unknown[] };
    expect(view.blocks.length).toBeLessThanOrEqual(100);
    expect(JSON.stringify(view)).toContain('https://patcher.test/approvals');
  });
});

describe('button references', () => {
  it('round-trips an id and hash', () => {
    expect(decodeRef(encodeRef({ id: ID, actionHash: HASH }))).toEqual({ id: ID, hash: HASH });
  });

  it('rejects anything else', () => {
    for (const value of [undefined, 42, '', 'garbage', `${ID}|short`, `not-a-uuid|${HASH}`, `${ID}|${HASH}|extra`]) {
      expect(decodeRef(value), String(value)).toBeNull();
    }
  });
});

describe('action hash', () => {
  const base = { title: 'T', body: 'B', action: { type: 'acknowledge', params: { a: 1, b: { c: [1, 2] } } } };

  it('does not depend on key order', () => {
    const reordered = { action: { params: { b: { c: [1, 2] }, a: 1 }, type: 'acknowledge' }, body: 'B', title: 'T' };
    expect(actionHash(reordered)).toBe(actionHash(base));
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });

  it('changes when the title, the body, the action type or any parameter changes', () => {
    const hash = actionHash(base);
    expect(actionHash({ ...base, title: 'T2' })).not.toBe(hash);
    expect(actionHash({ ...base, body: 'B2' })).not.toBe(hash);
    expect(actionHash({ ...base, action: { ...base.action, type: 'other' } })).not.toBe(hash);
    expect(actionHash({ ...base, action: { type: 'acknowledge', params: { a: 1, b: { c: [2, 1] } } } })).not.toBe(hash);
  });

  it('compares hashes without throwing on odd input', () => {
    expect(hashesMatch(HASH, HASH)).toBe(true);
    expect(hashesMatch(HASH, 'b'.repeat(64))).toBe(false);
    expect(hashesMatch(HASH, 'short')).toBe(false);
    expect(hashesMatch(HASH, '')).toBe(false);
  });
});
