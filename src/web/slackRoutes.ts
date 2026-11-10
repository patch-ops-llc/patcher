import express from 'express';
import type { Request, Response, Router } from 'express';
import { withTx } from '../db/pool.js';
import { queueStats } from '../queue/queue.js';
import { decide, editRecommendation, getRecommendation, listRecommendations, retryRecommendation } from '../recommendations/service.js';
import type { DecisionResult } from '../recommendations/service.js';
import { hashesMatch } from '../recommendations/hash.js';
import { setPaused } from '../settings/pause.js';
import { getAllSettings } from '../settings/settings.js';
import { canDecide, getUser, hasRole, touchProfile } from '../settings/users.js';
import { ACTION_IDS, EDIT_FIELDS, EDIT_MODAL_CALLBACK, clip, decodeRef, editModal, escapeMrkdwn } from '../slack/messages.js';
import { verifySlackSignature } from '../slack/verify.js';
import type { WebDeps } from './deps.js';

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const asString = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/**
 * Everything Slack sends to the hub app: events, button clicks and modal submissions, and
 * the `/ops` command. Each request is verified, written down or decided in one short
 * transaction, and acknowledged; anything slow or outbound is a job for the worker.
 */
export function slackRouter(deps: WebDeps): Router {
  const router = express.Router();
  const log = deps.log.child({ area: 'slack' });

  // The signature is computed over the exact bytes Slack sent, so nothing may parse them first.
  router.use(express.raw({ type: () => true, limit: '1mb' }));

  router.use((req: Request, res: Response, next) => {
    if (!deps.signingSecret || !deps.hubTeamId) {
      res.status(503).json({ error: 'slack_not_configured' });
      return;
    }
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const check = verifySlackSignature({
      signingSecret: deps.signingSecret,
      timestamp: req.get('x-slack-request-timestamp'),
      signature: req.get('x-slack-signature'),
      rawBody,
    });
    if (!check.ok) {
      log.warn('slack request rejected', { reason: check.reason, path: req.path });
      res.status(401).json({ error: 'invalid_signature' });
      return;
    }
    res.locals.rawBody = rawBody.toString('utf8');
    next();
  });

  const rawBody = (res: Response) => res.locals.rawBody as string;
  const isHub = (teamId: unknown) => teamId === deps.hubTeamId;

  // Events -------------------------------------------------------------------------------

  router.post('/events', async (_req, res) => {
    let body: Json;
    try {
      body = JSON.parse(rawBody(res)) as Json;
    } catch {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
    if (body.type === 'url_verification') {
      res.json({ challenge: body.challenge });
      return;
    }
    const eventId = asString(body.event_id);
    if (body.type !== 'event_callback' || !eventId || !isHub(body.team_id)) {
      res.status(200).end();
      return;
    }
    // Slack retries deliveries; the unique event id makes a retry a no-op.
    await withTx(deps.pool, async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO webhook_events (source, external_event_id, payload) VALUES ('slack', $1, $2)
         ON CONFLICT (source, external_event_id) DO NOTHING
         RETURNING id`,
        [eventId, JSON.stringify(body)],
      );
      if (inserted.rows[0]) {
        await deps.queue.enqueue('slack.event', { webhookEventId: inserted.rows[0].id }, { tx });
      }
    });
    res.status(200).end();
  });

  // Buttons and modals -------------------------------------------------------------------

  const tellPrivately = async (responseUrl: string | undefined, text: string) => {
    if (responseUrl) await deps.queue.enqueue('slack.respond', { responseUrl, text });
  };

  const refusalText = (result: Extract<DecisionResult, { ok: false }>) => result.message;

  router.post('/interactions', async (_req, res) => {
    let payload: Json;
    try {
      payload = JSON.parse(new URLSearchParams(rawBody(res)).get('payload') ?? '') as Json;
    } catch {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const user = asObject(payload.user);
    const actor = asString(user?.id);
    const team = asObject(payload.team);
    // The click must come from the hub workspace, by a member of it (not a Slack Connect guest).
    if (!actor || !isHub(team?.id) || (user?.team_id !== undefined && !isHub(user.team_id))) {
      log.warn('interaction from outside the hub ignored');
      res.status(200).end();
      return;
    }
    const responseUrl = asString(payload.response_url);

    if (payload.type === 'block_actions') {
      const action = asObject(Array.isArray(payload.actions) ? payload.actions[0] : undefined);
      const actionId = asString(action?.action_id);
      const ref = decodeRef(action?.value);
      if (!actionId || !ref || !Object.values(ACTION_IDS).includes(actionId as never)) {
        res.status(200).end();
        return;
      }
      await touchProfile(deps.pool, actor, { displayName: asString(user?.name) ?? null });
      const input = { id: ref.id, hash: ref.hash, actor, via: 'slack' as const };

      if (actionId === ACTION_IDS.approve || actionId === ACTION_IDS.dismiss) {
        const result = await decide(deps, { ...input, decision: actionId === ACTION_IDS.approve ? 'approve' : 'dismiss' });
        if (!result.ok) await tellPrivately(responseUrl, refusalText(result));
      } else if (actionId === ACTION_IDS.retry) {
        const result = await retryRecommendation(deps, input);
        if (!result.ok) await tellPrivately(responseUrl, refusalText(result));
      } else if (actionId === ACTION_IDS.details) {
        if (await getUser(deps.pool, actor)) {
          await deps.queue.enqueue('recommendation.details', { recommendationId: ref.id });
        } else {
          await tellPrivately(responseUrl, 'You do not have access to Patcher.');
        }
      } else if (actionId === ACTION_IDS.edit) {
        const [rec, person] = await Promise.all([getRecommendation(deps.pool, ref.id), getUser(deps.pool, actor)]);
        const triggerId = asString(payload.trigger_id);
        const link = `${deps.appBaseUrl}/approvals/${ref.id}`;
        if (!rec || !person || !canDecide(person, rec.kind)) {
          await tellPrivately(responseUrl, 'You are not on the approver list for this.');
        } else if (rec.status !== 'posted' || !hashesMatch(rec.actionHash, ref.hash)) {
          await tellPrivately(responseUrl, 'This can no longer be edited.');
        } else if (!deps.modals || !triggerId) {
          await tellPrivately(responseUrl, `Edit it in Patcher: ${link}`);
        } else {
          try {
            await deps.modals.openView({ triggerId, view: editModal(rec) });
          } catch (err) {
            log.warn('could not open edit modal', { err });
            await tellPrivately(responseUrl, `Could not open the editor here. Edit it in Patcher: ${link}`);
          }
        }
      }
      res.status(200).end();
      return;
    }

    if (payload.type === 'view_submission') {
      const view = asObject(payload.view);
      if (view?.callback_id !== EDIT_MODAL_CALLBACK) {
        res.status(200).end();
        return;
      }
      const ref = decodeRef(view.private_metadata);
      const values = asObject(asObject(view.state)?.values) ?? {};
      const field = (name: string) => asString(asObject(asObject(values[name])?.value)?.value) ?? '';
      const fieldError = (name: string, text: string) =>
        res.json({ response_action: 'errors', errors: { [name]: clip(text, 150) } });

      if (!ref) {
        fieldError(EDIT_FIELDS.title, 'This form is out of date. Close it and try again.');
        return;
      }
      let params: unknown;
      try {
        params = JSON.parse(field(EDIT_FIELDS.params));
      } catch {
        fieldError(EDIT_FIELDS.params, 'This is not valid JSON.');
        return;
      }
      const result = await editRecommendation(deps, {
        id: ref.id,
        hash: ref.hash,
        actor,
        via: 'slack',
        title: field(EDIT_FIELDS.title),
        body: field(EDIT_FIELDS.body),
        params,
      });
      if (!result.ok) {
        const where = result.message.startsWith('Body')
          ? EDIT_FIELDS.body
          : result.reason === 'invalid' && !result.message.startsWith('Title')
            ? EDIT_FIELDS.params
            : EDIT_FIELDS.title;
        fieldError(where, result.message);
        return;
      }
      res.status(200).end();
      return;
    }

    res.status(200).end();
  });

  // /ops ---------------------------------------------------------------------------------

  const USAGE = 'Usage: `/ops status`, `/ops pending`, `/ops pause`, `/ops resume`';

  router.post('/commands', async (_req, res) => {
    const form = new URLSearchParams(rawBody(res));
    const reply = (text: string) => res.json({ response_type: 'ephemeral', text });

    if (!isHub(form.get('team_id'))) {
      reply('This command works only in the PatchOps workspace.');
      return;
    }
    const person = await getUser(deps.pool, form.get('user_id') ?? '');
    if (!person) {
      reply('You do not have access to Patcher.');
      return;
    }
    const sub = (form.get('text') ?? '').trim().toLowerCase().split(/\s+/)[0] || 'status';

    switch (sub) {
        case 'status': {
          const [settings, pending, stats] = await Promise.all([
            getAllSettings(deps.pool),
            listRecommendations(deps.pool, ['posted'], 200),
            queueStats(deps.pool),
          ]);
          const dry = settings.dry_run || deps.dryRunEnv ? ' · dry run' : '';
          reply(
            `Patcher is ${settings.paused ? 'paused' : 'running'}${dry} · ${pending.length} pending · ${stats.depth} jobs queued\n<${deps.appBaseUrl}|Open Patcher>`,
          );
          return;
        }
        case 'pending': {
          const pending = await listRecommendations(deps.pool, ['posted'], 200);
          if (!pending.length) {
            reply('Nothing is waiting for a decision.');
            return;
          }
          const lines = pending
            .slice(0, 4)
            .map(
              (r, i) =>
                `${i + 1}. <${deps.appBaseUrl}/approvals/${r.id}|${escapeMrkdwn(deps.catalog.label(r.kind))} · ${escapeMrkdwn(clip(r.title, 80))}>`,
            );
          const more = pending.length > 4 ? `\n<${deps.appBaseUrl}/approvals|All ${pending.length} pending>` : '';
          reply(lines.join('\n') + more);
          return;
        }
        case 'pause': {
          if (!hasRole(person, 'approver')) {
            reply('Only an approver or owner can pause Patcher.');
            return;
          }
          const { changed } = await setPaused(deps, true, person.slackUserId);
          reply(changed ? 'Paused. Nothing is posted or run until `/ops resume`.' : 'Already paused.');
          return;
        }
        case 'resume': {
          if (!hasRole(person, 'owner')) {
            reply('Only an owner can resume Patcher.');
            return;
          }
          const { changed } = await setPaused(deps, false, person.slackUserId);
          reply(changed ? 'Resumed.' : 'Patcher is not paused.');
          return;
        }
      default:
        reply(USAGE);
    }
  });

  return router;
}
