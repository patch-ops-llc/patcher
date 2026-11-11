import { ModelApiError } from '../ai/client.js';
import type { GateReason } from '../ai/gate.js';
import { GATE_DETAIL, inboxModelGate } from '../ai/gate.js';
import { costUsd, estimateTokens } from '../ai/models.js';
import { loadPrompt } from '../ai/prompts.js';
import type { ModelDeps, TaskSpec } from '../ai/run.js';
import { ModelOutputError, callModel, repairCall } from '../ai/run.js';
import type { Pool, Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { FIX_ACTION } from '../fix/agentFix.js';
import { isConfigured } from '../integrations/status.js';
import { createRecommendation } from '../recommendations/service.js';
import type { Project } from '../registry/registry.js';
import { listProjects } from '../registry/registry.js';
import { getAllSettings, getSetting } from '../settings/settings.js';
import type { AllSettings } from '../settings/settings.js';
import { clip } from '../slack/messages.js';
import type { WorkerDeps } from '../worker/deps.js';
import { notifyOps } from '../worker/notify.js';
import { slackTime } from './capture.js';
import { INBOX_KINDS, INBOX_TASK_ACTION } from './catalog.js';
import { closeHandled } from './delivery.js';
import type { RawSlackMessage } from './reader.js';
import type { Wording, WordingContext } from './recommend.js';
import { RECOMMEND_OUTPUT_TOKENS, RECOMMEND_TASK, agentBrief, buildRecommendInput, checkWording, ruleWording, suggestion } from './recommend.js';
import { bundleMessages, getBundle, getWorkspace, listRules, recentDecisions, repliedSince, ruleFor } from './store.js';
import type { Line, Names } from './text.js';
import { READER_NAME, conversation, excerpt, plainText } from './text.js';
import type { CheckedTriage, Where } from './triage.js';
import { TRIAGE_OUTPUT_TOKENS, TRIAGE_TASK, buildTriageInput, checkTriage, decideDelivery, inQuietHours, isActionable } from './triage.js';
import type { Bundle, ChannelRule, StoredMessage, TriageResult, Workspace } from './types.js';
import { INBOX_CARRIER, INBOX_SOURCE } from './types.js';
import { openReader, resolveNames, withReader } from './workspace.js';

/**
 * The Slack pipeline after capture (design 8.6):
 *
 *   inbox.bundle   settle → names and thread context → recheck → triage (small model)
 *                  → recommend (mid model) → recheck → one recommendation in the shared loop
 *   inbox.recheck  the reader wrote in a conversation, or a message was deleted: close what
 *                  no longer needs him
 *
 * The model sorts and words. Code decides what a reading is worth: a quote that is not in
 * the messages is not believed, a project that is not on the list is not matched, and
 * nothing the model returns starts anything. When the model cannot be used the bundle
 * waits, and a message addressed to the reader is listed unanalysed so that it is not lost.
 */
type HoldReason = GateReason | 'provider';

const HOLD_DETAIL: Record<HoldReason, string> = { ...GATE_DETAIL, provider: 'the model provider did not answer' };

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 200);

const MAX_CONVERSATION_CHARS = 12_000;
const MAX_EARLIER_CHARS = 4_000;
const THREAD_CONTEXT = 40;

