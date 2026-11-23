import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createPiHistoryPreview } from './pi-history-preview.mjs';
/** Native Pi's recent-file semantics inside the already-owned archive, without a release-cwd filter. */
export async function ownedPiConversations(root, { preview = false, includeDeleted = false } = {}){
  const directory=fs.lstatSync(root);if(!directory.isDirectory()||directory.isSymbolicLink())throw Error('Pi 历史目录不可核对。');
  const handle=fs.opendirSync(root),names=[];try{for(let item;(item=handle.readSync());){if(names.length>=256)throw Error('Pi 历史文件数量超过核对预算。');names.push(item.name);}}finally{handle.closeSync();}
  const candidates=[];
  for(const entryName of names){
    const deleted=/\.jsonl\.deleted$/i.test(entryName);
    if(deleted&&!includeDeleted)continue;
    const name=deleted?entryName.slice(0,-'.deleted'.length):entryName;
    if(!name.toLowerCase().endsWith('.jsonl'))continue;
    if(!/^[^\\/:*?"<>|\x00-\x1f]{1,240}\.jsonl$/i.test(name))throw Error('Pi 历史文件名无效。');
    const file=path.join(root,entryName),before=fs.lstatSync(file,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>64n*1024n*1024n)throw Error('Pi 历史不是预算内的独占普通文件。');
    const fd=await fs.promises.open(file,'r'),bytes=Buffer.alloc(65536);let at=0;
    try{while(at<bytes.length){const part=await fd.read(bytes,at,bytes.length-at,at);if(!part.bytesRead)break;at+=part.bytesRead;}const after=await fd.stat({bigint:true}),current=fs.lstatSync(file,{bigint:true});for(const key of ['dev','ino','size','mtimeNs','ctimeNs','nlink'])if(before[key]!==after[key]||before[key]!==current[key])throw Error('Pi 历史读取期间变化。');}finally{await fd.close();}
    const prefix=bytes.subarray(0,at);
    let header;const source=new TextDecoder('utf-8').decode(prefix);
    for(const line of source.split('\n')){if(!line.trim())continue;let entry;try{entry=JSON.parse(line);}catch{continue;}if(entry?.type==='session'&&typeof entry.id==='string'&&entry.id)header=entry;break;}
    if(!header)continue;
    let title='';
    if(preview){
      const summary=createPiHistoryPreview();
      summary.startFile();summary.push(prefix);summary.endFile();
      const first=summary.result().messages.find(message=>message.role==='user');
      const prompt=first?.text||'';
      const marker='\n\n用户请求：';
      title=(prompt.startsWith('当前工程 documentId=')&&prompt.includes(marker)?prompt.slice(prompt.indexOf(marker)+marker.length):prompt).replace(/\s+/g,' ').trim().slice(0,96);
    }
    candidates.push({id:piConversationId(name),file,mtime:before.mtimeNs,name,title,deleted,updatedAt:new Date(Number(before.mtimeNs/1000000n)).toISOString()});
  }
  const after=[];const current=fs.opendirSync(root);try{for(let entry;(entry=current.readSync());){if(after.length>=256)throw Error('Pi 历史清单超过预算。');after.push(entry.name);}}finally{current.closeSync();}
  if(JSON.stringify(names.toSorted())!==JSON.stringify(after.toSorted()))throw Error('Pi 历史清单读取期间变化。');
  candidates.sort((a,b)=>a.mtime===b.mtime?b.name.localeCompare(a.name):a.mtime>b.mtime?-1:1);
  if(!candidates.length&&names.some(name=>name.toLowerCase().endsWith('.jsonl')))throw Error('未找到可核对的原生 Pi 历史头，未以空会话替代。');
  return candidates;
}

export const piConversationId = file => createHash('sha256').update(path.basename(file)).digest('hex');

/** Keep the original filename and JSONL bytes so restoration preserves native Pi identity. */
export function movePiConversation(root, conversation, deleted){
  const destination=path.join(root,conversation.name+(deleted?'.deleted':''));
  const exists=fs.lstatSync(destination,{throwIfNoEntry:false});
  if(exists)throw Error('已有同名 Pi 历史文件，未覆盖任何对话。');
  fs.renameSync(conversation.file,destination);
}

export async function ownedPiResumeFile(root, conversationId){
  const conversations=await ownedPiConversations(root);
  if(!conversationId)return conversations[0]?.file||null;
  const selected=conversations.find(conversation=>conversation.id===conversationId);
  if(!selected)throw Error('选中的 Pi 历史会话文件已不可用。');
  return selected.file;
}
