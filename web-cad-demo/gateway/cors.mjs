const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function effectivePort(url) {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

export function resolveCorsOrigin(requestOrigin, configuredOrigin) {
  if (!requestOrigin) return configuredOrigin;
  if (requestOrigin === configuredOrigin) return configuredOrigin;
  try {
    const requested = new URL(requestOrigin);
    const configured = new URL(configuredOrigin);
    const sameLocalDevPort = requested.protocol === configured.protocol
      && effectivePort(requested) === effectivePort(configured)
      && LOCAL_HOSTS.has(requested.hostname)
      && LOCAL_HOSTS.has(configured.hostname);
    return sameLocalDevPort ? requestOrigin : configuredOrigin;
  } catch {
    return configuredOrigin;
  }
}

export function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Request-Id, X-File-Name, X-Base-State-Token, X-Base-Revision, X-Cad-Task-Id, Accept, Authorization",
    "Vary": "Origin",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  };
}
