"use client";
import {createContext,useContext,useState,useSyncExternalStore,type ReactNode} from "react";
import {CommandEditSession} from "./command-edit-session";
import {modelingController,executeModelingCommand} from "./runtime";
import {useModelingController} from "./modeling-controller";

const Context=createContext<CommandEditSession|null>(null);
export function useEditorCommands(){const session=useContext(Context);return {session,execute:session?.execute || executeModelingCommand,executeBatch:session?.executeBatch || modelingController.executeBatch.bind(modelingController)};}

export function CommandEditScope({session,enabled,onReload,children}:{session:CommandEditSession|null;enabled?:boolean;onReload:()=>Promise<void>;children:ReactNode}){
  useModelingController(modelingController);
  useSyncExternalStore(session?.subscribe || (()=>()=>{}),session?.getSnapshot || (()=>0),()=>0);
  const [loading,setLoading]=useState(false),[error,setError]=useState<string|null>(null);
  if(!session)return enabled?<section className="command-edit-scope"><p role="status">正在载入完整工程状态…</p><fieldset className="command-edit-fields" disabled>{children}</fieldset></section>:<>{children}</>;
  const stale=session.isStale(),busy=session.isBusy() || loading;
  return <Context.Provider value={session}><section className="command-edit-scope" aria-label="工程编辑会话" data-stale={stale}>
    <div className={`command-edit-status${stale?" stale":""}`} role={stale?"alert":"status"}><span>{stale?"工程已变化，草稿保留，执行已阻止。":"编辑基线"}{!stale && <small>R{session.getBaseline().revision} · 修改后整体提交</small>}</span><button type="button" disabled={busy} onClick={async()=>{setLoading(true);setError(null);try{await onReload();}catch(reason){setError(reason instanceof Error?reason.message:"重新载入失败，草稿仍保留。");}finally{setLoading(false);}}}>重新载入（放弃草稿）</button></div>
    {error && <p className="property-error" role="alert">{error}</p>}
    <fieldset className="command-edit-fields" disabled={busy || stale || !session.isReady()}>{children}</fieldset>
  </section></Context.Provider>;
}
