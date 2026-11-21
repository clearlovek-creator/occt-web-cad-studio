import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileInventory,hashFile,atomicJson,assertRegularDirectory,validateRelease,frontendEnvironment,productionServerPath,copyCertifiedFiles,copyRuntimeExternals,frontendBuildInputs} from '../gateway/frontend-release.mjs';
import {copyProductionRuntime} from './frontend-runtime-closure.mjs';
import {sealFrontendComposition} from '../build/frontend-composition.mjs';

const workspace=path.resolve(import.meta.dirname,'..');
const args=process.argv.slice(2),rootIndex=args.indexOf('--release-root');
const root=path.resolve(rootIndex>=0?args[rootIndex+1]:path.join(workspace,'.releases'));
fs.mkdirSync(root,{recursive:true});assertRegularDirectory(root);
const id='frontend-'+Date.now()+'-'+crypto.randomUUID(),staging=path.join(root,'.pending-'+crypto.randomUUID()),source=path.join(staging,'source'),published=path.join(root,id);
const runtimeInputs=['scripts/frontend-server.mjs','gateway/frontend-release.mjs','gateway/frontend-proxy.mjs','gateway/frontend-assets.mjs'];
const inputs=frontendBuildInputs(2);
let link;
function sourceInventory(base=workspace){return inputs.flatMap(name=>{
  const file=path.join(base,name);if(!fs.existsSync(file))return [];
  const stat=fs.lstatSync(file);if(stat.isSymbolicLink())throw Error('Build inputs cannot be symbolic links.');
  return stat.isDirectory()?fileInventory(file).map(item=>({...item,file:name+'/'+item.file})):[{file:name,bytes:stat.size,sha256:hashFile(file)}];
});}
function safeCleanup(){
  if(path.dirname(staging)!==root||!path.basename(staging).startsWith('.pending-'))throw Error('Unexpected staging path; no cleanup performed.');
  if(link&&fs.existsSync(link)){if(!fs.lstatSync(link).isSymbolicLink())throw Error('Dependency link changed type; preserve staging for inspection.');fs.unlinkSync(link);}
  if(fs.existsSync(staging)){assertRegularDirectory(staging);fs.rmSync(staging,{recursive:true,force:true});}
}
try{
  const before=sourceInventory(),sourceSha256=crypto.createHash('sha256').update(JSON.stringify(before)).digest('hex');
  fs.mkdirSync(source,{recursive:true});
  copyCertifiedFiles(workspace,source,before);
  const copied=sourceInventory(source);
  if(JSON.stringify(copied)!==JSON.stringify(before)){
    const changed=[...new Set([...before,...copied].map(item=>item.file))].filter(file=>JSON.stringify(before.find(item=>item.file===file))!==JSON.stringify(copied.find(item=>item.file===file)));
    throw Error('Source changed while copying; candidate rejected before compilation. Inputs: '+changed.slice(0,10).join(', ')+'; first='+JSON.stringify({before:before.find(item=>item.file===changed[0]),copied:copied.find(item=>item.file===changed[0]),copiedFirst:copied.slice(0,2)}));
  }
  link=path.join(source,'node_modules');fs.symlinkSync(path.join(workspace,'node_modules'),link,process.platform==='win32'?'junction':'dir');
  const env={...frontendEnvironment(process.env),NODE_ENV:'production',CAD_FRONTEND_TARGET:'node',NEXT_PUBLIC_CAD_API_MODE:'same-origin'};
  delete env.NEXT_PUBLIC_GEOMETRY_API_URL;
  const child=spawn(process.execPath,[path.join(workspace,'node_modules/vinext/dist/cli.js'),'build'],{cwd:source,env,windowsHide:true,stdio:['ignore','inherit','inherit']});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});if(code!==0)throw Error('Frontend release build failed; prior selected version was not changed.');
  if(JSON.stringify(sourceInventory())!==JSON.stringify(before)||JSON.stringify(sourceInventory(source))!==JSON.stringify(before))throw Error('Source changed while building; candidate rejected. Build again from a stable source state.');
  // Windows build tools and directory watchers can retain directory handles
  // briefly after child exit. Publish a checked copy, never rename a live tree.
  fs.mkdirSync(published);copyCertifiedFiles(path.join(source,'dist'),path.join(published,'dist'),fileInventory(path.join(source,'dist')));
  const runtimePackages=copyRuntimeExternals(workspace,path.join(published,'dist'),published);
  for(const name of runtimeInputs){const target=path.join(published,'runtime',name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(source,name),target,fs.constants.COPYFILE_EXCL);}
  const productionRuntime=copyProductionRuntime(workspace,published);
  fs.mkdirSync(path.join(published,'runtime/provenance'),{recursive:true});fs.copyFileSync(path.join(source,'package-lock.json'),path.join(published,'runtime/provenance/package-lock.json'),fs.constants.COPYFILE_EXCL);
  const compiledComposition=sealFrontendComposition({workspace,release:published});
  if(JSON.stringify(sourceInventory())!==JSON.stringify(before))throw Error('Source changed while sealing the production runtime.');
  for(const item of fileInventory(published)){const fd=fs.openSync(path.join(published,item.file),'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
  const productionServerSha256=hashFile(productionServerPath(workspace));
  const manifest={format:'web-cad-frontend-release',version:2,releaseId:id,builtAt:new Date().toISOString(),runtime:'vinext-node',apiMode:'same-origin',nodeVersion:process.versions.node,sourceSha256,dependencyLockSha256:hashFile(path.join(source,'package-lock.json')),productionServerSha256,productionRuntime,runtimePackages,compiledComposition,files:fileInventory(published)};
  atomicJson(path.join(published,'release.json'),manifest);validateRelease(published,workspace);
  if(!args.includes('--no-select'))atomicJson(path.join(root,'selected.json'),{format:'web-cad-frontend-selection',version:1,releaseId:id});
  console.log(JSON.stringify({ok:true,releaseId:id,directory:published,files:manifest.files.length,selected:!args.includes('--no-select')}));
}catch(error){console.error(JSON.stringify({type:'cad.build',phase:'failed',code:error.code||'FRONTEND_BUILD_FAILED',error:error.message}));process.exitCode=1;}
finally{try{safeCleanup();}catch{console.warn(JSON.stringify({type:'cad.build',phase:'cleanup-deferred',staging,error:'临时构建目录仍被占用；保留待检查，不影响已校验的发布版本。'}));}}
