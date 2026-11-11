import { ModelApiError } from '../ai/client.js';
import type { GateReason } from '../ai/gate.js';
import { GATE_DETAIL, callsModelGate } from '../ai/gate.js';
import { costUsd, estimateTokens } from '../ai/models.js';
import { loadPrompt } from '../ai/prompts.js';
import type { ModelDeps, TaskSpec } from '../ai/run.js';
import { ModelOutputError, callModel } from '../ai/run.js';
import type { Actor } from '../audit/auditLog.js';
import { recordAudit, SYSTEM_ACTOR } from '../audit/auditLog.js';
import type { Pool, Queryable } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { FIX_ACTION } from '../fix/agentFix.js';
import type { Enqueuer } from '../queue/queue.js';
import { RecommendationInputError, createRecommendation } from '../recommendations/service.js';
import type { Project } from '../registry/registry.js';
import { listProjects } from '../registry/registry.js';
import { getSetting } from '../settings/settings.js';
import { clip } from '../slack/messages.js';
import type { WorkerDeps } from '../worker/deps.js';
import { notifyOps } from '../worker/notify.js';
import { draftCallBrief, ruleCallBrief } from './brief.js';
import { CALL_KINDS, FOLLOWUP_ACTION, TASK_ACTION } from './catalog.js';
import { computeHints, parseDomains } from './hints.js';
import type { CheckedMatch } from './match.js';
import { MATCH_TASK, MAX_PROJECTS, buildMatchInput, checkMatches, decideMatch } from './match.js';
import { capTranscript, indexTranscript } from './quotes.js';
import { afterCallAnalysed } from './seam.js';
import { CALL_CARRIER, closeCallRecommendations, getCall, isUuid, listMatches, listSuggestions, preferredTranscript } from './store.js';
import type { CheckedSuggestion, PastDecision, RepoContext } from './suggest.js';
import { SUGGEST_TASK, buildSuggestInput, checkSuggestions, repoContextText } from './suggest.js';
import type { Call, CallSuggestion } from './types.js';

/**
 * The two model steps of a call (design 5.2 and 5.3) and what happens around them:
 *
 *   calls.analyze   which project is the call about → matched, asked in Slack, or unmatched
 *   calls.suggest   for a matched call: what work does it ask for → recommendations
 *
 * The model drafts and classifies. It is given text and returns JSON; code checks every
 * entry against the transcript and the registry before anything is stored, and nothing it
 * returns can start an action: a suggestion becomes a recommendation that a person approves.
 * When a step cannot run (no key, switched off, over budget, provider down) the call waits
 * and is picked up again by the poll schedule.
 */
export type HoldReason = GateReason | 'off' | 'provider';

const HOLD_DETAIL: Record<HoldReason, string> = {
  ...GATE_DETAIL,
  off: 'calls are switched off in Settings',
  provider: 'the model provider did not answer',
};

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 200);

/** One job at a time per call. `busy` when another process holds the call. */
async function withCallLock<T>(pool: Pool, callId: string, fn: () => Promise<T>): Promise<T | 'busy'> {
  const session = await pool.connect();
  let locked = false;
  try {
    const got = await session.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(hashtextextended('call:' || $1, 0)) AS locked`, [callId]);
    locked = got.rows[0]?.locked === true;
    if (!locked) return 'busy';
    return await fn();
  } finally {
    if (locked) await session.query(`SELECT pg_advisory_unlock(hashtextextended('call:' || $1, 0))`, [callId]).catch(() => undefined);
    session.release();
  }
}

async function hold(deps: WorkerDeps, call: Call, reason: HoldReason, detail?: string): Promise<'held'> {
  const updated = await deps.pool.query(
    `UPDATE calls SET status = 'held', hold_reason = $2, status_detail = $3, updated_at = now()
      WHERE id = $1 AND version = $4 AND status IN ('received', 'analyzing', 'held', 'failed', 'matched')`,
    [call.id, reason, `Waiting: ${detail ?? HOLD_DETAIL[reason]}.`, call.version],
  );
  if (updated.rowCount && reason === 'budget' && call.holdReason !== 'budget') {
    // One notice when the budget first stops a call, not one per call.
    const waiting = await deps.pool.query(`SELECT 1 FROM calls WHERE status = 'held' AND hold_reason = 'budget' LIMIT 2`);
    if (waiting.rowCount === 1) {
      await notifyOps(
        deps,
        `Calls · the model budget for calls is used up, so new calls wait unanalysed. Raise it in <${deps.appBaseUrl}/settings#calls|Settings>, or they continue when there is room again.`,
      );
    }
  }
  return 'held';
}

