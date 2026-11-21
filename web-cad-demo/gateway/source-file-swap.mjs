import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {childExit,waitChildExit} from './child-exit.mjs';
import {managedStepDestination,managedStepPath,restorationStepPath} from './step-source-integrity.mjs';

export class SourceSwapError extends Error{constructor(code,message){super(message);this.name='SourceSwapError';this.code=code;}}
const fault=(code,message)=>new SourceSwapError(code,message);

/** One owned native operation at a time. An error is NOT proof of no mutation:
 * the transaction owner must reconcile target, stage and retained backup bytes. */
export class SourceFileSwap {
  constructor({dataDir,executablePath,spawnImpl=spawn,env=process.env,timeoutMs=30000,stopTimeoutMs=5000}={}){
    Object.assign(this,{dataDir:path.resolve(dataDir),executablePath,spawnImpl,timeoutMs,stopTimeoutMs});
    this.env=Object.fromEntries(Object.entries(env).filter(([key])=>['PATH','SYSTEMROOT','WINDIR','TEMP','TMP'].includes(key.toUpperCase())).map(([key,value])=>[key.toUpperCase(),value]));
    this.children=new Set();this.closed=false;
  }
  async swap({mode,target,stage,backup}){
    if(this.closed)throw fault('SOURCE_SWAP_CLOSED','来源替换服务已停止。');
    if(this.children.size)throw fault('SOURCE_SWAP_BUSY','上一次来源文件操作尚未退出，不能启动另一次替换。');
    if(!['install','replace','retire'].includes(mode)||mode==='retire'&&stage!==undefined||mode==='install'&&backup!==undefined)throw fault('SOURCE_SWAP_ARGUMENTS','来源替换参数无效。');
    target=mode==='install'?managedStepDestination(target,this.dataDir):managedStepPath(target,this.dataDir);
    if(mode!=='retire')stage=restorationStepPath(stage,this.dataDir);
    if(mode!=='install'){
      backup=restorationStepPath(backup,this.dataDir,{allowMissing:true});
      try{await fs.promises.lstat(backup);throw fault('SOURCE_SWAP_BACKUP_EXISTS','恢复备份已存在，未覆盖保留文件。');}catch(error){if(error.code!=='ENOENT')throw error;}
    }
    if(!this.executablePath||!fs.existsSync(this.executablePath))throw fault('SOURCE_SWAP_UNAVAILABLE','缺少受控来源替换程序，请构建 cad_source_file_swap。');
    // Recheck after asynchronous filesystem admission before spawning.
    if(this.closed)throw fault('SOURCE_SWAP_CLOSED','来源替换服务已停止。');
    if(this.children.size)throw fault('SOURCE_SWAP_BUSY','来源文件操作正在执行。');
    const args=['--root',this.dataDir,'--mode',mode,'--target',target,...(stage?['--stage',stage]:[]),...(backup?['--backup',backup]:[])];
    const child=this.spawnImpl(this.executablePath,args,{env:this.env,windowsHide:true,stdio:['ignore','pipe','pipe']});this.children.add(child);
    let output='',bytes=0,reason=null,timer;
    try{
      await new Promise(resolve=>{
        const stop=error=>{reason??=error;if(!child.killed)child.kill();};
        // A timeout requests termination but does not release the source gate.
        // Only actual close can settle swap(); close() has a bounded stop audit.
        timer=setTimeout(()=>stop(fault('SOURCE_SWAP_OUTCOME_UNKNOWN','来源替换超过时间预算，须核对文件与备份，不能直接重试。')),this.timeoutMs);
        child.once('close',resolve);
        child.once('error',()=>{reason??=fault('SOURCE_SWAP_UNAVAILABLE','来源替换程序无法启动，须核对事务记录。');if(child.pid==null)resolve();});
        child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>4096){stop(fault('SOURCE_SWAP_PROTOCOL','来源替换回复超出预算，须核对实际文件。'));return;}output+=chunk.toString('utf8');});
        child.stderr.on('data',()=>{});
      });
      if(reason)throw reason;
      let result;try{result=JSON.parse(output.trim());}catch{throw fault('SOURCE_SWAP_PROTOCOL','来源替换回复无效，须核对实际文件。');}
      if(result?.version!==1||typeof result.ok!=='boolean'||!Number.isSafeInteger(result.winError)||result.winError<0||result.winError>0xffffffff||child.exitCode!==(result.ok?0:2)||result.ok&&result.winError!==0||!result.ok&&result.winError===0)throw fault('SOURCE_SWAP_PROTOCOL','来源替换回复不符合协议，须核对实际文件。');
      return result;
    }finally{clearTimeout(timer);if(child.exitCode!==null||child.signalCode!==null||child.pid==null)this.children.delete(child);else child.once('close',()=>this.children.delete(child));}
  }
  async close(){
    this.closed=true;
    await Promise.all([...this.children].map(async child=>{
      if(!child.killed)child.kill();
      try{await waitChildExit(child,{timeoutMs:this.stopTimeoutMs,code:'SOURCE_SWAP_STOP_UNCONFIRMED',message:'来源替换进程退出未确认，须保持数据目录所有权。'});}
      catch(error){error.exitObserved=childExit(child);throw error;}
    }));
  }
}
