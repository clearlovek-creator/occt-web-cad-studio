import {parseOptimizationRecoveryRequest,type OptimizationRecoveryRequest} from '../../shared/mesh-optimization-recovery.mjs';
export type OptimizationAction=OptimizationRecoveryRequest&{state:'submitting'|'uncertain'|'failed'|'accepted';attemptJobId?:string;error?:string};
export type RecoveryStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
type Saved=OptimizationRecoveryRequest&{originJobId:string};
const jobPattern=/^mesh-[a-f0-9-]{36}$/;
/** Only unresolved requests are stored. Absence from a task list is not proof
 * that a timed-out registration did not execute. Never clear it automatically. */
export class OptimizationRecoveryJournal{
  private key:string;
  private documentId:string;
  private storage?:RecoveryStorage;
  constructor(documentId:string,storage?:RecoveryStorage){if(!/^[A-Za-z0-9_-]{1,64}$/.test(documentId))throw Error('恢复记录的工程身份无效。');this.documentId=documentId;this.storage=storage;this.key='webcad.mesh-optimization-recovery.v1:'+documentId;}
  private backing(){if(this.storage)return this.storage;try{if(typeof localStorage!=='undefined')return localStorage;}catch{}return undefined;}
  read():Record<string,OptimizationAction>{
    const storage=this.backing();if(!storage)return {};
    let raw:string|null;try{raw=storage.getItem(this.key);}catch{throw Error('浏览器恢复记录暂时无法读取；未发送新优化，请保留记录并检查存储权限。');}
    if(raw===null)return {};
    try{if(raw.length>128*1024)throw Error();const value=JSON.parse(raw);if(!value||Object.keys(value).length!==3||value.version!==1||value.documentId!==this.documentId||!Array.isArray(value.requests)||value.requests.length>32)throw Error();const actions:Record<string,OptimizationAction>={};for(const row of value.requests){if(!row||Object.keys(row).length!==4||!jobPattern.test(row.originJobId)||actions[row.originJobId])throw Error();const {originJobId,...request}=row;actions[originJobId]={...parseOptimizationRecoveryRequest(request),state:'uncertain',error:'恢复回复尚未核对；只读取任务记录，不会重新提交。'};}return actions;}catch{throw Error('浏览器恢复记录损坏或身份不符，原内容保留；未发送新优化。');}
  }
  save(actions:Record<string,OptimizationAction>){
    const storage=this.backing();if(!storage)throw Error('浏览器不能保存恢复请求身份，未发送新优化；请检查本地存储权限。');
    for(const [id,existing]of Object.entries(this.read())){const next=actions[id];if(!next||next.requestId!==existing.requestId||next.failedStateToken!==existing.failedStateToken||next.checkpointToken!==existing.checkpointToken)throw Error('浏览器中有另一条待核对恢复记录，原内容保留；请重新读取状态。');}
    const requests:Saved[]=Object.entries(actions).filter(([,action])=>action.state==='uncertain'||action.state==='submitting').map(([originJobId,action])=>{if(!jobPattern.test(originJobId))throw Error('恢复来源任务身份无效。');return {originJobId,...parseOptimizationRecoveryRequest({requestId:action.requestId,failedStateToken:action.failedStateToken,checkpointToken:action.checkpointToken})};});
    if(requests.length>32)throw Error('待核对的恢复请求已达上限，原记录保留。');
    try{const wire=JSON.stringify({version:1,documentId:this.documentId,requests});if(requests.length)storage.setItem(this.key,wire);else storage.removeItem(this.key);}catch{throw Error('浏览器无法持久保存恢复状态；原请求需只读核对，不会重新提交。');}
  }
}
