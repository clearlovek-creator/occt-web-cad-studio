"use client";
import {useEffect,useState} from 'react';
import {MESH_QUERY_TIMEOUTS} from '../../shared/mesh-query-timeouts.mjs';

/** Read-only panel query. A new identity hides old rows before its effect runs. */
export function useMeshQuery<T>(url:string,enabled:boolean,version:string,parse:(value:unknown)=>T,timeoutMs:number=MESH_QUERY_TIMEOUTS.controlMs){
  const identity=JSON.stringify([url,enabled,version,timeoutMs]);
  const [settled,setSettled]=useState<{identity:string;data:T|null;error:string}|null>(null);
  const current=settled?.identity===identity?settled:null;
  useEffect(()=>{
    if(!enabled)return;
    const controller=new AbortController();let live=true,timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
    void fetch(url,{signal:controller.signal}).then(async response=>{
      let payload:unknown;try{payload=JSON.parse(await response.text());}catch{throw Error(`网格服务响应无效（HTTP ${response.status}）。`);}
      if(!response.ok||!payload||typeof payload!=='object'||(payload as {ok?:unknown}).ok!==true)throw Error(typeof(payload as {error?:unknown})?.error==='string'?(payload as {error:string}).error:'网格报告读取失败。');
      const data=parse(payload);if(live)setSettled({identity,data,error:''});
    }).catch(reason=>{if(live)setSettled({identity,data:null,error:timedOut?'网格报告读取超时，可重新读取；原始网格保留。':reason instanceof Error?reason.message:'网格报告读取失败。'});}).finally(()=>clearTimeout(timer));
    return()=>{live=false;controller.abort();clearTimeout(timer);};
  },[enabled,url,identity,parse,timeoutMs]);
  return {data:enabled?current?.data??null:null,loading:enabled&&!current,error:enabled?current?.error??'':''};
}
