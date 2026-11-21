"use client";
import {useEffect,useMemo,useSyncExternalStore} from 'react';
import {API_ROOT} from '../api-config.ts';
import type {MeshJobPayload} from './mesh.ts';
import {ProjectMeshTaskStore} from './project-mesh-task-store.ts';
import {MeshStrategyClient} from './mesh-strategy-client.ts';
import {modelingController} from '../modeling/runtime.ts';

/** One observable task owner per workspace, independent of the tools dialog. */
export function useProjectMeshJobs(documentId:string,onResult:(result:MeshJobPayload)=>void){
  const store=useMemo(()=>new ProjectMeshTaskStore({documentId,apiRoot:API_ROOT}),[documentId]);
  const snapshot=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot);
  const strategies=useMemo(()=>new MeshStrategyClient({documentId,current:()=>modelingController.getSnapshot(),execute:input=>{if(modelingController.getSnapshot().documentId!==documentId)return Promise.reject(Error('工程已切换，未发送旧方案操作。'));return modelingController.execute(input);},getTask:key=>modelingController.getSnapshot().modelingTasks.find(item=>item.task.documentId===documentId&&item.task.requestKey===key)?.task,reconcile:async(key,operation)=>{await modelingController.refreshModelingTasks(documentId);const task=modelingController.getSnapshot().modelingTasks.find(item=>item.task.documentId===documentId&&item.task.requestKey===key)?.task;if(!task)return {status:'pending'};const fresh=await modelingController.checkModelingTask(task.taskId);if(fresh.documentId!==documentId||fresh.requestKey!==key||fresh.operation!==operation)throw Error('原方案任务身份不一致，未采用核对结果。');if(fresh.phase==='succeeded'){try{return {status:'committed',result:await modelingController.readModelingTaskResult(fresh.taskId)};}catch{return {status:'committed'};}}return {status:['failed','cancelled'].includes(fresh.phase)&&(fresh.restored===true||fresh.unchanged===true||fresh.execution==='not-started')?'not-committed':'pending'};}}),[documentId]);
  const strategyState=useSyncExternalStore(strategies.subscribe,strategies.getSnapshot,strategies.getSnapshot);
  useEffect(()=>strategies.start(),[strategies]);
  useEffect(()=>{let token=modelingController.getSnapshot().stateToken;const unsubscribe=modelingController.subscribe(()=>{const state=modelingController.getSnapshot();if(state.documentId===documentId&&state.stateToken!==token){token=state.stateToken;void strategies.refresh();void store.refresh();}});return()=>{unsubscribe();};},[documentId,strategies,store]);
  useEffect(()=>{store.setOnResult(onResult);},[store,onResult]);
  useEffect(()=>store.start(),[store]);
  return {...snapshot,create:store.create,cancel:store.cancel,select:store.select,refresh:store.refresh,recoverCatalog:store.recoverCatalog,recoverCompletion:store.recoverCompletion,checkCompletionRecovery:store.checkCompletionRecovery,resumeOptimization:store.resumeOptimization,checkOptimizationRecovery:store.checkOptimizationRecovery,prepareTetra:store.prepareTetra,discardTetra:store.discardTetra,checkTetra:store.checkTetra,setSetupRoute:store.setSetupRoute,setTetraDraft:store.setTetraDraft,setSizingDraft:store.setSizingDraft,setSetupRepairMode:store.setSetupRepairMode,setSetupQualityThreshold:store.setSetupQualityThreshold,setSetupStrictQuality:store.setSetupStrictQuality,setSetupOptimization:store.setSetupOptimization,setStrategyName:store.setStrategyName,setSelectedStrategy:store.setSelectedStrategy,loadStrategy:store.loadStrategy,strategies,strategyState};
}
export type ProjectMeshTasks=ReturnType<typeof useProjectMeshJobs>;
