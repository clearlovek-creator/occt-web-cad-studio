import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {validateSealedFrontendComposition,environmentFolders} from '../build/frontend-composition.mjs';
const LICENSE=/^(?:licen[cs]e|copying|notice|copyright)(?:$|[._-])/i;
const HASH=/^[a-f0-9]{64}$/;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=message=>Object.assign(Error(message),{code:'COMPONENT_INVENTORY_INVALID'});
const relative=(root,file)=>path.relative(root,file).replaceAll('\\','/');
function ordinaryTreeFile(root,file){
  const rel=relative(root,file);if(!safeRelative(rel))throw fail('External evidence escapes its declared root.');let current=path.resolve(root);
  for(const part of ['',...rel.split('/').slice(0,-1)]){if(part)current=path.join(current,part);const stat=fs.lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('External evidence directory links are not accepted.');}
  return file;
}
function readOrdinary(file,limit=4*1024*1024){
  const before=fs.lstatSync(file,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>BigInt(limit))throw fail('Inventory input must be a bounded ordinary single-link file.');
  const bytes=fs.readFileSync(file),after=fs.lstatSync(file,{bigint:true});if(['dev','ino','size','mtimeNs','ctimeNs'].some(key=>before[key]!==after[key])||BigInt(bytes.length)!==before.size)throw fail('Inventory input changed while reading.');return bytes;
}
export function parsePacmanSections(bytes){
  const sections={};let current;for(const line of bytes.toString('utf8').split(/\r?\n/)){
    if(line.length>4096)throw fail('Package database line exceeds its budget.');
    const header=/^%([A-Z0-9_]+)%$/.exec(line);if(header){current=header[1];if(Object.hasOwn(sections,current))throw fail('Duplicate package database section.');sections[current]=[];}
    else if(line){if(!current)throw fail('Package database has data before a section.');sections[current].push(line);}
  }return sections;
}
const safeRelative=file=>typeof file==='string'&&file&&!path.posix.isAbsolute(file)&&!file.replace(/\/$/,'').split('/').some(part=>!part||part==='..'||part==='.'||/[\\:\x00-\x1f]/.test(part));
export function loadPacmanEvidence(msysRoot,wantedNames){
  const database=path.join(msysRoot,'var/lib/pacman/local'),packages=[],proofs=[],index=new Map();let total=0,entries=0;
  const stat=fs.lstatSync(database);if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('Package database must be an ordinary directory.');
  const allEntries=fs.readdirSync(database,{withFileTypes:true});if(allEntries.some(entry=>entry.isSymbolicLink()))throw fail('Linked package database entries are not accepted.');const directories=allEntries.filter(entry=>entry.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name,'en'));if(directories.length>2048)throw fail('Package database exceeds 2048 packages.');
  for(const entry of directories){
    const folder=path.join(database,entry.name);if(fs.lstatSync(folder).isSymbolicLink())throw fail('Linked package database entries are not accepted.');
    const descriptor=readOrdinary(ordinaryTreeFile(msysRoot,path.join(folder,'desc'))),listing=readOrdinary(ordinaryTreeFile(msysRoot,path.join(folder,'files')),8*1024*1024);total+=descriptor.length+listing.length;if(total>64*1024*1024)throw fail('Package database exceeds 64 MiB.');
    const desc=parsePacmanSections(descriptor),files=parsePacmanSections(listing).FILES||[];entries+=files.length;if(entries>1000000)throw fail('Package database file entries exceed their budget.');
    if(desc.NAME?.length!==1||desc.VERSION?.length!==1||!/^[A-Za-z0-9+_.-]+$/.test(desc.NAME[0])||desc.VERSION[0].length>160)throw fail('Package identity metadata is invalid.');
    const pkg={name:desc.NAME[0],version:desc.VERSION[0],licenseDeclarations:desc.LICENSE||[],databaseKey:entry.name,licensePaths:[]};
    for(const file of files){if(!safeRelative(file))throw fail('Package database contains an unsafe relative path.');if(file.endsWith('/'))continue;
      if(LICENSE.test(path.posix.basename(file)))pkg.licensePaths.push(file);
      const name=path.posix.basename(file).toLowerCase();if(wantedNames.has(name)){if(!index.has(name))index.set(name,[]);index.get(name).push({pkg,file});}
    }
    packages.push(pkg);proofs.push({file:relative(msysRoot,path.join(folder,'desc')),bytes:descriptor.length,sha256:sha(descriptor)},{file:relative(msysRoot,path.join(folder,'files')),bytes:listing.length,sha256:sha(listing)});
  }
  return {packages,proofs,index,bytes:total,entries};
}
export function certifiedBundleReader(directory,files){
  const index=new Map(files.map(file=>[file.file,file]));
  return file=>{const expected=index.get(file);if(!expected||!safeRelative(file)||!HASH.test(expected.sha256))throw fail('Inventory resource is not in the sealed bundle.');const bytes=readOrdinary(ordinaryTreeFile(directory,path.join(directory,...file.split('/'))),Math.min(expected.bytes+1,16*1024*1024));if(bytes.length!==expected.bytes||sha(bytes)!==expected.sha256)throw fail('Sealed inventory resource changed.');return bytes;};
}
export const gapLabels={PACKAGE_LICENSE_DECLARATION_MISSING:'组件元数据缺少许可声明',PACKAGE_LOCAL_LICENSE_TEXT_MISSING:'组件自身目录未找到许可文本（不等于已确认缺许可）',DECLARED_EXTERNAL_NOTICE_MISSING:'包数据库列出的许可文件当前不存在',NATIVE_PACKAGE_LICENSE_NOT_IN_RUNTIME_BUNDLE:'原生包许可凭据在外部安装目录，尚未随运行包交付',NATIVE_PACKAGE_LICENSE_TEXT_NOT_FOUND:'本机包数据库未提供可读取的独立许可文本',NATIVE_PACKAGE_AMBIGUOUS:'同一原生文件精确匹配多个包，归属未定',PROJECT_NATIVE_BUILD_AND_LICENSE_UNATTESTED:'项目原生程序的构建来源和发布许可尚未签证',NATIVE_ORIGIN_UNMAPPED:'原生文件尚未映射到精确匹配的安装包',FRONTEND_COMPILED_MODULE_GRAPH_NOT_RECORDED:'未记录前端编译产物的实际模块组成',FRONTEND_GENERATED_MODULE_SUPPLIERS_UNATTRIBUTED:'前端虚拟/生成模块的供应方尚未逐项归属',FRONTEND_NON_JAVASCRIPT_COMPOSITION_UNAUDITED:'前端非 JavaScript 资源的组成尚未逐项核对',FRONTEND_POST_BUNDLE_JAVASCRIPT_UNATTRIBUTED:'编译分块之外生成的 JavaScript 尚未归属',PROJECT_DISTRIBUTION_POLICY_NOT_ATTESTED:'项目自身发布许可与政策待确认',EMBEDDED_NATIVE_TRANSITIVE_COMPONENTS_NOT_AUDITED:'原生程序内嵌的间接组件待核对',LICENSE_COMPATIBILITY_AND_SOURCE_DELIVERY_NOT_REVIEWED:'许可兼容及源码交付条件尚未经审查'};
export function buildComponentInventory({bundle,read,msysRoot,pacman,readExternal=file=>readOrdinary(file,64*1024*1024)}){
  const json=file=>JSON.parse(read(file).toString('utf8')),files=bundle.files,components=[],gaps=[],notices=new Map(),artifactOwners=new Map(),packageBoundaries=files.filter(file=>file.file.endsWith('/package.json')).map(file=>file.file.slice(0,-13));
  function notice(file,bytes,source){const hash=sha(bytes);if(!notices.has(hash))notices.set(hash,{sha256:hash,bytes:bytes.length,text:bytes.toString('base64'),sources:[]});notices.get(hash).sources.push({source,file});return {source,file,bytes:bytes.length,sha256:hash};}
  function add(component,owned){if(components.some(item=>item.id===component.id))throw fail('Duplicate inventory component.');components.push(component);for(const file of owned){if(artifactOwners.has(file.file))throw fail('Inventory artifact has multiple owners.');artifactOwners.set(file.file,component.id);}return component;}
  function npm(prefix,expected,scope,roots){
    const proof=files.find(file=>file.file===prefix+'/package.json');if(!proof)throw fail('Declared package metadata is missing from the bundle.');const metadata=json(proof.file);
    if(metadata.name!==expected.name||metadata.version!==expected.version)throw fail('Package identity differs from its sealed descriptor.');
    const owned=files.filter(file=>file.file.startsWith(prefix+'/')&&!roots.some(root=>root!==prefix&&file.file.startsWith(root+'/'))),licenseFiles=owned.filter(file=>LICENSE.test(path.posix.basename(file.file))&&!packageBoundaries.some(root=>root!==prefix&&root.startsWith(prefix+'/')&&file.file.startsWith(root+'/')));
    const evidence=licenseFiles.map(file=>notice(file.file,read(file.file),'bundle'));
    const component=add({id:'npm:'+prefix,kind:'npm',scope,name:metadata.name,version:metadata.version,licenseDeclarations:typeof metadata.license==='string'?[metadata.license]:[],metadata:{file:proof.file,sha256:proof.sha256},licenseEvidence:evidence,sourceEvidence:'sealed-package-and-descriptor',artifactCount:owned.length},owned);
    if(!component.licenseDeclarations.length)gaps.push({code:'PACKAGE_LICENSE_DECLARATION_MISSING',component:component.id});if(!evidence.length)gaps.push({code:'PACKAGE_LOCAL_LICENSE_TEXT_MISSING',component:component.id});return component;
  }
  const front='frontend/'+bundle.frontend.releaseId,back='backend/'+bundle.backend.releaseId,frontDescriptor=json(front+'/release.json'),sdk=json(back+'/pi-sdk/sdk-release.json');
  const packageSpecs=[...sdk.packages.map(pkg=>({prefix:back+'/pi-sdk/'+pkg.directory,expected:pkg,scope:'pi-sdk'})),...frontDescriptor.runtimePackages.map(pkg=>({prefix:front+'/node_modules/'+pkg.name,expected:pkg,scope:'frontend-server'})),{prefix:front+'/runtime/vendor/vinext',expected:{name:'vinext',version:frontDescriptor.productionRuntime.packageVersion},scope:'frontend-runner'}];
  const roots=packageSpecs.map(spec=>spec.prefix);for(const spec of packageSpecs)npm(spec.prefix,spec.expected,spec.scope,roots);
  const sdkRootNotice=back+'/pi-sdk/LICENSE';if(files.some(file=>file.file===sdkRootNotice))notice(sdkRootNotice,read(sdkRootNotice),'bundle');
  const nodeDescriptor=json('node/node-runtime.json'),nodeNotice='node/provenance/LICENSE';
  add({id:'node-runtime',kind:'application',name:'Node.js',version:nodeDescriptor.nodeVersion,scope:'node-runtime',licenseDeclarations:[],licenseEvidence:[notice(nodeNotice,read(nodeNotice),'bundle')],sourceEvidence:'sealed-official-checksum-material',executableSha256:bundle.node.executable.sha256,artifactCount:files.filter(file=>file.file.startsWith('node/')).length},files.filter(file=>file.file.startsWith('node/')));
  const native=json(back+'/release.json').native,packageComponents=new Map();
  for(const [profile,descriptor]of Object.entries(native.profiles))for(const item of descriptor.files){
    const file=back+'/native/'+profile+'/'+item.file,role=Object.entries(descriptor.roles).find(([,name])=>name===item.file)?.[0],matches=[];
    for(const candidate of pacman?.index.get(item.file.toLowerCase())||[]){const source=path.join(msysRoot,...candidate.file.split('/'));let bytes;try{bytes=readExternal(ordinaryTreeFile(msysRoot,source));}catch(error){if(error.code==='ENOENT')continue;throw error;}if(bytes.length===item.bytes&&sha(bytes)===item.sha256)matches.push(candidate);}
    if(matches.length===1){
      const {pkg,file:installedPath}=matches[0],id='msys2:'+pkg.name+'@'+pkg.version;let component=packageComponents.get(id);
      if(!component){
        const evidence=[];for(const licensePath of pkg.licensePaths){let bytes;try{bytes=readExternal(ordinaryTreeFile(msysRoot,path.join(msysRoot,...licensePath.split('/'))));}catch(error){if(error.code==='ENOENT'){gaps.push({code:'DECLARED_EXTERNAL_NOTICE_MISSING',component:id,file:licensePath});continue;}throw error;}if(bytes.length>4*1024*1024)throw fail('License evidence exceeds 4 MiB.');evidence.push(notice(licensePath,bytes,'msys2-local-install'));}
        component=add({id,kind:'native-package',scope:'native',name:pkg.name,version:pkg.version,licenseDeclarations:pkg.licenseDeclarations,licenseEvidence:evidence,sourceEvidence:'current-installed-bytes-match-local-package-file-list',databaseKey:pkg.databaseKey,artifacts:[]},[]);packageComponents.set(id,component);
        gaps.push({code:'NATIVE_PACKAGE_LICENSE_NOT_IN_RUNTIME_BUNDLE',component:id});if(!evidence.length)gaps.push({code:'NATIVE_PACKAGE_LICENSE_TEXT_NOT_FOUND',component:id});
      }
      component.artifacts.push({file,sha256:item.sha256,bytes:item.bytes,profile,installedPath});if(artifactOwners.has(file))throw fail('Duplicate native artifact ownership.');artifactOwners.set(file,id);
    }else{
      const id='native:'+profile+'/'+item.file;add({id,kind:role?'project-native':'unmapped-native',scope:'native',name:item.file,profile,role:role||null,licenseDeclarations:[],licenseEvidence:[],sourceEvidence:matches.length?'ambiguous-current-install-match':role?'sealed-project-role-build-origin-not-attested':'no-exact-current-package-match',sha256:item.sha256,artifactCount:1},[files.find(entry=>entry.file===file)]);gaps.push({code:matches.length?'NATIVE_PACKAGE_AMBIGUOUS':role?'PROJECT_NATIVE_BUILD_AND_LICENSE_UNATTESTED':'NATIVE_ORIGIN_UNMAPPED',component:id});
    }
  }
  let frontendComposition=null;const compiledChunks=new Map();
  if(Object.hasOwn(frontDescriptor,'compiledComposition')){
    const {composition,graphs}=validateSealedFrontendComposition({release:path.join(bundle.directory,front),descriptor:frontDescriptor.compiledComposition}),proof=files.find(f=>f.file===front+'/'+frontDescriptor.compiledComposition.file);
    for(const pkg of composition.packages){
      const id='compiled:'+front+'/'+pkg.id,evidence=pkg.notices.map(n=>{const file=front+'/runtime/provenance/composition/notices/'+n.sha256+'.txt';return notice(file,read(file),'bundle');});
      add({id,kind:'npm-bundled',scope:'frontend-compiled',name:pkg.name,version:pkg.version,licenseDeclarations:pkg.licenseDeclarations,licenseEvidence:evidence,metadata:{file:proof.file,sha256:proof.sha256,packageJsonSha256:pkg.packageJson.sha256},sourceEvidence:'bundler-output-chunk-modules-with-sealed-package-identity',artifactCount:0},[]);
      if(!evidence.length)gaps.push({code:'PACKAGE_LOCAL_LICENSE_TEXT_MISSING',component:id});if(!pkg.licenseDeclarations.length)gaps.push({code:'PACKAGE_LICENSE_DECLARATION_MISSING',component:id});
    }
    let generatedRecords=0;for(const graph of graphs)for(const chunk of graph.chunks){const generated=chunk.modules.filter(m=>m.kind==='generated').length;generatedRecords+=generated;compiledChunks.set(front+'/'+environmentFolders[graph.environment]+'/'+chunk.file,{components:[...new Set(chunk.modules.filter(m=>m.kind==='package').map(m=>'compiled:'+front+'/'+m.package))].sort(),projectModuleRecords:chunk.modules.filter(m=>m.kind==='project').length,generatedModuleRecords:generated,moduleRecords:chunk.modules.length});}
    frontendComposition={file:proof.file,sha256:proof.sha256,environments:composition.environments,packages:composition.packages.length,chunkFiles:compiledChunks.size,generatedModuleRecords:generatedRecords,unrecordedJavaScript:composition.unrecordedJavaScript,scope:composition.scope};
    if(generatedRecords)gaps.push({code:'FRONTEND_GENERATED_MODULE_SUPPLIERS_UNATTRIBUTED',records:generatedRecords});if(composition.unrecordedJavaScript.length)gaps.push({code:'FRONTEND_POST_BUNDLE_JAVASCRIPT_UNATTRIBUTED',files:composition.unrecordedJavaScript});gaps.push({code:'FRONTEND_NON_JAVASCRIPT_COMPOSITION_UNAUDITED'});
  }else gaps.push({code:'FRONTEND_COMPILED_MODULE_GRAPH_NOT_RECORDED',detail:'Dependency lock records are build provenance, not evidence that every locked package was shipped.'});
  gaps.push({code:'PROJECT_DISTRIBUTION_POLICY_NOT_ATTESTED'},{code:'EMBEDDED_NATIVE_TRANSITIVE_COMPONENTS_NOT_AUDITED'},{code:'LICENSE_COMPATIBILITY_AND_SOURCE_DELIVERY_NOT_REVIEWED'});
  const artifacts=files.map(file=>{let category,component=artifactOwners.get(file.file);const contributors=compiledChunks.get(file.file);if(component)category='identified-component';else if(contributors)category='compiled-frontend-module-evidence';else if(file.file.startsWith(back+'/pi-sdk/'))category='sdk-container-metadata-or-notice';else if(file.file.startsWith(front+'/dist/'))category='compiled-frontend-composition-unresolved';else if(file.file.startsWith('app/')||file.file.startsWith(back+'/runtime/')||file.file.startsWith(front+'/runtime/scripts/')||file.file.startsWith(front+'/runtime/gateway/')||file.file==='Start-WebCAD.ps1')category='project-code-no-distribution-policy';else category='container-or-build-provenance';return {...file,category,...(component?{component}:{}),...(contributors?{compiledContributors:contributors}:{})};});
  return {format:'web-cad-component-evidence',version:1,recordedAt:new Date().toISOString(),bundle:{releaseId:bundle.releaseId,manifestSha256:bundle.manifestSha256},qualification:'incomplete-not-release-approved',components,gaps,artifacts,frontendComposition,notices:[...notices.values()],packageDatabase:pacman?{packages:pacman.packages.length,bytes:pacman.bytes,entries:pacman.entries,proofs:pacman.proofs}:null,limits:['Package license strings are declarations, not legal conclusions.','Local database plus exact installed bytes is not a verified package archive, original build attestation or package-signature verification.','External notice copies are report evidence; they have not been added to the immutable runtime bundle.','Compiled module records are output inclusion evidence, not a minified byte attribution or a complete generated/asset supplier graph.']};
}
export function toCycloneDx(inventory){
  return {bomFormat:'CycloneDX',specVersion:'1.6',serialNumber:'urn:uuid:'+randomUUID(),version:1,metadata:{timestamp:inventory.recordedAt,component:{type:'application','bom-ref':'workbench:'+inventory.bundle.releaseId,name:'Web CAD preprocessing workbench',version:inventory.bundle.releaseId,properties:[{name:'web-cad:manifest-sha256',value:inventory.bundle.manifestSha256},{name:'web-cad:qualification',value:inventory.qualification}]}},components:inventory.components.map(component=>({type:component.kind==='application'?'application':component.kind.includes('native')&&component.sha256?'file':'library','bom-ref':component.id,name:component.name,...(component.version?{version:component.version}:{}),...(component.sha256||component.executableSha256?{hashes:[{alg:'SHA-256',content:component.sha256||component.executableSha256}]}:{}),...(component.licenseDeclarations.length?{licenses:component.licenseDeclarations.map(name=>({license:{name}}))}:{}),properties:[{name:'web-cad:source-evidence',value:component.sourceEvidence},{name:'web-cad:license-evidence-count',value:String(component.licenseEvidence.length)}]})),compositions:[{aggregate:'incomplete',assemblies:['workbench:'+inventory.bundle.releaseId]}]};
}
