/**
 * tests/ir-schema.test.ts —— JSON Schema 校验 + TS ↔ schema 字段级 parity（防漂移）。
 *
 * 两层测试目标（40 §1.5）：
 *   - schema 层：**任何厂商特性进入 canonical 再出来必须无损**——即使没有 adaptor 实现它，
 *     也要有 schema 层的 round-trip 用例兜底。这是 canonical 超集性质的回归网。
 *   - 防漂移：docs/design/10-canonical-schema.md §8 要求「JSON Schema 与本文 TS 类型一对一，
 *     由代码生成（不让手写两份导致漂移）」。本轮尚未接 ts-json-schema-generator，因此用
 *     TypeScript compiler API 读 ir/*.ts 里每个 interface 的属性名，与对应 schema 的
 *     properties 键做**字段级 parity 断言**——任何一边加/删字段而另一边没跟上，测试即红。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const schemaDir = join(root, "ir", "schema", "ag-ir-1");
const fixturesDir = join(root, "ir", "fixtures");

function readJson(p: string): unknown {
  return JSON.parse(readFileSync(p, "utf8"));
}

function listFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, ext));
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

/** 编译全部 schema（互相 $ref，必须先全部 addSchema）。 */
function compileRoot(): (data: unknown) => boolean {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  const rootId = "https://agentgateway.local/schema/ag-ir-1/root.schema.json";
  let rootSchema: Record<string, unknown> | undefined;
  for (const f of listFiles(schemaDir, ".json")) {
    const raw = readJson(f) as Record<string, unknown>;
    if (raw["$id"] === rootId) rootSchema = raw;
    else ajv.addSchema(raw, raw["$id"] as string);
  }
  if (rootSchema === undefined) throw new Error("缺少 root.schema.json");
  return ajv.compile(rootSchema);
}

