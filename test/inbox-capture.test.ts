import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applyEdit, capturedMessage, dedupeKeyOf, permalink, receiveCaptured } from '../src/inbox/capture.js';
import { forwardingAddress, htmlToText, issueAlias, mailBody, parseSlackMail, passwordMatches } from '../src/inbox/email.js';
import { fromSlackMessage } from '../src/inbox/slackEvents.js';
import { dropCounts, listBundles, listWorkspaces, saveRule } from '../src/inbox/store.js';
import { setSetting } from '../src/settings/settings.js';
import { signSlackRequest } from '../src/slack/verify.js';
import { createApp } from '../src/web/app.js';
import { ASK, DANA, DM_CHANNEL, GENERAL_CHANNEL, MAIL_SECRET, PORTAL_CHANNEL, SAM, captured, connectHub, mailWorkspace, messageEvent, notificationMail, nowTs } from './fixtures/inbox.js';
import type { Harness } from './helpers.js';
import { HUB, OWNER, SIGNING_SECRET, harness, resetDb, routeTo, seedPeople, testPool, webDeps } from './helpers.js';

/**
 * How a message gets in: the capture seam every source uses, Slack's events for the hub
 * workspace, and forwarded notification mail for the others. Slack and the mail service are
 * stand-ins, and every workspace, person and message is made up.
 */
const pool = testPool();
let h: Harness;
let app: ReturnType<typeof createApp>;
let hub: string;

beforeEach(async () => {
  await resetDb(pool);
  await seedPeople(pool);
  await routeTo(pool, 'inbox', 'C0INBOX');
  await setSetting(pool, 'inbox.enabled', true, OWNER);
  h = harness(pool);
  app = createApp(webDeps(h, { inboundEmailSecret: MAIL_SECRET }));
  hub = await connectHub(pool);
});
afterAll(() => pool.end());

const deps = () => h.worker;
const count = async (table: string): Promise<number> => Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n);
const drops = async (): Promise<Record<string, number>> => Object.fromEntries((await dropCounts(pool, 1)).map((d) => [d.reason, d.n]));

