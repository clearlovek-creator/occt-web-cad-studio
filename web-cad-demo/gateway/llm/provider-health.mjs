const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 15_000;

function messageOf(error) {
  return String(error instanceof Error ? error.message : error || "");
}
function transient(error) {
  return /timeout|timed out|fetch failed|network|HTTP (?:408|425|429|5\d\d)\b/i.test(messageOf(error));
}
function deterministic(error) {
  return /invalid JSON|no CAD tool calls|legacy modeling_plan|Tool Calling|unsupported|insufficient balance|insufficient quota|billing|credit|HTTP 402\\b|401|403|404|invalid arguments|schema/i.test(messageOf(error));
}

export class ProviderCircuitOpenError extends Error {
  constructor(providerId, retryAfterMs) {
    super("Provider " + providerId + " is temporarily unavailable; retry after " + Math.ceil(retryAfterMs / 1000) + "s.");
    this.name = "ProviderCircuitOpenError";
    this.code = "PROVIDER_CIRCUIT_OPEN";
    this.providerId = providerId;
    this.retryAfterMs = Math.max(0, Math.ceil(retryAfterMs));
  }
}

export class ProviderHealthRegistry {
  constructor({ failureThreshold = Number(process.env.AGENT_PROVIDER_FAILURE_THRESHOLD) || DEFAULT_FAILURE_THRESHOLD, cooldownMs = Number(process.env.AGENT_PROVIDER_COOLDOWN_MS) || DEFAULT_COOLDOWN_MS } = {}) {
    this.failureThreshold = Math.max(1, Math.min(10, Math.trunc(failureThreshold)));
    this.cooldownMs = Math.max(10, Math.min(300_000, Math.trunc(cooldownMs)));
    this.states = new Map();
  }
  state(providerId) {
    const id = String(providerId || "unknown");
    if (!this.states.has(id)) this.states.set(id, { status: "closed", failures: 0, openedAt: 0, lastError: "", lastSuccessAt: 0, halfOpen: false });
    return this.states.get(id);
  }
  snapshot(providerId) {
    const state = this.state(providerId);
    const remaining = state.status === "open" ? Math.max(0, state.openedAt + this.cooldownMs - Date.now()) : 0;
    return { providerId: String(providerId || "unknown"), status: remaining === 0 && state.status === "open" ? "half-open" : state.status, failures: state.failures, retryAfterMs: remaining, lastError: state.lastError || null, lastSuccessAt: state.lastSuccessAt || null };
  }
  canUse(provider) {
    if (!provider?.id) return false;
    const state = this.state(provider.id);
    if (state.status !== "open") return !state.halfOpen;
    if (Date.now() - state.openedAt < this.cooldownMs) return false;
    if (state.halfOpen) return false;
    return true;
  }
  assertAvailable(provider) {
    if (!provider?.id) throw new Error("Provider is not configured.");
    const state = this.state(provider.id);
    if (state.status === "open") {
      const remaining = state.openedAt + this.cooldownMs - Date.now();
      if (remaining > 0) throw new ProviderCircuitOpenError(provider.id, remaining);
      if (state.halfOpen) throw new ProviderCircuitOpenError(provider.id, this.cooldownMs);
      state.halfOpen = true;
    } else if (state.halfOpen) {
      throw new ProviderCircuitOpenError(provider.id, this.cooldownMs);
    }
  }
  success(provider) {
    if (!provider?.id) return;
    const state = this.state(provider.id);
    state.status = "closed";
    state.failures = 0;
    state.openedAt = 0;
    state.halfOpen = false;
    state.lastError = "";
    state.lastSuccessAt = Date.now();
  }
  failure(provider, error) {
    if (!provider?.id || !transient(error) || deterministic(error)) return;
    const state = this.state(provider.id);
    state.failures += 1;
    state.lastError = messageOf(error).slice(0, 300);
    state.halfOpen = false;
    if (state.failures >= this.failureThreshold) {
      state.status = "open";
      state.openedAt = Date.now();
    }
  }
  choose(providers = [], { providerId } = {}) {
    const enabled = providers.filter((provider) => provider && provider.enabled !== false);
    if (providerId) return enabled.find((provider) => provider.id === String(providerId)) || null;
    const healthy = enabled.filter((provider) => this.canUse(provider));
    return (healthy.length ? healthy : enabled).sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) || String(a.id).localeCompare(String(b.id)))[0] || null;
  }
  list() {
    return [...this.states.keys()].map((providerId) => this.snapshot(providerId));
  }
}

export { transient as isTransientProviderError };