import { createHash } from 'node:crypto';
import type { Evidence } from '../recommendations/types.js';

export const SEVERITIES = ['critical', 'warning', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** The categories of design section 7.2, in the order they rank when severity is equal. */
export const CATEGORIES = {
  outage: 'Outages',
  security: 'Security',
  bugs: 'Bugs',
  capacity: 'Capacity',
  deploy: 'Deploy hygiene',
  cost: 'Cost',
  custom: 'Project-specific',
} as const;
export type Category = keyof typeof CATEGORIES;
export const categories = Object.keys(CATEGORIES) as Category[];

export type ActionType = 'fix_via_agent' | 'investigate' | 'none';

export interface FindingScope {
  projectId: string;
  projectName: string;
  environmentId?: string | undefined;
  environmentName?: string | undefined;
  serviceId?: string | undefined;
  serviceName?: string | undefined;
}

/** What a check produces, before it is matched against earlier weeks. */
export interface FindingDraft {
  fingerprint: string;
  scope: FindingScope;
  category: Category;
  check: string;
  severity: Severity;
  /** A phrase that reads after the subject: "crashed 6 times in the last 7 days". */
  title: string;
  cause: string;
  recommendation: string;
  actionType: ActionType;
  evidence: Evidence[];
  /** The number the finding is about, compared with last week's to mark it growing. */
  metric?: number | undefined;
  /** Where a fix would go, when the service deploys from a repository. */
  repo?: string | null | undefined;
  branch?: string | null | undefined;
}

/**
 * What the model drafted for a finding in one run (design 7.3, step 1). It words and
 * classifies; the severity, the evidence and the fingerprint stay the rule's. It counts only
 * for the run it was written in: a later run that re-evaluates the finding starts from the
 * rule's wording again.
 */
export interface Assessment {
  runId: string;
  /** Reads after the subject, like a rule's title. */
  headline: string;
  cause: string;
  recommendation: string;
  action: ActionType;
  /** The evidence line of the finding that the assessment rests on. */
  quote: string;
  model: string;
  promptVersion: string;
}

/** A finding's wording and recommended action as the rule wrote them. */
export interface RuleWording {
  title: string;
  cause: string;
  recommendation: string;
  actionType: ActionType;
}

/**
 * The stable identity of a finding: where it is, which category, and a signature the check
 * chooses that does not change from week to week (never a count or a date).
 */
export function fingerprint(scope: FindingScope, category: Category, signature: string): string {
  const where = scope.serviceId ? `${scope.environmentId ?? ''}:${scope.serviceId}` : `project:${scope.projectId}`;
  return createHash('sha256').update(`${where}|${category}|${signature}`).digest('hex');
}

/** "acme api", "acme api (staging)" or, for a project-wide finding, "acme". */
export function subject(scope: FindingScope): string {
  const service = scope.serviceName && scope.serviceName.toLowerCase() !== scope.projectName.toLowerCase() ? ` ${scope.serviceName}` : '';
  const environment =
    scope.environmentName && scope.environmentName.toLowerCase() !== 'production' ? ` (${scope.environmentName})` : '';
  return `${scope.projectName}${service}${environment}`;
}

export type CheckStatus = 'checked' | 'not_applicable' | { notChecked: string };

/** How many services each check covered, and why it could not cover the rest. */
export interface CheckCoverage {
  key: string;
  category: Category;
  label: string;
  checked: number;
  notApplicable: number;
  notChecked: number;
  reasons: Record<string, number>;
}
