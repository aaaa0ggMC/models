# `openai-responses` 夹具来源（from-docs/）

> **本目录全部夹具都是「官方文档样本」，未经真实上游验证。**
> 42-openai-responses-access.md §5.2 的夹具纪律：期一/期二用 `from-docs/`，期三（有效
> DeepSeek key 到手）换成 `from-live/` 真样本后**重跑全部断言**；两份都过同一套断言，
> 差异就是 42 §2.3 的销账结果。**不要把这里的样本当成 live 样本。**

JSON 文件不能写注释，所以逐文件来源记在这张表里；`.sse.txt` 的文件头另有一行 `#` 注释。
所有样本只含假模型名 / 假 id / `example.com` URL，无真实凭据、无个人信息、无内网地址、
无绝对路径（40 §1.6 检查清单末条）。

## 逐文件来源

| 文件 | 形状 | 官方文档来源（2026-11-16 访问） | 验证状态 |
|---|---|---|---|
| `request.basic.json` | `instructions` + `input` 字符串 + `max_output_tokens` | <https://api-docs.deepseek.com/api/create-response>（请求体字段表：`instructions` / `input` / `max_output_tokens` / `temperature`） | `[doc]` 未接真实上游 |
| `request.multisystem.json` | `instructions` + system 角色 item + developer 角色 item 共存 | <https://api-docs.deepseek.com/guides/responses_api>（Input Items 表：`message` item 的 `role` 含 `system` / `developer`；`developer` 在 `deepseek-flash` 当 `system`、`deepseek-v4-pro` 当 `user`） | `[doc]` 未接真实上游 |
| `request.tools.json` | `tools[]` 字段**不嵌套** + `tool_choice` + `parallel_tool_calls` + `web_search` 内置工具 | <https://api-docs.deepseek.com/api/create-response>（`tools[].type="function"` 时 `name` / `description` / `parameters` 在顶层；`web_search` 仅 `deepseek-v4-pro`） | `[doc]` 未接真实上游 |
| `request.tool-loop.json` | `function_call` → `function_call_output` 回传（含 `id` ↔ `call_id`） | <https://api-docs.deepseek.com/guides/responses_api>（Input Items 表）+ <https://api-docs.deepseek.com/api/create-response>（回传用 `{type:"function_call_output", call_id}`） | `[doc]` 未接真实上游 |
| `request.malformed-tool-args.json` | `function_call.arguments` 是**非法 JSON 字符串** | <https://api-docs.deepseek.com/api/create-response>（`arguments` 是字符串） | `[doc]` 未接真实上游 |
| `request.multimodal.json` | `input_image`（`image_url` / `file_id`）+ `input_file`（`file_id`） | <https://api-docs.deepseek.com/guides/responses_api>（Image Input：`input_image` 的 `image_url` 或 `file_id` + `detail`；Input Items 表的 `input_file`） | `[doc]` 未接真实上游 |
| `request.unknown-item.json` | `custom_tool_call`（`input` 是自由文本） | <https://api-docs.deepseek.com/api/create-response>（输入 item 类型清单含 `custom_tool_call`；工具参考里 `custom` 只有 `{"type":"custom","name":"apply_patch"}`） | `[doc]` 未接真实上游 |
| `request.unknown-top-level.json` | Responses 专有顶层键（`truncation` / `max_tool_calls` / `prompt_cache_key` / `context_management` / `safety_check` / `title`） | <https://api-docs.deepseek.com/api/create-response>（DeepSeek 扩展参数 `safety_check{level}` / `title{enabled}`）+ 42 §4.3 的 unmapped 清单 | `[doc]` 未接真实上游 |
| `request.stream.json` | `stream: true` | <https://api-docs.deepseek.com/guides/responses_api>（流式是语义 SSE 事件） | `[doc]` 未接真实上游 |
| `request.stateful.json` | `previous_response_id` / `conversation` / `background` / `include` / `store` | <https://api-docs.deepseek.com/api/create-response>（无状态：不存 response / conversation，`store` 恒 `false`）+ 42 §4.4 / §4.9 | `[doc]` 未接真实上游 |
| `response.basic.json` | `output[]` 单 message item + `status:"completed"` + usage 五槽 | <https://api-docs.deepseek.com/guides/responses_api>（响应对象：`output` / `status` / `usage`） | `[doc]` 未接真实上游 |
| `response.tools.json` | `output[]` 含 `function_call` item（`id` + `call_id`） | 同上（Output Items 表） | `[doc]` 未接真实上游 |
| `response.usage-full.json` | `input_tokens_details.cached_tokens` / `output_tokens_details.reasoning_tokens` / `output_tokens_details.safety_tokens` / `server_tool_use` / `total_tokens` | <https://api-docs.deepseek.com/guides/responses_api>（usage 形状）+ 42 §4.6 的三行补充 | `[doc]` 未接真实上游 |
| `response.no-usage.json` | 响应体没有 `usage` | 10 §6.1 规则 2 的负向样本（「未知」绝不用 0 表示） | `[doc]` 未接真实上游 |
| `response.incomplete.json` | `status:"incomplete"` + `incomplete_details.reason:"max_output_tokens"` | <https://api-docs.deepseek.com/guides/responses_api>（终事件 `response.incomplete`） | `[doc]` 未接真实上游 |
| `response.failed.json` | `status:"failed"` + `error{code,message}` | 同上（终事件 `response.failed`；42 §4.5 末行：这是 HTTP 200） | `[doc]` 未接真实上游 |
| `response.stream.sse.txt` | 完整语义 SSE 事件序列（`sequence_number` 单调、无 `data: [DONE]`、终事件带 usage） | <https://api-docs.deepseek.com/guides/responses_api>（事件名清单与 `sequence_number` 语义） | `[doc]` 未接真实上游；**事件序列的完整形状是 42 §2.3 阻塞项 2（P0）** |

## 阻塞项对照（42 §2.3）

| 阻塞项 | 等级 | 本目录夹具能销吗 |
|---|---|---|
| 1. 端点路径带不带 `/v1` | P0 | **不能**——只能拿有效 key 打真实请求 |
| 2. 事件序列的完整形状 | P0 | **不能**——本夹具按文档构造，需 `from-live/` 真样本替换 |
| 3. `web_search_call` 流式产出形状 | P1 | 不能 |
| 4. `server_tool_use` 计费口径 | P1 | 不能 |
| 5. `input_file` + Files API | P1 | 不能 |
| 6. `strict` 字段的位置 | P1 | 不能 |
| 7. 限流配额池 | P1 | 不能 |
