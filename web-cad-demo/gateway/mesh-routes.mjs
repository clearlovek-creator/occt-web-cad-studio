import path from "node:path";
import { mkdir } from "node:fs/promises";
import { MeshWorkerError } from "./mesh-worker-client.mjs";
import {normalizeMeshSizing} from '../shared/mesh-sizing.mjs';
import {normalizeMeshOptimization} from '../shared/mesh-optimization.mjs';

const pathToOperation = new Map([
  ["/api/mesh/preflight", "mesh.preflight"],
  ["/api/mesh/create", "mesh.create"],
  ["/api/mesh/repair", "mesh.repair"],
  ["/api/mesh/intersections", "mesh.intersections"],
  ["/api/mesh/quality", "mesh.quality"],
]);

export function meshOperationFor(method, pathname) {
  if (method !== "POST") return "";
  return pathToOperation.get(pathname) || "";
}

function defaultOutputName(operation, inputPath, requestId) {
  const extension = path.extname(inputPath).toLowerCase();
  if (operation === "mesh.repair" || operation === "mesh.intersections") {
    if ([".step", ".stp"].includes(extension)) return `repaired-${requestId || Date.now()}.step`;
    if (extension === ".msh") return `repaired-${requestId || Date.now()}.msh`;
    if ([".stl", ".mesh"].includes(extension)) return `repaired-${requestId || Date.now()}${extension}`;
    return `repaired-${requestId || Date.now()}.brep`;
  }
  return `mesh-${Date.now()}-${requestId || "job"}.msh`;
}

function managedOutputPath(input, operation, requestId, outputDirectory) {
  const requestedName = path.basename(String(input.outputPath || defaultOutputName(operation, input.inputPath, requestId)));
  if (!requestedName || requestedName === "." || requestedName === "..") throw new Error("outputPath is invalid.");
  const root = path.resolve(outputDirectory);
  const output = path.resolve(root, requestedName);
  if (output !== root && !output.startsWith(`${root}${path.sep}`)) throw new Error("outputPath is outside the mesh output directory.");
  return output;
}

function copyOptional(parameters, input, key, convert = value => value) {
  if (input[key] !== undefined && input[key] !== null) parameters[key] = convert(input[key]);
}

export function buildMeshCommand(operation, input, requestId = "", options = {}) {
  if (!operation) throw new Error("Unknown mesh route.");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Mesh request must be an object.");
  const inputPath = String(input.inputPath || "").trim();
  if (!inputPath) throw new Error("inputPath is required.");
  const parameters = { inputPath };
  if (["mesh.create", "mesh.repair", "mesh.intersections"].includes(operation)) {
    const outputPath = options.outputDirectory
      ? managedOutputPath(input, operation, requestId, options.outputDirectory)
      : String(input.outputPath || "").trim();
    if (!outputPath) throw new Error("outputPath is required.");
    parameters.outputPath = outputPath;
  }
  if (operation === "mesh.create") parameters.dimension = Number.isInteger(input.dimension) ? input.dimension : 3;
  if(operation==='mesh.create'&&input.sizing!==undefined)parameters.sizing=normalizeMeshSizing(input.sizing);
  if(operation==='mesh.create'&&input.optimization!==undefined)parameters.optimization=normalizeMeshOptimization(input.optimization);
  if (operation === "mesh.create" && Array.isArray(input.bodyIds)) parameters.bodyIds = input.bodyIds.map((value) => String(value));
  if (operation === "mesh.create" && Array.isArray(input.bodyGeometry)) parameters.bodyGeometry = input.bodyGeometry;
  if (operation === "mesh.create" && input.bodyManifest && typeof input.bodyManifest === "object" && !Array.isArray(input.bodyManifest)) parameters.bodyManifest = input.bodyManifest;
  if (operation === "mesh.create" && options.qualityOutputPath) parameters.qualityOutputPath = options.qualityOutputPath;
  if (operation === "mesh.create" && options.renderOutputPath) parameters.renderOutputPath = options.renderOutputPath;
  if (["mesh.create", "mesh.repair", "mesh.intersections"].includes(operation)) {
    copyOptional(parameters, input, "repairMode", value => String(value));
    copyOptional(parameters, input, "resolveIntersections", value => Boolean(value));
    copyOptional(parameters, input, "surfaceAngle", value => Number(value));
    copyOptional(parameters, input, "tolerance", value => Number(value));
  }
  if (["mesh.create", "mesh.quality"].includes(operation)) {
    copyOptional(parameters, input, "qualityName", value => String(value));
    copyOptional(parameters, input, "qualityThreshold", value => Number(value));
  }
  return { protocolVersion: 1, requestId: String(requestId || ""), operation, parameters };
}

export async function handleMeshRoute({ method, pathname, input, requestId, client, outputDirectory, qualityOutputPath, renderOutputPath }) {
  const operation = meshOperationFor(method, pathname);
  if (!operation) return null;
  try {
    if (["mesh.create", "mesh.repair", "mesh.intersections"].includes(operation) && outputDirectory)
      await mkdir(outputDirectory, { recursive: true });
    const command = buildMeshCommand(operation, input, requestId, { outputDirectory, qualityOutputPath, renderOutputPath });
    const result = await client.request(command);
    return { status: 200, payload: result };
  } catch (error) {
    const code = error instanceof MeshWorkerError || typeof error?.code === "string" ? error.code : "MESH_REQUEST_FAILED";
    const status = code === "MESH_WORKER_TIMEOUT" ? 504 : 503;
    return { status, payload: { ok: false, protocolVersion: 1, requestId: String(requestId || ""), code, error: error instanceof Error ? error.message : "Mesh request failed.", recoverable: true } };
  }
}
