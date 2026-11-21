import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
export class ShutdownControl {
  constructor(dataDir,writer,{port,budgetMs}){this.file=path.join(dataDir,'.gateway-control.json');this.writer=writer;this.port=port;this.budgetMs=budgetMs;this.token=randomBytes(32).toString('hex');}
  publish(){const file=this.file+'.'+process.pid+'.tmp',value={format:'web-cad-shutdown-control',version:1,ownerPid:this.writer.ownerPid,ownerInstanceId:this.writer.instanceId,processCreationFileTime:this.writer.processCreationFileTime,port:this.port,shutdownBudgetMs:this.budgetMs,token:this.token};try{fs.writeFileSync(file,JSON.stringify(value),{mode:0o600,flag:'wx'});fs.renameSync(file,this.file);}finally{fs.rmSync(file,{force:true});}}
  authorized(request){
    if(request.headers.origin||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress))return false;
    const supplied=request.headers['x-cad-shutdown-token'];if(typeof supplied!=='string'||!/^[a-f0-9]{64}$/.test(supplied))return false;
    return timingSafeEqual(Buffer.from(supplied),Buffer.from(this.token));
  }
  remove(){try{const record=JSON.parse(fs.readFileSync(this.file,'utf8'));if(record.ownerInstanceId===this.writer.instanceId&&record.token===this.token)fs.rmSync(this.file,{force:true});}catch{/* Never delete a control record belonging to a different owner. */}}
  record(details){const target=path.join(path.dirname(this.file),'.gateway-last-shutdown.json'),temporary=target+'.'+process.pid+'.tmp';try{fs.writeFileSync(temporary,JSON.stringify({format:'web-cad-shutdown-result',version:1,ownerPid:this.writer.ownerPid,ownerInstanceId:this.writer.instanceId,...details,recordedAt:new Date().toISOString()}),{mode:0o600,flag:'wx'});fs.renameSync(temporary,target);}finally{fs.rmSync(temporary,{force:true});}}
}