async function fail(deps: WorkerDeps, call: Call, detail: string): Promise<'failed'> {
  await deps.pool.query(
    `UPDATE calls SET status = 'failed', hold_reason = NULL, status_detail = $2, updated_at = now() WHERE id = $1 AND version = $3`,
    [call.id, clip(detail, 300), call.version],
  );
  await recordAudit(deps.pool, { actor: SYSTEM_ACTOR, action: 'call.analysis.failed', target: call.id, after: { reason: clip(detail, 300) } });
  return 'failed';
}

type Asked<T> = { ok: true; value: T } | { ok: false; outcome: 'held' | 'failed' };

/** One gated model call for a call: budget first, then the provider, with both ways of failing sorted. */
async function ask<T>(deps: WorkerDeps, call: Call, spec: TaskSpec<T>, model: string, user: string, typicalOutputTokens: number): Promise<Asked<T>> {
  const inputTokens = estimateTokens(loadPrompt(spec.task).system) + estimateTokens(user);
  const estimate = costUsd(model, { inputTokens, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: typicalOutputTokens }) ?? 0;
  const gate = await callsModelGate({ pool: deps.pool, client: deps.integrations.model }, estimate);
  if (!gate.ok) return { ok: false, outcome: await hold(deps, call, gate.reason) };
  const modelDeps: ModelDeps = { pool: deps.pool, client: gate.client, log: deps.log };
  try {
    return { ok: true, value: await callModel(modelDeps, spec, { model, runId: call.id }, user) };
  } catch (err) {
    // Nothing is used from a reply that failed validation twice (design 13.1).
    if (err instanceof ModelOutputError) return { ok: false, outcome: await fail(deps, call, err.message) };
    if (err instanceof ModelApiError) return { ok: false, outcome: await hold(deps, call, 'provider', `the model provider did not answer (${reasonOf(err)})`) };
    throw err;
  }
}

export type AnalyzeOutcome = 'matched' | 'needs_project' | 'unmatched' | 'held' | 'failed' | 'waiting' | 'skipped' | 'busy' | 'not_found' | 'superseded';

const ANALYSABLE = ['received', 'analyzing', 'held', 'failed'];

export async function analyzeCall(deps: WorkerDeps, callId: string, now: Date = new Date()): Promise<AnalyzeOutcome> {
  return withCallLock(deps.pool, callId, () => analyzeLocked(deps, callId, now));
}

