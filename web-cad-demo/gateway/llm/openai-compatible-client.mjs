import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertProviderUrl } from "./provider-config.mjs";
import { toolDefinitionsForProtocol } from "./cad-tools.mjs";

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_RESPONSE_BYTES = 2_000_000;
function maxRequestBytes() { const value = Number(process.env.AGENT_REQUEST_BODY_LIMIT_BYTES); return Number.isFinite(value) && value > 0 ? Math.min(value, 2_000_000) : 512_000; }
const protocolCache = new Map();
function providerKey(config) { return String(config.baseUrl || "") + "|" + String(config.model || ""); }
function protocolOrder(config) {
  if (config.protocol === "chat-completions") return ["chat-completions"];
  if (config.protocol === "responses") return ["responses"];
  const cached = protocolCache.get(providerKey(config));
  return cached ? [cached, cached === "responses" ? "chat-completions" : "responses"] : ["responses", "chat-completions"];
}
function rememberProtocol(config, protocol) { if (config.protocol === "auto") protocolCache.set(providerKey(config), protocol); }
function requestBytes(value) { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function transportFailure(error) {
  const code = error?.cause?.code || error?.code || "";
  return code === "EACCES" || code === "ECONNREFUSED" || code === "ENETUNREACH" || code === "EHOSTUNREACH" || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENETDOWN" || /fetch failed/i.test(String(error?.message || error || ""));
}
function curlConfigValue(value) {
  return JSON.stringify(String(value));
}
function curlPost(url, headers, body, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const configPath = path.join(os.tmpdir(), "occt-curl-" + process.pid + "-" + crypto.randomUUID() + ".conf");
    const seconds = Math.max(5, Math.ceil(Number(timeoutMs || DEFAULT_TIMEOUT_MS) / 1000));
    const config = [
      "url = " + curlConfigValue(url),
      "request = POST",
      "silent",
      "show-error",
      "no-buffer",
      "connect-timeout = " + Math.min(seconds, 30),
      "max-time = " + seconds,
      ...Object.entries(headers).map(([name, value]) => "header = " + curlConfigValue(name + ": " + value)),
      "data-binary = @-",
      "write-out = " + curlConfigValue("\n__OCCT_HTTP_STATUS__:%{http_code}\n"),
    ].join("\n") + "\n";
    try { fs.writeFileSync(configPath, config, { encoding: "utf8", mode: 0o600 }); } catch (error) { reject(error); return; }
    const curlPath = process.env.AGENT_CURL_PATH || "curl.exe";
    const child = spawn(curlPath, ["--config", configPath], { windowsHide: true, shell: /[.]cmd$/i.test(curlPath), stdio: ["pipe", "pipe", "pipe"] });
    const output = [];
    const errors = [];
    child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
    child.on("error", (error) => { fs.rmSync(configPath, { force: true }); reject(error); });
    child.on("close", (code) => {
      fs.rmSync(configPath, { force: true });
      const text = Buffer.concat(output).toString("utf8");
      const marker = "\n__OCCT_HTTP_STATUS__:";
      const markerIndex = text.lastIndexOf(marker);
      const statusText = markerIndex >= 0 ? text.slice(markerIndex + marker.length).trim() : "";
      const status = Number(statusText);
      const bodyText = markerIndex >= 0 ? text.slice(0, markerIndex) : text;
      if (!Number.isFinite(status) || status <= 0) {
        const message = Buffer.concat(errors).toString("utf8").trim() || "curl transport failed.";
        const transportError = new Error(message);
        transportError.code = code === null ? "PROVIDER_CURL_FAILED" : "PROVIDER_CURL_EXIT_" + code;
        reject(transportError);
        return;
      }
      resolve({ ok: status >= 200 && status < 300, status, body: null, viaCurl: true, text: async () => bodyText });
    });
    if (signal) signal.addEventListener("abort", () => child.kill(), { once: true });
    child.stdin.end(body);
  });
}
async function postProvider(config, protocol, payload, timeoutMs = DEFAULT_TIMEOUT_MS, signal) {
  const url = endpoint(config.baseUrl, protocol);
  const headers = { "Content-Type": "application/json", Authorization: "Bearer " + (config.apiKey || "") };
  const transport = String(process.env.AGENT_HTTP_TRANSPORT || "auto").toLowerCase();
  if (transport === "curl") return curlPost(url, headers, JSON.stringify({ ...payload, ...(payload.stream ? { stream: false } : {}) }), timeoutMs, signal);
  try {
    return await fetch(url, { method: "POST", signal, headers, body: JSON.stringify(payload) });
  } catch (error) {
    if (transport !== "auto" || !transportFailure(error) || process.env.AGENT_DISABLE_CURL_FALLBACK === "true") throw error;
    return curlPost(url, headers, JSON.stringify({ ...payload, ...(payload.stream ? { stream: false } : {}) }), timeoutMs, signal);
  }
}
function trimHistory(history, build) {
  const items = Array.isArray(history) ? [...history] : [];
  while (items.length > 1 && requestBytes(build(items)) > maxRequestBytes()) items.shift();
  return items;
}
function fallbackAllowed(error) { return !/HTTP (?:400|401|402|403|404|422)\b|insufficient balance|insufficient quota|billing|credit|invalid JSON|no CAD tool calls|legacy modeling_plan|Tool Calling/i.test(String(error?.message || error || "")); }

