/**
 * gateway-core/builtin-tool-defaults.ts —— provider 级默认 builtin tool 注入的**纯函数**。
 *
 * 单独一个文件（而不是塞进 s3-on-request.ts）的理由：这是"要不要注入、注入哪些"的
 * 全部决策，而它必须是可单测的纯函数——S3 那一层要 mock 一堆 deps 才能跑到这里，
 * 而这个函数的每个分支（没开 / 开了但客户端已声明 / 开了且没声明 / tools 缺失）
 * 都对应一条会静默出错的路径。
 *
 * 与 50-builtin-search.md 的关系：注入的**形状**完全按该文档 §2.2 的 canonical
 * `BuiltinTool`（稳定名 + config），方言映射仍由 codec 在 S4 做（模式 A 的语义透传）。
 * 本文件不碰任何厂商字段名——那是"绕过 canonical"的第一步，也是仓库明令禁止的。
 */

import type {
  BuiltinTool,
  CanonicalRequestEnvelope,
  ChatPayload,
  CanonicalTool,
} from '../ir/index.js';

/** 可默认注入的 canonical builtin tool 稳定名（与 admin 的 ProviderBuiltinToolDefaults 对齐）。 */
export type DefaultableBuiltinTool = Extract<BuiltinTool['name'], 'web_search' | 'url_context'>;

/**
 * 往 canonical 请求里补默认 builtin tool。
 *
 * 三条语义（每条都有测试）：
 *   1. **不重复**：客户端已在 `payload.tools` 里声明了同名 builtin tool 就跳过——
 *      注入是补默认值，不是覆盖客户端显式声明（覆盖会让"我关了搜索"变成"照样搜"）；
 *   2. **不猜 config**：`config` 恒为 `{}`。DeepSeek 的全家桶工具是裸能力开关，
 *      官方文档明确 allowed_domains / user_location 一律 400，塞任何配置都会让
 *      上游 400（见 providers/deepseek/profile.ts 的 builtinToolAcceptsConfig）；
 *   3. **不动别的工具**：只在末尾追加，客户端声明的 function tool 顺序与内容不变。
 *
 * 返回**本次实际注入的名字**（空数组 = 什么都没做，调用方据此决定要不要关 fast path）。
 */
export function injectDefaultBuiltinTools(
  req: CanonicalRequestEnvelope,
  wanted: readonly DefaultableBuiltinTool[],
): DefaultableBuiltinTool[] {
  // 只对 chat 模态注入：其余模态的 payload 没有 tools 槽（15-modalities 的各模态
  // 都不建模 builtin tool），硬塞进去只会变成一个没人读的字段。
  if (req.kind !== 'chat') return [];
  const payload = req.payload as ChatPayload;
  const declared = new Set((payload.tools ?? []).filter(isBuiltinTool).map((t) => t.name));
  const injected: DefaultableBuiltinTool[] = [];
  for (const name of wanted) {
    if (declared.has(name)) continue;
    const tool: BuiltinTool = {
      type: 'builtin',
      name,
      config: {},
      // 由上游执行（DeepSeek 原生支持）。executor 缺省 = "网关自己执行"，
      // 这里必须显式写 provider，否则会被当成网关自实现的搜索后端。
      executor: 'provider',
    };
    payload.tools = [...(payload.tools ?? []), tool];
    declared.add(name);
    injected.push(name);
  }
  return injected;
}

function isBuiltinTool(tool: CanonicalTool): tool is BuiltinTool {
  return tool.type === 'builtin';
}