async function analyzeLocked(deps: WorkerDeps, callId: string, now: Date): Promise<AnalyzeOutcome> {
  const call = await getCall(deps.pool, callId);
  if (!call) return 'not_found';
  if (!ANALYSABLE.includes(call.status)) return 'skipped';
  // Still inside the settle time: a second recording of the same call may be on its way.
  if (call.status === 'received' && call.analyzeAfter && call.analyzeAfter.getTime() > now.getTime()) {
    await deps.queue.enqueue('calls.analyze', { callId }, { startAfter: call.analyzeAfter });
    return 'waiting';
  }
  if (!(await getSetting(deps.pool, 'calls.enabled'))) return hold(deps, call, 'off');

  const transcript = await preferredTranscript(deps.pool, callId);
  if (!transcript?.text) return fail(deps, call, 'The transcript text is no longer stored, so the call cannot be analysed.');
  await deps.pool.query(`UPDATE calls SET status = 'analyzing', status_detail = NULL, updated_at = now() WHERE id = $1`, [callId]);

  // The project is already known (a person chose it, or matching finished before a wait): go on to the suggestions.
  const known = (await listMatches(deps.pool, callId)).filter((m) => m.state === 'matched');
  if (known.length) {
    await deps.pool.query(`UPDATE calls SET status = 'matched', hold_reason = NULL, status_detail = NULL, updated_at = now() WHERE id = $1`, [callId]);
    await deps.queue.enqueue('calls.suggest', { callId });
    return 'matched';
  }

  const projects = (await listProjects(deps.pool)).filter((p) => p.status === 'active');
  const text = transcript.text;
  const index = indexTranscript(text);
  let checked: { summary: string | null; matches: CheckedMatch[] } = { summary: null, matches: [] };
  const hints = computeHints(call, text, projects, parseDomains(await getSetting(deps.pool, 'calls.internal_domains')));
  const thresholds = {
    auto: await getSetting(deps.pool, 'ai.calls.auto_match_confidence'),
    ask: await getSetting(deps.pool, 'ai.calls.ask_confidence'),
  };

  if (projects.length) {
    const capped = capTranscript(text, await getSetting(deps.pool, 'ai.calls.transcript_token_cap'));
    const input = buildMatchInput(call, projects, hints, capped.text);
    const asked = await ask(deps, call, MATCH_TASK, await getSetting(deps.pool, 'ai.calls.model_match'), input.user, 500);
    if (!asked.ok) return asked.outcome;
    const result = checkMatches(asked.value, input, index, hints, thresholds.auto);
    if (result.dropped.length) deps.log.info('call match entries not used', { callId, dropped: result.dropped });
    checked = result;
  }
  const decision = decideMatch(checked.matches, hints, projects, thresholds);
  const detail = !projects.length
    ? 'There is no active project in the registry to match against.'
    : decision.status === 'unmatched'
      ? decision.candidates[0] && decision.candidates[0].confidence > 0
        ? `No project was clear enough. Closest: ${decision.candidates[0].project.name} (${decision.candidates[0].confidence.toFixed(2)}).`
        : 'No listed project fits this call.'
      : null;

  const stored = await withTx(deps.pool, async (tx) => {
    const current = await tx.query<{ status: string; version: number }>('SELECT status, version FROM calls WHERE id = $1 FOR UPDATE', [callId]);
    // A person set the project, or the recording was deleted, while the model was reading.
    if (current.rows[0]?.status !== 'analyzing' || current.rows[0].version !== call.version) return false;
    await tx.query('DELETE FROM call_analyses WHERE call_id = $1', [callId]);
    const rows = [
      ...decision.matched.map((m) => ({ m, state: 'matched' })),
      ...decision.candidates.map((m) => ({ m, state: 'candidate' })),
    ];
    for (const { m, state } of rows) {
      await tx.query(
        `INSERT INTO call_analyses (call_id, transcript_id, project_id, match_conf, evidence, state, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (call_id, project_id) DO NOTHING`,
        [callId, transcript.id, m.project.id, m.confidence, JSON.stringify({ ...(m.quote ? { quote: m.quote, at: m.at } : {}), hints: m.hints }), state, m.source],
      );
    }
    await tx.query(
      `UPDATE calls SET status = $2, summary = coalesce($3, summary), status_detail = $4, hold_reason = NULL, updated_at = now() WHERE id = $1`,
      [callId, decision.status, checked.summary || null, detail],
    );
    await recordAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: 'call.match',
      target: callId,
      after: {
        status: decision.status,
        projects: rows.map(({ m, state }) => ({ project: m.project.name, confidence: m.confidence, state })),
      },
    });
    if (decision.status === 'matched') await deps.queue.enqueue('calls.suggest', { callId }, { tx });
    // The question goes to Slack; an unmatched call is only listed in the UI.
    if (decision.status === 'needs_project') await deps.queue.enqueue('calls.post', { callId }, { tx });
    return true;
  });
  if (!stored) return 'superseded';

  const analysed = await getCall(deps.pool, callId);
  if (analysed) await afterCallAnalysed(deps, analysed);
  return decision.status;
}

