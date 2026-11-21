import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const transpile=name=>ts.transpileModule(fs.readFileSync(new URL('../app/model/'+name,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2017}}).outputText;
const modelUrl='data:text/javascript;base64,'+Buffer.from(transpile('source-restoration.ts')).toString('base64');
const {parseRestoration,parseRestorationList,parseRestorationHealth}=await import(modelUrl);
const client=transpile('source-restoration-store.ts').replace(/(['"])\.\/source-restoration\1/,JSON.stringify(modelUrl));const {SourceRestorationStore}=await import('data:text/javascript;base64,'+Buffer.from(client).toString('base64'));
const id1='restore-11111111-1111-1111-1111-111111111111',id2='restore-22222222-2222-2222-2222-222222222222';
const proof={status:'file',size:100,sha256:'a'.repeat(64),fingerprint:'b'.repeat(64),algorithm:'sha256-chain-1m-v1'};
const operation=(id=id1,extra={})=>({version:1,operationId:id,documentId:'A',scope:'current-undo-redo',state:'prepared',phase:'prepared',fileName:'original.step',createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString(),referenceCount:2,projects:['A','B'],before:{...proof},candidate:{...proof},changed:null,errorCode:null,requestErrorCode:null,requestError:null,recovery:null,supersededBy:null,blocking:false,serviceBusy:false,serviceBlocked:false,uploadComplete:true,canCommit:true,canRollback:false,canRevalidate:true,canAbandon:true,canReview:false,materials:[{role:'candidate',label:'candidate',available:true}],...extra});
const health={blocked:false,active:null},response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};};
function until(store,predicate){if(predicate(store.getSnapshot()))return Promise.resolve(store.getSnapshot());return new Promise((resolve,reject)=>{const done=store.subscribe(()=>{if(predicate(store.getSnapshot())){clearTimeout(timer);done();resolve(store.getSnapshot());}}),timer=setTimeout(()=>{done();reject(Error('Client state did not settle: '+JSON.stringify(store.getSnapshot())));},5000);});}
function fixture(t,{documentId='A'}={}){
  const records=new Map([[id1,operation()],[id2,operation(id2)]]),requests=[],saved=new Map(),pending=[];let write,read;
  const store=new SourceRestorationStore(documentId,{apiRoot:'http://fixture/api',storage:()=>({getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value)}),fetchImpl:async(url,init={})=>{
    const address=new URL(url),id=address.pathname.split('/')[3];requests.push({url:String(url),init,id});
    if(init.method==='POST'){if(write)return write(address,init);return response({ok:true,restoration:records.get(id),health});}
    if(read){const result=read(address,init);if(result)return result;}
    if(address.pathname==='/api/source-restores'){const offset=Number(address.searchParams.get('offset')||0),limit=Number(address.searchParams.get('limit')||20);return response({ok:true,items:[...records.values()].slice(offset,offset+limit),total:records.size,offset,limit,health});}
    return records.has(id)?response({ok:true,restoration:records.get(id),health}):response({ok:false,error:'not found'},404);
  }});
  let stop=store.start();t.after(()=>{stop();for(const item of pending)item.resolve(response({ok:true,restoration:operation(),health}));});
  return {store,records,requests,saved,pending,setWrite:value=>write=value,setRead:value=>read=value,stop:()=>stop(),restart:()=>{stop=store.start();},binding:{documentId,scope:documentId==='@storage'?'storage':'current-undo-redo',auditJobId:'sources-test',assetId:'asset',fileName:'original.step'}};
}

test('restoration presentation rejects foreign identity, invalid file proofs and unsafe material roles',()=>{
  assert.equal(parseRestoration(operation(),'A',id1).operationId,id1);assert.equal(parseRestoration(operation(),'B',id1).operationId,id1,'Associated projects may inspect shared-source records');
  for(const value of [{...operation(),operationId:id2},{...operation(),candidate:{...proof,sha256:'bad'}},{...operation(),canCommit:'true'},{...operation(),materials:[{role:'../../private',label:'bad',available:true}]},{...operation(),projects:['other'],documentId:'other'},{...operation(),createdAt:'bad'}])assert.throws(()=>parseRestoration(value,'A',id1));
  assert.throws(()=>parseRestorationHealth({blocked:'false',active:null}));assert.throws(()=>parseRestorationList({ok:true,items:[operation(),operation()],total:2,offset:0,limit:20,health},'A'));
});