/** One job at a time per bundle. `busy` when another process holds it. */
async function withBundleLock<T>(pool: Pool, bundleId: string, fn: () => Promise<T>): Promise<T | 'busy'> {
  const session = await pool.connect();
  let locked = false;
  try {
    const got = await session.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(hashtextextended('inbox:' || $1, 0)) AS locked`, [bundleId]);
    locked = got.rows[0]?.locked === true;
    if (!locked) return 'busy';
    return await fn();
  } finally {
    if (locked) await session.query(`SELECT pg_advisory_unlock(hashtextextended('inbox:' || $1, 0))`, [bundleId]).catch(() => undefined);
    session.release();
  }
}

type Asked<T> = { ok: true; value: T } | { ok: false; hold: HoldReason; detail?: string } | { ok: false; failed: string };

interface Ask<T> {
  spec: TaskSpec<T>;
  model: string;
  user: string;
  typicalOutputTokens: number;
  /** A problem with a reply that passed the schema, worth one more try. */
  problem?: (value: T) => string | null;
}

/** One gated model call: the switch and the budget first, then the provider, with both ways of failing sorted. */
async function ask<T>(deps: WorkerDeps, bundleId: string, input: Ask<T>): Promise<Asked<T>> {
  const inputTokens = estimateTokens(loadPrompt(input.spec.task).system) + estimateTokens(input.user);
  const estimate = costUsd(input.model, { inputTokens, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: input.typicalOutputTokens }) ?? 0;
  const gate = await inboxModelGate({ pool: deps.pool, client: deps.integrations.model }, estimate);
  if (!gate.ok) return { ok: false, hold: gate.reason };
  const modelDeps: ModelDeps = { pool: deps.pool, client: gate.client, log: deps.log };
  const ctx = { model: input.model, runId: bundleId };
  try {
    const first = await callModel(modelDeps, input.spec, ctx, input.user);
    const problem = input.problem?.(first);
    if (!problem) return { ok: true, value: first };
    try {
      return { ok: true, value: await repairCall(modelDeps, input.spec, ctx, input.user, problem) };
    } catch (err) {
      // The first reply was valid; what it lacks is handled by the caller's checks.
      if (err instanceof ModelOutputError) return { ok: true, value: first };
      throw err;
    }
  } catch (err) {
    // Nothing is used from a reply that failed validation twice (design 13.1).
    if (err instanceof ModelOutputError) return { ok: false, failed: err.message };
    if (err instanceof ModelApiError) return { ok: false, hold: 'provider', detail: `the model provider did not answer (${reasonOf(err)})` };
    throw err;
  }
}

async function setStatus(
  db: Queryable,
  bundleId: string,
  status: Bundle['status'],
  detail: string | null,
  extra: { triage?: TriageResult | null; summary?: string | null; projectId?: string | null } = {},
): Promise<void> {
  await db.query(
    `UPDATE slack_bundles
        SET status = $2, status_detail = $3, hold_reason = NULL, held_step = NULL,
            triage = coalesce($4, triage), summary = coalesce($5, summary), project_id = coalesce($6, project_id),
            analysed_at = CASE WHEN $4::jsonb IS NOT NULL THEN now() ELSE analysed_at END, updated_at = now()
      WHERE id = $1`,
    [bundleId, status, detail ? detail.slice(0, 300) : null, extra.triage ? JSON.stringify(extra.triage) : null, extra.summary ?? null, extra.projectId ?? null],
  );
}

export type BundleOutcome =
  | 'not_found'
  | 'skipped'
  | 'waiting'
  | 'off'
  | 'empty'
  | 'handled'
  | 'held'
  | 'dropped'
  | 'fyi'
  | 'failed'
  | 'recommended'
  | 'unanalysed'
  | 'busy';

export async function processBundle(deps: WorkerDeps, bundleId: string): Promise<BundleOutcome> {
  const outcome = await withBundleLock(deps.pool, bundleId, () => processLocked(deps, bundleId));
  if (outcome === 'busy') await deps.queue.enqueue('inbox.bundle', { bundleId }, { startAfter: 30 });
  return outcome;
}

interface Context {
  bundle: Bundle;
  workspace: Workspace;
  settings: AllSettings;
  rule: ChannelRule | null;
  messages: StoredMessage[];
  lines: Line[];
  texts: string[];
  earlier: string | null;
  where: Where;
  sender: string | null;
  channel: string;
  /** Projects the prompt may name, and the names it must not. */
  projects: Project[];
  otherProjectNames: string[];
}

const describeChannel = (bundle: Pick<Bundle, 'channelType' | 'channelName' | 'channelId'>, channelName: string | null): { label: string; forModel: string } => {
  if (bundle.channelType === 'im') return { label: 'DM', forModel: 'a direct message to the owner' };
  if (bundle.channelType === 'mpim') return { label: 'group DM', forModel: 'a group message that includes the owner' };
  const name = channelName ?? bundle.channelName;
  return name ? { label: `#${name}`, forModel: `the channel #${name}` } : { label: 'a channel', forModel: 'a channel' };
};

/**
 * Design 8.7: a prompt about one workspace never contains content from another. The hub is
 * the agency's own workspace and may be about any project. Every other workspace sees only
 * the projects a person linked to it or to one of its channels.
 */
async function visibleProjects(deps: WorkerDeps, workspace: Workspace, rule: ChannelRule | null): Promise<{ projects: Project[]; others: string[] }> {
  const active = (await listProjects(deps.pool)).filter((p) => p.status === 'active');
  if (workspace.readMode === 'api' && workspace.teamId !== null && workspace.teamId === deps.hubTeamId) return { projects: active, others: [] };
  const rules = await listRules(deps.pool, workspace.id);
  const linked = new Set([workspace.projectId, rule?.projectId, ...rules.map((r) => r.projectId)].filter((id): id is string => Boolean(id)));
  const projects = active.filter((p) => linked.has(p.id));
  return { projects, others: active.filter((p) => !linked.has(p.id)).flatMap((p) => [p.name, ...(p.client ? [p.client] : [])]) };
}

async function processLocked(deps: WorkerDeps, bundleId: string): Promise<BundleOutcome> {
  let bundle = await getBundle(deps.pool, bundleId);
  if (!bundle) return 'not_found';
  if (bundle.status !== 'open' && bundle.status !== 'held' && bundle.status !== 'reading') return 'skipped';
  if (bundle.status === 'open' && bundle.settleAt.getTime() > Date.now()) {
    await deps.queue.enqueue('inbox.bundle', { bundleId }, { startAfter: new Date(bundle.settleAt.getTime() + 1000) });
    return 'waiting';
  }
  // Closed to new messages from here on: one that arrives while the model reads opens the next bundle.
  if (bundle.status === 'open') {
    await deps.pool.query(`UPDATE slack_bundles SET status = 'reading', updated_at = now() WHERE id = $1 AND status = 'open'`, [bundleId]);
    bundle = { ...bundle, status: 'reading' };
  }

  const [workspace, settings] = await Promise.all([getWorkspace(deps.pool, bundle.workspaceId), getAllSettings(deps.pool)]);
  if (!workspace?.enabled || !settings['inbox.enabled']) {
    await setStatus(deps.pool, bundleId, 'dropped', 'Reading was switched off before this was read.');
    return 'off';
  }
  const messages = await bundleMessages(deps.pool, bundleId);
  if (!messages.length) {
    await setStatus(deps.pool, bundleId, 'dropped', 'The message was deleted before it was read.');
    return 'empty';
  }

  const reader = await openReader(deps, workspace);
  const names = await resolveNames(deps, workspace, reader, {
    userIds: messages.flatMap((m) => [...(m.senderId ? [m.senderId] : []), ...[...(m.text ?? '').matchAll(/<@([UW][A-Z0-9]+)/g)].map((x) => x[1]!)]),
    channelId: bundle.channelId,
  });
  const who: Names = { users: names.users, readerId: workspace.readerUserId };
  const nameOf = (m: Pick<StoredMessage, 'senderId' | 'senderName'>): string => (m.senderId && names.users.get(m.senderId)) || m.senderName || 'Someone';

  // The earlier messages of a thread, where the source can give them (design 8.6, step 5).
  let earlier: string | null = null;
  if (reader && bundle.threadTs && bundle.channelId) {
    const channelId = bundle.channelId;
    const threadTs = bundle.threadTs;
    const thread = await withReader(deps, workspace, 'conversations.replies', (r) => r.replies(channelId, threadTs, THREAD_CONTEXT));
    if (thread) {
      const firstTs = messages[0]!.ts ?? '';
      const lastTs = messages.at(-1)!.ts ?? '';
      const isPerson = (m: RawSlackMessage): m is RawSlackMessage & { ts: string; user: string; text: string } =>
        typeof m.ts === 'string' && typeof m.user === 'string' && typeof m.text === 'string' && !m.bot_id;
      if (lastTs && thread.some((m) => isPerson(m) && m.user === workspace.readerUserId && m.ts > lastTs)) {
        await setStatus(deps.pool, bundleId, 'handled', 'You replied in the thread.');
        return 'handled';
      }
      const before = thread.filter(isPerson).filter((m) => m.ts < firstTs);
      const missing = before.map((m) => m.user).filter((id) => id !== workspace.readerUserId && !names.users.has(id));
      if (missing.length) {
        const more = await resolveNames(deps, workspace, reader, { userIds: missing, channelId: null });
        for (const [id, name] of more.users) names.users.set(id, name);
      }
      if (before.length) {
        earlier = conversation(
          before.map((m) => ({
            sender: m.user === workspace.readerUserId ? READER_NAME : (names.users.get(m.user) ?? 'Someone'),
            text: plainText(m.text, who),
            at: slackTime(m.ts),
          })),
          MAX_EARLIER_CHARS,
        );
      }
    }
  }

  if (await repliedSince(deps.pool, bundle)) {
    await setStatus(deps.pool, bundleId, 'handled', 'You replied in the conversation.');
    return 'handled';
  }

  const lines: Line[] = messages.map((m) => ({ sender: nameOf(m), text: plainText(m.text ?? '', who), at: m.sentAt }));
  const rule = await ruleFor(deps.pool, workspace.id, { id: bundle.channelId, name: bundle.channelName });
  const visible = await visibleProjects(deps, workspace, rule);
  const channel = describeChannel(bundle, names.channelName);
  const sender = lines[0]!.sender === 'Someone' ? null : lines[0]!.sender;
  const complete = bundle.source === 'api' || bundle.source === 'companion_page';
  const ctx: Context = {
    bundle,
    workspace,
    settings,
    rule,
    messages,
    lines,
    texts: lines.map((l) => l.text),
    earlier,
    where: { workspaceName: workspace.name, channel: channel.forModel, inThread: Boolean(bundle.threadTs), completeness: complete ? 'conversation' : 'notification' },
    sender,
    channel: channel.label,
    projects: visible.projects,
    otherProjectNames: visible.others,
  };
  await deps.pool.query('UPDATE slack_bundles SET sender_name = coalesce($2, sender_name), channel_name = coalesce(channel_name, $3) WHERE id = $1', [
    bundleId,
    sender ? sender.slice(0, 120) : null,
    names.channelName,
  ]);

  const text = conversation(lines, MAX_CONVERSATION_CHARS);
  const addressedByRule = bundle.addressed || rule?.rule === 'urgent';

  // Triage, unless an earlier attempt got that far and only the wording is still owed.
  let triage: TriageResult;
  let project: Project | null;
  let quote: string | null;
  if (bundle.status === 'held' && bundle.heldStep === 'recommend' && bundle.triage) {
    triage = bundle.triage;
    project = visible.projects.find((p) => p.id === bundle.projectId) ?? null;
    quote = bundle.quote;
  } else {
    const input = buildTriageInput({ where: ctx.where, projects: visible.projects, examples: await recentDecisions(deps.pool, workspace.id), earlier, messages: text });
    const check = (reply: Parameters<typeof checkTriage>[0]): CheckedTriage => checkTriage(reply, { refs: input.refs, texts: ctx.texts, addressedByRule: bundle.addressed });
    const asked = await ask(deps, bundleId, {
      spec: TRIAGE_TASK,
      model: settings['ai.inbox.model_triage'],
      user: input.user,
      typicalOutputTokens: TRIAGE_OUTPUT_TOKENS,
      problem: (reply) => (isActionable(reply.label) && !check(reply).result.grounded ? '`quote` is not in <messages> word for word' : null),
    });
    if (!asked.ok) {
      if ('hold' in asked) return hold(deps, ctx, 'triage', asked.hold, asked.detail);
      // An unusable reading of something addressed to him is still shown, without one.
      if (addressedByRule) return surface(deps, ctx, { reason: 'The reading did not pass the checks.' });
      await setStatus(deps.pool, bundleId, 'failed', `Not read: ${asked.failed}`);
      return 'failed';
    }
    const checked = check(asked.value);
    triage = checked.result;
    project = checked.project;
    quote = checked.quote;
    if (triage.label === 'none') {
      await setStatus(deps.pool, bundleId, 'dropped', triage.reason || 'Nothing for you.', { triage });
      return 'dropped';
    }
    if (triage.label === 'fyi') {
      await setStatus(deps.pool, bundleId, 'fyi', triage.reason || 'For your information.', { triage, projectId: project?.id ?? null });
      return 'fyi';
    }
    if (!triage.grounded) {
      // "Evidence or nothing": a reading whose quote is not in the messages is not used.
      if (addressedByRule) return surface(deps, ctx, { reason: 'The reading could not be checked against the message.', triage });
      await setStatus(deps.pool, bundleId, 'failed', 'Not used: the quoted words are not in the messages.', { triage });
      return 'failed';
    }
    await deps.pool.query('UPDATE slack_bundles SET triage = $2, project_id = $3, quote = $4, analysed_at = now(), updated_at = now() WHERE id = $1', [
      bundleId,
      JSON.stringify(triage),
      project?.id ?? null,
      quote,
    ]);
  }
  project ??= visible.projects.find((p) => p.id === (rule?.projectId ?? workspace.projectId)) ?? null;

  const wordingCtx: WordingContext = {
    sender,
    channel: channel.label,
    label: triage.label,
    texts: ctx.texts,
    ownProject: project?.name ?? '',
    otherProjects: ctx.otherProjectNames,
  };
  const asked = await ask(deps, bundleId, {
    spec: RECOMMEND_TASK,
    model: settings['ai.inbox.model_recommend'],
    user: buildRecommendInput({ where: ctx.where, label: triage.label, project, earlier, messages: text }),
    typicalOutputTokens: RECOMMEND_OUTPUT_TOKENS,
  });
  let wording: Wording;
  if (asked.ok) {
    wording = checkWording(asked.value, wordingCtx);
  } else if ('hold' in asked) {
    return hold(deps, ctx, 'recommend', asked.hold, asked.detail);
  } else {
    deps.log.warn('slack recommendation not worded, using the rule wording', { bundleId, reason: asked.failed });
    wording = ruleWording(wordingCtx);
  }
  if (wording.source === 'model' && wording.action === 'none') {
    await setStatus(deps.pool, bundleId, 'fyi', 'On a closer look, nothing needs doing.', { triage, summary: wording.summary, projectId: project?.id ?? null });
    return 'fyi';
  }

  // Recheck (design 8.6, step 6): the model calls took a while, and he may have answered meanwhile.
  if (await repliedSince(deps.pool, bundle)) {
    await setStatus(deps.pool, bundleId, 'handled', 'You replied in the conversation.', { triage });
    return 'handled';
  }
  return propose(deps, ctx, { triage, project, wording, quote: wording.quote ?? quote, status: 'recommended', detail: null });
}

interface Proposal {
  triage: TriageResult | null;
  project: Project | null;
  wording: Wording;
  quote: string | null;
  status: 'recommended' | 'unanalysed';
  detail: string | null;
  /** Overrides what the rules would decide: an item that waited on the budget goes to the digest. */
  delivery?: 'digest';
}

/** Turns a read bundle into one recommendation in the shared loop, carried by the item's own message or by a digest. */
async function propose(deps: WorkerDeps, ctx: Context, p: Proposal): Promise<'recommended' | 'unanalysed'> {
  const { bundle, workspace, settings } = ctx;
  const repos = p.project?.links.filter((l) => l.kind === 'repo').map((l) => l.externalId) ?? [];
  const brief =
    p.wording.source === 'model' && p.wording.action === 'code_change' && p.project && repos.length === 1 && settings['inbox.agent_enabled'] && (await isConfigured(deps.pool, 'cursor'))
      ? agentBrief({ summary: p.wording.summary, taskTitle: p.wording.taskTitle, projectName: p.project.name, workspaceName: workspace.name })
      : null;
  const agent = brief !== null;
  const suggest = suggestion(p.wording, agent);
  const link = bundle.link ?? ctx.messages.find((m) => m.link)?.link ?? null;
  const evidenceQuote = p.quote ? clip(p.quote, 300) : excerpt(ctx.messages.at(-1)!.text ?? '', 300) || 'A message with no text that can be shown.';
  const source = clip(`Slack · ${workspace.name} · ${ctx.channel}${ctx.sender ? ` · ${ctx.sender}` : ''}`, 280);

  const { recommendation } = await createRecommendation(deps, {
    kind: agent ? INBOX_KINDS.change : INBOX_KINDS.task,
    sourceType: INBOX_SOURCE,
    sourceId: bundle.id,
    title: p.wording.summary,
    body: `Suggest: ${suggest}`,
    evidence: [{ quote: evidenceQuote, source, ...(link ? { url: link } : {}) }],
    action: agent
      ? { type: FIX_ACTION, params: { findingId: null, repo: repos[0]!, ref: null, prompt: brief } }
      : {
          type: INBOX_TASK_ACTION,
          params: {
            bundleId: bundle.id,
            projectId: p.project?.id ?? null,
            title: p.wording.taskTitle,
            detail: clip([p.wording.summary, link ? `Message: ${link}` : ''].filter(Boolean).join('\n'), 1900),
          },
        },
    risk: agent ? 'medium' : 'low',
    dedupeKey: `inbox:${bundle.id}`,
    carrier: { type: INBOX_CARRIER, id: bundle.id },
  });

  const { urgent, delivery } = decideDelivery(p.triage ? { label: p.triage.label, urgency: p.triage.urgency } : null, {
    rule: ctx.rule?.rule ?? null,
    digestOnly: settings['inbox.digest_only'],
    quiet: inQuietHours(new Date(), settings['inbox.quiet_hours'], settings['inbox.quiet_tz']),
  });
  // An unread message addressed to him is shown at once unless his settings say otherwise.
  const unreadNow = p.status === 'unanalysed' && !settings['inbox.digest_only'] && ctx.rule?.rule !== 'digest_only' && !inQuietHours(new Date(), settings['inbox.quiet_hours'], settings['inbox.quiet_tz']);
  const how = p.delivery ?? (unreadNow ? 'now' : delivery);

  await withTx(deps.pool, async (tx) => {
    await tx.query(
      `UPDATE slack_bundles
          SET status = $2, status_detail = $3, hold_reason = NULL, held_step = NULL, triage = coalesce($4, triage),
              summary = $5, suggestion = $6, draft = $7, quote = $8, link = coalesce(link, $9), project_id = $10, urgent = $11,
              delivery = $12, recommendation_id = $13, analysed_at = coalesce(analysed_at, now()), updated_at = now()
        WHERE id = $1`,
      [
        bundle.id,
        p.status,
        p.detail,
        p.triage ? JSON.stringify(p.triage) : null,
        p.wording.summary,
        suggest,
        p.wording.draft,
        p.quote,
        link,
        p.project?.id ?? null,
        urgent,
        how,
        recommendation.id,
      ],
    );
    if (how === 'now') await deps.queue.enqueue('inbox.post', { bundleId: bundle.id }, { tx });
  });
  return p.status;
}

/** Shows a message addressed to the reader without a reading: who wrote, where, and a link. */
async function surface(deps: WorkerDeps, ctx: Context, why: { reason: string; triage?: TriageResult; delivery?: 'digest' }): Promise<'unanalysed'> {
  const wording = ruleWording({ sender: ctx.sender, channel: ctx.channel, label: 'reply', texts: ctx.texts, ownProject: '', otherProjects: [] });
  const project = ctx.projects.find((p) => p.id === (ctx.rule?.projectId ?? ctx.workspace.projectId)) ?? null;
  await propose(deps, ctx, {
    triage: why.triage ?? null,
    project,
    wording,
    quote: null,
    status: 'unanalysed',
    detail: `Not analysed: ${why.reason}`,
    ...(why.delivery ? { delivery: why.delivery } : {}),
  });
  return 'unanalysed';
}

/**
 * The model cannot be used now. The bundle waits for the catch-up schedule. Something
 * addressed to the reader does not wait for long: after the time set in Settings it is
 * listed as "not analysed", in the digest when the reason is the budget (design 13.1).
 * While Patcher is paused nothing is shown, as everywhere.
 */
async function hold(deps: WorkerDeps, ctx: Context, step: 'triage' | 'recommend', reason: HoldReason, detail?: string): Promise<'held' | 'unanalysed'> {
  const { bundle, settings } = ctx;
  const waitedMinutes = (Date.now() - bundle.openedAt.getTime()) / 60_000;
  const addressed = bundle.addressed || ctx.rule?.rule === 'urgent' || bundle.triage?.addressed === true;
  if (reason !== 'paused' && addressed && waitedMinutes >= settings['inbox.unanalysed_after_minutes']) {
    return surface(deps, ctx, { reason: `${detail ?? HOLD_DETAIL[reason]}.`, ...(reason === 'budget' ? { delivery: 'digest' as const } : {}) });
  }
  const first = await withTx(deps.pool, async (tx) => {
    const before = await tx.query<{ hold_reason: string | null }>('SELECT hold_reason FROM slack_bundles WHERE id = $1 FOR UPDATE', [bundle.id]);
    await tx.query(
      `UPDATE slack_bundles SET status = 'held', hold_reason = $2, held_step = $3, status_detail = $4, updated_at = now() WHERE id = $1`,
      [bundle.id, reason, step, `Waiting: ${detail ?? HOLD_DETAIL[reason]}.`],
    );
    return before.rows[0]?.hold_reason !== 'budget';
  });
  if (reason === 'budget' && first) {
    // One notice when the budget first stops a message, not one per message.
    const waiting = await deps.pool.query(`SELECT 1 FROM slack_bundles WHERE status = 'held' AND hold_reason = 'budget' LIMIT 2`);
    if (waiting.rowCount === 1) await notifyOps(deps, 'Slack messages are waiting: the model budget for Slack is used up. Raise it in Settings, or wait for the window to pass.');
  }
  return 'held';
}

// Recheck ------------------------------------------------------------------------------------------

/** The reader wrote in a conversation, or a message was deleted there: look again at what is waiting on it. */
export async function recheckChannel(deps: WorkerDeps, workspaceId: string, channelKey: string): Promise<number> {
  const { rows } = await deps.pool.query<{ id: string }>(
    `SELECT b.id FROM slack_bundles b
      WHERE b.workspace_id = $1 AND b.channel_key = $2 AND b.status IN ('recommended', 'unanalysed')
        AND b.created_at > now() - interval '14 days'`,
    [workspaceId, channelKey],
  );
  let closed = 0;
  for (const { id } of rows) {
    const bundle = await getBundle(deps.pool, id);
    if (!bundle) continue;
    const left = await deps.pool.query('SELECT 1 FROM slack_messages WHERE bundle_id = $1 AND NOT own LIMIT 1', [id]);
    const detail = !left.rowCount ? 'The message was deleted.' : (await repliedSince(deps.pool, bundle)) ? 'You replied in the conversation.' : null;
    if (detail && (await closeHandled(deps, id, detail))) closed += 1;
  }
  return closed;
}

// Catch-up -----------------------------------------------------------------------------------------

const SWEEP_LIMIT = 200;

/**
 * The `slack.catchup` schedule: bundles whose job was lost, bundles that waited for the
 * model, and a reading that was interrupted are put back on the queue.
 */
export async function sweepBundles(deps: WorkerDeps): Promise<string> {
  if (await getSetting(deps.pool, 'paused')) return 'Paused.';
  const { rows } = await deps.pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM slack_bundles
      WHERE (status = 'open' AND settle_at < now() - interval '1 minute')
         OR (status = 'held' AND updated_at < now() - interval '2 minutes')
         OR (status = 'reading' AND updated_at < now() - interval '20 minutes')
      ORDER BY opened_at LIMIT $1`,
    [SWEEP_LIMIT],
  );
  for (const row of rows) await deps.queue.enqueue('inbox.bundle', { bundleId: row.id });
  const unposted = await deps.pool.query<{ id: string }>(
    `SELECT b.id FROM slack_bundles b JOIN recommendations r ON r.id = b.recommendation_id
      WHERE b.delivery = 'now' AND b.slack_ts IS NULL AND b.post_error IS NULL AND r.status = 'drafted'
        AND b.updated_at < now() - interval '2 minutes'
      LIMIT $1`,
    [SWEEP_LIMIT],
  );
  for (const row of unposted.rows) await deps.queue.enqueue('inbox.post', { bundleId: row.id });
  return `${rows.length} bundle${rows.length === 1 ? '' : 's'} put back, ${unposted.rows.length} post${unposted.rows.length === 1 ? '' : 's'} retried`;
}
