"use client";
import {useEffect,useRef,useState} from 'react';
import {API_ROOT} from '../api-config';
import {parseRestorationHealth,type RestorationHealth} from '../model/source-restoration';

export function SourceRecoveryBanner({onOpen,onReload,onBlocked}:{onOpen:()=>void;onReload:()=>Promise<void>;onBlocked:(blocked:boolean)=>void}){
  const [health,setHealth]=useState<RestorationHealth|null>(null),[resolved,setResolved]=useState(false),[error,setError]=useState(''),[loading,setLoading]=useState(false),read=useRef<()=>void>(()=>{});
  useEffect(()=>{
    let alive=true,epoch=0,timer:ReturnType<typeof setTimeout>|undefined,controller:AbortController|undefined,blocked=false;
    const refresh=async()=>{
      const generation=++epoch;clearTimeout(timer);controller?.abort();const owned=new AbortController();controller=owned;const timeout=setTimeout(()=>owned.abort(),15000);
      try{const response=await fetch(API_ROOT+'/health',{signal:owned.signal}),payload=await response.json();if(!response.ok||payload?.ok!==true)throw Error('后台状态暂未核对。');if(payload.storage?.sourceRestoration===undefined)return;
        const next=parseRestorationHealth(payload.storage.sourceRestoration);if(!alive||generation!==epoch)return;if(blocked&&!next.blocked)setResolved(true);blocked=next.blocked;setHealth(next);setError('');onBlocked(next.blocked);
      }catch{if(alive&&generation===epoch&&blocked)setError('状态读取失败，保留上次阻断提示，请重查；没有重发建模命令。');}
      finally{clearTimeout(timeout);if(alive&&generation===epoch)timer=setTimeout(()=>void refresh(),blocked?2000:10000);}
    };
    read.current=()=>void refresh();void refresh();const updated=()=>void refresh();window.addEventListener('cad:source-restoration-updated',updated);
    return()=>{alive=false;epoch++;clearTimeout(timer);controller?.abort();window.removeEventListener('cad:source-restoration-updated',updated);};
  },[onBlocked]);
  if(!health?.blocked&&!resolved)return null;
  return <aside className={`source-recovery-banner ${health?.blocked?'attention':'resolved'}`} role="status" aria-label="来源事务状态"><div><strong>{health?.blocked?'来源事务待复核，建模暂时阻断':'来源阻断已解除'}</strong><p>{health?.blocked?health.diagnostic?.error:'请显式重新载入当前工程；不会重发之前的建模请求。'}</p>{error&&<small>{error}</small>}</div><div><button type="button" onClick={onOpen}>查看来源恢复记录</button><button type="button" onClick={()=>read.current()}>重查状态</button>{!health?.blocked&&<button type="button" disabled={loading} onClick={()=>{setLoading(true);void onReload().then(()=>setResolved(false)).catch(reason=>setError(reason instanceof Error?reason.message:'工程未成功载入，请重查。')).finally(()=>setLoading(false));}}>重新载入工程</button>}</div></aside>;
}
