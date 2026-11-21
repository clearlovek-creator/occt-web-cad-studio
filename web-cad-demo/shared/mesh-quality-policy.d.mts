export type MeshQualityPolicy='warning'|'strict';
export type MeshAcceptanceSettings={version:1;qualityPolicy:MeshQualityPolicy;qualityThreshold:number};
export function normalizeMeshQualityPolicy(value:unknown):MeshQualityPolicy;
export function meshAcceptanceSettings(options:unknown):MeshAcceptanceSettings;
export function validateMeshAcceptanceSettings(value:unknown,options:unknown):void;