async function repoContexts(deps: WorkerDeps, repos: string[]): Promise<RepoContext[]> {
  const github = deps.integrations.github;
  const out: RepoContext[] = [];
  for (const repo of repos.slice(0, 2)) {
    if (!github) {
      out.push({ repo, readme: null, pulls: [] });
      continue;
    }
    // Context only: a repository that cannot be read makes the suggestions less informed, not impossible.
    const readme = await github.readme(repo).catch((err: unknown) => {
      deps.log.info('could not read the README', { repo, reason: reasonOf(err) });
      return null;
    });
    const pulls = await github.openPullTitles(repo).catch((err: unknown) => {
      deps.log.info('could not read the open pull requests', { repo, reason: reasonOf(err) });
      return [] as string[];
    });
    out.push({ repo, readme, pulls });
  }
  return out;
}

/** What people decided about earlier suggestions for this project. Only this project's: one client's history never informs another's prompt. */
async function pastDecisions(db: Queryable, projectId: string): Promise<PastDecision[]> {
  const { rows } = await db.query<{ title: string; status: string }>(
    `SELECT r.title, r.status
       FROM call_suggestions s JOIN recommendations r ON r.id = s.recommendation_id
      WHERE s.project_id = $1 AND r.status IN ('approved', 'executing', 'done', 'failed', 'dismissed')
      ORDER BY r.decided_at DESC NULLS LAST
      LIMIT 12`,
    [projectId],
  );
  return rows.map((r) => ({ title: r.title, decision: r.status === 'dismissed' ? 'dismissed' : 'approved' }));
}

/** Names that must not appear in a suggestion for `project`: the other clients and their projects. */
function otherNames(project: Project, all: Project[]): string[] {
  const client = project.client.trim().toLowerCase();
  return all
    .filter((p) => p.id !== project.id && (!client || p.client.trim().toLowerCase() !== client))
    .flatMap((p) => [p.name, p.client])
    .filter(Boolean);
}

interface Drafted {
  project: Project;
  suggestion: CheckedSuggestion;
  brief: string | null;
}

export type SuggestOutcome = 'suggested' | 'none' | 'held' | 'failed' | 'skipped' | 'busy' | 'not_found' | 'superseded';

export async function suggestForCall(deps: WorkerDeps, callId: string): Promise<SuggestOutcome> {
  const outcome = await withCallLock(deps.pool, callId, () => suggestLocked(deps, callId));
  if (outcome === 'busy') await deps.queue.enqueue('calls.suggest', { callId }, { startAfter: 30 });
  return outcome;
}

async function suggestLocked(deps: WorkerDeps, callId: string): Promise<SuggestOutcome> {
  const call = await getCall(deps.pool, callId);
  if (!call) return 'not_found';
  if (call.status !== 'matched') return 'skipped';

  if (call.suggestedVersion !== call.version) {
    const drafted = await draftSuggestions(deps, call);
    if (drafted === 'held' || drafted === 'failed') return drafted;
    const stored = await withTx(deps.pool, async (tx) => {
      const current = await tx.query<{ status: string; version: number }>('SELECT status, version FROM calls WHERE id = $1 FOR UPDATE', [callId]);
      if (current.rows[0]?.status !== 'matched' || current.rows[0].version !== call.version) return false;
      for (const [position, d] of drafted.entries()) {
        await tx.query(
          `INSERT INTO call_suggestions
             (call_id, project_id, version, position, type, drafted_type, type_note, title, detail, draft, quote, quote_at, repo, brief)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (call_id, version, position) DO NOTHING`,
          [
            callId,
            d.project.id,
            call.version,
            position + 1,
            d.suggestion.type,
            d.suggestion.draftedType,
            d.suggestion.typeNote,
            d.suggestion.title,
            d.suggestion.detail,
            d.suggestion.draft,
            d.suggestion.quote,
            d.suggestion.quoteAt,
            d.suggestion.repo,
            d.brief,
          ],
        );
      }
      await tx.query('UPDATE calls SET suggested_version = version, updated_at = now() WHERE id = $1', [callId]);
      await recordAudit(tx, {
        actor: SYSTEM_ACTOR,
        action: 'call.suggest',
        target: callId,
        after: { version: call.version, suggestions: drafted.map((d) => ({ type: d.suggestion.type, project: d.project.name })) },
      });
      return true;
    });
    if (!stored) return 'superseded';
  }

  // Safe to repeat: each suggestion gets at most one recommendation, by its dedupe key.
  const suggestions = await listSuggestions(deps.pool, callId, call.version);
  const projects = new Map((await listProjects(deps.pool)).map((p) => [p.id, p]));
  for (const suggestion of suggestions) {
    if (suggestion.type === 'note' || suggestion.recommendationId) continue;
    const project = projects.get(suggestion.projectId);
    if (project) await propose(deps, call, suggestion, project);
  }
  await deps.queue.enqueue('calls.post', { callId });
  return suggestions.length ? 'suggested' : 'none';
}

