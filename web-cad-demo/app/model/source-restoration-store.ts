import {parseRestoration,parseRestorationHealth,parseRestorationList,restorationId,type RestorationBinding,type RestorationHealth,type SourceRestoration} from './source-restoration';

type Action='commit'|'rollback'|'revalidate'|'abandon'|'review';
type Snapshot={items:SourceRestoration[];total:number;offset:number;selectedId:string|null;selected:SourceRestoration|null;health:RestorationHealth|null;loading:boolean;loadingDetail:boolean;writePending:string|null;awaitingRead:boolean;error:string;listError:string;detailError:string;notice:string;unknownAction:string|null;loaded:boolean};
const initial=():Snapshot=>({items:[],total:0,offset:0,selectedId:null,selected:null,health:null,loading:false,loadingDetail:false,writePending:null,awaitingRead:false,error:'',listError:'',detailError:'',notice:'',unknownAction:null,loaded:false});
class HttpFailure extends Error{constructor(message:string,public status:number){super(message);}}
type Options={apiRoot:string;fetchImpl?:typeof fetch;storage?:()=>Storage|null;onUpdated?:()=>void};

/** Browser observer only. Writes have their own lifetime; unmount aborts GETs,
 * never an accepted upload or action. The server is the sole job authority. */
export class SourceRestorationStore{
  private state=initial();private readonly serverState=this.state;private listeners=new Set<()=>void>();private users=0;private generation=0;private listEpoch=0;private detailEpoch=0;private timer:ReturnType<typeof setTimeout>|undefined;private readers=new Set<AbortController>();private writePromise:Promise<void>|null=null;private unknown=new Map<string,string>();
  private readonly fetcher:typeof fetch;
  constructor(readonly documentId:string,private options:Options){this.fetcher=options.fetchImpl||((input,init)=>fetch(input,init));}
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>this.listeners.delete(listener);};
  getSnapshot=()=>this.state;getServerSnapshot=()=>this.serverState;
  get retained(){return this.users>0||Boolean(this.writePromise);}
  private update(next:Partial<Snapshot>){this.state={...this.state,...next};for(const listener of this.listeners)listener();}
  private storage(){try{return this.options.storage?.()||null;}catch{return null;}}
  private remember(id:string){try{this.storage()?.setItem('cad.source-restore:'+this.documentId,id);}catch{/* Optional local pointer, never the operation authority. */}}
  start(){
    this.users++;if(this.users===1){this.generation++;let id:string|null=null;try{id=this.storage()?.getItem('cad.source-restore:'+this.documentId)||null;}catch{/* optional */}
      if(!this.state.selectedId&&restorationId(id))this.update({selectedId:id});void this.refresh();}
    return()=>{this.users--;if(!this.users){this.generation++;this.listEpoch++;this.detailEpoch++;clearTimeout(this.timer);for(const reader of this.readers)reader.abort();this.readers.clear();}};
  }
  private async json(route:string,init:RequestInit={},write=false){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),write?90000:15000);if(!write)this.readers.add(controller);
    try{const response=await this.fetcher(this.options.apiRoot+route,{...init,signal:controller.signal});const body=await response.text();if(body.length>8*1024*1024)throw Error('来源恢复报告超出显示预算。');let payload;try{payload=JSON.parse(body);}catch{throw Error(`来源恢复服务响应无效（HTTP ${response.status}）。`);}
      if(!response.ok||payload?.ok!==true)throw new HttpFailure(typeof payload?.error==='string'?payload.error:'来源恢复请求未完成。',response.status);return payload;
    }finally{clearTimeout(timer);this.readers.delete(controller);}
  }
  private schedule(){clearTimeout(this.timer);if(this.users)this.timer=setTimeout(()=>void this.refresh(),this.state.writePending||this.state.health?.active||this.state.selected?.serviceBusy?750:5000);}
  async refresh(){
    const generation=this.generation;if(!this.users)return;await Promise.all([this.readList(generation),this.readDetail(generation)]);if(generation===this.generation)this.schedule();
  }
  private async readList(generation:number){
    const epoch=++this.listEpoch,offset=this.state.offset;this.update({loading:true});
    try{const result=parseRestorationList(await this.json('/source-restores?'+new URLSearchParams({documentId:this.documentId,offset:String(offset),limit:'20'})),this.documentId);
      if(result.offset!==offset||result.limit!==20)throw Error('恢复历史回复的分页范围不符，未替换当前列表。');
      if(!this.users||generation!==this.generation||epoch!==this.listEpoch)return;this.update({items:result.items,total:result.total,health:result.health,loading:false,loaded:true,listError:''});
    }catch(error){if(this.users&&generation===this.generation&&epoch===this.listEpoch)this.update({loading:false,loaded:true,listError:error instanceof Error?error.message:'恢复历史读取失败。'});}
  }
  private async readDetail(generation:number){
    const id=this.state.selectedId;if(!id)return;const epoch=++this.detailEpoch;this.update({loadingDetail:true});
    try{const payload=await this.json('/source-restores/'+encodeURIComponent(id)),selected=parseRestoration(payload.restoration,this.documentId,id),health=parseRestorationHealth(payload.health);
      if(!this.users||generation!==this.generation||epoch!==this.detailEpoch||this.state.selectedId!==id)return;
      const unknown=this.unknown.get(id),confirmed=unknown==='commit'&&['committed','attention'].includes(selected.state)||unknown==='rollback'&&['rolled-back','attention'].includes(selected.state)||unknown==='abandon'&&selected.state==='abandoned'||unknown==='upload'&&selected.uploadComplete;
      if(confirmed)this.unknown.delete(id);
      this.update({selected,health,loadingDetail:false,awaitingRead:false,detailError:'',...(confirmed?{unknownAction:null,notice:'已通过原操作记录核对结果；没有重发写请求。'}:{})});
    }catch(error){if(this.users&&generation===this.generation&&epoch===this.detailEpoch&&this.state.selectedId===id)this.update({loadingDetail:false,...(this.state.writePending&&error instanceof HttpFailure&&error.status===404?{}:{detailError:error instanceof Error?error.message:'恢复记录读取失败。'})});}
  }
  select(id:string){if(!restorationId(id))return;this.detailEpoch++;this.remember(id);const unknownAction=this.unknown.get(id)||null;this.update({selectedId:id,selected:null,loadingDetail:true,error:'',detailError:'',notice:unknownAction?'此操作的上次请求结果尚未确认，请查询原记录。':'',unknownAction});if(this.users)void this.readDetail(this.generation).then(()=>this.schedule());}
  page(offset:number){if(offset<0||!Number.isSafeInteger(offset))return;this.update({offset,error:''});if(this.users)void this.readList(this.generation);}
  acknowledge(){if(!this.state.selected||this.state.selected.serviceBusy||this.state.awaitingRead)return;if(this.state.selectedId)this.unknown.delete(this.state.selectedId);this.update({unknownAction:null,notice:'已保留当前核对结果；后续操作仍需显式发起。',error:''});}
  private write(id:string,action:string,work:()=>Promise<unknown>){
    if(this.writePromise||this.state.unknownAction||this.state.awaitingRead)return Promise.resolve();
    this.update({writePending:action,error:'',notice:'',unknownAction:null});
    const running=Promise.resolve().then(work).then(raw=>{
      const payload=raw as {restoration:unknown;health:unknown};parseRestoration(payload.restoration,this.documentId,id);parseRestorationHealth(payload.health);
      this.unknown.delete(id);
      // A delayed POST receipt may contain an older snapshot than polling has
      // already observed. Treat it only as admission; only a fresh GET publishes
      // state, and pre-receipt reads cannot enable a second action.
      this.detailEpoch++;this.update({awaitingRead:true,...(this.state.selectedId===id?{notice:'后台已接受，正在查询原操作结果。'}:{})});
      this.options.onUpdated?.();
    }).catch(error=>{
      const rejected=error instanceof HttpFailure&&error.status>=400&&error.status<500;if(!rejected)this.unknown.set(id,action);if(this.state.selectedId!==id)return;
      this.update({error:rejected?error.message:'',notice:rejected?'':'请求结果尚未确认。请查询原操作记录，不要重新上传或重复执行。',unknownAction:rejected?null:action});
    }).finally(()=>{this.writePromise=null;this.update({writePending:null});if(this.users)void this.refresh();});
    this.writePromise=running;return running;
  }
  prepare(file:File,binding:RestorationBinding){
    if(binding.documentId!==this.documentId){this.update({error:'来源选择与当前查看范围不一致，请返回检查报告重新选择。'});return Promise.resolve();}
    if(this.writePromise||this.state.unknownAction||this.state.awaitingRead)return Promise.resolve();const id='restore-'+crypto.randomUUID();this.select(id);this.update({notice:'正在上传原始 STEP；关闭窗口不会重发或重新开始任务。'});
    return this.write(id,'upload',()=>this.json('/source-restores/'+id+'/prepare?'+new URLSearchParams({scope:binding.scope,documentId:binding.documentId,auditJobId:binding.auditJobId,assetId:binding.assetId,fileName:file.name}),{method:'POST',headers:{'Content-Type':'application/step'},body:file},true));
  }
  action(action:Action){const id=this.state.selectedId,selected=this.state.selected,key=({commit:'canCommit',rollback:'canRollback',revalidate:'canRevalidate',abandon:'canAbandon',review:'canReview'} as const)[action];if(!id||!selected||selected.operationId!==id||!selected[key])return Promise.resolve();return this.write(id,action,()=>this.json('/source-restores/'+id+'/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'},true));}
}
