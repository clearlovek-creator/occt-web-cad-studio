"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { executeModelingCommand } from "../modeling/runtime";
import { modelingController } from "../modeling/runtime";
import { useModelingController } from "../modeling/modeling-controller";

export type PropertyTarget = { kind: "body" | "face" | "edge"; bodyId: string; topologyId?: string; topologyRevision?: number; bodyIdentity?: string; topologyIdentity?: string } | null;
export type PropertyField = { key: string; label: string; type: "bool" | "int" | "double" | "expression" | "enum" | "vector3"; required?: boolean; options?: string[]; default?: unknown };
export type PropertyType = { typeId: string; key: string; name: string; description: string; targetScope: "project" | "body" | "face" | "edge"; association: "none" | "optional" | "required"; targetMode?:"single"|"multiple";splitPolicy?:"review"|"all-descendants";fields: PropertyField[]; version: number };
export type PropertyInstance = { instanceId: string; typeId: string; typeKey: string; typeVersion: number; name: string; value: Record<string, unknown>; target: PropertyTarget; targets?:NonNullable<PropertyTarget>[];state: string; stateReason?: string; association?: { status: string; anchor?: PropertyTarget;anchors?:NonNullable<PropertyTarget>[]; candidates: NonNullable<PropertyTarget>[];candidateCount?:number;candidatesTruncated?:boolean;members?:Array<{index:number;anchor:NonNullable<PropertyTarget>;state:string;status:string;reason?:string;candidateCount:number;candidateIndexes:number[]}> } };
export type PropertySchema = { schemaVersion?:1|2;types: PropertyType[]; instances: PropertyInstance[]; stateToken?: string; stateSequence?:number };
export const instanceTargets=(instance:Pick<PropertyInstance,'target'|'targets'>|undefined):NonNullable<PropertyTarget>[]=>instance?.targets || (instance?.target?[instance.target]:[]);
export type PropertyMigration = {type:PropertyType;instanceCount:number;addedFields:PropertyField[];changed:boolean;examples:Array<{instanceId:string;name:string;addedValues:Record<string,unknown>}>};
export type SchemaResult = { ok: true; documentId?:string;revision?:number;stateSequence?:number;stateToken?: string; migration?:PropertyMigration; type?: PropertyType; instance?: PropertyInstance; types?: PropertyType[]; instances?: PropertyInstance[]; propertySchema?: PropertySchema; package?: unknown; vectorValue?: number[]; error?: string };
const CHANGED = "cad:property-schema-changed";
export async function schemaCommand(operation: string, inputs: Record<string, unknown> = {}, parameters: Record<string, unknown> = {}, baseStateToken?: string) {
  let result:SchemaResult;
  try{result = await executeModelingCommand<SchemaResult>({ operation, inputs, parameters, ...(baseStateToken?{baseStateToken}:{}) });}
  catch(reason){if((reason as {code?:string})?.code==="PROJECT_STATE_CONFLICT")window.dispatchEvent(new Event(CHANGED));throw reason;}
  if (!operation.endsWith(".list") && operation !== "property.package.export" && !operation.endsWith(".preview")) window.dispatchEvent(new Event(CHANGED));
  return result;
}
export function usePropertySchema(revision?: number, documentId?: string) {
  const controller=useModelingController(modelingController);
  const currentRevision=revision ?? controller.revision;
  const currentDocument=documentId ?? controller.documentId;
  const [schema, setSchema] = useState<PropertySchema>({ types: [], instances: [] });
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const ticket = ++sequence.current;
    try { const result = await schemaCommand("property.type.list");
      const next = result.propertySchema || { types: result.types || [], instances: (await schemaCommand("property.instance.list")).instances || [] };
      if (ticket === sequence.current && modelingController.acceptsState(result)) { setSchema(next); setError(null); return next; }
    } catch (reason) { if (ticket === sequence.current) setError(reason instanceof Error ? reason.message : "属性数据读取失败"); }
    return null;
  }, []);
  useEffect(() => { let active = true; queueMicrotask(() => { if (active) void refresh(); }); window.addEventListener(CHANGED, refresh); return () => { active = false; sequence.current++; window.removeEventListener(CHANGED, refresh); }; }, [refresh, currentRevision, currentDocument, controller.history?.eventId]);
  return { ...schema, error, refresh };
}