async function draftSuggestions(deps: WorkerDeps, call: Call): Promise<Drafted[] | 'held' | 'failed'> {
  const transcript = await preferredTranscript(deps.pool, call.id);
  if (!transcript?.text) {
    await deps.pool.query(`UPDATE calls SET status_detail = $2 WHERE id = $1`, [
      call.id,
      'The transcript text is no longer stored, so no suggestions were drafted.',
    ]);
    return [];
  }
  const text = transcript.text;
  const index = indexTranscript(text);
  const capped = capTranscript(text, await getSetting(deps.pool, 'ai.calls.transcript_token_cap'));
  const max = await getSetting(deps.pool, 'ai.calls.max_suggestions');
  const all = await listProjects(deps.pool);
  const matches = (await listMatches(deps.pool, call.id)).filter((m) => m.state === 'matched').slice(0, MAX_PROJECTS);
  const suggestModel = await getSetting(deps.pool, 'ai.calls.model_suggest');
  const out: Drafted[] = [];

  for (const match of matches) {
    if (out.length >= max) break;
    const project = all.find((p) => p.id === match.projectId);
    if (!project || project.status !== 'active') continue;
    const repos = project.links.filter((l) => l.kind === 'repo').map((l) => l.externalId.toLowerCase());
    const contexts = await repoContexts(deps, repos);
    const user = buildSuggestInput(call, project, contexts, await pastDecisions(deps.pool, project.id), capped.text);
    const asked = await ask(deps, call, SUGGEST_TASK, suggestModel, user, 1500);
    if (!asked.ok) return asked.outcome;
    const { kept, dropped } = checkSuggestions(asked.value, project, text, index, {
      repos,
      agentUnavailable: deps.integrations.cursor ? null : 'Cursor is not configured (CURSOR_API_KEY)',
      otherNames: otherNames(project, all),
      max: max - out.length,
    });
    if (dropped.length) deps.log.info('call suggestions not used', { callId: call.id, project: project.name, dropped });

    for (const suggestion of kept) {
      let brief: string | null = null;
      if (suggestion.type === 'code_change' && suggestion.repo) {
        brief = await briefFor(deps, call, suggestion, project, suggestion.repo, repoContextText(contexts.filter((c) => c.repo === suggestion.repo)));
      }
      out.push({ project, suggestion, brief });
    }
  }
  return out;
}

/** The brief for one code change: drafted by the model when it may be asked, written by rule otherwise. Never blocks the suggestion. */
async function briefFor(deps: WorkerDeps, call: Call, suggestion: CheckedSuggestion, project: Project, repo: string, repoContext: string): Promise<string> {
  const fallback = ruleCallBrief(suggestion, project);
  const gate = await callsModelGate({ pool: deps.pool, client: deps.integrations.model });
  if (!gate.ok) return fallback;
  try {
    const drafted = await draftCallBrief(
      { pool: deps.pool, client: gate.client, log: deps.log },
      { model: await getSetting(deps.pool, 'ai.calls.model_brief'), runId: call.id },
      suggestion,
      project,
      repo,
      repoContext,
    );
    return drafted.prompt;
  } catch (err) {
    deps.log.warn('call brief not drafted, using the rule brief', { callId: call.id, reason: reasonOf(err) });
    return fallback;
  }
}

