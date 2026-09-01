import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import type { Context, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession, createBashTool, createReadTool, discoverAndLoadExtensions,
  ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import dsco, { canonicalize, inScope, observe, projectPayload } from "../index.ts";

const model: Model<"openai-completions"> = {
  id: "deepseek-v4-pro", name: "Mock DeepSeek", provider: "deepseek",
  api: "openai-completions", baseUrl: "https://api.deepseek.com",
  reasoning: true, input: ["text", "image"], contextWindow: 1000000, maxTokens: 4096,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
};
const tool = (name: string, parameters: unknown = { type: "object", properties: {} }) =>
  ({ type: "function", function: { name, description: name, parameters } });
const project = (payload: Record<string, unknown>) => projectPayload(payload) as typeof payload;

test("canonical JSON keys, Unicode, schema semantics, array order and prototype keys", () => {
  const a = JSON.parse('{"z":1,"__proto__":{"safe":true},"a":{"雪":"😀","required":["z","a"],"prefixItems":[{"type":"string"},{"type":"number"}]}}');
  const b = { a: a.a, ["__proto__"]: { safe: true }, z: 1 };
  const before = JSON.stringify(a);
  assert.equal(JSON.stringify(canonicalize(a)), JSON.stringify(canonicalize(b)));
  assert.deepEqual(canonicalize(a), a);
  assert.equal(JSON.stringify(a), before);
  assert.equal(Object.getPrototypeOf(canonicalize(a)), Object.prototype);
  assert.deepEqual(canonicalize([false, null, 2, "é😀"]), [false, null, 2, "é😀"]);
  assert.equal(JSON.stringify(canonicalize([{ z: 1, a: 2 }])), '[{"a":2,"z":1}]');
});

test("request projection copies tools only, uses code-unit order, keeps calls/results/images", () => {
  const messages = [
    { role: "system", content: "Current permissions: read only" },
    { role: "user", content: "雪😀" },
    { role: "assistant", reasoning_content: "reasoning must survive", content: null,
      tool_calls: [{ id: "call-original", type: "function", function: { name: "z", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call-original", isError: true,
      content: [{ type: "text", text: "😀".repeat(30000) }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] },
  ];
  const payload = { messages, tools: [tool("z"), tool("ä"), tool("A"), tool("a")] };
  const before = JSON.stringify(payload);
  const result = project(payload);
  assert.equal(result.messages, messages);
  assert.deepEqual((result.tools as ReturnType<typeof tool>[]).map((t) => t.function.name), ["A", "a", "z", "ä"]);
  assert.equal(JSON.stringify(payload), before);
  assert.deepEqual(project(result), result);
  const appended = project({ ...payload, messages: [...messages, { role: "user", content: "next" }] });
  assert.equal(JSON.stringify((appended.messages as unknown[]).slice(0, messages.length)), JSON.stringify(messages));
  assert.equal(JSON.stringify(appended.tools), JSON.stringify(result.tools));
  const removed = project({ ...payload, tools: [tool("a")] });
  assert.deepEqual(removed.tools, [tool("a")]);
  assert.equal(projectPayload(null), null);
  const withoutTools = { messages };
  assert.equal(projectPayload(withoutTools), withoutTools);
  for (const tools of [
    [null],
    [{ type: "custom", function: tool("x").function }],
    [{ type: "function", function: null }],
    [{ type: "function", function: { ...tool("x").function, name: 1 } }],
    [{ type: "custom", custom: { name: "x" } }],
    [{ ...tool("z"), cache_control: { type: "ephemeral" } }],
    [{ ...tool("z"), function: { ...tool("z").function, cache_control: { type: "ephemeral" } } }],
    [tool("a"), { type: "custom", function: tool("x").function }],
  ]) {
    const unsupported = { messages, tools };
    assert.equal(projectPayload(unsupported), unsupported);
  }
  const duplicates = project({ messages, tools: [tool("x", { order: 1 }), tool("x", { order: 2 })] });
  assert.deepEqual((duplicates.tools as ReturnType<typeof tool>[]).map((t) => t.function.parameters), [{ order: 1 }, { order: 2 }]);
});

test("scope is exact endpoint/API, never a model-name guess", () => {
  assert.equal(inScope(model), true);
  for (const baseUrl of ["https://api.deepseek.com/v1", "https://api.deepseek.com/v1/", "https://api.deepseek.com:443/"]) {
    assert.equal(inScope({ ...model, baseUrl }), true);
  }
  for (const baseUrl of ["https://gateway.example/deepseek", "https://api.deepseek.com.evil.test", "http://api.deepseek.com", "https://api.deepseek.com:444", "https://user@api.deepseek.com", "https://api.deepseek.com/anthropic", "https://api.deepseek.com/?route=other", "invalid"]) {
    assert.equal(inScope({ ...model, baseUrl }), false, baseUrl);
  }
  assert.equal(inScope(undefined), false);
  assert.equal(inScope({ ...model, api: "anthropic-messages" }, true), false);
  assert.equal(inScope({ ...model, baseUrl: "http://localhost:1234/v1" }, true), true);
});

test("diagnostics distinguish first, repeated, appended and intentionally changed prefixes", () => {
  const payload = { messages: [{ role: "system", content: "secret" }, { role: "user", content: "hello" }], tools: [tool("a")] };
  const first = observe(payload);
  assert.match(first.status, /First observed/);
  assert.match(observe(payload, first.shape).status, /identical/);
  assert.match(observe({ ...payload, messages: [...payload.messages, { role: "assistant", content: "next" }] }, first.shape).status, /append-only/);
  assert.match(observe({ ...payload, tools: [] }, first.shape).status, /tool definitions/);
  const updated = { ...payload, messages: [{ role: "system", content: "new safety rules" }, payload.messages[1]] };
  assert.match(observe(updated, first.shape).status, /system instructions/);
  const developer = { ...payload, messages: [{ role: "developer", content: "old safety rules" }, payload.messages[1]] };
  const developerFirst = observe(developer);
  assert.match(observe({ ...developer, messages: [{ role: "developer", content: "new safety rules" }, payload.messages[1]] }, developerFirst.shape).status, /system instructions/);
  assert.equal(project(updated).messages, updated.messages);
  assert.match(observe({ ...payload, messages: payload.messages.slice(0, 1) }, first.shape).status, /message prefix/);
  assert.equal(
    observe({ messages: [{ role: "system", content: "changed" }], tools: [] }, first.shape).status,
    "Subsequent request; changed: system instructions, tool definitions, message prefix.",
  );
  assert.ok(!JSON.stringify(first).includes("secret"));
  assert.deepEqual(observe({}), { status: "Unsupported payload; no comparison." });
  assert.deepEqual(observe(null), { status: "Unsupported payload; no comparison." });
  assert.equal(
    observe({ messages: [] }).shape?.tools,
    createHash("sha256").update("undefined").digest("hex"),
  );
});

test("extension wiring reports and resets request identity", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  let flagRegistration: { name: string; options: unknown } | undefined;
  let commandRegistration: { name: string; options: any } | undefined;
  let optIn = false;
  dsco({
    registerFlag: (name: string, options: unknown) => { flagRegistration = { name, options }; },
    registerCommand: (name: string, options: unknown) => { commandRegistration = { name, options }; },
    on: (name: string, handler: (...args: any[]) => any) => { handlers.set(name, handler); },
    getFlag: () => optIn,
  } as unknown as ExtensionAPI);

  assert.deepEqual([...handlers.keys()], ["session_start", "model_select", "before_provider_request"]);
  assert.deepEqual(flagRegistration, {
    name: "dsco-compatible",
    options: {
      description: "Opt in the current OpenAI-compatible endpoint to tool ordering (does not establish DeepSeek caching)",
      type: "boolean",
      default: false,
    },
  });
  assert.equal(commandRegistration?.name, "dsco");
  assert.equal(commandRegistration?.options.description, "Show local prefix stability; Pi's footer reports actual cache usage");

  const notices: Array<{ message: string; level: string }> = [];
  const status = async () => {
    await commandRegistration!.options.handler("", {
      ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
    });
    return notices.at(-1)!;
  };
  const expected = (message: string) => ({
    message: `${message}\nCompared at this hook only; later hooks may change the request. Pi's footer reports provider cache-read usage.`,
    level: "info",
  });
  assert.deepEqual(await status(), expected("No scoped request observed."));

  const request = { messages: [{ role: "user", content: "hello" }], tools: [tool("a")] };
  const context = (sessionId: string, selected: Model<"openai-completions"> = model) => ({
    model: selected,
    modelRegistry: { isUsingOAuth: () => false, getRegisteredProviderIds: () => [] },
    sessionManager: { getSessionId: () => sessionId },
  });
  const beforeRequest = handlers.get("before_provider_request")!;

  beforeRequest({ payload: request }, context("one"));
  assert.deepEqual(await status(), expected("First observed request (also after resume); server cache warmth unknown."));
  handlers.get("session_start")!();
  assert.deepEqual(await status(), expected("No scoped request observed."));

  beforeRequest({ payload: request }, context("one"));
  beforeRequest({ payload: request }, context("one", { ...model, baseUrl: "https://gateway.example/v1" }));
  assert.deepEqual(await status(), expected("Inactive for this endpoint or API; request unchanged."));
  beforeRequest({ payload: request }, context("one"));
  assert.deepEqual(await status(), expected("First observed request (also after resume); server cache warmth unknown."));

  beforeRequest({ payload: request }, context("two"));
  assert.deepEqual(await status(), expected("First observed request (also after resume); server cache warmth unknown."));
  optIn = true;
  beforeRequest({ payload: request }, context("two", { ...model, baseUrl: "https://gateway.example/v1" }));
  assert.deepEqual(await status(), expected("First observed request (also after resume); server cache warmth unknown."));
});

test("native bash limits preserve complete output, Unicode, and supported read retrieval", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsco-output-"));
  let overflow: string | undefined;
  try {
    const original = "omitted-first-line\n" + "雪😀".repeat(20000);
    const bytes = Buffer.from(original);
    const bash = createBashTool(dir, { operations: {
      exec: async (_command, _cwd, options) => {
        // Split inside a multi-byte code point to exercise Pi's streaming decoder.
        options.onData(bytes.subarray(0, 20));
        options.onData(bytes.subarray(20));
        return { exitCode: 0 };
      },
    } });
    const result = await bash.execute("call-output", { command: "mock" });
    overflow = result.details?.fullOutputPath;
    assert.ok(overflow);
    assert.equal(await readFile(overflow, "utf8"), original);
    const text = result.content.map((c) => c.type === "text" ? c.text : "").join("");
    assert.match(text, /Full output:/);
    assert.ok(!text.includes("�"));
    assert.ok(!text.includes("omitted-first-line"));
    const read = createReadTool(dir);
    const recovered = await read.execute("retrieve", { path: overflow, offset: 1, limit: 1 });
    assert.match(JSON.stringify(recovered.content), /omitted-first-line/);
    const before = JSON.stringify(result);
    project({ tools: [tool("z"), tool("a")], messages: [{ role: "tool", tool_call_id: "call-output", content: result.content }] });
    assert.equal(JSON.stringify(result), before);
  } finally {
    if (overflow) await rm(overflow, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pi package loader + SDK + real adapter: mock HTTP, tools, usage, retry and disk resume", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsco-integration-"));
  // Any accidental network access fails; the adapter receives a separate mock fetch.
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden in test"); });
  const requests: Record<string, any>[] = [];
  const notifications: string[] = [];
  const peerExtension = join(dir, "peer.ts");
  const instructionsFile = join(dir, "instructions.txt");
  const lateFile = join(dir, "late.txt");
  await writeFile(instructionsFile, "Initial policy.");
  await writeFile(peerExtension, `
    import { readFileSync, existsSync } from 'node:fs';
    export default function (pi) {
      pi.on('before_agent_start', (event) => ({
        systemPrompt: event.systemPrompt + '\\n' + readFileSync(${JSON.stringify(instructionsFile)}, 'utf8')
      }));
      pi.on('before_provider_request', (event) => {
        if (existsSync(${JSON.stringify(lateFile)})) return {
          ...event.payload, messages: [
            { role: 'system', content: 'Late policy.' }, ...event.payload.messages.slice(1)
          ]
        };
      });
    }
  `);
  let failNext = false;
  let callTool = true;
  const mockFetch: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    if (failNext) {
      failNext = false;
      return new Response('{"error":{"message":"retry mock"}}', { status: 429, headers: { "retry-after": "0" } });
    }
    const delta = callTool ? {
      role: "assistant", reasoning_content: "preserved reasoning 雪😀",
      tool_calls: [{ index: 0, id: "call_mock", type: "function", function: { name: "read", arguments: JSON.stringify({ path: join(dir, "fixture.txt") }) } }],
    } : { role: "assistant", content: "mock answer" };
    const finish_reason = callTool ? "tool_calls" : "stop";
    callTool = false;
    const chunk = { id: "mock", object: "chat.completion.chunk", created: 0, model: model.id,
      choices: [{ index: 0, delta, finish_reason }],
      usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 } };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  };
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  // Dummy auth only; neither environment nor saved credentials are resolved.
  t.mock.method(runtime, "getAuth", async () => ({ auth: { apiKey: "test-only" }, env: {} }));
  t.mock.method(runtime, "streamSimple", (requestModel: Model<"openai-completions">, context: Context, options: object) =>
    stream(requestModel, context, { ...options, apiKey: "test-only", env: {}, fetch: mockFetch, maxRetries: 1 }));
  async function openSession(manager: SessionManager, resume = false) {
    const extensions = await discoverAndLoadExtensions([resolve("."), peerExtension], dir, join(dir, "agent"));
    assert.deepEqual(extensions.errors, []);
    assert.equal(extensions.extensions.length, 2);
    assert.ok(extensions.extensions[0].handlers.has("before_provider_request"));
    const loader: ResourceLoader = {
      getExtensions: () => extensions,
      getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => "Stable test instructions.", getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources() {}, async reload() {},
    };
    const { session } = await createAgentSession({ cwd: dir, agentDir: join(dir, "agent"), model,
      modelRuntime: runtime, resourceLoader: loader, sessionManager: manager,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens: 32 } }),
      tools: ["read", "bash"], thinkingLevel: "off",
      sessionStartEvent: { type: "session_start", reason: resume ? "resume" : "startup" },
    });
    await session.bindExtensions({ onError: (error) => assert.fail(error.error), uiContext: {
      ...session.extensionRunner.getUIContext(), notify: (message) => notifications.push(message),
    } });
    return session;
  }
  let session: Awaited<ReturnType<typeof openSession>> | undefined;
  try {
    await writeFile(join(dir, "fixture.txt"), "read result 雪😀");
    const manager = SessionManager.create(dir, join(dir, "sessions"));
    session = await openSession(manager);
    await session.prompt("read fixture");
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].tools.map((t: any) => t.function.name), ["bash", "read"]);
    assert.deepEqual(requests[1].messages.slice(0, requests[0].messages.length), requests[0].messages);
    const assistant = requests[1].messages.find((m: any) => m.tool_calls);
    assert.equal(assistant.reasoning_content, "preserved reasoning 雪😀");
    const result = requests[1].messages.find((m: any) => m.role === "tool");
    assert.equal(result.tool_call_id, assistant.tool_calls[0].id);
    assert.match(result.content, /read result 雪😀/);
    const response = session.messages.at(-1);
    assert.equal(response?.role, "assistant");
    if (response?.role === "assistant") {
      assert.equal(response.usage.cacheRead, 60);
      assert.equal(response.usage.input, 40);
    }
    await session.prompt("/dsco");
    assert.match(notifications.at(-1)!, /append-only/);
    failNext = true;
    await session.prompt("next");
    assert.equal(requests.length, 4);
    assert.deepEqual(requests[2], requests[3], "transport retry replays the same payload");
    const sessionFile = manager.getSessionFile()!;
    const saved = session.messages;
    session.dispose();
    session = await openSession(SessionManager.open(sessionFile), true);
    assert.equal(JSON.stringify(session.messages), JSON.stringify(saved), "disk round-trip preserves serialized history");
    await session.prompt("resume");
    assert.deepEqual(requests[4].messages.slice(0, requests[3].messages.length), requests[3].messages);
    await session.prompt("/dsco");
    assert.match(notifications.at(-1)!, /First observed/);
    session.setActiveToolsByName(["read"]);
    await session.prompt("permissions changed");
    assert.deepEqual(requests[5].tools.map((t: any) => t.function.name), ["read"]);
    await session.prompt("/dsco");
    assert.match(notifications.at(-1)!, /tool definitions/);
    await writeFile(instructionsFile, "Updated safety policy.");
    await session.prompt("new instructions");
    assert.match(requests[6].messages[0].content, /Updated safety policy/);
    await session.prompt("/dsco");
    assert.match(notifications.at(-1)!, /system instructions/);
    await writeFile(lateFile, "enabled");
    await session.prompt("later hook");
    assert.equal(requests[7].messages[0].content, "Late policy.");
    await session.prompt("/dsco");
    assert.match(notifications.at(-1)!, /later hooks may change/);
    await rm(lateFile);
    const compacted = await session.compact();
    assert.match(compacted.summary, /mock answer/);
    const summaryRequest = requests.at(-1)!;
    assert.equal(summaryRequest.tools, undefined, "native compactor keeps its own request construction");
    assert.notEqual(summaryRequest.messages[0].content, requests[6].messages[0].content);
    await session.prompt("after compaction");
    assert.match(JSON.stringify(requests.at(-1)!.messages), /mock answer/);
    assert.ok(session.sessionManager.getEntries().some((entry) => entry.type === "compaction"));
    const untouched = { messages: [], tools: [tool("z"), tool("a")] };
    await session.setModel({ ...model, baseUrl: "https://gateway.example/v1" });
    assert.equal(await session.extensionRunner.emitBeforeProviderRequest(untouched), untouched);
    session.extensionRunner.setFlagValue("dsco-compatible", true);
    assert.deepEqual((await session.extensionRunner.emitBeforeProviderRequest(untouched) as any).tools.map((t: any) => t.function.name), ["a", "z"]);
    session.extensionRunner.setFlagValue("dsco-compatible", false);
    await session.setModel(model);
    const oauth = t.mock.method(runtime, "isUsingOAuth", () => true);
    assert.equal(await session.extensionRunner.emitBeforeProviderRequest(untouched), untouched);
    oauth.mock.restore();
    const registered = t.mock.method(runtime, "getRegisteredProviderIds", () => [model.provider]);
    assert.equal(await session.extensionRunner.emitBeforeProviderRequest(untouched), untouched);
    registered.mock.restore();
    assert.ok(notifications.every((n) => !n.includes("preserved reasoning") && !n.includes("test-only")));
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
