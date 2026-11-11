import { readFileSync } from 'node:fs';
import path from 'node:path';
import { rootDir } from '../paths.js';

/**
 * Prompts are versioned files, one folder per task (design section 10.2). The version in use
 * is named here, so changing a prompt is a new file plus one line, and every recorded call
 * says which version it ran with.
 */
export const PROMPTS = {
  'audit-service': 'v1',
  'audit-rollup': 'v1',
  'fix-brief': 'v1',
  'call-match': 'v1',
  'call-suggestions': 'v1',
  'call-brief': 'v1',
  'sales-classify': 'v1',
  'deal-brief': 'v1',
  'proposal-draft': 'v1',
  'proposal-check': 'v1',
} as const;

export type PromptTask = keyof typeof PROMPTS;
export const promptTasks = Object.keys(PROMPTS) as PromptTask[];

export interface Prompt {
  task: PromptTask;
  version: string;
  /** The system prompt: role, rules and what to return. */
  system: string;
}

const loaded = new Map<PromptTask, Prompt>();

export function loadPrompt(task: PromptTask): Prompt {
  let prompt = loaded.get(task);
  if (!prompt) {
    const version = PROMPTS[task];
    const system = readFileSync(path.join(rootDir, 'prompts', task, `${version}.md`), 'utf8').trim();
    if (!system) throw new Error(`The prompt ${task}/${version} is empty`);
    prompt = { task, version, system };
    loaded.set(task, prompt);
  }
  return prompt;
}

/** Fails at boot, not at the first audit, when a prompt file is missing from the deploy. */
export function loadAllPrompts(): Prompt[] {
  return promptTasks.map(loadPrompt);
}

/**
 * Wraps text that came from outside (logs, deploy errors, names) in a block the prompt
 * declares to be data. Anything in the text that would close the block early is defused,
 * so the data cannot step out of it.
 */
export function dataBlock(tag: string, text: string): string {
  const safe = text.replace(new RegExp(`<(/?)(${tag})`, 'gi'), '<$1 $2');
  return `<${tag}>\n${safe.trim()}\n</${tag}>`;
}
