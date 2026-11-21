import test from 'node:test';
import assert from 'node:assert/strict';
import {DocumentLoader,DocumentLoadError} from '../gateway/document-loader.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(options={}){
  const histories=new Map([['doc',{current:'current',undo:['old'],redo:[],restoreError:null}]]),calls=[],phases=[],applied=[];
  const historyStore={get:id=>histories.get(id)||{current:null,undo:[],redo:[],restoreError:null},isValidSnapshot:()=>true,readProjectData:(_id,path)=>({path}),markRestoreError:(id,error)=>{histories.get(id).restoreError=error;}};
  const loader=new DocumentLoader({historyStore,restore:async(id,file)=>{calls.push([id,file]);return {ok:true,revision:4};},applyProjectData:async(id,schema)=>{applied.push([id,schema]);},recoverCheckpoint:async(id,old,path,_result,schema)=>{histories.set(id,{...old,current:path,undo:[],redo:[],restoreError:null});applied.push([id,schema]);},onProgress:(id,phase)=>phases.push([id,phase]),...options});return {loader,histories,calls,phases,applied,historyStore};
}

test('cold status and catalog counts do not restore or mutate native documents',()=>{
  const {loader,calls,applied}=fixture();assert.equal(loader.status('doc').state,'unloaded');assert.deepEqual(loader.counts(['doc']),{known:1,unloaded:1,loading:0,ready:0,failed:0});assert.deepEqual(calls,[]);assert.deepEqual(applied,[]);
});
test('concurrent opens share one restoration; readiness follows geometry and project data',async()=>{
  const geometry=deferred(),properties=deferred(),calls=[];const {loader,phases}=fixture({restore:async(id,file)=>{calls.push([id,file]);return geometry.promise;},applyProjectData:()=>properties.promise});const first=loader.ensure('doc'),second=loader.ensure('doc');assert.equal(first,second);await Promise.resolve();assert.equal(loader.status('doc').phase,'restoring-geometry');assert.equal(loader.loaded.size,0);geometry.resolve({ok:true});await new Promise(resolve=>setImmediate(resolve));assert.equal(loader.status('doc').phase,'restoring-project-data');assert.equal(loader.loaded.size,0);properties.resolve();await Promise.all([first,second]);assert.equal(calls.length,1);assert.equal(loader.status('doc').state,'ready');await loader.ensure('doc');assert.equal(calls.length,1);assert.deepEqual(phases.map(row=>row[1]),['checking','checking','restoring-geometry','restoring-project-data']);
});
test('loader-level pending work and failures are isolated by project; native worker scheduling is separate',async()=>{
  const slow=deferred();const {loader,histories}=fixture({restore:(id)=>id==='slow'?slow.promise:Promise.resolve({ok:true})});histories.set('slow',{current:'current',undo:[],redo:[]});histories.set('broken',{current:null,undo:[],redo:[],restoreError:'damaged manifest'});const pending=loader.ensure('slow');await loader.ensure('doc');assert.equal(loader.status('doc').state,'ready');assert.equal(loader.status('slow').state,'loading');await assert.rejects(loader.ensure('broken'),/damaged manifest/);assert.equal(loader.status('broken').state,'failed');slow.resolve({ok:true});await pending;
});
test('fallback uses only validated checkpoints and publishes properties from the successful native restore',async()=>{
  const calls=[],applied=[];const {loader,histories}=fixture({restore:async(id,file)=>{calls.push(file);return {ok:file==='old',error:'native read failed'};},applyProjectData:async()=>assert.fail('Current corrupt checkpoint must not publish properties'),recoverCheckpoint:async(id,history,path,_result,schema)=>{assert.equal(path,'old');applied.push(schema);histories.set(id,{...history,current:path,restoreError:null});}});await loader.ensure('doc');assert.deepEqual(calls,['current','old']);assert.deepEqual(applied,[{path:'old'}]);assert.equal(loader.status('doc').recovered,true);
});
test('transport failure never proves corruption or walks back history and a later explicit read can retry',async()=>{
  let attempts=0;const {loader,histories}=fixture({restore:async()=>{if(++attempts===1)throw Object.assign(Error('worker timeout'),{code:'WORKER_TIMEOUT'});return {ok:true};}});await assert.rejects(loader.ensure('doc'),/timeout/);assert.equal(histories.get('doc').restoreError,null);assert.equal(histories.get('doc').current,'current');assert.equal(loader.status('doc').state,'unloaded');await loader.ensure('doc');assert.equal(attempts,2);assert.equal(loader.status('doc').state,'ready');
});
test('an old-generation load cannot publish properties or mark a replacement worker ready',async()=>{
  const old=deferred(),{loader,applied}=fixture({restore:()=>old.promise});const pending=loader.ensure('doc'),rejected=assert.rejects(pending,error=>error instanceof DocumentLoadError&&error.code==='DOCUMENT_LOAD_INTERRUPTED');await Promise.resolve();loader.invalidate();old.resolve({ok:true});await rejected;assert.equal(loader.loaded.size,0);assert.deepEqual(applied,[]);assert.equal(loader.status('doc').state,'unloaded');
});
test('all invalid candidates fail without empty-model substitution and property application failure blocks readiness',async()=>{
  const broken=fixture();broken.historyStore.isValidSnapshot=()=>false;await assert.rejects(broken.loader.ensure('doc'),error=>error.code==='HISTORY_RESTORE_FAILED');assert.equal(broken.loader.loaded.size,0);assert.deepEqual(broken.calls,[]);assert.equal(broken.loader.status('doc').state,'failed');
  const properties=fixture({applyProjectData:async()=>{throw Error('write denied');}});await assert.rejects(properties.loader.ensure('doc'),error=>error.code==='PROJECT_DATA_RESTORE_FAILED');assert.equal(properties.loader.status('doc').state,'failed');assert.equal(properties.loader.loaded.size,0);
});
