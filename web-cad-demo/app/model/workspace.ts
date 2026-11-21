"use client";
import {useCallback,useEffect,useState} from "react";
import {modelingController} from "../modeling/runtime";
import type {WorkspaceMetadata} from "../modeling/modeling-controller";
export function useWorkspaceMetadata(documentId:string,revision:number|null|undefined,activity:string) {
  const [project,setProject]=useState<WorkspaceMetadata|null>(null),[error,setError]=useState<string|null>(null),[generation,setGeneration]=useState(0);
  const refresh=useCallback(()=>setGeneration(value=>value+1),[]);
  useEffect(()=>{let active=true;const timer=setTimeout(()=>{void modelingController.getWorkspaceMetadata(documentId).then(value=>{if(active){setProject(value);setError(null);}}).catch(reason=>{if(active)setError(reason instanceof Error ? reason.message : "工程状态不可用");});},150);return ()=>{active=false;clearTimeout(timer);};},[documentId,revision,activity,generation]);
  return {project:project?.documentId===documentId ? project:null,error,refresh};
}