function endpoint(baseUrl, protocol) {
  const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${root}/v1/${protocol === "responses" ? "responses" : "chat/completions"}`;
}
export function describeProviderError(error, endpointUrl) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  if (/insufficient balance|insufficient quota|billing|credit|HTTP 402\b/i.test(rawMessage)) {
    const billing = new Error(`Provider account balance or quota is insufficient: ${endpointUrl}. Recharge the account or switch to another Provider.`);
    billing.code = "PROVIDER_INSUFFICIENT_BALANCE";
    billing.retryableByModel = false;
    return billing;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch failed/i.test(message)) { const network = new Error(`Unable to connect to the LLM service: ${endpointUrl}. Check the gateway network, proxy, firewall and TLS settings（网络、代理、防火墙或 TLS）。`); network.code = "PROVIDER_NETWORK_ERROR"; network.retryableByModel = false; network.cause = error; return network; }
  if (error?.name === "AbortError") return new Error(`大模型请求超时：${endpointUrl}`, { cause: error });
  return error instanceof Error ? error : new Error(message);
}
function normalizedHistoryItems(history = []) {
  if (!Array.isArray(history)) return [];
  const items = [];
  for (let index = 0; index < history.length;) {
    const message = history[index];
    if (!message || typeof message !== "object") { index += 1; continue; }
    const role = String(message.role || "");
    if (role !== "assistant" || !message.toolName) {
      if (role === "user" || role === "system" || role === "assistant") items.push({ type: "message", role, content: String(message.content || "") });
      index += 1;
      continue;
    }
    const calls = [];
    let cursor = index;
    while (cursor < history.length) {
      const candidate = history[cursor];
      if (!candidate || candidate.role !== "assistant" || !candidate.toolName) break;
      const id = String(candidate.toolCallId || ("call-" + Date.now() + "-" + cursor));
      calls.push({ id, message: candidate });
      cursor += 1;
    }
    const results = new Map();
    while (cursor < history.length && history[cursor]?.role === "tool") {
      const result = history[cursor];
      const id = String(result.toolCallId || result.toolName || "tool-call");
      if (!results.has(id)) results.set(id, result);
      cursor += 1;
    }
    const complete = calls.length > 0 && calls.every((call) => results.has(call.id));
    if (!complete) {
      items.push({ type: "message", role: "assistant", content: calls.map((call) => String(call.message.content || ("Tool call: " + call.message.toolName))).join("\n") });
    } else {
      items.push({ type: "tool-group", calls, results });
    }
    index = cursor;
  }
  return items;
}

function chatHistoryMessages(history = []) {
  return normalizedHistoryItems(history).flatMap((item) => {
    if (item.type === "message") return [{ role: item.role, content: item.content }];
    const first = item.calls[0]?.message;
    return [
      {
        role: "assistant",
        content: String(first?.content || ""),
        ...(first?.reasoningContent ? { reasoning_content: String(first.reasoningContent) } : {}),
        tool_calls: item.calls.map(({ id, message }) => ({ id, type: "function", function: { name: String(message.toolName), arguments: JSON.stringify(message.toolArguments || {}) } })),
      },
      ...item.calls.map(({ id }) => ({ role: "tool", tool_call_id: id, content: String(item.results.get(id)?.content || "") })),
    ];
  });
}

function responsesHistoryItems(history = []) {
  return normalizedHistoryItems(history).flatMap((item) => {
    if (item.type === "message") return [{ role: item.role, content: [{ type: "input_text", text: item.content }] }];
    return [
      ...item.calls.map(({ id, message }) => ({ type: "function_call", call_id: id, name: String(message.toolName), arguments: JSON.stringify(message.toolArguments || {}) })),
      ...item.calls.map(({ id }) => ({ type: "function_call_output", call_id: id, output: String(item.results.get(id)?.content || "") })),
    ];
  });
}
function requestBody(config, protocol, prompt, systemPrompt, stream, toolOptions = {}) {
  const schemaInstruction = "Use the supplied CAD function tools. Do not emit prose, modeling_plan JSON, or invent tool names. Call one or more declared tools when an action or query is required.";
  const safeSystemPrompt = String(systemPrompt || "").slice(0, Math.min(128_000, Math.floor(maxRequestBytes() * 0.45)));
  const safePrompt = String(prompt || "").slice(0, 32_000);
  if (protocol === "responses") {
    const promptMessage = !toolOptions.omitPrompt && safePrompt ? [{ role: "user", content: [{ type: "input_text", text: safePrompt }] }] : [];
    const build = (history) => ({
      model: config.model,
      input: [{ role: "system", content: [{ type: "input_text", text: safeSystemPrompt + "\n" + schemaInstruction }] }, ...history, ...promptMessage],
      stream,
      tools: toolDefinitionsForProtocol("responses", toolOptions),
    });
    return build(trimHistory(responsesHistoryItems(toolOptions.history), build));
  }
  const build = (history) => {
    const messages = [{ role: "system", content: safeSystemPrompt + "\n" + schemaInstruction }, ...history];
    if (!toolOptions.omitPrompt && safePrompt) messages.push({ role: "user", content: safePrompt });
    return { model: config.model, messages, stream, tools: toolDefinitionsForProtocol("chat-completions", toolOptions) };
  };
  return build(trimHistory(chatHistoryMessages(toolOptions.history), build));
}async function readLimited(response) {
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) throw new Error("LLM response exceeds the configured limit.");
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
function responseToolCalls(payload, protocol) {
  if (protocol === "responses") {
    return (payload.output || []).filter((item) => item?.type === "function_call" && typeof item.name === "string").map((item) => ({ id: item.call_id || item.id || `call-${crypto.randomUUID?.() || Date.now()}`, name: item.name, arguments: item.arguments || "{}" }));
  }
  const message = payload.choices?.[0]?.message || {};
  const reasoningContent = message.reasoning_content || message.reasoningContent || "";
  return (message.tool_calls || []).filter((item) => typeof item?.function?.name === "string").map((item) => ({ id: item.id || `call-${crypto.randomUUID?.() || Date.now()}`, name: item.function.name, arguments: item.function.arguments || "{}", ...(reasoningContent ? { reasoningContent } : {}) }));
}
function responseText(payload, protocol) {
  const calls = responseToolCalls(payload, protocol);
  if (calls.length) {
    if (calls.some((call) => call.name === "modeling_plan")) throw new Error("LLM returned legacy modeling_plan; CAD Tool Calling is required.");
    return JSON.stringify({ toolCalls: calls });
  }
  throw new Error("LLM returned no CAD tool calls.");
}

async function requestModelingPlanInternal(config, prompt, systemPrompt, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  assertProviderUrl(config.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
  const protocols = protocolOrder(config);
  let lastError;
  try {
    for (const protocol of protocols) {
      try {
        const response = await postProvider(config, protocol, requestBody(config, protocol, prompt, systemPrompt, false), timeoutMs, controller.signal);
        const text = await readLimited(response);
        const payload = text ? JSON.parse(text) : {};
        if (!response.ok) throw new Error(payload.error?.message || payload.error || `LLM request failed with HTTP ${response.status}.`);
        rememberProtocol(config, protocol);
        return { protocol, raw: payload, plan: JSON.parse(responseText(payload, protocol)) };
      } catch (error) { lastError = describeProviderError(error, endpoint(config.baseUrl, protocol)); if (config.protocol !== "auto" || controller.signal.aborted || !fallbackAllowed(lastError)) throw lastError; }
    }
    throw lastError || new Error("LLM request failed.");
  } finally { clearTimeout(timer); }
}

export async function requestModelingPlan(config, prompt, systemPrompt, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const correction = attempt === 0 ? "" : "\n\nProtocol correction: the previous response did not contain a CAD tool call. Call one or more declared CAD tools now; do not answer with prose or modeling_plan JSON.";
      return await requestModelingPlanInternal(config, prompt, `${systemPrompt}${correction}`, options);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/LLM returned no CAD tool calls|legacy modeling_plan|invalid JSON/i.test(message) || attempt === 1) throw error;
    }
  }
  throw lastError || new Error("LLM Tool Calling request failed.");
}

function responseContent(payload, protocol) {
  if (protocol === "responses") {
    if (typeof payload.output_text === "string") return payload.output_text;
    return (payload.output || []).flatMap((item) => item?.content || []).map((item) => item?.text || "").join("");
  }
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((item) => item?.text || "").join("");
  return "";
}

export async function requestCadToolTurn(config, prompt, systemPrompt, { signal, timeoutMs = DEFAULT_TIMEOUT_MS, mode = "edit", includeQueries = true, history = [], omitPrompt = false } = {}) {
  assertProviderUrl(config.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
  const protocols = protocolOrder(config);
  let lastError;
  try {
    for (const protocol of protocols) {
      try {
        const response = await postProvider(config, protocol, requestBody(config, protocol, prompt, systemPrompt, false, { includeQueries, mode, history, omitPrompt }), timeoutMs, controller.signal);
        const text = await readLimited(response);
        const payload = text ? JSON.parse(text) : {};
        if (!response.ok) throw new Error(payload.error?.message || payload.error || `LLM request failed with HTTP ${response.status}.`);
        rememberProtocol(config, protocol);
        return { protocol, raw: payload, toolCalls: responseToolCalls(payload, protocol), text: responseContent(payload, protocol) };
      } catch (error) {
        lastError = describeProviderError(error, endpoint(config.baseUrl, protocol));
        if (config.protocol !== "auto" || controller.signal.aborted || !fallbackAllowed(lastError)) throw lastError;
      }
    }
    throw lastError || new Error("LLM Tool Calling request failed.");
  } finally { clearTimeout(timer); }
}

export async function testProvider(config, options = {}) {
  const result = await requestCadToolTurn({ ...config, model: config.model }, "For connectivity testing only, call create_box with width 1, depth 1 and height 1. Do not answer with prose.", "You are a connectivity test. Return exactly one declared CAD tool call; the gateway will not execute it.", { ...options, mode: "edit", includeQueries: false });
  if (!result.toolCalls?.length) throw new Error("Provider did not return a CAD Tool Calling response.");
  return { ok: true, protocol: result.protocol, model: config.model, capabilities: { toolCalling: true, protocol: result.protocol, reasoningContent: result.toolCalls.some((call) => Boolean(call.reasoningContent)) } };
}function streamDelta(payload, protocol) {
  if (protocol === "chat-completions") return payload.choices?.[0]?.delta?.content || payload.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments || "";
  if (payload.type === "response.function_call_arguments.delta") return payload.delta || "";
  return payload.delta || payload.output_text?.delta || payload.item?.content?.[0]?.text || payload.item?.arguments || "";
}

async function streamModelingPlanInternal(config, prompt, systemPrompt, { signal, timeoutMs = DEFAULT_TIMEOUT_MS, onDelta = () => {} } = {}) {
  assertProviderUrl(config.baseUrl);
  const protocols = protocolOrder(config);
  let lastError;
  for (const protocol of protocols) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      const response = await postProvider(config, protocol, requestBody(config, protocol, prompt, systemPrompt, true), timeoutMs, controller.signal);
      if (!response.ok) { const text = await readLimited(response); let payload = {}; try { payload = JSON.parse(text); } catch {} throw new Error(payload.error?.message || payload.error || `LLM request failed with HTTP ${response.status}.`); }
      if (!response.body) {
        const text = await response.text();
        const payload = text ? JSON.parse(text) : {};
        const calls = responseToolCalls(payload, protocol);
        if (calls.length) return { protocol, plan: { toolCalls: calls } };
        throw new Error("LLM streaming response has no CAD tool calls.");
      }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; let accumulated = ""; const toolCalls = new Map();
      const appendTool = (index, name, args) => {
        const key = String(index ?? toolCalls.size);
        const current = toolCalls.get(key) || { id: `call-${key}`, name: name || "", arguments: "" };
        if (name) current.name = name;
        if (args) current.arguments += args;
        toolCalls.set(key, current);
      };
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/); buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim(); if (!data || data === "[DONE]") continue;
          let payload; try { payload = JSON.parse(data); } catch { continue; }
          const delta = payload.choices?.[0]?.delta;
          if (protocol === "chat-completions" && Array.isArray(delta?.tool_calls)) {
            for (const call of delta.tool_calls) appendTool(call.index, call.function?.name, call.function?.arguments);
          } else if (protocol === "responses") {
            if (payload.type === "response.output_item.added" && payload.item?.type === "function_call") appendTool(payload.output_index, payload.item.name, payload.item.arguments);
            else if (payload.type === "response.function_call_arguments.delta") appendTool(payload.output_index, "", payload.delta);
          }
          const textDelta = delta?.content || (protocol === "responses" && payload.type !== "response.function_call_arguments.delta" ? payload.item?.content?.[0]?.text : "") || "";
          if (textDelta) { accumulated += textDelta; onDelta(textDelta); }
        }
      }      if (toolCalls.size) {
        const calls = [...toolCalls.values()];
        if (calls.some((call) => call.name === "modeling_plan")) throw new Error("LLM returned legacy modeling_plan; CAD Tool Calling is required.");
        return { protocol, plan: { toolCalls: calls } };
      }
      throw new Error("LLM returned no CAD tool calls.");
    } catch (error) { lastError = describeProviderError(error, endpoint(config.baseUrl, protocol)); if (config.protocol !== "auto" || signal?.aborted) throw lastError; }
    finally { clearTimeout(timer); }
  }
  throw lastError || new Error("LLM streaming request failed.");
}
export async function streamModelingPlan(config, prompt, systemPrompt, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const correction = attempt === 0 ? "" : "\n\nProtocol correction: the previous response did not contain a CAD tool call. Call one or more declared CAD tools now; do not answer with prose or modeling_plan JSON.";
      return await streamModelingPlanInternal(config, prompt, `${systemPrompt}${correction}`, options);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/LLM returned no CAD tool calls|legacy modeling_plan|invalid JSON/i.test(message) || attempt === 1) throw error;
    }
  }
  throw lastError || new Error("LLM Tool Calling stream failed.");
}
