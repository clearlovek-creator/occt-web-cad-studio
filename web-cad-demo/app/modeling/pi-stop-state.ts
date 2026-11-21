export type PiStopState = {phase:'idle'|'sending'|'checking'|'uncertain'|'refreshing';notice:string|null};
type Connection = {request:(command:Record<string,unknown>)=>Promise<unknown>;refresh:()=>Promise<unknown>};
/** One native abort per user run. Status recovery is read-only and owner-fenced. */
export class PiStopCoordinator {
  private live=true;
  private state:PiStopState={phase:'idle',notice:null};
  private pending:Promise<void>|null=null;
  private connection:Connection;
  private discover:()=>Promise<void>;
  private onChange:(state:PiStopState)=>void;
  constructor(connection:Connection,discover:()=>Promise<void>,onChange:(state:PiStopState)=>void){this.connection=connection;this.discover=discover;this.onChange=onChange;}
  private publish(state:PiStopState){if(!this.live)return;this.state=state;this.onChange({...state});}
  close(){this.live=false;}
  reset(){if(this.live&&!this.pending)this.publish({phase:'idle',notice:null});}
  private observe(){return (async()=>{await this.discover();if(!this.live)return;await this.connection.refresh();})();}
  stop():Promise<void>{
    if(!this.live||this.state.phase!=='idle')return this.pending||Promise.resolve();
    this.publish({phase:'sending',notice:'正在停止 Pi 并核对建模任务；请等待真实终态，已提交的操作不会被强行撤销。'});
    const work=(async()=>{
      try{await this.connection.request({type:'abort'});if(!this.live)return;await this.observe();this.publish({phase:'checking',notice:'停止请求已返回；几何是否已恢复，以建模任务的最终状态为准。'});}
      catch{this.publish({phase:'uncertain',notice:'停止结果尚未确认，后台可能仍在执行或恢复。请检查状态；不会自动再次发送停止或建模命令。'});}
    })();this.pending=work;
    void work.finally(()=>{if(this.pending===work)this.pending=null;}).catch(()=>{});return work;
  }
  check():Promise<void>{
    if(!this.live)return Promise.resolve();if(this.pending)return this.pending;
    this.publish({phase:'refreshing',notice:'正在只读核对 Pi 与建模任务，没有重发停止或建模命令。'});
    const work=(async()=>{try{await this.observe();this.publish({phase:'checking',notice:'已读取当前会话与任务状态；建模结果仍以任务终态为准。'});}catch{this.publish({phase:'uncertain',notice:'状态暂不可读，请保留当前会话并稍后检查；没有重复发送停止或建模命令。'});}})();
    this.pending=work;void work.finally(()=>{if(this.pending===work)this.pending=null;}).catch(()=>{});return work;
  }
}
