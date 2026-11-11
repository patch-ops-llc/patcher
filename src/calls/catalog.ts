import { z } from 'zod';
import type { Pool } from '../db/pool.js';
import type { Catalog } from '../recommendations/catalog.js';

/**
 * What approving a call's suggestion can do (design 5.3). A code change uses the action
 * the audit already has, `cursor.launch_agent`: an agent on a repository linked in the
 * registry, which opens a pull request and never merges. The other two only write a row in
 * Patcher: a task on the project, or a drafted message for a person to send. A `note`
 * proposes nothing and is never a recommendation.
 */
export const CALL_KINDS = { change: 'call_change', task: 'call_task', followup: 'call_followup' } as const;
export const TASK_ACTION = 'calls.record_task';
export const FOLLOWUP_ACTION = 'calls.followup_draft';

const base = {
  callId: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string().trim().min(3, 'The title is too short.').max(150),
};

export const taskParams = z.object({ ...base, detail: z.string().trim().max(2000).default('') }).strict();
export type TaskParams = z.infer<typeof taskParams>;

export const followupParams = z
  .object({ ...base, draft: z.string().trim().min(10, 'The draft is too short to send.').max(3000) })
  .strict();
export type FollowupParams = z.infer<typeof followupParams>;

/** What the two actions need at run time. The public service registers them without one. */
export interface CallRuntime {
  pool: Pool;
}

async function record(
  runtime: CallRuntime,
  input: { kind: 'task' | 'followup'; projectId: string; callId: string; title: string; body: string; recommendationId: string },
): Promise<string> {
  const project = await runtime.pool.query<{ name: string }>(`SELECT name FROM projects WHERE id = $1`, [input.projectId]);
  if (!project.rows[0]) throw new Error('The project is no longer in the registry, so nothing was recorded.');
  // One row per approved recommendation, however often the action is delivered.
  await runtime.pool.query(
    `INSERT INTO project_tasks (project_id, kind, title, body, call_id, recommendation_id)
     VALUES ($1, $2, $3, $4, (SELECT id FROM calls WHERE id = $5), $6)
     ON CONFLICT (recommendation_id) DO NOTHING`,
    [input.projectId, input.kind, input.title, input.body, input.callId, input.recommendationId],
  );
  return project.rows[0].name;
}

export function registerCallCatalog(catalog: Catalog, runtime: CallRuntime | null): Catalog {
  return catalog
    .registerKind({ kind: CALL_KINDS.change, label: 'Call', defaultReportType: 'calls' })
    .registerKind({ kind: CALL_KINDS.task, label: 'Call', defaultReportType: 'calls' })
    .registerKind({ kind: CALL_KINDS.followup, label: 'Call', defaultReportType: 'calls' })
    .registerAction({
      type: TASK_ACTION,
      params: taskParams,
      describe: (p) => `Record a task on the project in Patcher: "${p.title}". Nothing is sent or changed anywhere else.`,
      async execute(params, ctx) {
        if (!runtime) throw new Error('This action runs in the worker only.');
        const project = await record(runtime, {
          kind: 'task',
          projectId: params.projectId,
          callId: params.callId,
          title: params.title,
          body: params.detail,
          recommendationId: ctx.recommendationId,
        });
        return { summary: `Task recorded on ${project}.` };
      },
    })
    .registerAction({
      type: FOLLOWUP_ACTION,
      params: followupParams,
      describe: (p) => `Keep this drafted message on the project for a person to send. Patcher sends nothing. Draft: ${p.draft}`,
      async execute(params, ctx) {
        if (!runtime) throw new Error('This action runs in the worker only.');
        await record(runtime, {
          kind: 'followup',
          projectId: params.projectId,
          callId: params.callId,
          title: params.title,
          body: params.draft,
          recommendationId: ctx.recommendationId,
        });
        return { summary: 'Draft ready for a person to send. Patcher sent nothing.', detail: params.draft };
      },
    });
}
