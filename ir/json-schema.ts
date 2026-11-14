/**
 * ir/json-schema.ts —— JSON Schema 的最小 TS 表示。
 *
 * 设计依据：docs/design/40-provider-adaptors.md §4（tool parameters 的 JSON Schema 归一化）。
 * 这里只做"能装下任意 JSON Schema 子集"的类型；真正的校验由 ajv 在运行时完成
 * （见 scripts/check-json-schema.mjs 与各 adaptor 的 schema 层 round-trip 测试）。
 *
 * 之所以带索引签名 `[k: string]: unknown`：canonical 明确允许未建模字段经 raw 透传，
 * schema 节点同样可能带上游扩展关键字，收紧成封闭并集会逼出大量 `as` 断言。
 */

export type JSONSchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";

export interface JSONSchema {
  $id?: string;
  $schema?: string;
  $ref?: string;
  $defs?: Record<string, JSONSchema>;
  $comment?: string;

  type?: JSONSchemaType | JSONSchemaType[];
  properties?: Record<string, JSONSchema>;
  patternProperties?: Record<string, JSONSchema>;
  additionalProperties?: boolean | JSONSchema;
  items?: JSONSchema | JSONSchema[];
  prefixItems?: JSONSchema[];
  required?: string[];
  enum?: unknown[];
  const?: unknown;

  allOf?: JSONSchema[];
  anyOf?: JSONSchema[];
  oneOf?: JSONSchema[];
  not?: JSONSchema;
  if?: JSONSchema;
  then?: JSONSchema;
  else?: JSONSchema;

  format?: string;
  title?: string;
  description?: string;
  default?: unknown;
  examples?: unknown[];

  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;

  minLength?: number;
  maxLength?: number;
  pattern?: string;

  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;

  minProperties?: number;
  maxProperties?: number;

  /** 非标准扩展：部分上游用 nullable 表达可空，见 40 §4 的 nullable 策略三档。 */
  nullable?: boolean;

  [keyword: string]: unknown;
}
