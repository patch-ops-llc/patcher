import { z } from 'zod';
import type { Logger } from '../log.js';
import type { ReportType } from '../settings/routes.js';

/**
 * The fixed action catalog of design principle 1: the only things approval can trigger.
 * A model never calls anything; code maps its output onto one of these entries, and the
 * entry runs only after an approver's decision.
 */
export interface ActionContext {
  /** Stable per approved recommendation version; pass it to third parties that accept one. */
  idempotencyKey: string;
  log: Logger;
}

export interface ActionResult {
  /** An id or link in the system acted on, shown with the outcome. */
  externalRef?: string;
  /** One short line for the thread reply. */
  summary?: string;
}

export interface ActionDefinition<P = unknown> {
  type: string;
  params: z.ZodType<P>;
  /** One line describing exactly what approval will do, shown under Details. */
  describe(params: P): string;
  execute(params: P, ctx: ActionContext): Promise<ActionResult>;
}

export interface KindDefinition {
  kind: string;
  /** Leading word of the Slack message, for example "Call" or "Audit". */
  label: string;
  /** Which channel route the kind uses unless the caller names another. */
  defaultReportType: ReportType;
}

export interface ProposedAction {
  type: string;
  params: unknown;
}

export class CatalogError extends Error {}

export class Catalog {
  private readonly actions = new Map<string, ActionDefinition>();
  private readonly kinds = new Map<string, KindDefinition>();

  registerAction<P>(definition: ActionDefinition<P>): this {
    if (this.actions.has(definition.type)) throw new CatalogError(`Action already registered: ${definition.type}`);
    this.actions.set(definition.type, definition);
    return this;
  }

  registerKind(definition: KindDefinition): this {
    if (this.kinds.has(definition.kind)) throw new CatalogError(`Kind already registered: ${definition.kind}`);
    this.kinds.set(definition.kind, definition);
    return this;
  }

  action(type: string): ActionDefinition {
    const found = this.actions.get(type);
    if (!found) throw new CatalogError(`Action is not in the catalog: ${type}`);
    return found;
  }

  kind(kind: string): KindDefinition {
    const found = this.kinds.get(kind);
    if (!found) throw new CatalogError(`Recommendation kind is not registered: ${kind}`);
    return found;
  }

  /** Label for display; falls back to the raw kind so an old row never breaks a page. */
  label(kind: string): string {
    return this.kinds.get(kind)?.label ?? kind;
  }

  kindNames(): string[] {
    return [...this.kinds.keys()];
  }

  /** Validates a proposed action against its catalog entry and returns the normalized form. */
  validate(action: ProposedAction): ProposedAction {
    const definition = this.action(action.type);
    const parsed = definition.params.safeParse(action.params);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
      throw new CatalogError(`Action parameters are not valid. ${where}${issue?.message ?? ''}`.trim());
    }
    return { type: action.type, params: parsed.data };
  }

  describe(action: ProposedAction): string {
    const definition = this.actions.get(action.type);
    if (!definition) return action.type;
    const parsed = definition.params.safeParse(action.params);
    return parsed.success ? definition.describe(parsed.data) : action.type;
  }
}

/**
 * What the foundation ships. `acknowledge` is the design's "note" outcome: approving records
 * the decision and does nothing else. `test` is the recommendation sent from the Settings
 * screen to check a channel route and the approval loop.
 */
export function createCatalog(): Catalog {
  return new Catalog()
    .registerAction({
      type: 'acknowledge',
      params: z.object({ note: z.string().max(500).default('') }).strict(),
      describe: (p) => (p.note ? `Record the approval only. Note: ${p.note}` : 'Record the approval only.'),
      execute: () => Promise.resolve({ summary: 'Recorded. Nothing else to do.' }),
    })
    .registerKind({ kind: 'test', label: 'Test', defaultReportType: 'errors' });
}
