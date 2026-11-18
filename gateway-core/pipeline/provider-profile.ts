/**
 * gateway-core/pipeline/provider-profile.ts —— provider 特定知识在管道里的两个注入点。
 *
 * 本文件只放**按 access path 查 profile 的小 helper**，provider 专有知识本身在
 * providers/<provider>/profile.ts（经 di/ports.ts 的 ProviderProfileRegistry 注入）。
 * gateway-core 因此不硬编码任何 provider 的名字/字段/路径。
 *
 * 两个注入点：
 *   1. `endpointPathFor`：S4 解析上游端点路径（DeepSeek 的 /chat/completions 与
 *      /anthropic/v1/messages 都与 OpenAI/Anthropic 本家不同）；
 *   2. `applyProviderUsageProfile`：S10 计量边界做 usage 归一。
 *
 * 为什么 usage 归一一放在 S10：口径（40 §2）的单一来源在 codec，但**provider 专有
 * 字段名**的归一属于 metering 模块的「usage 归一」职责（00 §4.2 模块表），且必须对
 * **所有路径**生效：非流式快路径（extractUsage）、非流式慢路径（decodeResponse）、
 * 流式慢路径（decodeStream 的 usage 帧）、流式快路径（嗅探器）。四处的原始 usage 都
 * 逐字段保留在 `CanonicalUsage.raw` 里（40 §2.2c I4：raw 独立于 units，永不被聚合
 * 破坏），因此在一个 choke point 上按 raw 重算 units 即可覆盖全部路径，不必改四个
 * 调用点。codec 侧同样不塞 provider 专名：codec 按 (FormatId, ModalityKind) 注册、
 * 一个实例服务多个 access path，dialect 与 provider 两级知识必须分开。
 *
 * 为什么端点路径在 S4 而不在 S5：路径是「编码产物」的一部分（EncodedRequest.path），
 * 与 base URL（凭据解析器）分属两侧；S4 同时服务快路径分支（那里不调 codec，但路径
 * 仍必须按 provider 解析）与慢路径分支（codec 自己问 profile）。
 */

import type { CanonicalUsage } from '../../ir/index.js';
import type { ProviderProfileRegistry } from '../../di/ports.js';

/**
 * 按 access path 查 provider profile 的端点路径覆盖。
 *
 * 返回 undefined = 没有 profile 或 profile 不覆盖该 path（调用方用 dialect 默认值）。
 */
export function endpointPathFor(
  profiles: ProviderProfileRegistry | undefined,
  accessPath: string | undefined,
): string | undefined {
  if (profiles === undefined || accessPath === undefined) return undefined;
  return profiles.forAccessPath(accessPath)?.endpointPath?.(accessPath);
}

/**
 * 按 access path 查 provider profile，把厂商专有 usage 字段归一成 canonical。
 *
 * 归一是**补洞**而不是**覆盖**：dialect codec 已从标准字段算出的值保持有效，profile
 * 只补它认不出的专有字段（典型：DeepSeek 的 usage 顶层 prompt_cache_hit_tokens /
 * prompt_cache_miss_tokens，OpenAI 系把缓存数埋在 prompt_tokens_details.cached_tokens
 * 里）。上游没给 usage 时键省略 + warning 的既有规则（10 §6.1 规则 2）不受影响——
 * 本函数只在 `units.tokens` 已存在时工作。
 *
 * 返回原对象（未修改）当：没有 profile / profile 不给 usageFromRaw / usage 缺失 /
 * raw 缺失 / profile 认不出任何一个字段。绝不把未知记成 0（10 §6.1 规则 2）。
 */
export function applyProviderUsageProfile(
  usage: CanonicalUsage | undefined,
  accessPath: string | undefined,
  profiles: ProviderProfileRegistry | undefined,
): CanonicalUsage | undefined {
  if (usage === undefined || profiles === undefined || accessPath === undefined) return usage;
  const tokens = usage.units.tokens;
  const raw = usage.raw;
  if (tokens === undefined || raw === undefined) return usage;

  const profile = profiles.forAccessPath(accessPath);
  if (profile?.usageFromRaw === undefined) return usage;

  const normalized = profile.usageFromRaw(raw);
  if (normalized === undefined) return usage;

  return { ...usage, units: { ...usage.units, tokens: normalized } };
}
