export type MeshOptimization={version:1;method:'netgen';iterations:number};
export type MeshOptimizationReport={version:1;method:'netgen';iterations:number;before:{minQuality:number;averageQuality:number;badCount:number;tetraCount:number};after:{minQuality:number;averageQuality:number;badCount:number;tetraCount:number}};
export const MESH_OPTIMIZATION_SCHEMA:Record<string,unknown>;
export function normalizeMeshOptimization(value:unknown):MeshOptimization|undefined;
export function validateMeshOptimizationReport(report:unknown,requested:unknown,mesh:unknown):void;
