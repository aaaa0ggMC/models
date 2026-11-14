/**
 * ir/diagnostic.ts —— 转换诊断与损耗策略。
 *
 * 唯一事实来源：docs/design/10-canonical-schema.md §2（ConversionDiagnostic）、
 * docs/design/20-pipeline.md §S4（loss_policy 三档 + emulate 特殊档）、
 * docs/design/00-overview.md §5（术语表：loss policy / degraded / conversion diagnostic）。
 *
 * 硬约束：诊断是一等公民，**不允许只打日志不上报**——静默丢参数比失败更危险。
 */

import type { FormatId } from "./format.js";

/** 单条转换诊断。把"丢了什么"变成一等公民。 */
export interface ConversionDiagnostic {
  /** 稳定诊断码，如 "temperature_unsupported"。 */
  code: string;
  /** canonical 侧出错字段路径，如 "params.temperature"。 */
  field_path?: string;
  from: FormatId;
  to: FormatId;
  /** info = 已处理；warning = 有损但可继续；error = 该特性完全未生效。 */
  level: "info" | "warning" | "error";
  message: string;
}

/**
 * 遇不支持字段时的策略：
 *   allow  —— 转换完成 + 记 warning 级诊断（默认）
 *   safe   —— 丢弃 warning 级，遇 error 级诊断立即失败
 *   strict —— 任何诊断都失败
 *   emulate—— 由网关自身补齐（仅内置搜索等少数能力，50-builtin-search.md）
 */
export type LossPolicy = "allow" | "safe" | "strict" | "emulate";

export const DEFAULT_LOSS_POLICY: LossPolicy = "allow";

/** 诊断收集器：adaptor 在编码过程中往里塞诊断，Runner 统一收进响应信封与 RequestTrace。 */
export class DiagnosticCollector {
  private readonly items: ConversionDiagnostic[] = [];

  add(diagnostic: ConversionDiagnostic): void {
    this.items.push(diagnostic);
  }

  info(
    code: string,
    from: FormatId,
    to: FormatId,
    message: string,
    field_path?: string,
  ): void {
    this.add({ code, from, to, level: "info", message, ...(field_path === undefined ? {} : { field_path }) });
  }

  warning(
    code: string,
    from: FormatId,
    to: FormatId,
    message: string,
    field_path?: string,
  ): void {
    this.add({ code, from, to, level: "warning", message, ...(field_path === undefined ? {} : { field_path }) });
  }

  error(code: string, from: FormatId, to: FormatId, message: string, field_path?: string): void {
    this.add({ code, from, to, level: "error", message, ...(field_path === undefined ? {} : { field_path }) });
  }

  /** 是否含 error 级诊断（`safe` 档据此立即失败）。 */
  hasError(): boolean {
    return this.items.some((d) => d.level === "error");
  }

  get all(): readonly ConversionDiagnostic[] {
    return this.items;
  }

  /** 字符串摘要，进 warnings。 */
  summary(): string[] {
    return this.items.map(
      (d) => `${d.code}${d.field_path === undefined ? "" : `@${d.field_path}`}(${d.level}): ${d.message}`,
    );
  }

  /**
   * 按 loss_policy 判定本次编码是否应当失败。
   * 返回 null 表示放行；返回诊断数组表示应据此报 capability_unsupported。
   */
  evaluate(policy: LossPolicy): ConversionDiagnostic[] | null {
    if (policy === "strict" && this.items.length > 0) return [...this.items];
    if (policy === "safe" && this.hasError()) return this.items.filter((d) => d.level === "error");
    return null;
  }
}
