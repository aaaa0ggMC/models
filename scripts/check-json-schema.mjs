/**
 * scripts/check-json-schema.mjs —— 用 ajv 校验 canonical 夹具。
 *
 * 为什么需要它：docs/design/10-canonical-schema.md §8 要求 JSON Schema 与 TS 类型一对一、
 * round-trip 测试夹具按 schema 校验并进 CI；70-roadmap Phase 1 的验收标准里也有一条
 * 「canonical schema 的 TS 类型 + JSON Schema 可被 tsc / ajv 编译校验通过」。
 *
 * 本脚本做两件事：
 *   1. 编译 ir/schema/ag-ir-1/ 下的全部 schema（含互相 $ref），确保 schema 自身合法；
 *   2. 用根 schema 校验 ir/fixtures/ 下的每个 canonical 夹具。
 *
 * 防漂移：schema 与 TS 类型不允许各写一份后悄悄分叉，因此
 * tests/ir-schema.test.ts 里还有一层「TS 接口字段 ↔ schema properties」的字段级 parity 断言。
 */

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const schemaDir = join(root, "ir", "schema", "ag-ir-1");
const fixturesDir = join(root, "ir", "fixtures");

async function listJsonFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listJsonFiles(p)));
    else if (e.name.endsWith(".json")) out.push(p);
  }
  return out;
}

function main() {
  return (async () => {
    const ajv = new Ajv2020({
      strict: false,
      allErrors: true,
      // 夹具里的 canonical 对象带 ir_version 等字面量，不需要 meta-schema 之外的额外格式校验
      validateFormats: false,
    });

    // 1) 编译全部 schema（互相 $ref，因此必须先全部 addSchema）
    const files = await listJsonFiles(schemaDir);
    if (files.length === 0) {
      console.error("未找到任何 schema 文件");
      process.exitCode = 1;
      return;
    }
    const rootId = "https://agentgateway.local/schema/ag-ir-1/root.schema.json";
    let rootSchema;
    for (const f of files) {
      const raw = JSON.parse(await readFile(f, "utf8"));
      if (raw["$id"] === rootId) rootSchema = raw;
      else ajv.addSchema(raw, raw["$id"]);
    }
    if (rootSchema === undefined) {
      console.error("缺少 root.schema.json");
      process.exitCode = 1;
      return;
    }
    const validate = ajv.compile(rootSchema);
    console.log(`schema 编译通过：${files.length} 个文件`);

    // 2) 校验夹具
    const fixtures = await listJsonFiles(fixturesDir);
    if (fixtures.length === 0) {
      console.error("未找到任何 canonical 夹具（ir/fixtures/）");
      process.exitCode = 1;
      return;
    }
    let failed = 0;
    for (const f of fixtures) {
      const data = JSON.parse(await readFile(f, "utf8"));
      const ok = validate(data);
      const rel = f.slice(root.length + 1);
      if (ok) {
        console.log(`  ok   ${rel}`);
      } else {
        failed += 1;
        console.error(`  FAIL ${rel}`);
        for (const err of validate.errors ?? []) {
          console.error(`       ${err.instancePath || "(root)"} ${err.message}`);
        }
      }
    }
    if (failed > 0) {
      console.error(`\n${failed}/${fixtures.length} 个夹具未通过 schema 校验`);
      process.exitCode = 1;
      return;
    }
    console.log(`\n全部 ${fixtures.length} 个 canonical 夹具通过 schema 校验`);
  })();
}

await main();
