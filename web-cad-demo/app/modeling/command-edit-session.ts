import {isReadOnlyCommand, type ModelingCommandInput, type ModelingCommandResponse} from "./command-contract.ts";
import { ModelingCommandError, type ModelingController } from "./modeling-controller.ts";

export {isReadOnlyCommand} from './command-contract.ts';
type Baseline={documentId:string;revision:number|null;stateToken:string|null};

/** A form owns its read state. Only its successful writes advance the lease;
 * refreshing elsewhere never silently rebases a dirty form. */
export class CommandEditSession {
  private baseline:Baseline;
  private version=0;
  private pending=0;
  private conflicted=false;
  private listeners=new Set<()=>void>();
  private controller:ModelingController;
  constructor(controller:ModelingController,source?:Baseline){this.controller=controller;const state=source || controller.getSnapshot();this.baseline={documentId:state.documentId,revision:state.revision,stateToken:state.stateToken};}
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>this.listeners.delete(listener);};
  getSnapshot=()=>this.version;
  getBaseline=()=>({...this.baseline});
  isBusy=()=>this.pending>0;
  isReady=()=>Boolean(this.baseline.stateToken && this.baseline.revision!==null);
  isStale=()=>{const current=this.controller.getSnapshot();return this.conflicted || current.documentId!==this.baseline.documentId || Boolean(current.stateToken && current.stateToken!==this.baseline.stateToken);};
  private notify(){this.version++;this.listeners.forEach(listener=>listener());}
  private assertCurrent(){
    if(this.pending)throw new ModelingCommandError({ok:false,code:"EDITOR_BUSY",error:"此编辑会话已有提交正在执行，请等待完成。"},409);
    if(!this.isReady())throw new ModelingCommandError({ok:false,code:"EDITOR_NOT_READY",error:"工程状态尚未载入，请重新载入编辑窗口。"},409);
    if(this.isStale())throw new ModelingCommandError({ok:false,code:"PROJECT_STATE_CONFLICT",error:"工程已变化，草稿已保留；请重新载入后再执行，不能用旧参数覆盖新数据。"},409);
  }
  private advance(result:ModelingCommandResponse){
    if(typeof result.stateToken!=="string")throw new ModelingCommandError({ok:false,code:"WORKER_UPGRADE_REQUIRED",error:"命令已返回，但缺少工程状态标识；请更新服务并查询工程，勿重复执行。"},502);
    this.baseline={documentId:this.baseline.documentId,revision:result.revision??this.baseline.revision,stateToken:result.stateToken};
  }
  execute=async<T extends ModelingCommandResponse=ModelingCommandResponse>(input:ModelingCommandInput):Promise<T>=>{
    if(this.controller.getSnapshot().documentId!==this.baseline.documentId)throw new ModelingCommandError({ok:false,code:"PROJECT_STATE_CONFLICT",error:"编辑窗口所属工程已切换。"},409);
    if(input.operation==="feature.input.preview"||input.operation==="document.naming.preview"){
      this.assertCurrent();this.pending++;this.notify();
      try{return await this.controller.execute<T>({...input,baseRevision:this.baseline.revision!,baseStateToken:this.baseline.stateToken!});}
      catch(error){if(["PROJECT_STATE_CONFLICT","STALE_REVISION","REVISION_CONFLICT"].includes((error as {code?:string})?.code || ""))this.conflicted=true;throw error;}
      finally{this.pending--;this.notify();}
    }
    if(isReadOnlyCommand(input.operation))return this.controller.execute<T>(input);
    this.assertCurrent();this.pending++;this.notify();
    try{const result=await this.controller.execute<T>({...input,baseRevision:this.baseline.revision!,baseStateToken:this.baseline.stateToken!});if(!input.options?.preview)this.advance(result);return result;}
    catch(error){if(["PROJECT_STATE_CONFLICT","STALE_REVISION","REVISION_CONFLICT"].includes((error as {code?:string})?.code || ""))this.conflicted=true;throw error;}
    finally{this.pending--;this.notify();}
  };
  executeBatch=async<T extends ModelingCommandResponse=ModelingCommandResponse>(steps:ModelingCommandInput[]):Promise<T>=>{
    this.assertCurrent();this.pending++;this.notify();
    try{const result=await this.controller.executeBatch<T>(steps,{baseRevision:this.baseline.revision!,baseStateToken:this.baseline.stateToken!});this.advance(result);return result;}
    catch(error){if(["PROJECT_STATE_CONFLICT","STALE_REVISION","REVISION_CONFLICT"].includes((error as {code?:string})?.code || ""))this.conflicted=true;throw error;}
    finally{this.pending--;this.notify();}
  };
}
