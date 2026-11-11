import { z } from 'zod';
import type { Pool } from '../db/pool.js';
import type { Catalog } from '../recommendations/catalog.js';

/**
 * What approving a Slack item can do (design 8.6). `Task` writes a row in Patcher: a task
 * on the matched project, or a task without a project when none was matched. `Agent` uses
 * the action the audit already has, `cursor.launch_agent`: an agent on a repository linked
 * in the registry, which opens a pull request and never merges. Neither posts in Slack.
 * "Send reply" is phase 5 and is not here: this phase holds no scope that could post as
 * the reader.
 */
export const INBOX_KINDS = { task: 'slack_task', change: 'slack_change' } as const;
export const INBOX_TASK_ACTION = 'inbox.record_task';

export const inboxTaskParams = z
  .object({
    bundleId: z.string().uuid(),
    projectId: z.string().uuid().nullable().default(null),
    title: z.string().trim().min(3, 'The title is too short.').max(150),
    detail: z.string().trim().max(2000).default(''),
  })
  .strict();
export type InboxTaskParams = z.infer<typeof inboxTaskParams>;

export interface InboxRuntime {
  pool: Pool;
}

export function registerInboxCatalog(catalog: Catalog, runtime: InboxRuntime | null): Catalog {
  return catalog
    .registerKind({ kind: INBOX_KINDS.task, label: 'Slack', defaultReportType: 'inbox' })
    .registerKind({ kind: INBOX_KINDS.change, label: 'Slack', defaultReportType: 'inbox' })
    .registerAction({
      type: INBOX_TASK_ACTION,
      params: inboxTaskParams,
      describe: (p) => `Record a task in Patcher: "${p.title}". Nothing is sent or changed in Slack or anywhere else.`,
      async execute(params, ctx) {
        if (!runtime) throw new Error('This action runs in the worker only.');
        let projectName: string | null = null;
        if (params.projectId) {
          const project = await runtime.pool.query<{ name: string }>('SELECT name FROM projects WHERE id = $1', [params.projectId]);
          if (!project.rows[0]) throw new Error('The project is no longer in the registry, so nothing was recorded.');
          projectName = project.rows[0].name;
        }
        // One row per approved recommendation, however often the action is delivered.
        await runtime.pool.query(
          `INSERT INTO project_tasks (project_id, kind, title, body, bundle_id, recommendation_id)
           VALUES ($1, 'task', $2, $3, (SELECT id FROM slack_bundles WHERE id = $4), $5)
           ON CONFLICT (recommendation_id) DO NOTHING`,
          [params.projectId, params.title, params.detail, params.bundleId, ctx.recommendationId],
        );
        return { summary: projectName ? `Task recorded on ${projectName}.` : 'Task recorded, without a project.' };
      },
    });
}
