/**
 * Every request Patcher can make to Railway in this phase. The client sends nothing that is
 * not in this list, and everything here is a read: there is no mutation, and no field that
 * returns a variable's value (`variables`, `variablesForServiceDeployment` and
 * `Environment.config` are never used). Variable names come from `Environment.variables`,
 * whose `Variable` type has a name and no value.
 *
 * Fields were confirmed against Railway's schema by introspection on 2026-11-10.
 */
/**
 * Error-level lines, without what Postgres writes to stderr at its ordinary levels. Railway
 * labels those as errors too, and one busy database would otherwise fill the whole request.
 */
const ERROR_LOG_FILTER = '@level:error -"] LOG:" -"] STATEMENT:" -"] DETAIL:" -"] HINT:" -"] CONTEXT:"';

export const READ_QUERIES = {
  projects: `query projects($after: String) {
    projects(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id name workspaceId deletedAt
        environments(first: 50) { edges { node { id name isEphemeral } } }
        services(first: 100) { edges { node { id name } } }
      } }
    }
  }`,

  environment: `query environment($id: String!) {
    environment(id: $id) {
      id name projectId
      serviceInstances(first: 100) { edges { node {
        id serviceId serviceName createdAt
        healthcheckPath cronSchedule nextCronRunAt sleepApplication numReplicas
        restartPolicyType rootDirectory railwayConfigFile
        source { repo image }
        resolvedFileConfig { configFile }
        domains {
          serviceDomains { domain }
          customDomains { domain status { certificateStatus certificates { expiresAt } } }
        }
        latestDeployment { id status createdAt statusUpdatedAt deploymentStopped meta instances { status } }
        activeDeployments { id status createdAt }
      } } }
      volumeInstances(first: 100) { edges { node {
        id serviceId mountPath sizeMB currentSizeMB state volume { name }
      } } }
      variables(first: 500) { pageInfo { hasNextPage } edges { node { name serviceId } } }
    }
  }`,

  deployments: `query deployments($projectId: String!, $environmentId: String!) {
    deployments(first: 100, input: { projectId: $projectId, environmentId: $environmentId }) {
      pageInfo { hasNextPage }
      edges { node { id serviceId status createdAt } }
    }
  }`,

  deploymentEvents: `query deploymentEvents($id: String!) {
    deploymentEvents(id: $id, first: 50) {
      edges { node { step completedAt payload { error reason } } }
    }
  }`,

  cronExecutions: `query cronExecutions($environmentId: String!, $serviceId: String!) {
    deploymentInstanceExecutions(first: 20, input: { environmentId: $environmentId, serviceId: $serviceId }) {
      edges { node { status createdAt completedAt } }
    }
  }`,

  projectEvents: `query projectEvents($projectId: String!, $actions: [String!]) {
    events(projectId: $projectId, first: 100, filter: { action: { in: $actions } }) {
      pageInfo { hasNextPage }
      edges { node { object action severity createdAt environmentId payload } }
    }
  }`,

  metrics: `query metrics($environmentId: String!, $startDate: DateTime!, $endDate: DateTime!) {
    metrics(
      environmentId: $environmentId, startDate: $startDate, endDate: $endDate,
      sampleRateSeconds: 3600, groupBy: [SERVICE_ID],
      measurements: [CPU_USAGE, CPU_LIMIT, MEMORY_USAGE_GB, MEMORY_LIMIT_GB, NETWORK_TX_GB]
    ) { measurement tags { serviceId } values { ts value } }
  }`,

  errorLogs: `query errorLogs($environmentId: String!, $anchorDate: String!, $limit: Int!) {
    environmentLogs(environmentId: $environmentId, filter: ${JSON.stringify(ERROR_LOG_FILTER)}, anchorDate: $anchorDate, beforeLimit: $limit) {
      timestamp severity message tags { serviceId }
    }
  }`,

  httpByStatus: `query httpByStatus($environmentId: String!, $serviceId: String!, $startDate: DateTime!, $endDate: DateTime!) {
    httpMetricsGroupedByStatus(
      environmentId: $environmentId, serviceId: $serviceId, startDate: $startDate, endDate: $endDate, stepSeconds: 86400
    ) { statusCode samples { ts value } }
  }`,

  httpDuration: `query httpDuration($environmentId: String!, $serviceId: String!, $startDate: DateTime!, $endDate: DateTime!) {
    httpDurationMetrics(
      environmentId: $environmentId, serviceId: $serviceId, startDate: $startDate, endDate: $endDate, stepSeconds: 86400
    ) { samples { ts p50 p95 } }
  }`,

  tcpProxies: `query tcpProxies($environmentId: String!, $serviceId: String!) {
    tcpProxies(environmentId: $environmentId, serviceId: $serviceId) { domain proxyPort applicationPort }
  }`,

  usage: `query usage($workspaceId: String!, $startDate: DateTime!, $endDate: DateTime!) {
    usage(
      workspaceId: $workspaceId, startDate: $startDate, endDate: $endDate,
      groupBy: [PROJECT_ID], measurements: [CPU_USAGE, MEMORY_USAGE_GB, NETWORK_TX_GB, DISK_USAGE_GB]
    ) { measurement value tags { projectId } }
  }`,
} as const;

export type ReadQueryName = keyof typeof READ_QUERIES;

/** Fields and operations that must never appear in a request, checked when the module loads. */
const FORBIDDEN = [
  /\bmutation\b/i,
  /\bsubscription\b/i,
  /\bvariables\s*\(\s*(?:projectId|environmentId)/,
  /\bvariablesForServiceDeployment\b/,
  /\bdecryptVariables\b/,
  /\bconfig\s*[({]/,
  /\bvalue\b/,
];

export function assertReadOnly(name: string, text: string): void {
  if (!/^\s*query\b/.test(text)) throw new Error(`Railway request ${name} is not a query`);
  // `value` is a number in two places, a metric sample and a usage total; anywhere else it
  // could be a variable's value, so it is refused.
  const withoutNumbers = text.replace(/\{\s*ts\s+value\s*\}/g, '{}').replace(/measurement\s+value\b/g, 'measurement');
  for (const pattern of FORBIDDEN) {
    if (pattern.test(withoutNumbers)) throw new Error(`Railway request ${name} is not allowed: ${pattern.source}`);
  }
}

for (const [name, text] of Object.entries(READ_QUERIES)) assertReadOnly(name, text);
