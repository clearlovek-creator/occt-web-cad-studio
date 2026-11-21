import fs from 'node:fs';
import path from 'node:path';
/** Native Pi's recent-file semantics inside the already-owned archive, without a release-cwd filter. */
export async function ownedPiResumeFile(root){
  const directory=fs.lstatSync(root);if(!directory.isDirectory()||directory.isSymbolicLink())throw Error('Pi 历史目录不可核对。');
  const handle=fs.opendirSync(root),names=[];try{for(let item;(item=handle.readSync());){if(names.length>=256)throw Error('Pi 历史文件数量超过核对预算。');names.push(item.name);}}finally{handle.closeSync();}
  const candidates=[];
  for(const name of names){
    if(!name.toLowerCase().endsWith('.jsonl'))continue;
    if(!/^[^\\/:*?"<>|\x00-\x1f]{1,240}\.jsonl$/i.test(name))throw Error('Pi 历史文件名无效。');
    const file=path.join(root,name),before=fs.lstatSync(file,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>64n*1024n*1024n)throw Error('Pi 历史不是预算内的独占普通文件。');
    const fd=await fs.promises.open(file,'r'),bytes=Buffer.alloc(65536);let at=0;
    try{while(at<bytes.length){const part=await fd.read(bytes,at,bytes.length-at,at);if(!part.bytesRead)break;at+=part.bytesRead;}const after=await fd.stat({bigint:true}),current=fs.lstatSync(file,{bigint:true});for(const key of ['dev','ino','size','mtimeNs','ctimeNs','nlink'])if(before[key]!==after[key]||before[key]!==current[key])throw Error('Pi 历史读取期间变化。');}finally{await fd.close();}
    let header=false;const text=new TextDecoder('utf-8').decode(bytes.subarray(0,at));
    for(const line of text.split('\n')){if(!line.trim())continue;let entry;try{entry=JSON.parse(line);}catch{continue;}header=entry?.type==='session'&&typeof entry.id==='string'&&Boolean(entry.id);break;}
    if(header)candidates.push({file,mtime:before.mtimeNs,name});
  }
  const after=[];const current=fs.opendirSync(root);try{for(let entry;(entry=current.readSync());){if(after.length>=256)throw Error('Pi 历史清单超过预算。');after.push(entry.name);}}finally{current.closeSync();}
  if(JSON.stringify(names.toSorted())!==JSON.stringify(after.toSorted()))throw Error('Pi 历史清单读取期间变化。');
  candidates.sort((a,b)=>a.mtime===b.mtime?b.name.localeCompare(a.name):a.mtime>b.mtime?-1:1);
  if(!candidates.length&&names.some(name=>name.toLowerCase().endsWith('.jsonl')))throw Error('未找到可核对的原生 Pi 历史头，未以空会话替代。');
  return candidates[0]?.file||null;
}