describe('the capture seam', () => {
  it('stores a message, opens a bundle for it and schedules the read after the settle window', async () => {
    expect(await receiveCaptured(deps(), captured(hub))).toBe('stored');
    const [bundle] = await listBundles(pool);
    expect(bundle).toMatchObject({ status: 'open', channelId: PORTAL_CHANNEL, messageCount: 1, addressed: false, source: 'api' });
    const [job] = h.queue.jobs;
    expect(job).toMatchObject({ name: 'inbox.bundle', data: { bundleId: bundle!.id }, options: { startAfter: 181 } });
    const { rows } = await pool.query<{ text: string; purge_after: Date }>('SELECT text, purge_after FROM slack_messages');
    expect(rows[0]!.text).toBe(ASK);
    expect(rows[0]!.purge_after.getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);
  });

  it('puts messages that arrive together in one bundle, and a thread in its own', async () => {
    const root = nowTs();
    await receiveCaptured(deps(), captured(hub, { ts: root }));
    await receiveCaptured(deps(), captured(hub, { senderId: SAM, text: 'And is the staging site updated too?' }));
    await receiveCaptured(deps(), captured(hub, { threadTs: root, text: 'Replying in the thread about the export.' }));
    const bundles = await listBundles(pool);
    expect(bundles.map((b) => [b.threadTs, b.messageCount]).sort()).toEqual([
      [null, 2],
      [root, 1],
    ]);
    expect(h.queue.of('inbox.bundle')).toHaveLength(2);
  });

  it('takes the same message once, whichever source brings it again', async () => {
    const ts = nowTs();
    expect(await receiveCaptured(deps(), captured(hub, { ts }))).toBe('stored');
    expect(await receiveCaptured(deps(), captured(hub, { ts }))).toBe('duplicate');
    expect(await count('slack_messages')).toBe(1);
    expect((await drops()).duplicate).toBe(1);

    const first = captured(hub, { ts: null, channelId: null, channelName: 'project-portal', senderId: null, senderName: 'Dana Reyes' });
    expect(dedupeKeyOf(first)).toBe(dedupeKeyOf({ ...first, text: `  ${ASK.toUpperCase()} ` }));
    expect(dedupeKeyOf(first)).not.toBe(dedupeKeyOf({ ...first, text: 'Something else entirely.' }));
  });

  it('marks a direct message and a mention as addressed, by rule', async () => {
    await receiveCaptured(deps(), captured(hub, { channelId: DM_CHANNEL, channelType: 'im' }));
    await receiveCaptured(deps(), captured(hub, { channelId: GENERAL_CHANNEL, mentionsReader: true }));
    expect((await listBundles(pool)).map((b) => b.addressed)).toEqual([true, true]);
  });

  it('leaves out what the filter names, stores nothing of it, and counts why', async () => {
    await saveRule(pool, { workspaceId: hub, channel: GENERAL_CHANNEL, rule: 'exclude', projectId: null }, OWNER);
    const outcomes = [
      await receiveCaptured(deps(), captured(hub, { origin: 'bot' })),
      await receiveCaptured(deps(), captured(hub, { origin: 'system' })),
      await receiveCaptured(deps(), captured(hub, { channelId: GENERAL_CHANNEL })),
      await receiveCaptured(deps(), captured(hub, { channelId: 'C0INBOX' })),
      await receiveCaptured(deps(), captured(hub, { text: '   ' })),
    ];
    expect(outcomes).toEqual(['bot', 'system', 'excluded', 'patcher_channel', 'empty']);
    expect(await count('slack_messages')).toBe(0);
    expect(await count('slack_bundles')).toBe(0);
    expect(await drops()).toEqual({ bot: 1, system: 1, excluded: 1, patcher_channel: 1, empty: 1 });
    expect(h.queue.jobs).toHaveLength(0);
  });

  it('follows the workspace switches: off, direct messages off, channels without a rule left out', async () => {
    await pool.query(`UPDATE slack_workspaces SET read_dms = false, channel_default = 'exclude' WHERE id = $1`, [hub]);
    await saveRule(pool, { workspaceId: hub, channel: PORTAL_CHANNEL, rule: 'include', projectId: null }, OWNER);
    expect(await receiveCaptured(deps(), captured(hub, { channelId: DM_CHANNEL, channelType: 'im' }))).toBe('dm_off');
    expect(await receiveCaptured(deps(), captured(hub, { channelId: GENERAL_CHANNEL }))).toBe('not_included');
    expect(await receiveCaptured(deps(), captured(hub))).toBe('stored');

    await pool.query('UPDATE slack_workspaces SET enabled = false WHERE id = $1', [hub]);
    expect(await receiveCaptured(deps(), captured(hub))).toBe('workspace_off');
    await pool.query(`UPDATE slack_workspaces SET enabled = true, status = 'disconnected' WHERE id = $1`, [hub]);
    expect(await receiveCaptured(deps(), captured(hub))).toBe('disconnected');
  });

  it('stores nothing at all while the reader is switched off', async () => {
    await setSetting(pool, 'inbox.enabled', false, OWNER);
    expect(await receiveCaptured(deps(), captured(hub))).toBe('off');
    expect(await count('slack_messages')).toBe(0);
  });

  it("keeps the reader's own message without its text, and asks for a recheck of the conversation", async () => {
    expect(await receiveCaptured(deps(), captured(hub, { own: true, senderId: OWNER, text: 'I will look at it today.' }))).toBe('own');
    const { rows } = await pool.query<{ text: string | null; own: boolean; bundle_id: string | null }>('SELECT text, own, bundle_id FROM slack_messages');
    expect(rows).toEqual([{ text: null, own: true, bundle_id: null }]);
    expect(h.queue.of('inbox.recheck')).toEqual([{ workspaceId: hub, channelKey: PORTAL_CHANNEL }]);
    expect(await count('slack_bundles')).toBe(0);
  });

  it('accepts a message from the companion sources through the same schema, and refuses a malformed one', async () => {
    const other = await mailWorkspace(pool, 'acme-co', 'Acme');
    const fromCompanion = captured(other, { source: 'companion_notification', channelId: null, channelName: 'project-portal', ts: null, senderId: null, senderName: 'Dana Reyes', link: null });
    expect(await receiveCaptured(deps(), fromCompanion)).toBe('stored');
    expect((await listBundles(pool))[0]).toMatchObject({ source: 'companion_notification', channelKey: 'name:project-portal' });
    expect(capturedMessage.safeParse({ ...fromCompanion, source: 'carrier_pigeon' }).success).toBe(false);
    expect(capturedMessage.safeParse({ ...fromCompanion, extra: true }).success).toBe(false);
    await expect(receiveCaptured(deps(), { ...fromCompanion, ts: 'yesterday' })).rejects.toThrow();
  });

  it('builds a link with nothing in it that signs anyone in', () => {
    expect(permalink({ domain: 'patchops', teamId: HUB, channelId: PORTAL_CHANNEL, ts: '1800000000.000100', threadTs: null })).toBe(
      `https://patchops.slack.com/archives/${PORTAL_CHANNEL}/p1800000000000100`,
    );
    expect(permalink({ domain: null, teamId: HUB, channelId: PORTAL_CHANNEL, ts: '1800000000.000100', threadTs: null })).toBe(
      `https://slack.com/app_redirect?channel=${PORTAL_CHANNEL}&team=${HUB}`,
    );
  });
});