/** Turns one stored suggestion into a recommendation in the shared loop, shown on the call's message. */
async function propose(deps: WorkerDeps, call: Call, suggestion: CallSuggestion, project: Project): Promise<void> {
  const when = call.startedAt ? call.startedAt.toISOString().slice(0, 10) : null;
  const source = clip(`Call "${call.title}"${when ? `, ${when}` : ''}${suggestion.quoteAt ? `, at ${suggestion.quoteAt}` : ''}`, 280);
  const common = { callId: call.id, projectId: project.id, title: suggestion.title };
  const mapped =
    suggestion.type === 'code_change' && suggestion.repo
      ? {
          kind: CALL_KINDS.change,
          risk: 'medium' as const,
          action: {
            type: FIX_ACTION,
            params: { findingId: null, repo: suggestion.repo, ref: null, prompt: suggestion.brief ?? ruleCallBrief(suggestion, project) },
          },
        }
      : suggestion.type === 'client_followup'
        ? { kind: CALL_KINDS.followup, risk: 'low' as const, action: { type: FOLLOWUP_ACTION, params: { ...common, draft: suggestion.draft ?? suggestion.detail } } }
        : { kind: CALL_KINDS.task, risk: 'low' as const, action: { type: TASK_ACTION, params: { ...common, detail: suggestion.detail } } };
  try {
    const { recommendation } = await createRecommendation(deps, {
      kind: mapped.kind,
      sourceType: 'call',
      sourceId: call.id,
      title: suggestion.title,
      body: clip(suggestion.detail, 400),
      evidence: [{ quote: suggestion.quote, source, url: `${deps.appBaseUrl}/calls/${call.id}` }],
      action: mapped.action,
      risk: mapped.risk,
      dedupeKey: `call:${call.id}:v${suggestion.version}:${suggestion.position}`,
      carrier: { type: CALL_CARRIER, id: call.id },
    });
    await deps.pool.query('UPDATE call_suggestions SET recommendation_id = $2 WHERE id = $1', [suggestion.id, recommendation.id]);
  } catch (err) {
    if (!(err instanceof RecommendationInputError)) throw err;
    // Kept as a suggestion to read; it proposes nothing.
    deps.log.warn('call suggestion could not be proposed', { callId: call.id, position: suggestion.position, reason: err.message });
    await deps.pool.query(`UPDATE call_suggestions SET type_note = $2 WHERE id = $1`, [suggestion.id, clip(`Not proposed: ${err.message}`, 200)]);
  }
}

// Decisions people make about a call. These run in the public service too, so they take no worker dependencies.

export type ProjectChoice =
  | { ok: true; call: Call; projectName: string | null }
  | { ok: false; reason: 'not_found' | 'stale' | 'gone' | 'no_project'; message: string };

/**
 * A person says which project a call belongs to: the answer to the Slack question, "Wrong
 * project", or the rematch form in the UI. What was still waiting for a decision under the
 * old project is closed, and suggestions are drafted again for the new one.
 */
