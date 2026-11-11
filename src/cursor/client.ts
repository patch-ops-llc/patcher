/**
 * Client for Cursor's Cloud Agents API (v1, public beta), built from the published reference:
 * https://cursor.com/docs/cloud-agent/api/endpoints. Only what "Fix via agent" needs: start
 * an agent on one repository, and read a run until it ends. v1 has no webhooks, so the
 * worker polls.
 */
export const CURSOR_API_URL = 'https://api.cursor.com';

export class CursorApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

/**
 * Documented today: CREATING, RUNNING, WAITING_FOR_BACKGROUND_WORK, FINISHED, ERROR, CANCELLED
 * and EXPIRED. Kept as a string so a status Cursor adds later reads as "still running".
 */
export type RunStatus = string;

export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED']);

export interface StartedAgent {
  agentId: string;
  runId: string;
  url: string;
}

export interface AgentRun {
  status: RunStatus;
  /** The agent's final reply, once the run has ended. */
  result: string | null;
  branches: { repoUrl: string; branch: string | null; prUrl: string | null }[];
}

export interface StartAgentInput {
  /** `bc-<uuid>`, chosen by the caller so a repeated request cannot start a second agent. */
  agentId: string;
  name: string;
  prompt: string;
  /** `owner/name` on GitHub. */
  repo: string;
  startingRef?: string | undefined;
}

export interface CursorClient {
  startAgent(input: StartAgentInput): Promise<StartedAgent>;
  getRun(agentId: string, runId: string): Promise<AgentRun>;
}

export interface CursorClientOptions {
  apiKey: string;
  /** A model id from `GET /v1/models`. Omitted: Cursor uses the account's default. */
  model?: string | undefined;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface AgentBody {
  id?: string;
  url?: string;
  latestRunId?: string;
}

export function createCursorClient(options: CursorClientOptions): CursorClient {
  const doFetch = options.fetch ?? fetch;
  const baseUrl = (options.baseUrl ?? CURSOR_API_URL).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 30_000;

  const request = async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new CursorApiError(`Cursor did not answer (${err instanceof Error ? err.name : 'error'})`, 0, undefined);
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    if (!response.ok) {
      const error = (parsed as { error?: { code?: unknown; message?: unknown } | string; message?: unknown }).error;
      const code = typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined;
      const message =
        typeof error === 'object' && typeof error.message === 'string'
          ? error.message
          : typeof (parsed as { message?: unknown }).message === 'string'
            ? ((parsed as { message: string }).message)
            : typeof error === 'string'
              ? error
              : 'request failed';
      throw new CursorApiError(`Cursor: ${message.slice(0, 200)} (HTTP ${response.status}${code ? `, ${code}` : ''})`, response.status, code);
    }
    return parsed as T;
  };

  const started = (agent: AgentBody | undefined, runId: string | undefined): StartedAgent => {
    if (!agent?.id || !runId) throw new CursorApiError('Cursor: the response had no agent or run id', 200, undefined);
    return { agentId: agent.id, runId, url: agent.url ?? `https://cursor.com/agents/${agent.id}` };
  };

  return {
    async startAgent(input) {
      try {
        const created = await request<{ agent?: AgentBody; run?: { id?: string } }>('POST', '/v1/agents', {
          agentId: input.agentId,
          name: input.name.slice(0, 100),
          prompt: { text: input.prompt },
          repos: [{ url: `https://github.com/${input.repo}`, ...(input.startingRef ? { startingRef: input.startingRef } : {}) }],
          // The agent works on its own branch and opens a pull request. Nothing merges it.
          workOnCurrentBranch: false,
          autoCreatePR: true,
          ...(options.model ? { model: { id: options.model } } : {}),
        });
        return started(created.agent, created.run?.id ?? created.agent?.latestRunId);
      } catch (err) {
        // The same id was sent before, so the agent exists: this is that agent, not a failure.
        if (err instanceof CursorApiError && err.status === 409 && err.code === 'agent_id_conflict') {
          const agent = await request<AgentBody>('GET', `/v1/agents/${encodeURIComponent(input.agentId)}`);
          return started(agent, agent.latestRunId);
        }
        throw err;
      }
    },

    async getRun(agentId, runId) {
      const run = await request<{
        status?: string;
        result?: string;
        git?: { branches?: { repoUrl?: string; branch?: string; prUrl?: string }[] };
      }>('GET', `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`);
      return {
        status: run.status ?? 'RUNNING',
        result: run.result ?? null,
        branches: (run.git?.branches ?? []).map((b) => ({
          repoUrl: b.repoUrl ?? '',
          branch: b.branch ?? null,
          prUrl: b.prUrl ?? null,
        })),
      };
    },
  };
}