describe('Slack events for the hub workspace', () => {
  const send = (body: Record<string, unknown>, secret = SIGNING_SECRET) => {
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    return request(app)
      .post('/slack/events')
      .set('content-type', 'application/json')
      .set('x-slack-request-timestamp', String(ts))
      .set('x-slack-signature', signSlackRequest(secret, ts, raw))
      .send(raw);
  };

  it('reads a message event at once and does not store the event itself', async () => {
    await send(messageEvent()).expect(200);
    expect(await count('slack_messages')).toBe(1);
    expect(await count('webhook_events')).toBe(0);
    expect(h.queue.of('slack.event')).toHaveLength(0);
    const [bundle] = await listBundles(pool);
    expect(bundle).toMatchObject({ channelId: PORTAL_CHANNEL, channelType: 'channel' });
    expect(bundle!.link).toMatch(new RegExp(`^https://patchops\\.slack\\.com/archives/${PORTAL_CHANNEL}/p\\d{16}$`));
    const [workspace] = await listWorkspaces(pool);
    expect(workspace!.lastEventAt).not.toBeNull();
    expect(workspace!.lastMessageAt).not.toBeNull();
  });

  it('takes a retry of the same event as a duplicate', async () => {
    const event = messageEvent();
    await send(event).expect(200);
    await send(event).expect(200);
    expect(await count('slack_messages')).toBe(1);
  });

  it('rejects a request that is not signed by Slack', async () => {
    await send(messageEvent(), 'another-secret').expect(401);
    expect(await count('slack_messages')).toBe(0);
  });

  it('ignores an event that was not delivered for the connected reader', async () => {
    await send(messageEvent({}, { authorizations: [{ team_id: HUB, user_id: 'U0SOMEONE', is_bot: false }] })).expect(200);
    await send(messageEvent({}, { authorizations: [{ team_id: HUB, user_id: OWNER, is_bot: true }] })).expect(200);
    await send(messageEvent({}, { team_id: 'T0OTHER' })).expect(200);
    expect(await count('slack_messages')).toBe(0);
    expect((await drops()).not_reader).toBe(2);
  });

  it('leaves out bots, joins and other system messages', async () => {
    await send(messageEvent({ subtype: 'bot_message', bot_id: 'B0BOT', user: undefined })).expect(200);
    await send(messageEvent({ bot_id: 'B0BOT' })).expect(200);
    await send(messageEvent({ subtype: 'channel_join', text: '<@U0DANA> has joined the channel' })).expect(200);
    expect(await count('slack_messages')).toBe(0);
    expect(await drops()).toEqual({ bot: 2, system: 1 });
  });

  it('sees a mention of the reader, a direct message, and a reply in a thread', async () => {
    await send(messageEvent({ text: `<@${OWNER}> ${ASK}`, channel: GENERAL_CHANNEL })).expect(200);
    await send(messageEvent({ channel: DM_CHANNEL, channel_type: 'im' })).expect(200);
    const root = nowTs(-60);
    await send(messageEvent({ thread_ts: root })).expect(200);
    const bundles = await listBundles(pool);
    expect(bundles.map((b) => [b.channelId, b.addressed, b.threadTs]).sort()).toEqual(
      [
        [GENERAL_CHANNEL, true, null],
        [DM_CHANNEL, true, null],
        [PORTAL_CHANNEL, false, root],
      ].sort(),
    );
  });

  it("stores the reader's own message without text", async () => {
    await send(messageEvent({ user: OWNER, text: 'On it.' })).expect(200);
    const { rows } = await pool.query<{ text: string | null; own: boolean }>('SELECT text, own FROM slack_messages');
    expect(rows).toEqual([{ text: null, own: true }]);
  });

  it('applies an edit to the stored copy and deletes what was deleted in Slack', async () => {
    const ts = nowTs();
    await send(messageEvent({ ts })).expect(200);
    h.queue.clear();
    await send(
      messageEvent({ subtype: 'message_changed', user: undefined, text: undefined, ts: nowTs(), message: { ts, user: DANA, text: 'Can you confirm it goes live on Thursday?' }, previous_message: { ts, text: ASK } }),
    ).expect(200);
    expect((await pool.query<{ text: string }>('SELECT text FROM slack_messages')).rows[0]!.text).toBe('Can you confirm it goes live on Thursday?');

    // A reply added to a thread also arrives as "changed", with the same text: nothing to do.
    await send(messageEvent({ subtype: 'message_changed', ts: nowTs(), message: { ts, user: DANA, text: 'Can you confirm it goes live on Thursday?' }, previous_message: { ts, text: 'Can you confirm it goes live on Thursday?' } })).expect(200);

    await send(messageEvent({ subtype: 'message_deleted', user: undefined, text: undefined, ts: nowTs(), deleted_ts: ts })).expect(200);
    expect(await count('slack_messages')).toBe(0);
    expect(h.queue.of('inbox.recheck')).toEqual([{ workspaceId: hub, channelKey: PORTAL_CHANNEL }]);
    expect(await applyEdit(deps(), { workspaceId: hub, channelId: PORTAL_CHANNEL, ts }, 'late edit')).toBe(false);
  });

  it('still records other events for the worker', async () => {
    await send({ type: 'event_callback', team_id: HUB, event_id: 'Ev0REVOKED', event: { type: 'tokens_revoked', tokens: { oauth: [OWNER] } } }).expect(200);
    expect(await count('webhook_events')).toBe(1);
    expect(h.queue.of('slack.event')).toHaveLength(1);
  });

  it('converts history the same way as events', () => {
    const workspace = { id: hub, teamId: HUB, domain: 'patchops', readerUserId: OWNER };
    const channel = { id: PORTAL_CHANNEL, name: 'project-portal', type: 'channel' as const };
    const converted = fromSlackMessage(workspace, channel, { ts: '1800000000.000100', user: DANA, text: `<@${OWNER}> hello`, subtype: 'thread_broadcast' });
    expect(converted).toMatchObject({ kind: 'message', message: { origin: 'person', mentionsReader: true, own: false, channelName: 'project-portal' } });
    expect(fromSlackMessage(workspace, channel, { user: DANA, text: 'no timestamp' })).toEqual({ kind: 'ignore' });
  });
});

