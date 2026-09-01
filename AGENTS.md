# AGENTS.md

## Behavior

- In `before_provider_request`, sort the current function-tool list by name and
  recursively sort JSON object keys. Ordering uses JavaScript code units, never
  locale rules. Schema arrays (including `required`, `enum`, and `prefixItems`)
  keep their original order and values. JavaScript's integer-key enumeration
  rules still apply deterministically.
- Copy the tool surface only. Keep messages, reasoning, tool-call IDs, results,
  error information, images, and request options untouched. Never restore removed
  tools or freeze system instructions. Unknown tool types and lists carrying
  tool-level `cache_control` markers are left alone.
- `/dsco` reports first observation, identical/appended prefix, or changed system,
  tools, and message prefix. Only SHA-256 fingerprints remain in process memory;
  the command displays categories, not hashes or content. No diagnostic data is
  written to session history or inserted into model input.

Default scope is the `openai-completions` adapter with an HTTPS base URL of
`api.deepseek.com`, using `/`, `/v1`, or `/v1/`, no custom port, credentials, query,
or fragment. Model names do not establish scope. Other APIs/providers are unchanged.
OAuth and extension-registered providers require opt-in because the hook exposes
the selected model, not their actual transport/auth URL overrides.

For an endpoint you have independently verified as compatible:

```sh
pi -e ./index.ts --dsco-compatible
```

This flag opts **all OpenAI-completions models selected during that invocation**
into ordering. It does not assert that a gateway offers DeepSeek caching.
No other configuration is needed.

## Native Behavior and Limits

| Concern | Ownership / outcome |
| --- | --- |
| Ordinary history and resume | Pi appends/persists messages and rebuilds context on resume. This extension never edits history or prunes after idle time. |
| Tool output | Reuse Pi's built-in limits; no additional truncation or retrieval tool. |
| Retry | Pi's OpenAI adapter retries its prepared payload; agent-level retry and overflow recovery remain enabled. |
| Compaction | Pi keeps its thresholds, recent tail, tool-boundary handling, summaries, and failure handling. |
| Cache usage | Pi maps DeepSeek `prompt_cache_hit_tokens` to `usage.cacheRead`; its footer reports cache reads and latest hit percentage. |
| Instruction / permission changes | Always honored. Changed tool descriptions, schemas, availability, and prompts can legitimately change the prefix. |

Pi's `bash` keeps the last **2,000 lines or 50 KiB**, whichever limit is reached
first, and includes a full-output temporary-file path. The model can use the
ordinary `read` tool with offsets/limits (or an available shell) to retrieve
omitted content. `read` keeps the first 2,000 lines/50 KiB and provides continuation
instructions; the source file remains available. These are Pi's information vs.
context-size tradeoffs, **not measured cache improvements**. Results are stored
once, not shortened again by this extension. UTF-8 handling and images stay native.

Temporary bash files are not archival storage: OS cleanup can remove them after
a restart, and read source files can change. Tool permissions still govern access.
Custom/MCP tools must implement their own limits, explicit omission notices, and
supported retrieval; Pi has no universal cap. This extension cannot guarantee
bounded output or durable retrieval for arbitrary tools and does not silently
wrap them or bypass permissions.

Pi's native compactor uses a separate summarization system prompt, serialized
conversation, and no ordinary tools. `session_before_compact` permits a **complete
custom summarizer**, but has no hook to change only the native summarizer's input
while retaining its implementation. Reusing the ordinary system/tools/contiguous
prefix for native summaries needs a Pi core change. A custom replacement is
possible but deliberately not included; neither is a competing compaction loop.

Hooks run in load order. Earlier extensions can change history; later extensions
can undo ordering or alter the payload after it is observed. This extension does
not reorder other extensions or enforce a final-wire guarantee. Pi's generated
system prompt also lists tools in active-tool order: sorting only the API tool
array cannot stabilize that text when another extension reorders active tools.
Such prompt changes are diagnosed, never hidden. Pi's own provider projection
(for example cross-model reasoning/ID conversion) remains outside this extension.
Enabling or removing this extension can itself cause a one-time tool-prefix change.

