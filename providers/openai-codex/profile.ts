/**
 * providers/openai-codex/profile.ts —— ChatGPT 订阅（Codex OAuth）ProviderProfile。
 *
 * `base_url` 为 `https://chatgpt.com/backend-api`，Responses 端点固定在 `/codex/responses`
 * （不同于标准 OpenAI 的 `/v1/responses`）。
 */

import type { ProviderProfile, ProviderRoutingOptionSpec } from '../../di/ports.js';

export const OPENAI_CODEX_ACCESS_PATH = 'openai-codex.openai-responses';
export const OPENAI_CODEX_ENDPOINT_PATH = '/codex/responses';

export const OPENAI_CODEX_ROUTING_OPTIONS: readonly ProviderRoutingOptionSpec[] = [
  {
    key: 'max_5h_requests',
    label: '5小时请求上限',
    unit: '次/5h',
    type: 'number',
    default_value: 80,
    telemetry_field: 'window_5h_requests',
    operator: 'lte',
  },
  {
    key: 'max_5h_tokens',
    label: '5小时Token上限',
    unit: 'Tokens/5h',
    type: 'number',
    telemetry_field: 'window_5h_tokens',
    operator: 'lte',
  },
  {
    key: 'min_upstream_remaining_requests',
    label: '上游剩余请求下限',
    unit: '次',
    type: 'number',
    telemetry_field: 'upstream_remaining_requests',
    operator: 'gte',
  },
];

export function createOpenAICodexProfile(): ProviderProfile {
  return {
    id: 'openai-codex',
    accessPaths: [OPENAI_CODEX_ACCESS_PATH],
    endpointPath(accessPath: string): string | undefined {
      if (
        accessPath === OPENAI_CODEX_ACCESS_PATH ||
        accessPath.startsWith('openai-codex-')
      ) {
        return OPENAI_CODEX_ENDPOINT_PATH;
      }
      return undefined;
    },
    routingNodeOptions(): readonly ProviderRoutingOptionSpec[] {
      return OPENAI_CODEX_ROUTING_OPTIONS;
    },
  };
}
