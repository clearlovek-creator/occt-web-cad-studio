/* Real kernel-lock owner fixture. Test processes only. */
import {spawn} from 'node:child_process';
import {acquireDataDirectoryWriter} from '../../gateway/data-directory-writer.mjs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
try{
  const mode=process.argv[3],lease=acquireDataDirectoryWriter(process.argv[2],mode==='missing-helper'?{helperPath:path.join(process.argv[2],'missing-lock-component.exe')}:undefined);let descendant;
  if(mode==='descendant'){
    const nonce=randomUUID(),child=spawn(process.execPath,['-e',`const net=require('node:net');const server=net.createServer(socket=>socket.end('${nonce}'));server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));setTimeout(()=>server.close(),5000);`],{detached:true,windowsHide:true,stdio:['ignore','pipe','ignore']});
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);let text='';child.stdout.on('data',chunk=>{text+=chunk;if(text.includes('\n'))resolve(JSON.parse(text).port);});});descendant={pid:child.pid,port,nonce};child.unref();
  }
  process.stdout.write(JSON.stringify({type:'writer-ready',lease,...(descendant?{descendant}:{})})+'\n');
  process.stdin.resume();process.stdin.on('data',chunk=>{if(String(chunk).trim()==='exit')process.exit(0);});
}catch(error){process.stderr.write(JSON.stringify({code:error.code||'FIXTURE_ERROR',error:error.message})+'\n');process.exit(73);}
