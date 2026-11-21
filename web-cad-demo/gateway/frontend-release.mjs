import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';

const ID=/^frontend-[0-9]{13}-[a-f0-9-]{36}$/;
const HASH=/^[a-f0-9]{64}$/;
const RUNTIME_ENTRY='dist/server/prod-server.js';
const RUNTIME_DYNAMIC=new Set([
  '`${pathToFileURL(rscEntryPath).href}?t=${rscMtime}`',
  '`${pathToFileURL(serverEntryPath).href}?t=${serverMtime}`',
]);
export class FrontendReleaseError extends Error {
  constructor(code,message){super(message);this.name='FrontendReleaseError';this.code=code;}
}
const fail=message=>new FrontendReleaseError('FRONTEND_RELEASE_INVALID',message);
export function hashFile(file){
  const hash=crypto.createHash('sha256'),fd=fs.openSync(file,'r'),buffer=Buffer.allocUnsafe(1024*1024);
  try{for(;;){const bytes=fs.readSync(fd,buffer,0,buffer.length,null);if(!bytes)break;hash.update(buffer.subarray(0,bytes));}return hash.digest('hex');}
  finally{fs.closeSync(fd);}
}
export function productionServerPath(workspace){return path.join(workspace,'node_modules','vinext','dist','server','prod-server.js');}
export function releaseProductionServerPath(release,workspace){return release.version===2?path.join(release.directory,'runtime/vendor/vinext/dist/server/prod-server.js'):productionServerPath(workspace);}
export function frontendBuildInputs(version=2){
  return ['app','shared','public','build','worker','package.json','package-lock.json','tsconfig.json','next.config.ts','vite.config.ts','postcss.config.mjs','scripts/frontend-server.mjs','gateway/frontend-release.mjs','gateway/frontend-proxy.mjs','gateway/frontend-assets.mjs',...(version>=2?['scripts/build-frontend-release.mjs','scripts/frontend-runtime-closure.mjs']:[])];
}
export function assertRegularDirectory(directory){
  const stat=fs.lstatSync(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('发布目录类型无效，不能使用链接或其他文件替代目录。');
}
export function fileInventory(directory,{exclude=[]}={}){
  assertRegularDirectory(directory);const files=[];let total=0;
  function walk(folder){for(const entry of fs.readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
    const file=path.join(folder,entry.name),relative=path.relative(directory,file).replaceAll('\\','/');if(exclude.includes(relative))continue;const stat=fs.lstatSync(file);
    if(stat.isSymbolicLink())throw fail('发布文件不能包含符号链接。');
    if(stat.isDirectory())walk(file);
    else if(stat.isFile()&&stat.nlink===1){total+=stat.size;if(total>512*1024*1024||files.length>=10000)throw fail('发布文件超过 512 MiB 或 10000 个文件的校验预算。');files.push({file:path.relative(directory,file).replaceAll('\\','/'),bytes:stat.size,sha256:hashFile(file)});}
    else throw fail('发布文件类型无效。');
  }}walk(directory);return files;
}
export function copyCertifiedFiles(source,target,files){
  assertRegularDirectory(source);fs.mkdirSync(target,{recursive:true});assertRegularDirectory(target);
  for(const item of files){
    const segments=item.file.split('/');if(segments.some(part=>!part||part==='.'||part==='..'||/[\\:]/.test(part)))throw fail('构建清单包含无效相对路径。');
    let parent=target;for(const segment of segments.slice(0,-1)){parent=path.join(parent,segment);if(!fs.existsSync(parent))fs.mkdirSync(parent);assertRegularDirectory(parent);}
    const input=path.join(source,...segments),output=path.join(target,...segments),stat=fs.lstatSync(input);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw fail('构建源文件类型已经改变。');
    // Node's recursive cp on this Windows runtime can silently omit a directory
    // when the destination contains Chinese characters. Copy certified files,
    // then verify each byte sequence instead of trusting a directory operation.
    fs.copyFileSync(input,output,fs.constants.COPYFILE_EXCL);
    if(fs.statSync(output).size!==item.bytes||hashFile(output)!==item.sha256)throw fail('复制的构建文件与源快照不一致，候选版本已拒绝。');
  }
}
export function copyRuntimeExternals(workspace,dist,directory){
  const external=readSmallJson(path.join(dist,'server','vinext-externals.json'));
  if(!Array.isArray(external)||external.some(name=>typeof name!=='string'))throw fail('构建缺少有效的服务器依赖清单。');
  const queue=external.map(name=>({name,from:workspace,optional:false})),copied=new Map();
  while(queue.length){
    const {name,from,optional}=queue.shift();if(!/^(?:@[A-Za-z0-9_-]+\/)?[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name))throw fail('服务器依赖名称无效。');
    const locations=createRequire(path.join(from,'package.json')).resolve.paths(name)||[];
    const packageRoot=locations.map(folder=>path.join(folder,name)).find(folder=>fs.existsSync(path.join(folder,'package.json')));
    if(!packageRoot){if(optional)continue;throw fail('缺少服务器运行依赖 '+name+'，未发布候选版本。');}
    const real=fs.realpathSync(packageRoot),previous=copied.get(name);
    if(previous){if(previous.source!==real)throw fail('服务器依赖 '+name+' 存在冲突版本，不能以错误依赖发布。');continue;}
    const pkg=readSmallJson(path.join(real,'package.json'));
    if(pkg.name!==name||typeof pkg.version!=='string')throw fail('服务器依赖身份无效。');
    const destination=path.join(directory,'node_modules',name);
    copyCertifiedFiles(real,destination,fileInventory(real));copied.set(name,{source:real,version:pkg.version});
    const dependencies={...pkg.dependencies,...pkg.optionalDependencies,...pkg.peerDependencies};
    for(const dependency of Object.keys(dependencies))queue.push({name:dependency,from:real,optional:Object.hasOwn(pkg.optionalDependencies||{},dependency)||pkg.peerDependenciesMeta?.[dependency]?.optional===true});
  }
  return [...copied].map(([name,value])=>({name,version:value.version}));
}
export function atomicJson(file,value){
  const temporary=file+'.'+crypto.randomUUID()+'.tmp';let fd;
  try{fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value,null,2));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,file);}
  finally{if(fd!==undefined)fs.closeSync(fd);fs.rmSync(temporary,{force:true});}
}
export function readSmallJson(file,limit=2*1024*1024){
  const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>limit)throw fail('发布清单类型或大小无效。');
  try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw fail('发布清单损坏；请保留原目录并重新生成发布版本。');}
}
export function releaseDirectory(root,id){
  if(!ID.test(id))throw fail('发布版本标识无效。');assertRegularDirectory(root);
  const directory=path.join(path.resolve(root),id);assertRegularDirectory(directory);return directory;
}
function validateProductionRuntime(runtime){
  if(runtime?.version!==1||runtime.packageName!=='vinext'||typeof runtime.packageVersion!=='string'||!runtime.packageVersion||runtime.packageVersion.length>80||runtime.license!=='MIT'||runtime.entry!==RUNTIME_ENTRY||!Array.isArray(runtime.files)||runtime.files.length<3||runtime.files.length>256||!Array.isArray(runtime.dynamicEntries)||runtime.dynamicEntries.length>2)throw fail('随包生产运行器清单无效。');
  let total=0;
  for(const file of runtime.files){
    if(!file||typeof file.file!=='string'||file.file.split('/').some(part=>!part||part==='.'||part==='..'||/[\\:]/.test(part))||!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>1024*1024||!HASH.test(file.sha256))throw fail('随包生产运行器文件记录无效。');
    total+=file.bytes;
  }
  if(total>8*1024*1024)throw fail('随包生产运行器超过容量预算。');
  const seen=new Set();
  for(const dynamic of runtime.dynamicEntries){
    if(!dynamic||dynamic.file!==RUNTIME_ENTRY||dynamic.scope!=='certified-build-entry'||!RUNTIME_DYNAMIC.has(dynamic.expression)||seen.has(dynamic.expression))throw fail('随包生产运行器动态入口记录无效。');
    seen.add(dynamic.expression);
  }
}
export function validateRelease(directory,workspace){
  directory=path.resolve(directory);assertRegularDirectory(directory);const manifest=readSmallJson(path.join(directory,'release.json'));
  if(manifest?.format!=='web-cad-frontend-release'||![1,2].includes(manifest.version)||!ID.test(manifest.releaseId)||path.basename(directory)!==manifest.releaseId||manifest.apiMode!=='same-origin'||manifest.runtime!=='vinext-node'||!HASH.test(manifest.dependencyLockSha256)||!HASH.test(manifest.sourceSha256)||!Array.isArray(manifest.files)||manifest.files.length<3||manifest.files.length>10000)throw fail('发布清单的身份或运行协议无效。');
  if(manifest.version===1){
    if(hashFile(path.join(workspace,'package-lock.json'))!==manifest.dependencyLockSha256)throw fail('运行依赖锁与发布构建不一致，请安装匹配依赖或重新构建发布版本。');
    if(manifest.productionServerSha256!==hashFile(productionServerPath(workspace)))throw fail('生产运行器与发布时校验的版本不一致，请安装匹配依赖或重新构建。');
  }else{
    if(manifest.nodeVersion!==process.versions.node)throw fail('Node 运行版本与前端构建不一致，请使用匹配的运行时。');
    const runtime=manifest.productionRuntime,vendor=path.join(directory,'runtime/vendor/vinext');
    validateProductionRuntime(runtime);
    if(JSON.stringify(fileInventory(vendor))!==JSON.stringify(runtime.files))throw fail('随包生产运行器缺失、增加或内容不一致。');
    const pkg=readSmallJson(path.join(vendor,'package.json'));if(pkg.name!=='vinext'||pkg.version!==runtime.packageVersion||pkg.type!=='module'||pkg.license!=='MIT'||!runtime.files.some(file=>file.file==='LICENSE'&&file.bytes>0))throw fail('随包生产运行器身份或许可不一致。');
    if(hashFile(path.join(directory,'runtime/provenance/package-lock.json'))!==manifest.dependencyLockSha256)throw fail('随包依赖锁与构建记录不一致。');
    if(hashFile(releaseProductionServerPath({...manifest,directory},workspace))!==manifest.productionServerSha256)throw fail('随包生产运行器入口与构建记录不一致。');
  }
  const actual=fileInventory(directory,{exclude:['release.json']});
  if(actual.reduce((sum,item)=>sum+item.bytes,0)>512*1024*1024)throw fail('发布文件超过 512 MiB 校验预算。');
  if(JSON.stringify(actual)!==JSON.stringify(manifest.files))throw fail('发布文件缺失、增加或校验不一致；没有启动不完整版本。');
  for(const file of ['dist/server/index.js','dist/server/ssr/index.js','runtime/scripts/frontend-server.mjs','runtime/gateway/frontend-release.mjs','runtime/gateway/frontend-proxy.mjs','runtime/gateway/frontend-assets.mjs'])if(!actual.some(item=>item.file===file))throw fail('发布版本缺少必要的服务器入口。');
  if(!actual.some(item=>item.file.startsWith('dist/client/assets/')&&item.file.endsWith('.js')))throw fail('发布版本缺少浏览器资源。');
  return {...manifest,directory};
}
export function selectRelease(root,workspace,id){
  root=path.resolve(root);
  if(!fs.existsSync(root))throw new FrontendReleaseError('FRONTEND_RELEASE_MISSING','没有前端发布构建，请先运行 npm run build:release；开发时可显式选择 Development。');
  assertRegularDirectory(root);
  if(!id){
    const pointer=path.join(root,'selected.json');
    if(!fs.existsSync(pointer))throw new FrontendReleaseError('FRONTEND_RELEASE_MISSING','尚未选择前端发布版本，请先运行 npm run build:release。');
    const selected=readSmallJson(pointer,4096);
    if(selected?.format!=='web-cad-frontend-selection'||selected.version!==1)throw fail('发布版本选择记录无效。');
    id=selected.releaseId;
  }
  return validateRelease(releaseDirectory(root,id),workspace);
}
export function frontendEnvironment(environment){
  const allowed=new Set(['PATH','SYSTEMROOT','WINDIR','COMSPEC','USERPROFILE','HOME','TEMP','TMP','APPDATA','LOCALAPPDATA','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMDATA','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE','NODE_ENV','CAD_FRONTEND_TARGET','NEXT_PUBLIC_GEOMETRY_API_URL']);
  return Object.fromEntries(Object.entries(environment).filter(([key])=>allowed.has(key.toUpperCase())));
}