describe('forwarded notification mail', () => {
  let token: string;
  let acme: string;
  const basic = (password: string) => `Basic ${Buffer.from(`postmark:${password}`).toString('base64')}`;
  const deliver = (body: unknown, password = MAIL_SECRET) => request(app).post('/ingest/email').set('authorization', basic(password)).send(body as object);
  const outcomes = async (): Promise<string[]> => (await pool.query<{ outcome: string }>('SELECT outcome FROM inbound_emails ORDER BY received_at')).rows.map((r) => r.outcome);

  beforeEach(async () => {
    token = await issueAlias(pool, OWNER);
    acme = await mailWorkspace(pool, 'acme-co', 'Acme');
  });

  it('reads the workspace, the channel, the sender and the message from a mail', () => {
    const mail = notificationMail(token);
    const parsed = parseSlackMail({ subject: `Fwd: ${String(mail.Subject)}`, text: String(mail.TextBody), html: '' });
    expect(parsed).toMatchObject({
      domain: 'acme-co',
      channelId: 'C0ACMEPORTAL',
      channelName: 'project-portal',
      channelType: 'channel',
      ts: '1800000000.000200',
      threadTs: '1800000000.000100',
      senderName: 'Dana Reyes',
      link: 'https://acme-co.slack.com/archives/C0ACMEPORTAL/p1800000000000200',
    });
    expect(parsed.text).toContain(ASK);
    // The sign-in part of Slack's links and the footer are gone.
    expect(parsed.text).not.toContain('x-p123');
    expect(parsed.text).not.toContain('receiving this email');
    expect(parsed.text).not.toContain('Unsubscribe');
  });

  it('reads a direct message, and a mail with only an HTML part', () => {
    const dm = parseSlackMail({ subject: 'Sam Okafor sent you a message', text: 'Are you free at three?\nhttps://globex-co.slack.com/archives/D0SAMDM/p1800000001000100', html: '' });
    expect(dm).toMatchObject({ domain: 'globex-co', channelType: 'im', senderName: 'Sam Okafor', channelName: null });
    expect(htmlToText('<p>One &amp; two</p><style>p{}</style><div>three</div>')).toContain('One & two');
    expect(mailBody({ text: '', html: '<p>Hello there</p><p>Made by Slack</p>' })).toBe('Hello there');
    const bare = parseSlackMail({ subject: 'Something', text: 'See https://app.slack.com/ and https://acme-co.slack.com/', html: '' });
    expect(bare).toMatchObject({ domain: 'acme-co', channelId: null, link: 'https://acme-co.slack.com/' });
  });

  it('turns a mail into one captured message for a workspace that is switched on', async () => {
    const res = await deliver(notificationMail(token)).expect(200);
    expect(res.body).toEqual({ ok: true });
    const [bundle] = await listBundles(pool);
    expect(bundle).toMatchObject({ workspaceId: acme, source: 'email', channelId: 'C0ACMEPORTAL', channelName: 'project-portal', addressed: true, senderName: 'Dana Reyes' });
    const { rows } = await pool.query<{ text: string; sender_name: string; link: string }>('SELECT text, sender_name, link FROM slack_messages');
    expect(rows[0]).toMatchObject({ sender_name: 'Dana Reyes', link: 'https://acme-co.slack.com/archives/C0ACMEPORTAL/p1800000000000200' });
    expect(rows[0]!.text).toContain(ASK);
    expect(await outcomes()).toEqual(['stored']);
    // Nothing of the mail is kept beside the message: no subject, no body.
    const kept = await pool.query<{ subject: string | null; parsed_ok: boolean }>('SELECT subject, parsed_ok FROM inbound_emails');
    expect(kept.rows).toEqual([{ subject: null, parsed_ok: true }]);
  });

  it('takes a second delivery of the same mail, and a second mail about the same message, once', async () => {
    const mail = notificationMail(token);
    await deliver(mail).expect(200);
    await deliver(mail).expect(200);
    await deliver(notificationMail(token)).expect(200);
    expect(await count('slack_messages')).toBe(1);
    expect(await outcomes()).toEqual(['stored', 'duplicate']);
  });

  it('refuses a delivery without the password, and one to an address that was never issued or was replaced', async () => {
    await request(app).post('/ingest/email').send(notificationMail(token)).expect(401);
    await deliver(notificationMail(token), 'wrong').expect(401);
    await deliver(notificationMail('0'.repeat(32))).expect(403);
    await issueAlias(pool, OWNER);
    await deliver(notificationMail(token)).expect(403);
    expect(await count('slack_messages')).toBe(0);
    expect(await count('inbound_emails')).toBe(0);
  });

  it('answers 503 until the password is configured', async () => {
    const unconfigured = createApp(webDeps(h));
    await request(unconfigured).post('/ingest/email').set('authorization', basic(MAIL_SECRET)).send(notificationMail(token)).expect(503);
  });

  it('does not read mail from anyone but Slack, and keeps only its subject for a confirmation code', async () => {
    await deliver(notificationMail(token, { From: 'forwarding-noreply@mail.example', FromFull: { Email: 'forwarding-noreply@mail.example' }, Subject: 'Forwarding confirmation code 123456' })).expect(200);
    expect(await count('slack_messages')).toBe(0);
    const { rows } = await pool.query<{ outcome: string; subject: string; sender: string }>('SELECT outcome, subject, sender FROM inbound_emails');
    expect(rows).toEqual([{ outcome: 'not_slack', subject: 'Forwarding confirmation code 123456', sender: 'forwarding-noreply@mail.example' }]);
  });

  it('adds an unknown workspace switched off and reads nothing from it until a person switches it on', async () => {
    const mail = (id: number) => notificationMail(token, { TextBody: `Hello\nhttps://initech-co.slack.com/archives/C0INITECH/p180000000${id}000100` });
    await deliver(mail(1)).expect(200);
    const added = (await listWorkspaces(pool)).find((w) => w.domain === 'initech-co');
    expect(added).toMatchObject({ enabled: false, readMode: 'email_only', name: 'initech-co' });
    await deliver(mail(2)).expect(200);
    expect(await count('slack_messages')).toBe(0);
    expect(await outcomes()).toEqual(['workspace_new', 'workspace_off']);

    await pool.query('UPDATE slack_workspaces SET enabled = true WHERE id = $1', [added!.id]);
    await deliver(mail(3)).expect(200);
    expect(await count('slack_messages')).toBe(1);
  });

  it('drops mail about the workspace that is read through the app, and mail that names no workspace', async () => {
    await deliver(notificationMail(token, { TextBody: `Hello\nhttps://patchops.slack.com/archives/${PORTAL_CHANNEL}/p1800000005000100` })).expect(200);
    await deliver(notificationMail(token, { TextBody: 'A mail with no link in it.' })).expect(200);
    await deliver({ nothing: 'useful' }).expect(200);
    expect(await count('slack_messages')).toBe(0);
    expect(await outcomes()).toEqual(['covered_by_api', 'no_workspace']);
  });

  it('refuses a mail too large to read for good, so the mail service stops sending it', async () => {
    await deliver(notificationMail(token, { TextBody: 'x'.repeat(2_200_000) })).expect(403);
    await request(app).post('/ingest/email').set('authorization', basic(MAIL_SECRET)).set('content-type', 'application/json').send('{not json').expect(403);
  });

  it('compares the password without accepting a near miss, and builds the address from the saved one', () => {
    expect(passwordMatches(basic(MAIL_SECRET), MAIL_SECRET)).toBe(true);
    expect(passwordMatches(basic(`${MAIL_SECRET}x`), MAIL_SECRET)).toBe(false);
    expect(passwordMatches(`Bearer ${MAIL_SECRET}`, MAIL_SECRET)).toBe(false);
    expect(passwordMatches(undefined, MAIL_SECRET)).toBe(false);
    expect(forwardingAddress('abc123@inbound.example.com', 'f00d')).toBe('abc123+f00d@inbound.example.com');
    expect(forwardingAddress('', 'f00d')).toBeNull();
  });
});