describe("ir/schema：ajv 校验 canonical 夹具", () => {
  const validate = compileRoot();

  it.each(listFiles(fixturesDir, ".json"))("%s 通过 schema 校验", (file) => {
    const data = readJson(file);
    const ok = validate(data);
    if (!ok) {
      const msgs = (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join("\n");
      throw new Error(`夹具未通过 schema 校验:\n${msgs}`);
    }
    expect(ok).toBe(true);
  });

  it("usage 缺省时对应键省略而不是 0（10 §6.1 规则 2）", () => {
    const validateUsage = compileRoot();
    const withUnknown: Record<string, unknown> = {
      ir_version: "ag-ir/1",
      kind: "chat",
      model: "m",
      source_format: "openai.chat",
      raw: {},
      payload: { messages: [] },
      // 故意不给 usage
    };
    expect(validateUsage(withUnknown)).toBe(true);

    const withZeroTokens: Record<string, unknown> = {
      ...withUnknown,
      usage: { units: { tokens: { input_tokens: 0 } }, source: "provider" },
    };
    // tokens 的所有字段是 required 的——"只填一个 0"过不了，逼着上游要么全给要么整个省略
    expect(validateUsage(withZeroTokens)).toBe(false);
  });

  it("「输出免费」必须记真实值 + pricing_state.output=free，不能把 output_tokens 置 0（10 §6.1 规则 5）", () => {
    const validateUsage = compileRoot();
    const base: Record<string, unknown> = {
      ir_version: "ag-ir/1",
      kind: "decision",
      model: "gemini-decision-1",
      source_format: "gemini.decisions",
      raw: {},
      payload: { content: [], questions: [{ id: "q", type: "binary", prompt: "p" }] },
    };
    const outputFree: Record<string, unknown> = {
      ...base,
      usage: {
        units: {
          tokens: {
            input_tokens: 100,
            output_tokens: 12,
            total_tokens: 112,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            reasoning_tokens: 0,
            pricing_state: { input: "billed", output: "free" },
          },
          questions: { asked: 1, answered: 1 },
        },
        source: "provider",
      },
    };
    expect(validateUsage(outputFree)).toBe(true);
  });

  it("未知顶层字段必须进 raw.unmapped（信封是封闭的）", () => {
    const validate = compileRoot();
    const withUnknownTop: Record<string, unknown> = {
      ir_version: "ag-ir/1",
      kind: "chat",
      model: "m",
      source_format: "openai.chat",
      raw: {},
      payload: { messages: [] },
      some_future_top_level_field: { a: 1 },
    };
    expect(validate(withUnknownTop)).toBe(false);

    const withUnmapped: Record<string, unknown> = {
      ...withUnknownTop,
      raw: { unmapped: { some_future_top_level_field: { a: 1 } } },
    };
    delete withUnmapped["some_future_top_level_field"];
    expect(validate(withUnmapped)).toBe(true);
  });

  it("未知 part 类型可承载（前向兼容）", () => {
    const validate = compileRoot();
    const withUnknownPart: Record<string, unknown> = {
      ir_version: "ag-ir/1",
      kind: "chat",
      model: "m",
      source_format: "openai.chat",
      raw: {},
      payload: {
        messages: [
          {
            role: "user",
            parts: [{ type: "unknown", raw_type: "future_block", raw: { any: "shape" } }],
          },
        ],
      },
    };
    expect(validate(withUnknownPart)).toBe(true);
  });

  it("BuiltinTool.name 只用 canonical 稳定名；厂商版本串进 native", () => {
    const validate = compileRoot();
    const ok: Record<string, unknown> = {
      ir_version: "ag-ir/1",
      kind: "chat",
      model: "m",
      source_format: "anthropic.messages",
      raw: {},
      payload: {
        messages: [],
        tools: [
          {
            type: "builtin",
            name: "web_search",
            config: {},
            native: { provider_tool_type: "web_search_20250305" },
          },
        ],
      },
    };
    expect(validate(ok)).toBe(true);

    const vendorName: Record<string, unknown> = {
      ...ok,
      payload: {
        messages: [],
        tools: [{ type: "builtin", name: "web_search_20250305", config: {} }],
      },
    };
    expect(validate(vendorName)).toBe(false);
  });
});

describe("ir/schema ↔ ir/*.ts 字段级 parity（防漂移）", () => {
  /** 用 TS compiler API 收集指定文件里每个 interface 的属性名。 */
  function collectInterfaceProps(file: string): Map<string, string[]> {
    const source = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
    const out = new Map<string, string[]>();
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && node.name !== undefined) {
        const props: string[] = [];
        for (const member of node.members) {
          if (ts.isPropertySignature(member) && member.name !== undefined) {
            const name = ts.isIdentifier(member.name)
              ? member.name.text
              : ts.isStringLiteral(member.name)
                ? member.name.text
                : undefined;
            if (name !== undefined) props.push(name);
          }
        }
        out.set(node.name.text, props);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
  }

  function schemaProps(schemaFile: string, schemaTitle: string): string[] {
    const schema = readJson(join(schemaDir, schemaFile)) as {
      properties?: Record<string, unknown>;
      $defs?: Record<string, { properties?: Record<string, unknown> }>;
      title?: string;
    };
    // 优先取 $defs 里同名定义；只有 title 本身是顶层 properties 时才退回顶层
    const fromDefs = schema.$defs?.[schemaTitle]?.properties;
    const props = fromDefs ?? (schema.title === schemaTitle ? schema.properties : undefined);
    if (props === undefined) throw new Error(`${schemaFile} 找不到 ${schemaTitle} 的 properties`);
    return Object.keys(props);
  }

  it("UsageUnits / TokenUsage 的字段与 TS 一致", () => {
    const tsProps = collectInterfaceProps(join(root, "ir", "usage.ts"));
    const unitsSchema = schemaProps("usage.schema.json", "UsageUnits");
    const tokenSchema = schemaProps("usage.schema.json", "TokenUsage");
    expect(unitsSchema.sort()).toEqual([...(tsProps.get("UsageUnits") ?? [])].sort());
    expect(tokenSchema.sort()).toEqual([...(tsProps.get("TokenUsage") ?? [])].sort());
  });

  it("CacheControl / ResponseFormat / ThinkingConfig 的字段与 TS 一致", () => {
    const chatTs = collectInterfaceProps(join(root, "ir", "chat.ts"));
    const toolsSchema = readJson(join(schemaDir, "tools.schema.json")) as {
      $defs: Record<string, { properties?: Record<string, unknown> }>;
    };
    const chatSchema = readJson(join(schemaDir, "chat.schema.json")) as {
      $defs: Record<string, { properties?: Record<string, unknown> }>;
    };
    expect(Object.keys(toolsSchema.$defs["CacheControl"]!.properties!).sort()).toEqual(
      [...(chatTs.get("CacheControl") ?? [])].sort(),
    );
    expect(Object.keys(chatSchema.$defs["ResponseFormat"]!.properties!).sort()).toEqual(
      [...(chatTs.get("ResponseFormat") ?? [])].sort(),
    );
    expect(Object.keys(chatSchema.$defs["ThinkingConfig"]!.properties!).sort()).toEqual(
      [...(chatTs.get("ThinkingConfig") ?? [])].sort(),
    );
  });

  it("MediaRef / RawEnvelope / ConversionDiagnostic 的字段与 TS 一致", () => {
    const mediaTs = collectInterfaceProps(join(root, "ir", "media.ts"));
    const envelopeTs = collectInterfaceProps(join(root, "ir", "envelope.ts"));
    const mediaSchema = readJson(join(schemaDir, "media.schema.json")) as {
      properties: Record<string, unknown>;
    };
    // MediaBase 的公共字段 + 三个子类各自的特有字段
    const base = mediaTs.get("MediaBase") ?? [];
    const inline = mediaTs.get("InlineMedia") ?? [];
    const uri = mediaTs.get("UriMedia") ?? [];
    const asset = mediaTs.get("AssetMedia") ?? [];
    const expected = [...new Set([...base, ...inline, ...uri, ...asset, "kind"])];
    expect(Object.keys(mediaSchema.properties).sort()).toEqual(expected.sort());

    const envSchema = readJson(join(schemaDir, "envelope.schema.json")) as {
      $defs: Record<string, { properties?: Record<string, unknown> }>;
    };
    expect(Object.keys(envSchema.$defs["RawEnvelope"]!.properties!).sort()).toEqual(
      [...(envelopeTs.get("RawEnvelope") ?? [])].sort(),
    );
    expect(Object.keys(envSchema.$defs["ConversionDiagnostic"]!.properties!).sort()).toEqual(
      [...(collectInterfaceProps(join(root, "ir", "diagnostic.ts")).get("ConversionDiagnostic") ?? [])].sort(),
    );
  });

  it("DecisionQuestion / DecisionOption / DecisionAnswer 的字段与 TS 一致", () => {
    const decisionTs = collectInterfaceProps(join(root, "ir", "decision.ts"));
    const schema = readJson(join(schemaDir, "decision.schema.json")) as {
      $defs: Record<string, { properties?: Record<string, unknown> }>;
    };
    for (const name of ["DecisionQuestion", "DecisionOption", "DecisionAnswer"]) {
      expect(Object.keys(schema.$defs[name]!.properties!).sort()).toEqual(
        [...(decisionTs.get(name) ?? [])].sort(),
      );
    }
  });
});
