/** Fair process-local reader/writer gate. It complements the directory writer
 * lease; it is not a lock against another program editing files directly. */
export class SourceAccessGate {
  constructor(){this.readers=0;this.writer=false;this.waiting=[];this.closed=false;}
  acquire(write){
    if(this.closed)return Promise.reject(Object.assign(new Error('后台正在停止，未开始新的来源访问。'),{code:'SERVICE_STOPPING'}));
    return new Promise((resolve,reject)=>{this.waiting.push({write,resolve,reject});this.drain();});
  }
  drain(){
    if(this.writer||!this.waiting.length)return;
    if(this.waiting[0].write){
      if(this.readers)return;const next=this.waiting.shift();this.writer=true;next.resolve(()=>{this.writer=false;this.drain();});return;
    }
    while(this.waiting.length&&!this.waiting[0].write){const next=this.waiting.shift();this.readers++;next.resolve(()=>{this.readers--;this.drain();});}
  }
  async read(action){const release=await this.acquire(false);try{return await action();}finally{release();}}
  async write(action){const release=await this.acquire(true);try{return await action();}finally{release();}}
  close(){this.closed=true;for(const next of this.waiting)next.reject(Object.assign(new Error('来源访问仍在排队，已随后台停止取消。'),{code:'SERVICE_STOPPING'}));this.waiting=[];}
}
