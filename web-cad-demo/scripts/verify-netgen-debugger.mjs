// Fixed diagnostic cohort against retained CAD; never a product retry policy.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {selectBackendRelease} from '../gateway/backend-release.mjs';
import {validateNativeRuntime} from '../gateway/native-runtime-release.mjs';
import {hashFile,assertRegularDirectory} from '../gateway/frontend-release.mjs';

const root=path.resolve(import.meta.dirname,'..'),releaseRoot=path.resolve('.artifacts/constrained-ui-backend-releases'),inputRoot=path.resolve('.artifacts/sheet-constraints-service-final/data/mesh-jobs/default/mesh-1f098c74-1a64-4719-a1a0-d4cdfadc3e0d'),output=path.resolve(process.env.NETGEN_DEBUG_ARTIFACTS||'.artifacts/netgen-debugger-baseline'),debuggerPath='C:/Program Files (x86)/Windows Kits/10/Debuggers/x64/cdb.exe';
assert.equal(process.platform,'win32');assert.equal(process.versions.node,'24.22.3');assert.equal(path.dirname(output),path.join(root,'.artifacts'));assert.match(path.basename(output),/^netgen-debugger-/);assert.equal(fs.existsSync(output),false);assertRegularDirectory(path.dirname(output));fs.mkdirSync(output);
const backend=selectBackendRelease(releaseRoot),native=validateNativeRuntime(path.join(backend.directory,'native'),backend.native),{DiscreteTetraClient}=await import(pathToFileURL(path.join(backend.directory,'runtime/gateway/discrete-tetra-client.mjs')).href),read=name=>JSON.parse(fs.readFileSync(path.join(inputRoot,name)));
const snapshot=read('discrete-source.json'),metadata=read('metadata.json'),domain=read('partition.json'),settings=metadata.options.discreteTetra,input={domain,meshSize:settings.meshSize,quality:settings.quality,optimization:settings.optimization},sourceInput={...snapshot.cad.bundle.input,options:snapshot.settings.repair};
assert.equal(input.optimization.method,'netgen');
const inputs=['discrete-source.json','metadata.json','partition.json'].map(name=>({file:path.relative(root,path.join(inputRoot,name)).replaceAll('\\','/'),sha256:hashFile(path.join(inputRoot,name))})),sourceProof={file:'scripts/verify-netgen-debugger.mjs',sha256:hashFile('scripts/verify-netgen-debugger.mjs')},records=[],children=new Set(),debuggers=new Set();
for(let run=1;run<=20;run++){
  const directory=path.join(output,'run-'+String(run).padStart(2,'0'));fs.mkdirSync(directory);const logFile=path.join(directory,'debugger.log'),stderr=[],start=performance.now();let debugDone,debugError,attached=false,debugCode;
  const client=new DiscreteTetraClient({workerPath:native.roles.mesh,runtimePath:native.meshBin,timeoutMs:60000,spawnImpl:(...args)=>{
    const child=spawn(...args);children.add(child);child.once('close',()=>children.delete(child));child.stderr.on('data',bytes=>{if(stderr.join('').length<32768)stderr.push(bytes.toString());});
    const write=child.stdin.write.bind(child.stdin);
    child.stdin.write=(chunk,...writeArgs)=>{
      if(!attached&&JSON.parse(String(chunk)).operation==='mesh.discrete-tetra'){
        attached=true;
        const command='sxe -c ".ecxr; kv; r; u @rip-20 L40; lm; .dump /m fault.dmp; q" av; .echo NETGEN_DEBUGGER_READY; g';
        const debug=spawn(debuggerPath,['-p',String(child.pid),'-G','-logo',logFile,'-c',command],{cwd:directory,windowsHide:true,stdio:['ignore','pipe','pipe']});debuggers.add(debug);
        let diagnostic='';const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Debugger attach did not reach its explicit ready marker.')),15000);const onData=bytes=>{diagnostic=(diagnostic+bytes).slice(-262144);if(diagnostic.includes('NETGEN_DEBUGGER_READY')){clearTimeout(timer);resolve();}};debug.stdout.on('data',onData);debug.stderr.on('data',onData);debug.once('error',error=>{clearTimeout(timer);reject(error);});debug.once('close',()=>{clearTimeout(timer);if(!diagnostic.includes('NETGEN_DEBUGGER_READY'))reject(Error('Debugger closed before ready: '+diagnostic.slice(-4096)));});});
        debugDone=new Promise(resolve=>debug.once('close',(code,signal)=>{debuggers.delete(debug);debugCode={code,signal};resolve();}));
        void ready.then(()=>write(chunk,...writeArgs)).catch(error=>{debugError=error.message;child.kill();});return true;
      }
      return write(chunk,...writeArgs);
    };
    return child;
  }});
  try{
    const result=await client.tetrahedralize(input,{sourceInput});fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result),{flag:'wx'});records.push({run,ok:true,tetrahedra:result.report.tetraCount,minimumSICN:result.quality.minimumSICN,optimization:result.optimization.disposition});
  }catch(error){records.push({run,ok:false,code:error.code,message:error.message,stderr:stderr.join('')});}
  finally{await client.closeAndWait();if(debugDone)await Promise.race([debugDone,new Promise((_,reject)=>setTimeout(()=>reject(Error('Debugger did not close after its owned target exited.')),10000))]);}
  assert.equal(children.size,0);assert.equal(debuggers.size,0);assert.equal(debugError,undefined,debugError);assert.equal(attached,true);
  const trace=fs.readFileSync(logFile,'utf8');assert.match(trace,/NETGEN_DEBUGGER_READY/);const record=records.at(-1);Object.assign(record,{elapsedMs:Math.round(performance.now()-start),debuggerExit:debugCode,debuggerLogSha256:hashFile(logFile),accessViolation:/Access violation|c0000005/i.test(trace),dumpPresent:fs.existsSync(path.join(directory,'fault.dmp'))});console.log(JSON.stringify(record));
}
for(const item of [...inputs,sourceProof])assert.equal(hashFile(path.join(root,item.file)),item.sha256);assert.equal(selectBackendRelease(releaseRoot,backend.releaseId).manifestSha256,backend.manifestSha256);validateNativeRuntime(path.join(backend.directory,'native'),backend.native);
const report={format:'web-cad-netgen-debugger-cohort',version:1,ok:true,createdAt:new Date().toISOString(),scope:'Twenty predeclared independent diagnostic processes with one retained input and invasive debugger attachment; not retry, root-cause proof or product acceptance',backend:{releaseId:backend.releaseId,manifestSha256:backend.manifestSha256,nativeSha256:backend.native.sha256},debugger:{file:debuggerPath,sha256:hashFile(debuggerPath)},inputs,sourceProof,records,counts:{total:records.length,passed:records.filter(r=>r.ok).length,failed:records.filter(r=>!r.ok).length,accessViolations:records.filter(r=>r.accessViolation).length,dumps:records.filter(r=>r.dumpPresent).length},childrenExited:true,dailyServicesChanged:false,paidProviderCalls:0};fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({ok:true,counts:report.counts,output}));
