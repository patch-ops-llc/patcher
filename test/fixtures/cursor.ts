import type { AgentRun, CursorClient, StartAgentInput, StartedAgent } from '../../src/cursor/client.js';

/** Stands in for Cursor's Cloud Agents API: remembers what was started and answers polls. */
export class FakeCursor implements CursorClient {
  started: StartAgentInput[] = [];
  run: AgentRun = { status: 'RUNNING', result: null, branches: [] };
  failStart: Error | undefined;
  failPoll: Error | undefined;
  polls = 0;

  startAgent(input: StartAgentInput): Promise<StartedAgent> {
    if (this.failStart) return Promise.reject(this.failStart);
    // Like the real API, a repeated agent id does not start a second agent.
    if (!this.started.some((s) => s.agentId === input.agentId)) this.started.push(input);
    return Promise.resolve({ agentId: input.agentId, runId: 'run-1', url: `https://cursor.com/agents/${input.agentId}` });
  }

  getRun(): Promise<AgentRun> {
    this.polls += 1;
    return this.failPoll ? Promise.reject(this.failPoll) : Promise.resolve(this.run);
  }
}
