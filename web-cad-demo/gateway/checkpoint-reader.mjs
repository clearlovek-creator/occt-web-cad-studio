import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';

const BUFFER_BYTES=1024*1024;
const sameFile=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs'].every(key=>a[key]===b[key]);

/** Full content verification on every call. No timestamp/hash cache or retained file contents. */
export class CheckpointReader {
  constructor(){
    this.buffer=null;
    this.counters={geometryFiles:0,geometryBytes:0,geometryReadMs:0,rejectedFiles:0};
  }

  snapshot(file){
    const began=performance.now();let fd;
    this.counters.geometryFiles++;
    try{
      const entry=fs.lstatSync(file,{bigint:true});
      if(!entry.isFile()||entry.isSymbolicLink()||entry.size<32n)throw new Error('History snapshot has an invalid file type or length.');
      fd=fs.openSync(file,'r');
      const before=fs.fstatSync(fd,{bigint:true});
      if(!sameFile(entry,before))throw new Error('History snapshot changed while opening.');
      this.buffer??=Buffer.allocUnsafe(BUFFER_BYTES);
      const hash=createHash('sha256'),header=Buffer.alloc(7);let total=0n,headerBytes=0,count;
      while((count=fs.readSync(fd,this.buffer,0,this.buffer.length,null))>0){
        this.counters.geometryBytes+=count;total+=BigInt(count);
        if(headerBytes<header.length){const copied=Math.min(header.length-headerBytes,count);this.buffer.copy(header,headerBytes,0,copied);headerBytes+=copied;}
        if(headerBytes===header.length&&header.toString('ascii')!=='BINFILE')throw new Error('History snapshot is not a readable XBF file.');
        hash.update(this.buffer.subarray(0,count));
      }
      const after=fs.fstatSync(fd,{bigint:true}),current=fs.lstatSync(file,{bigint:true});
      if(total!==before.size||!sameFile(before,after)||!sameFile(before,current)||!current.isFile()||current.isSymbolicLink())throw new Error('History snapshot changed during integrity verification.');
      return hash.digest('hex');
    }catch(error){this.counters.rejectedFiles++;throw error;}
    finally{if(fd!==undefined)fs.closeSync(fd);this.counters.geometryReadMs+=performance.now()-began;}
  }

  metrics(){return {version:1,strategy:'full-sha256-no-cache',readBufferBytes:this.buffer?.length||0,...this.counters};}
}