## Reading Diagnostics

[DeepSeek's cache](https://api-docs.deepseek.com/guides/kv_cache/) is automatic,
server-side, best-effort prefix caching. Reuse requires matching a persisted prefix
unit. Identical local fingerprints are **potential reuse**, not measured cache hits.
First observation after startup/resume has unknown server warmth; subsequent
requests are a local warm-session comparison, not proof of a warm server cache.
No timeout is used to guess expiration, and failed attempts can become the local
comparison baseline. Transport retries may occur without another hook invocation.

Use Pi's provider-reported usage for actual hits. `usage.input` excludes cache-read
and cache-write tokens; total prompt tokens are their sum. Missing provider cache
fields default to zero in Pi, so zero alone does not establish a measured miss.
Costs come from Pi's model catalog. No live benchmark was run, and no hit-rate,
latency, or cost reduction is claimed.

## Verification

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Result on Pi 0.84.4 / Node 26.8.1: **type-check passed; 6 tests passed**.
Tests cover deterministic serialization, immutable projections, Unicode, tool
pairing, native overflow-file retrieval, endpoint scope, intentional changes, and
hook ordering. The integration check loads the package through Pi's actual
loader, runs its SDK session loop and real OpenAI adapter with mocked HTTP,
checks DeepSeek usage mapping and retry equality, and resumes a session from disk.
It also runs native compaction and continues the compacted session.
Network fetch is blocked in that check; authentication is replaced with a dummy
value and all test state lives in temporary directories. No saved credentials or
paid API calls are used.

## Design References / Handoff

Reviewed on 2026-08-31 against installed Pi 0.84.4 and Reasonix `main-v2` at
[`c2fea801`](https://github.com/esengine/DeepSeek-Reasonix/tree/c2fea80175b19ce8521faf27bdacdc34a08b395d).
This is original TypeScript, inspired by the following current source behavior;
no upstream implementation code was copied.

| Reasonix technique | Pi adaptation |
| --- | --- |
| [Sorted tools](https://github.com/esengine/DeepSeek-Reasonix/blob/c2fea80175b19ce8521faf27bdacdc34a08b395d/internal/tool/tool.go) and [schema canonicalization](https://github.com/esengine/DeepSeek-Reasonix/blob/c2fea80175b19ce8521faf27bdacdc34a08b395d/internal/provider/schema_canonicalize.go) | Implemented at the request hook, but without Reasonix's array sorting or schema repair. |
| [Prefix diagnostics](https://github.com/esengine/DeepSeek-Reasonix/blob/c2fea80175b19ce8521faf27bdacdc34a08b395d/internal/agent/cache_shape.go) | Local hash comparison; actual hits stay in Pi's existing usage reporting. |
| [Stable sampling/retries](https://github.com/esengine/DeepSeek-Reasonix/blob/c2fea80175b19ce8521faf27bdacdc34a08b395d/internal/agent/sampling_request.go) and [idle resume](https://github.com/esengine/DeepSeek-Reasonix/blob/c2fea80175b19ce8521faf27bdacdc34a08b395d/internal/control/projection_bind.go) | Reuse Pi's native lifecycle; no frozen session engine. |
| [Cache-aligned compaction](https://github.com/esengine/DeepSeek-Reasonix/blob/c2fea80175b19ce8521faf27bdacdc34a08b395d/internal/agent/compact.go) | Native Pi summary-input change needs core support; custom replacement not included. |
| Bounded tool projection; planner/executor separation | Reuse native tool output limits; do not build another harness or switch models. |
| Pinned MCP placeholders / environment snapshots | Not implemented: never preserve obsolete tools or safety information for caching. |

Pi references: [extension hooks](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/extensions.md),
[package format](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/packages.md),
[SDK request wiring](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/src/core/sdk.ts),
[OpenAI adapter](https://github.com/earendil-works/pi/blob/v0.84.4/packages/ai/src/api/openai-completions.ts),
[tool output](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/src/core/tools/bash.ts),
[compaction](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/src/core/compaction/compaction.ts),
[DeepSeek endpoints](https://api-docs.deepseek.com/).
