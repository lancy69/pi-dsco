import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ObjectValue = Record<string, unknown>;
const isObject = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Sort JSON object keys only; array order and all values retain their meaning. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function inScope(model: { api: string; baseUrl: string } | undefined, optIn = false): boolean {
  if (model?.api !== "openai-completions") return false;
  if (optIn) return true;
  try {
    const url = new URL(model.baseUrl);
    return url.origin === "https://api.deepseek.com" &&
      ["/", "/v1", "/v1/"].includes(url.pathname) &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/** Copy only the tool surface. Never touch messages, results, or tool-call IDs. */
export function projectPayload(payload: unknown): unknown {
  if (!isObject(payload) || !Array.isArray(payload.tools)) return payload;
  // Unknown tool protocols (including positional cache markers) must stay untouched.
  if (!payload.tools.every((tool) => isObject(tool) && tool.type === "function" &&
    isObject(tool.function) && typeof tool.function.name === "string" &&
    !Object.hasOwn(tool, "cache_control") && !Object.hasOwn(tool.function, "cache_control"))) return payload;
  const tools = payload.tools.map((tool) => canonicalize(tool) as ObjectValue);
  tools.sort((a, b) => {
    const left = (a.function as ObjectValue).name as string;
    const right = (b.function as ObjectValue).name as string;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return { ...payload, tools };
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
type Shape = { system: string; tools: string; messages: string[] };

/** Retain only hashes in memory, and report categories, never content or hashes. */
export function observe(payload: unknown, previous?: Shape): { shape?: Shape; status: string } {
  if (!isObject(payload) || !Array.isArray(payload.messages)) return { status: "Unsupported payload; no comparison." };
  const system = payload.messages.filter((message) => isObject(message) &&
    (message.role === "system" || message.role === "developer"));
  const shape = { system: hash(system), tools: hash(payload.tools), messages: payload.messages.map(hash) };
  if (!previous) return { shape, status: "First observed request (also after resume); server cache warmth unknown." };
  const changes: string[] = [];
  if (shape.system !== previous.system) changes.push("system instructions");
  if (shape.tools !== previous.tools) changes.push("tool definitions");
  const prefixUnchanged = previous.messages.every((value, index) => value === shape.messages[index]);
  if (!prefixUnchanged) changes.push("message prefix");
  return {
    shape,
    status: changes.length ? `Subsequent request; changed: ${changes.join(", ")}.` :
      `Subsequent request; ${shape.messages.length === previous.messages.length ? "identical" : "append-only"} observed prefix. Potential reuse only; not a cache hit.`,
  };
}

export default function dsco(pi: ExtensionAPI) {
  let previous: Shape | undefined;
  let identity: string | undefined;
  let status = "No scoped request observed.";
  pi.registerFlag("dsco-compatible", {
    description: "Opt in the current OpenAI-compatible endpoint to tool ordering (does not establish DeepSeek caching)",
    type: "boolean",
    default: false,
  });
  const reset = () => { previous = undefined; identity = undefined; status = "No scoped request observed."; };
  pi.on("session_start", reset);
  pi.on("model_select", reset);
  pi.on("before_provider_request", (event, ctx) => {
    const optIn = pi.getFlag("dsco-compatible") === true;
    // The hook exposes the selected model, not auth/transport URL overrides.
    // OAuth and extension-defined transports therefore require explicit opt-in.
    const opaqueTransport = ctx.model && (ctx.modelRegistry.isUsingOAuth(ctx.model) ||
      ctx.modelRegistry.getRegisteredProviderIds().includes(ctx.model.provider));
    if ((!optIn && opaqueTransport) || !inScope(ctx.model, optIn)) {
      reset();
      status = "Inactive for this endpoint or API; request unchanged.";
      return;
    }
    const currentIdentity = hash([ctx.sessionManager.getSessionId(), ctx.model?.provider, ctx.model?.id, ctx.model?.baseUrl]);
    if (currentIdentity !== identity) previous = undefined;
    identity = currentIdentity;
    const payload = projectPayload(event.payload);
    const observation = observe(payload, previous);
    previous = observation.shape;
    status = observation.status;
    return payload;
  });
  pi.registerCommand("dsco", {
    description: "Show local prefix stability; Pi's footer reports actual cache usage",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`${status}\nCompared at this hook only; later hooks may change the request. Pi's footer reports provider cache-read usage.`, "info");
    },
  });
}