test('closing during an accepted upload leaves its owned write alive; reopen only reads the original ID',async t=>{
  const f=fixture(t),write=deferred(),entered=deferred();f.pending.push(write);let uploaded;
  f.setWrite((url,init)=>{uploaded=url.pathname.split('/')[3];f.records.set(uploaded,operation(uploaded));entered.resolve(init.signal);return write.promise;});
  const creating=f.store.prepare(new File(['STEP'],'original.step'),f.binding),signal=await entered.promise;f.stop();assert.equal(signal.aborted,false,'UI close must not abort an owned write');
  write.resolve(response({ok:true,restoration:f.records.get(uploaded),health}));await creating;assert.equal(f.store.getSnapshot().selectedId,uploaded);assert.equal(f.store.getSnapshot().selected,null,'Admission receipts are not a second source of job state');
  f.restart();await until(f.store,state=>state.loaded&&state.selected?.operationId===uploaded&&!state.loadingDetail);assert.equal(f.requests.filter(item=>item.init.method==='POST').length,1);assert.equal(f.saved.get('cad.source-restore:A'),uploaded);
});

test('late details and completed writes cannot replace a newer manual history selection',async t=>{
  const f=fixture(t),old=deferred(),entered=deferred();f.pending.push(old);f.setRead(url=>{if(url.pathname.endsWith(id1)){entered.resolve();return old.promise;}});
  f.store.select(id1);await entered.promise;f.store.select(id2);await until(f.store,state=>state.selected?.operationId===id2);old.resolve(response({ok:true,restoration:operation(),health}));await new Promise(resolve=>setImmediate(resolve));assert.equal(f.store.getSnapshot().selected.operationId,id2);
  f.setRead(()=>null);f.store.select(id1);await until(f.store,state=>state.selected?.operationId===id1);const write=deferred(),started=deferred();f.pending.push(write);f.setWrite(()=>{started.resolve();return write.promise;});
  const committing=f.store.action('commit');await started.promise;f.store.select(id2);await until(f.store,state=>state.selected?.operationId===id2);write.resolve(response({ok:true,restoration:operation(id1,{state:'committed',canCommit:false,canRollback:true,changed:true}),health}));await committing;assert.equal(f.store.getSnapshot().selectedId,id2);assert.equal(f.store.getSnapshot().selected.operationId,id2);
});

test('unknown write outcomes stay attached to their operation across browsing and reopen, with no automatic POST retry',async t=>{
  const f=fixture(t);f.store.select(id1);await until(f.store,state=>state.selected?.operationId===id1);const failed=deferred(),started=deferred();f.pending.push(failed);f.setWrite(()=>{started.resolve();return failed.promise;});
  const committing=f.store.action('commit');await started.promise;f.store.select(id2);await until(f.store,state=>state.selected?.operationId===id2);failed.reject(Error('network response lost'));await committing;
  f.store.select(id1);await until(f.store,state=>state.selected?.operationId===id1);assert.equal(f.store.getSnapshot().unknownAction,'commit');await f.store.action('commit');assert.equal(f.requests.filter(item=>item.init.method==='POST').length,1);
  f.stop();f.restart();await until(f.store,state=>!state.loadingDetail&&state.selected?.operationId===id1);assert.equal(f.store.getSnapshot().unknownAction,'commit');f.store.acknowledge();assert.equal(f.store.getSnapshot().unknownAction,null);
});

test('a lost accepted reply is resolved by a matching committed record, not by re-executing the request',async t=>{
  const f=fixture(t);f.store.select(id1);await until(f.store,state=>state.selected?.operationId===id1);f.setWrite(()=>{f.records.set(id1,operation(id1,{state:'committed',canCommit:false,canRollback:true,changed:true}));throw Error('reply lost');});
  await f.store.action('commit');await until(f.store,state=>state.selected?.state==='committed'&&state.unknownAction===null);assert.match(f.store.getSnapshot().notice,/没有重发/);assert.equal(f.requests.filter(item=>item.init.method==='POST').length,1);
});

test('read failures do not erase known records, and a different project binding never sends a write',async t=>{
  const f=fixture(t);f.store.select(id1);await until(f.store,state=>state.selected?.operationId===id1);f.setRead(url=>url.pathname.endsWith(id1)?response({ok:false,error:'temporary detail failure'},500):null);
  await f.store.refresh();assert.equal(f.store.getSnapshot().selected.operationId,id1);assert.match(f.store.getSnapshot().detailError,/temporary/);assert.equal(f.store.getSnapshot().listError,'');
  await f.store.prepare(new File(['STEP'],'original.step'),{...f.binding,documentId:'other'});assert.equal(f.requests.filter(item=>item.init.method==='POST').length,0);assert.match(f.store.getSnapshot().error,/范围不一致/);
  f.setRead(()=>null);await f.store.refresh();assert.equal(f.store.getSnapshot().detailError,'');assert.match(f.store.getSnapshot().error,/范围不一致/,'A successful poll must not erase a rejected user action');
});
