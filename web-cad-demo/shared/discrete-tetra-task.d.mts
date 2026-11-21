export type DiscreteTetraSettings={version:1;source:{linearDeflection:number;angularDeflection:number;maxTriangles:number};repair:{snapGridSize:number;iterations:number;tolerance:number};meshSize:number;quality:{version:1;mode:'strict'|'diagnostic';threshold:number;maxBadFraction:number};optimization?:{version:1;method:'gmsh'|'netgen'|'relocate';iterations:number;acceptance:'non-regressing'};materialPolicy:'require-consistent'};
export const DISCRETE_TETRA_TASK_KIND:'discrete-tetra';
export const CAD_DISCRETE_TETRA_SOURCE_BYTES:number;
export const CAD_DISCRETE_TETRA_RESULT_BYTES:number;
export function normalizeDiscreteTetraSettings(value?:unknown):DiscreteTetraSettings;
