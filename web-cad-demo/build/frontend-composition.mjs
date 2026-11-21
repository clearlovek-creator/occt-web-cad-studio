/** Build-time evidence, not a runtime loader or a legal certification. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const slash=value=>value.replaceAll('\\','/');
const relative=(root,file)=>slash(path.relative(root,file));
const safe=file=>typeof file==='string'&&file.length>0&&file.length<=2048&&!path.posix.isAbsolute(file)&&!file.split('/').some(p=>!p||p==='.'||p==='..'||/[\\:\x00-\x1f]/.test(p));
const inside=(root,file)=>{const rel=relative(root,file);return rel===''||safe(rel);};
const fail=message=>{throw Object.assign(Error(message),{code:'FRONTEND_COMPOSITION_INVALID'});};
const NOTICE=/^(?:licen[cs]e|copying|notice|copyright)(?:$|[._-])/i;
export const graphFile='.cad-module-evidence.json';
export const environmentFolders={client:'dist/client',rsc:'dist/server',ssr:'dist/server/ssr'};
function ordinary(root,file,limit=4*1024*1024){
  if(!inside(root,file)||path.resolve(root)===path.resolve(file))fail('Evidence file escapes its declared root.');let current=root;
  for(const part of ['',...relative(root,file).split('/').slice(0,-1)]){if(part)current=path.join(current,part);const s=fs.lstatSync(current);if(!s.isDirectory()||s.isSymbolicLink())fail('Evidence directory links are not accepted.');}
  const before=fs.lstatSync(file,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>BigInt(limit))fail('Evidence requires a bounded ordinary single-link file.');
  const bytes=fs.readFileSync(file),after=fs.lstatSync(file,{bigint:true});if(['dev','ino','size','mtimeNs','ctimeNs'].some(k=>before[k]!==after[k])||BigInt(bytes.length)!==before.size)fail('Evidence changed while reading.');return bytes;
}
function jsonBytes(bytes){try{return JSON.parse(bytes);}catch{fail('Composition JSON is invalid.');}}
function packageRecord(dependencies,root){
  const location='node_modules/'+relative(dependencies,root);if(!safe(location))fail('Package location is invalid.');
  const bytes=ordinary(dependencies,path.join(root,'package.json')),metadata=jsonBytes(bytes);
  if(typeof metadata.name!=='string'||!/^(@[\w.-]+\/)?[\w.-]+$/.test(metadata.name)||typeof metadata.version!=='string'||!metadata.version||metadata.version.length>160)fail('Bundled package identity is invalid.');
  const notices=fs.readdirSync(root,{withFileTypes:true}).filter(e=>NOTICE.test(e.name)&&!e.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name,'en')).map(e=>{const text=ordinary(dependencies,path.join(root,e.name));return {file:e.name,bytes:text.length,sha256:sha(text)};});
  return {id:location,name:metadata.name,version:metadata.version,licenseDeclarations:typeof metadata.license==='string'?[metadata.license]:[],packageJson:{bytes:bytes.length,sha256:sha(bytes)},notices};
}
export function createModuleClassifier({root,dependencies}){
  root=fs.realpathSync(root);dependencies=fs.realpathSync(dependencies);const packages=new Map();
  function classify(id){
    if(typeof id!=='string'||id.length>32768)fail('Module ID exceeds its budget.');
    const unknown=()=>({id:'generated:'+sha(id),kind:'generated',package:null});
    if(id.includes('\0'))return unknown();
    const query=id.indexOf('?'),file=query<0?id:id.slice(0,query),suffix=query<0?'':'?'+sha(id.slice(query));
    if(!path.isAbsolute(file)||!fs.existsSync(file))return unknown();
    const real=fs.realpathSync(file);
    if(inside(dependencies,real)){
      let folder=path.dirname(real);while(inside(dependencies,folder)&&folder!==dependencies){
        if(fs.existsSync(path.join(folder,'package.json'))){let record=packages.get(folder);if(!record){record=packageRecord(dependencies,folder);packages.set(folder,record);}return {id:record.id+'/'+relative(folder,real)+suffix,kind:'package',package:record.id};}
        folder=path.dirname(folder);
      }fail('Bundled dependency has no package identity.');
    }
    if(inside(root,real)){const rel=relative(root,real);if(!safe(rel))return unknown();return {id:'project:'+rel+suffix,kind:'project',package:null};}
    // Never serialize an absolute machine path or guess a supplier from a virtual ID.
    return unknown();
  }
  return {classify,packages:()=>[...packages.values()].sort((a,b)=>a.id.localeCompare(b.id,'en'))};
}
export function collectChunkEvidence(bundle,{environment,classifier}){
  if(!Object.hasOwn(environmentFolders,environment))fail('Unexpected build environment.');
  const chunks=[];
  for(const chunk of Object.values(bundle)){
    if(chunk.type!=='chunk')continue;
    if(!safe(chunk.fileName)||typeof chunk.code!=='string'||!chunk.modules||typeof chunk.modules!=='object')fail('Output chunk metadata is unavailable.');
    const modules=Object.entries(chunk.modules).map(([id,value])=>{if(!Number.isSafeInteger(value.renderedLength)||value.renderedLength<0)fail('Rendered module metadata is unavailable.');return {...classifier.classify(id),renderedLength:value.renderedLength};}).sort((a,b)=>a.id.localeCompare(b.id,'en'));
    if(new Set(modules.map(m=>m.id)).size!==modules.length)fail('Normalized module identities collide.');
    chunks.push({file:chunk.fileName,bytes:Buffer.byteLength(chunk.code),sha256:sha(chunk.code),entry:chunk.isEntry===true,imports:[...chunk.imports],dynamicImports:[...chunk.dynamicImports],modules});
  }
  if(!chunks.length||chunks.length>2048||chunks.reduce((sum,c)=>sum+c.modules.length,0)>100000)fail('Chunk evidence is empty or exceeds its budget.');
  return {format:'web-cad-output-module-evidence',version:1,environment,method:'bundler-output-chunk-modules',chunks:chunks.sort((a,b)=>a.file.localeCompare(b.file,'en')),packages:classifier.packages(),limits:['Module lists describe bundler output inclusion, not exact minified byte attribution. Zero rendered length is retained, not counted as positive code contribution.','Generated/virtual modules have opaque IDs; supplier identity is not inferred from their names. Assets and code generated outside output chunks require separate evidence.']};
}
/** @returns {import('vite').Plugin} */
export function frontendCompositionPlugin(){
  let root,dependencies;
  return {name:'cad-output-module-evidence',apply:'build',enforce:'post',configResolved(config){root=config.root;dependencies=path.join(root,'node_modules');},generateBundle:{order:'post',handler(_options,bundle){
    const classifier=createModuleClassifier({root,dependencies}),evidence=collectChunkEvidence(bundle,{environment:this.environment?.name,classifier});
    this.emitFile({type:'asset',fileName:graphFile,source:JSON.stringify(evidence)});
  }}};
}
export function validateChunkEvidence(evidence,{directory,environment}){
  if(evidence?.format!=='web-cad-output-module-evidence'||evidence.version!==1||evidence.environment!==environment||evidence.method!=='bundler-output-chunk-modules'||!Array.isArray(evidence.chunks)||!evidence.chunks.length||evidence.chunks.length>2048||!Array.isArray(evidence.packages)||evidence.packages.length>1024)fail('Output module evidence identity is invalid.');
  const packages=new Set(),chunks=new Set();
  for(const pkg of evidence.packages){if(!safe(pkg.id)||!pkg.id.startsWith('node_modules/')||packages.has(pkg.id)||typeof pkg.name!=='string'||typeof pkg.version!=='string'||!Array.isArray(pkg.notices))fail('Package evidence is invalid.');packages.add(pkg.id);}
  let moduleCount=0;
  for(const chunk of evidence.chunks){
    if(!safe(chunk.file)||chunks.has(chunk.file)||!Array.isArray(chunk.modules)||!Array.isArray(chunk.imports)||!Array.isArray(chunk.dynamicImports))fail('Chunk evidence is invalid.');chunks.add(chunk.file);
    const bytes=ordinary(directory,path.join(directory,...chunk.file.split('/')),32*1024*1024);if(bytes.length!==chunk.bytes||sha(bytes)!==chunk.sha256)fail('Output chunk differs from the compiler evidence.');
    const seen=new Set();for(const record of chunk.modules){if(typeof record.id!=='string'||seen.has(record.id)||!['package','project','generated'].includes(record.kind)||!Number.isSafeInteger(record.renderedLength)||record.renderedLength<0||record.kind==='package'&&!packages.has(record.package)||record.kind!=='package'&&record.package!==null)fail('Module evidence is invalid.');seen.add(record.id);moduleCount++;}
  }
  if(moduleCount>100000)fail('Module evidence exceeds its budget.');return {chunks:chunks.size,moduleRecords:moduleCount};
}
function unrecordedScripts(release,covered){
  const result=[];let files=0;
  function walk(folder){for(const entry of fs.readdirSync(folder,{withFileTypes:true})){if(++files>10000)fail('Build output exceeds its file budget.');const file=path.join(folder,entry.name);if(entry.isSymbolicLink())fail('Build output links are not accepted.');if(entry.isDirectory())walk(file);else if(/\.(?:m?js|cjs)$/.test(entry.name)&&!covered.has(relative(release,file)))result.push(relative(release,file));}}
  walk(path.join(release,'dist'));return result.sort();
}
export function validateSealedFrontendComposition({release,descriptor}){
  const expected='runtime/provenance/composition/composition.json';if(descriptor?.file!==expected||!/^[a-f0-9]{64}$/.test(descriptor.sha256))fail('Sealed composition descriptor is invalid.');
  const bytes=ordinary(release,path.join(release,expected),16*1024*1024);if(sha(bytes)!==descriptor.sha256)fail('Sealed composition hash differs.');const value=jsonBytes(bytes);
  if(value.format!=='web-cad-frontend-composition'||value.version!==1||value.scope!=='bundler-output-chunks-only'||!Array.isArray(value.environments)||value.environments.length!==3||!Array.isArray(value.packages)||!Array.isArray(value.noticeFiles))fail('Sealed composition identity is invalid.');
  const graphs=[],packages=new Map(),covered=new Set(),environmentNames=new Set();
  for(const entry of value.environments){
    if(!Object.hasOwn(environmentFolders,entry.environment)||environmentNames.has(entry.environment)||entry.file!==environmentFolders[entry.environment]+'/'+graphFile)fail('Sealed composition environments are invalid.');environmentNames.add(entry.environment);
    const graphBytes=ordinary(release,path.join(release,entry.file),16*1024*1024);if(graphBytes.length!==entry.bytes||sha(graphBytes)!==entry.sha256)fail('Sealed module graph differs.');const graph=jsonBytes(graphBytes),counts=validateChunkEvidence(graph,{directory:path.join(release,environmentFolders[entry.environment]),environment:entry.environment});if(counts.chunks!==entry.chunks||counts.moduleRecords!==entry.moduleRecords)fail('Sealed graph counts differ.');graphs.push(graph);
    for(const chunk of graph.chunks)covered.add(environmentFolders[entry.environment]+'/'+chunk.file);
    for(const pkg of graph.packages){if(packages.has(pkg.id)&&JSON.stringify(packages.get(pkg.id))!==JSON.stringify(pkg))fail('Sealed package evidence is inconsistent.');packages.set(pkg.id,pkg);}
  }
  if(JSON.stringify([...packages.values()].sort((a,b)=>a.id.localeCompare(b.id,'en')))!==JSON.stringify(value.packages)||packages.size!==descriptor.packages||descriptor.environments!==3||value.noticeFiles.length!==descriptor.noticeFiles)fail('Sealed composition aggregate differs.');
  const expectedNotices=new Map();for(const pkg of packages.values())for(const n of pkg.notices){if(!safe(n.file)||!Number.isSafeInteger(n.bytes)||n.bytes<0||!/^[a-f0-9]{64}$/.test(n.sha256))fail('Notice evidence is invalid.');if(expectedNotices.has(n.sha256)&&expectedNotices.get(n.sha256)!==n.bytes)fail('Notice evidence is inconsistent.');expectedNotices.set(n.sha256,n.bytes);}
  if(expectedNotices.size!==value.noticeFiles.length)fail('Sealed notice coverage differs.');let noticeBytes=0;const noticeIds=new Set();
  for(const n of value.noticeFiles){if(n.file!=='runtime/provenance/composition/notices/'+n.sha256+'.txt'||noticeIds.has(n.sha256)||expectedNotices.get(n.sha256)!==n.bytes)fail('Sealed notice membership differs.');noticeIds.add(n.sha256);const text=ordinary(release,path.join(release,n.file));noticeBytes+=text.length;if(noticeBytes>32*1024*1024||text.length!==n.bytes||sha(text)!==n.sha256)fail('Sealed notice bytes differ.');}
  if(JSON.stringify(unrecordedScripts(release,covered))!==JSON.stringify(value.unrecordedJavaScript))fail('Unrecorded JavaScript ledger differs.');
  return {composition:value,graphs};
}
export function sealFrontendComposition({workspace,release}){
  const dependencies=fs.realpathSync(path.join(workspace,'node_modules')),packages=new Map(),environments=[],covered=new Set();
  for(const [environment,folder]of Object.entries(environmentFolders)){
    const directory=path.join(release,folder),file=path.join(directory,graphFile),bytes=ordinary(release,file,16*1024*1024),evidence=jsonBytes(bytes),counts=validateChunkEvidence(evidence,{directory,environment});
    for(const chunk of evidence.chunks)covered.add(folder+'/'+chunk.file);
    for(const pkg of evidence.packages){const previous=packages.get(pkg.id);if(previous&&JSON.stringify(previous)!==JSON.stringify(pkg))fail('Dependency identity or notices changed between build environments.');packages.set(pkg.id,pkg);}
    environments.push({environment,file:folder+'/'+graphFile,bytes:bytes.length,sha256:sha(bytes),...counts});
  }
  const notices=new Map();
  for(const pkg of packages.values()){
    const packageRoot=path.join(dependencies,...pkg.id.slice('node_modules/'.length).split('/')),actual=packageRecord(dependencies,packageRoot);
    if(JSON.stringify(actual)!==JSON.stringify(pkg))fail('Bundled package changed before sealing.');
    for(const item of pkg.notices){const bytes=ordinary(dependencies,path.join(packageRoot,item.file));if(bytes.length!==item.bytes||sha(bytes)!==item.sha256)fail('Package notice changed before sealing.');notices.set(item.sha256,bytes);}
  }
  const unrecordedJavaScript=unrecordedScripts(release,covered);
  if([...notices.values()].reduce((sum,bytes)=>sum+bytes.length,0)>32*1024*1024)fail('Notice copies exceed their budget.');
  const output=path.join(release,'runtime/provenance/composition');fs.mkdirSync(output,{recursive:true});fs.mkdirSync(path.join(output,'notices'));
  for(const [hash,bytes]of notices)fs.writeFileSync(path.join(output,'notices',hash+'.txt'),bytes,{flag:'wx'});
  const result={format:'web-cad-frontend-composition',version:1,scope:'bundler-output-chunks-only',environments,packages:[...packages.values()].sort((a,b)=>a.id.localeCompare(b.id,'en')),noticeFiles:[...notices].map(([hash,bytes])=>({file:'runtime/provenance/composition/notices/'+hash+'.txt',bytes:bytes.length,sha256:hash})),unrecordedJavaScript:unrecordedJavaScript.sort(),gaps:['Generated/virtual module suppliers and non-JavaScript asset composition are not certified.',...unrecordedJavaScript.length?['JavaScript written outside recorded output chunks remains unattributed.']:[],...packages.values().some(p=>!p.notices.length)?['One or more bundled packages have no package-local notice text.']:[]]};
  fs.writeFileSync(path.join(output,'composition.json'),JSON.stringify(result,null,2),{flag:'wx'});const descriptor={file:'runtime/provenance/composition/composition.json',sha256:sha(fs.readFileSync(path.join(output,'composition.json'))),packages:packages.size,noticeFiles:notices.size,environments:environments.length};validateSealedFrontendComposition({release,descriptor});return descriptor;
}
