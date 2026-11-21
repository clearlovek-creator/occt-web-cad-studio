import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";

const PROVIDER_FILE = "agent-providers.enc";
const PRIVATE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function json(value) { return JSON.stringify(value); }
function secretKey(secret, salt = "web-cad-agent-provider") { return crypto.scryptSync(secret, salt, 32); }

export function normalizeProvider(input = {}) {
  const id = String(input.id || crypto.randomUUID()).trim();
  const name = String(input.name || id).trim().slice(0, 80);
  const baseUrl = String(input.baseUrl || "").trim().replace(/\/+$/, "");
  const model = String(input.model || "").trim().slice(0, 160);
  const protocol = ["auto", "responses", "chat-completions"].includes(input.protocol) ? input.protocol : "auto";
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) throw new Error("Provider id is invalid.");
  if (!name) throw new Error("Provider name is required.");
  if (!baseUrl) throw new Error("Provider base URL is required.");
  const parsed = new URL(baseUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("Provider URL must use http or https.");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Provider URL cannot contain credentials, query or hash.");
  if (!model) throw new Error("Provider model is required.");
  const priority = Number.isFinite(Number(input.priority)) ? Math.max(0, Math.min(100, Math.trunc(Number(input.priority)))) : 0;
  const toolCalling = true;
  const capabilities = { toolCalling: true, verified: input.capabilities?.verified === true, protocol: protocol === "auto" ? null : protocol, ...(input.capabilities && typeof input.capabilities === "object" ? input.capabilities : {}) };
  return { id, name, baseUrl, model, protocol, priority, toolCalling, capabilities, enabled: input.enabled !== false, createdAt: input.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
}

export function assertProviderUrl(baseUrl, { allowPrivate = process.env.AGENT_ALLOW_PRIVATE_URL === "true" } = {}) {
  const parsed = new URL(baseUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("Provider URL must use http or https.");
  const hostname = parsed.hostname.toLowerCase();
  if (!allowPrivate && (PRIVATE_HOSTS.has(hostname) || net.isIP(hostname) === 4 && (hostname.startsWith("10.") || hostname.startsWith("192.168.") || hostname.startsWith("172.")))) {
    throw new Error("Private provider URLs are disabled. Set AGENT_ALLOW_PRIVATE_URL=true for local development.");
  }
  return parsed;
}

function encrypt(value, secret) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(secret, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(json(value), "utf8"), cipher.final()]);
  return JSON.stringify({ version: 1, salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: ciphertext.toString("base64") });
}
function decrypt(value, secret) {
  const envelope = JSON.parse(value);
  if (envelope.version !== 1) throw new Error("Unsupported provider configuration version.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(secret, Buffer.from(envelope.salt, "base64")), Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8"));
}

export function selectProvider(providers = [], { providerId, defaultProviderId = process.env.AGENT_DEFAULT_PROVIDER } = {}) {
  const enabled = providers.filter((provider) => provider && provider.enabled !== false);
  if (providerId) return enabled.find((provider) => provider.id === String(providerId)) || null;
  if (defaultProviderId) {
    const preferred = enabled.find((provider) => provider.id === String(defaultProviderId));
    if (preferred) return preferred;
  }
  return [...enabled].sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) || String(a.updatedAt || "").localeCompare(String(b.updatedAt || "")) || String(a.id).localeCompare(String(b.id)))[0] || null;
}

export class ProviderStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, PROVIDER_FILE);
    this.secret = process.env.AGENT_CONFIG_SECRET || "web-cad-demo-local-provider-secret";
    fs.mkdirSync(dataDir, { recursive: true });
  }
  read() {
    if (!fs.existsSync(this.filePath)) return [];
    try { const value = decrypt(fs.readFileSync(this.filePath, "utf8"), this.secret); return Array.isArray(value) ? value.map((item) => ({ ...item, toolCalling: true, capabilities: { ...(item.capabilities || {}), toolCalling: true, verified: item.capabilities?.verified === true } })) : []; }
    catch (error) { throw new Error(`Provider configuration cannot be decrypted: ${error.message}`); }
  }
  write(providers) { fs.writeFileSync(this.filePath, encrypt(providers, this.secret), { mode: 0o600 }); }
  list() { return this.read().map((item) => ({ ...item, apiKeyConfigured: Boolean(item.apiKey), apiKey: undefined })); }
  get(id) { return this.read().find((item) => item.id === id); }
  save(input) {
    const existing = this.get(input.id);
    const normalized = normalizeProvider(input);
    const apiKey = input.apiKey === undefined || input.apiKey === "" ? existing?.apiKey || "" : String(input.apiKey).trim();
    if (apiKey.length > 4096) throw new Error("Provider API key is too long.");
    const provider = { ...normalized, apiKey };
    const providers = this.read().filter((item) => item.id !== provider.id);
    providers.push(provider);
    this.write(providers);
    return { ...provider, apiKey: undefined, apiKeyConfigured: Boolean(apiKey) };
  }
  updateCapabilities(id, capabilities = {}) {
    const providers = this.read();
    const index = providers.findIndex((item) => item.id === String(id));
    if (index < 0) return null;
    providers[index] = { ...providers[index], capabilities: { ...(providers[index].capabilities || {}), ...capabilities, verified: capabilities.verified === true, toolCalling: capabilities.toolCalling === true } , updatedAt: new Date().toISOString() };
    this.write(providers);
    return { ...providers[index], apiKey: undefined, apiKeyConfigured: Boolean(providers[index].apiKey) };
  }
  remove(id) { this.write(this.read().filter((item) => item.id !== id)); }
}
