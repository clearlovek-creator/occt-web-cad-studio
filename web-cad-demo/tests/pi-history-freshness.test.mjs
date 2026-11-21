import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {assertFreshPiDocument,ensurePiSessionOwner,inspectPiSessionOwner} from '../gateway/pi-session-ownership.mjs';
import {createPiHistoryPreview} from '../gateway/pi-history-preview.mjs';
import {ownedPiResumeFile} from '../gateway/pi-resume-file.mjs';
import {PiRpcSession} from '../gateway/pi-rpc-runtime.mjs';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-pi-fresh-'));t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^cad-pi-fresh-/);fs.rmSync(root,{recursive:true,force:true});});return root;}
const message=(role,text,extra={})=>JSON.stringify({type:'message',timestamp:'2026-11-17T00:00:00Z',message:{role,content:[{type:'text',text}],...extra}})+'\n';
test('freshness is read-only for missing roots and ignores unrelated unclaimed histories without attributing them',async t=>{
  const root=fixture(t),missing=path.join(root,'absent');await assertFreshPiDocument(missing,'new');assert.equal(fs.existsSync(missing),false);const legacy=path.join(root,'legacy');fs.mkdirSync(legacy);fs.writeFileSync(path.join(legacy,'old.jsonl'),'old private bytes');await assertFreshPiDocument(root,'new');assert.equal(fs.readFileSync(path.join(legacy,'old.jsonl'),'utf8'),'old private bytes');assert.equal(fs.existsSync(path.join(legacy,'web-cad-owner.json')),false);
});
test('canonical target materials including an empty directory cannot be reused by a fresh CAD project',async t=>{
  const root=fixture(t);fs.mkdirSync(path.join(root,'webcad-target'));await assert.rejects(assertFreshPiDocument(root,'target'),{code:'PI_DOCUMENT_HISTORY_EXISTS'});assert.deepEqual(fs.readdirSync(path.join(root,'webcad-target')),[]);
});
test('a noncanonical persisted owner for the target is found without reading or rewriting its native history',async t=>{
  const root=fixture(t),session=path.join(root,'custom-session');ensurePiSessionOwner(session,'custom-session','target');fs.writeFileSync(path.join(session,'history.jsonl'),'preserved');await assert.rejects(assertFreshPiDocument(root,'target'),{code:'PI_DOCUMENT_HISTORY_EXISTS'});assert.equal(fs.readFileSync(path.join(session,'history.jsonl'),'utf8'),'preserved');await assertFreshPiDocument(root,'other');
});
test('damaged and shared owner metadata fail closed rather than implying a fresh target',async t=>{
  const root=fixture(t),session=path.join(root,'owner');ensurePiSessionOwner(session,'owner','other');const file=path.join(session,'web-cad-owner.json');fs.linkSync(file,path.join(root,'copy'));await assert.rejects(assertFreshPiDocument(root,'target'),{code:'PI_SESSION_OWNER_UNAVAILABLE'});fs.unlinkSync(path.join(root,'copy'));fs.truncateSync(file,3);await assert.rejects(assertFreshPiDocument(root,'target'),{code:'PI_SESSION_OWNER_UNAVAILABLE'});assert.equal(fs.statSync(file).size,3);
});
test('directory budgets, cancellation and inventory races never authorize a new target',async t=>{
  const root=fixture(t);for(let i=0;i<2049;i++)fs.mkdirSync(path.join(root,'s'+i));await assert.rejects(assertFreshPiDocument(root,'target'),{code:'PI_SESSION_OWNER_LIMIT'});
  const small=path.join(root,'s0');for(let i=0;i<18;i++)fs.mkdirSync(path.join(small,'x'+i));await assert.rejects(assertFreshPiDocument(small,'target',{isCancelled:()=>true}),{code:'PI_SESSION_OWNER_STOPPING'});const pending=assertFreshPiDocument(small,'target');fs.mkdirSync(path.join(small,'late'));await assert.rejects(pending,{code:'PI_SESSION_OWNER_CHANGED'});
});
test('history specimens include only bounded human text, preserve UTF-8 chunks and exclude tools and thinking',()=>{
  const p=createPiHistoryPreview();p.startFile();const bytes=Buffer.from(message('user','工程中文')+message('assistant','visible',{content:[{type:'thinking',thinking:'not shown'},{type:'text',text:'answer'}]})+message('toolResult','private tool JSON'));for(let i=0;i<bytes.length;i+=3)p.push(bytes.subarray(i,i+3));p.endFile();const result=p.result();assert.deepEqual(result.messages.map(value=>value.text),['工程中文','answer']);assert.doesNotMatch(JSON.stringify(result),/not shown|private tool JSON/);result.messages[0].text='mutated';assert.equal(p.result().messages[0].text,'工程中文');
});
test('preview bounds long lines, individual messages, message count and total parsed records',()=>{
  const p=createPiHistoryPreview();p.startFile();p.push(Buffer.from('x'.repeat(65537)+'\n'+message('user','long'.repeat(1000))+Array.from({length:20},(_,i)=>message('assistant','m'+i)).join('')+'{}\n'.repeat(10001)+message('user','after budget')));p.endFile();const result=p.result();assert.equal(result.messages.length,12);assert.equal(result.skippedLines,1);assert.equal(result.limited,true);assert.doesNotMatch(JSON.stringify(result),/after budget/);assert.ok(result.omittedMessages>0);const text=createPiHistoryPreview();text.startFile();text.push(Buffer.from(message('user','a'.repeat(2000))));text.endFile();assert.equal(text.result().messages[0].text.length,1000);assert.equal(text.result().messages[0].truncated,true);
});
test('explicit content preview has the same original byte proof while default ownership inspection stays private',async t=>{
  const root=fixture(t),session=path.join(root,'legacy');fs.mkdirSync(session);const file=path.join(session,'old.jsonl'),bytes=Buffer.from(message('user','private original context'));fs.writeFileSync(file,bytes);const metadata=await inspectPiSessionOwner(session,'legacy','doc'),preview=await inspectPiSessionOwner(session,'legacy','doc',{includePreview:true});assert.equal(metadata.preview,undefined);assert.doesNotMatch(JSON.stringify(metadata),/private original/);assert.equal(preview.preview.messages[0].text,'private original context');assert.equal(preview.historyDigest,metadata.historyDigest);assert.deepEqual(fs.readFileSync(file),bytes);assert.equal(fs.existsSync(path.join(session,'web-cad-owner.json')),false);
});
test('owned resume selects the latest native header without using the new release cwd or changing original bytes',async t=>{
  const root=fixture(t),older=path.join(root,'old.jsonl'),newer=path.join(root,'new.jsonl');for(const file of [older,newer])fs.writeFileSync(file,JSON.stringify({type:'session',id:path.basename(file),cwd:'different-old-runtime'})+'\n');fs.utimesSync(older,100,100);fs.utimesSync(newer,200,200);const bytes=fs.readFileSync(newer);assert.equal(await ownedPiResumeFile(root),newer);assert.deepEqual(fs.readFileSync(newer),bytes);
});
test('unrecognized or shared history never silently becomes a fresh empty native session',async t=>{
  const root=fixture(t);fs.writeFileSync(path.join(root,'invalid.jsonl'),'{}\n');await assert.rejects(ownedPiResumeFile(root),/未以空会话替代/);fs.unlinkSync(path.join(root,'invalid.jsonl'));const file=path.join(root,'valid.jsonl');fs.writeFileSync(file,'{"type":"session","id":"native"}\n');fs.linkSync(file,path.join(root,'copy.jsonl'));await assert.rejects(ownedPiResumeFile(root),/独占普通文件/);
});
test('an actually empty owned archive needs no fake resume identity and oversized header scans remain bounded',async t=>{
  const root=fixture(t);assert.equal(await ownedPiResumeFile(root),null);fs.writeFileSync(path.join(root,'huge.jsonl'),'x'.repeat(65537));await assert.rejects(ownedPiResumeFile(root),/未找到/);
});
test('disposing during asynchronous resume-file inspection cannot launch a late native child',async t=>{
  const root=fixture(t),open=fs.promises.open,file=path.join(root,'native.jsonl');ensurePiSessionOwner(root,'owned','doc');fs.writeFileSync(file,'{"type":"session","id":"owned"}\n');let release,entered=false,spawns=0;const gate=new Promise(resolve=>{release=resolve;});fs.promises.open=async(...args)=>{entered=true;await gate;return open(...args);};const session=new PiRpcSession({sessionId:'owned',documentId:'doc',cliPath:'fake.js',extensionPath:path.join(root,'ext.mjs'),cwd:root,sessionRoot:root,agentConfigDir:path.join(root,'config'),spawnImpl:()=>{spawns++;throw Error('late spawn');}});try{const pending=session.start({resume:true}),checked=assert.rejects(pending,{code:'PI_SESSION_DISPOSED'});for(let i=0;i<100&&!entered;i++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(entered,true);await session.dispose();release();await checked;assert.equal(spawns,0);}finally{fs.promises.open=open;release();await session.dispose();}
});
