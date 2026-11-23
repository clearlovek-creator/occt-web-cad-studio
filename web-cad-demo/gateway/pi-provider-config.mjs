function envSuffix(id) {
  return String(id || "provider").replace(/[^A-Za-z0-9]/g, "_").toUpperCase().slice(0, 48) || "PROVIDER";
}

function piApi(protocol) {
  return protocol === "responses" ? "openai-responses" : "openai-completions";
}

export function buildPiProviderConfig(providers = []) {
  const configured = {};
  const environment = {};
  for (const provider of providers) {
    if (provider.enabled === false || !provider.id || !provider.baseUrl || !provider.model) continue;
    const keyVariable = `PI_CAD_PROVIDER_${envSuffix(provider.id)}_API_KEY`;
    if (provider.apiKey) environment[keyVariable] = provider.apiKey;
    const baseUrl = String(provider.baseUrl).trim().replace(/\/(?:chat\/completions|responses)\/?$/i, "").replace(/\/+$/, "");
    const api = piApi(provider.protocol);
    configured[String(provider.id).slice(0, 80)] = {
      name: String(provider.name || provider.id),
      baseUrl,
      api,
      ...(provider.apiKey ? { apiKey: `$${keyVariable}`, authHeader: true } : {}),
      models: [{
        id: String(provider.model),
        name: String(provider.model),
        api,
        baseUrl,
        reasoning: false,
        input: provider.supportsImages === true ? ["text", "image"] : ["text"],
        contextWindow: 128_000,
        maxTokens: 8_192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    };
  }
  return { models: { $schema: "https://pi.dev/schemas/models.schema.json", providers: configured }, environment };
}