export async function setCallProject(
  deps: { pool: Pool; queue: Enqueuer },
  input: { callId: string; projectId: string | null; actor: Actor; via: 'slack' | 'ui'; expectedVersion?: number },
): Promise<ProjectChoice> {
  if (!isUuid(input.callId)) return { ok: false, reason: 'not_found', message: 'That call no longer exists.' };
  return withTx(deps.pool, async (tx): Promise<ProjectChoice> => {
    await tx.query('SELECT id FROM calls WHERE id = $1 FOR UPDATE', [input.callId]);
    const call = await getCall(tx, input.callId);
    if (!call) return { ok: false, reason: 'not_found', message: 'That call no longer exists.' };
    if (call.status === 'deleted') return { ok: false, reason: 'gone', message: 'The recording was deleted at its source.' };
    if (input.expectedVersion !== undefined && input.expectedVersion !== call.version) {
      return { ok: false, reason: 'stale', message: 'The project of this call was already changed. Check the current message.' };
    }
    let projectName: string | null = null;
    if (input.projectId) {
      const project = isUuid(input.projectId)
        ? await tx.query<{ name: string }>(`SELECT name FROM projects WHERE id = $1 AND status = 'active'`, [input.projectId])
        : { rows: [] };
      if (!project.rows[0]) return { ok: false, reason: 'no_project', message: 'That project is not an active project in the registry.' };
      projectName = project.rows[0].name;
    }

    const before = await listMatches(tx, input.callId);
    const closed = await closeCallRecommendations(tx, input.callId, {
      reason: projectName ? `Closed: the call was moved to ${projectName}.` : 'Closed: the call was taken off its project.',
      actor: input.actor,
    });
    await tx.query('DELETE FROM call_analyses WHERE call_id = $1', [input.callId]);
    if (input.projectId) {
      await tx.query(
        `INSERT INTO call_analyses (call_id, project_id, match_conf, evidence, state, source, decided_by)
         VALUES ($1, $2, 1, '{}', 'matched', 'person', $3)`,
        [input.callId, input.projectId, input.actor],
      );
    }
    await tx.query(
      `UPDATE calls
          SET status = $2, version = version + 1, project_set_by = $3, hold_reason = NULL,
              status_detail = $4, details_ts = NULL, updated_at = now()
        WHERE id = $1`,
      [input.callId, input.projectId ? 'matched' : 'unmatched', input.actor, input.projectId ? null : 'Marked as belonging to no listed project.'],
    );
    await recordAudit(tx, {
      actor: input.actor,
      action: 'call.project.set',
      target: input.callId,
      before: { projects: before.filter((m) => m.state === 'matched').map((m) => m.projectName), status: call.status },
      after: { project: projectName, via: input.via, closedRecommendations: closed },
    });
    await deps.queue.enqueue(input.projectId ? 'calls.suggest' : 'calls.post', { callId: input.callId }, { tx });
    const updated = await getCall(tx, input.callId);
    return { ok: true, call: updated!, projectName };
  });
}

/** "Analyse again" in the UI: forget the match and what was still waiting, and start over. */
export async function reanalyzeCall(deps: { pool: Pool; queue: Enqueuer }, callId: string, actor: Actor): Promise<boolean> {
  if (!isUuid(callId)) return false;
  return withTx(deps.pool, async (tx) => {
    const { rows } = await tx.query<{ status: string }>('SELECT status FROM calls WHERE id = $1 FOR UPDATE', [callId]);
    if (!rows[0] || rows[0].status === 'deleted') return false;
    await closeCallRecommendations(tx, callId, { reason: 'Closed: the call was analysed again.', actor });
    await tx.query('DELETE FROM call_analyses WHERE call_id = $1', [callId]);
    await tx.query(
      `UPDATE calls
          SET status = 'received', version = version + 1, analyze_after = NULL, hold_reason = NULL, status_detail = NULL,
              project_set_by = NULL, details_ts = NULL, updated_at = now()
        WHERE id = $1`,
      [callId],
    );
    await recordAudit(tx, { actor, action: 'call.reanalyze', target: callId, before: { status: rows[0].status } });
    await deps.queue.enqueue('calls.analyze', { callId }, { tx });
    return true;
  });
}

/**
 * Picks up calls that are waiting: held for something that has since changed, or left
 * behind by a job that never finished. Runs with the poll schedule and after a resume.
 */
export async function resumeWaitingCalls(deps: Pick<WorkerDeps, 'pool' | 'queue' | 'integrations'>): Promise<number> {
  if (!(await getSetting(deps.pool, 'calls.enabled'))) return 0;
  const { rows } = await deps.pool.query<{ id: string; status: string; hold_reason: string | null }>(
    `SELECT id, status, hold_reason FROM calls
      WHERE status = 'held'
         OR (status = 'received' AND coalesce(analyze_after, created_at) < now() - interval '30 minutes')
         OR (status = 'analyzing' AND updated_at < now() - interval '30 minutes')
      ORDER BY created_at
      LIMIT 50`,
  );
  if (!rows.length) return 0;
  const gate = await callsModelGate({ pool: deps.pool, client: deps.integrations.model });
  let resumed = 0;
  for (const row of rows) {
    // Still closed for the same reason: leave it waiting, with no model call and no second notice.
    if (row.status === 'held' && !gate.ok && row.hold_reason === gate.reason) continue;
    await deps.queue.enqueue('calls.analyze', { callId: row.id });
    resumed += 1;
  }
  return resumed;
}
