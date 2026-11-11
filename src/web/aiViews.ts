import type { CallTotals } from '../ai/run.js';
import type { SafeHtml } from './html.js';
import { html } from './html.js';

export const usd = (cost: number | null): string => (cost === null ? 'unknown' : `$${cost.toFixed(cost < 1 ? 4 : 2)}`);

/** Model calls grouped by task, model and prompt version. */
export function callsTable(calls: CallTotals[]): SafeHtml {
  return html`<table class="dense">
    <thead>
      <tr><th>Task</th><th>Model</th><th>Prompt</th><th>Calls</th><th>Failed</th><th>Input tokens</th><th>From cache</th><th>Output tokens</th><th>Cost</th></tr>
    </thead>
    <tbody>
      ${calls.map(
        (c) => html`<tr>
          <td><code>${c.task}</code></td>
          <td><code>${c.model}</code></td>
          <td>${c.promptVersion}</td>
          <td>${c.calls}${c.batched ? html` <span class="muted">(${c.batched} in a batch)</span>` : ''}</td>
          <td>${c.failed ? html`<span class="bad">${c.failed}</span>` : '0'}</td>
          <td>${c.inputTokens.toLocaleString('en-US')}</td>
          <td>${c.cachedTokens.toLocaleString('en-US')}</td>
          <td>${c.outputTokens.toLocaleString('en-US')}</td>
          <td>${usd(c.cost)}${c.unpriced ? html` <span class="muted">(${c.unpriced} without a known price)</span>` : ''}</td>
        </tr>`,
      )}
    </tbody>
  </table>`;
}
