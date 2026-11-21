// Release builds use a same-origin bridge configured by the running server,
// not a gateway port frozen into JavaScript at compile time.
const configuredApiRoot = process.env.NEXT_PUBLIC_CAD_API_MODE === "same-origin" && typeof window !== "undefined"
  ? new URL("/api", window.location.origin).href
  : process.env.NEXT_PUBLIC_GEOMETRY_API_URL || "http://127.0.0.1:8788/api";

export const API_ROOT = configuredApiRoot.replace(/\/+$/, "");
export const API_ORIGIN = API_ROOT.endsWith("/api") ? API_ROOT.slice(0, -4) : API_ROOT;
export type ModelingAgentBackend = "gateway" | "python";
export const AGENT_BACKEND = (process.env.NEXT_PUBLIC_MODELING_AGENT_BACKEND || "gateway") as ModelingAgentBackend;
export const AGENT_API_ROOT = (process.env.NEXT_PUBLIC_MODELING_AGENT_API_URL || "http://127.0.0.1:8090/api/v1/agent").replace(/\/+$/, "");
