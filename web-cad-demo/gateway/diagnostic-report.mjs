import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const releaseId=/^frontend-[0-9]{13}-[a-f0-9-]{36}$/;
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha256=/^[a-f0-9]{64}$/;
const integer=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?Math.round(value*100)/100:null;
const bool=value=>typeof value==='boolean'?value:null;
const choice=(value,values)=>values.includes(value)?value:null;
const stamp=stat=>['dev','ino','size','mtimeNs','ctimeNs'].map(key=>String(stat[key])).join(':');
const object=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const policy=Object.freeze({readOnly:true,providerRequests:false,modelQueries:false,automaticRetries:false,rawLogs:false,environmentFiles:false,projectFiles:false,absolutePaths:false,processIdentifiers:false,controlCredentials:false,localFilesAreRunningBinaryAttestation:false});
export class DiagnosticError extends Error{constructor(code){super(code);this.name='DiagnosticError';this.code=code;}}
const fault=code=>new DiagnosticError(code);

/** No arbitrary web destinations, embedded credentials, queries or fragments. */
export function diagnosticEndpoint(value,kind){
  let url;try{url=new URL(value);}catch{throw fault('DIAGNOSTIC_ENDPOINT_INVALID');}
  if(!['frontend','gateway'].includes(kind)||url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||Number(url.port||80)<1024||url.pathname!==(kind==='gateway'?'/api':'/'))throw fault('DIAGNOSTIC_ENDPOINT_INVALID');
  return url;
}

function regularPath(workspace,relative,{directory=false,missing=false}={}){
  const base=path.resolve(workspace),file=path.resolve(base,relative),inside=path.relative(base,file);
  if(!inside||inside==='..'||inside.startsWith('..'+path.sep)||path.isAbsolute(inside))throw fault('DIAGNOSTIC_FILE_UNSAFE');
  const root=fs.lstatSync(base);if(root.isSymbolicLink()||!root.isDirectory())throw fault('DIAGNOSTIC_FILE_UNSAFE');
  const parts=inside.split(path.sep);let current=base;
  for(let index=0;index<parts.length;index++){
    current=path.join(current,parts[index]);let stat;
    try{stat=fs.lstatSync(current);}catch(error){if(error.code==='ENOENT'&&missing)return file;throw error;}
    if(stat.isSymbolicLink())throw fault('DIAGNOSTIC_FILE_UNSAFE');
    if(index<parts.length-1||directory){if(!stat.isDirectory())throw fault('DIAGNOSTIC_FILE_UNSAFE');}
    else if(!stat.isFile()||stat.nlink!==1)throw fault('DIAGNOSTIC_FILE_UNSAFE');
  }
  return file;
}

/** Fixed-buffer reads with before/after identity checks, never a directory walk. */
function readEvidence(workspace,relative,{maxBytes=2*1024*1024,json=false,onRead=()=>{}}={}){
  const file=regularPath(workspace,relative),entry=fs.lstatSync(file,{bigint:true});let fd;
  if(entry.size>BigInt(maxBytes))throw fault('DIAGNOSTIC_FILE_TOO_LARGE');
  try{
    fd=fs.openSync(file,'r');const before=fs.fstatSync(fd,{bigint:true});if(stamp(entry)!==stamp(before))throw fault('DIAGNOSTIC_FILE_CHANGED');
    const buffer=Buffer.alloc(Math.min(1024*1024,maxBytes+1)),hash=createHash('sha256'),chunks=[];let size=0;
    for(;;){const bytes=fs.readSync(fd,buffer,0,Math.min(buffer.length,maxBytes-size+1),null);if(!bytes)break;onRead(bytes);size+=bytes;if(size>maxBytes)throw fault('DIAGNOSTIC_FILE_TOO_LARGE');hash.update(buffer.subarray(0,bytes));if(json)chunks.push(Buffer.from(buffer.subarray(0,bytes)));}
    regularPath(workspace,relative);const after=fs.fstatSync(fd,{bigint:true}),current=fs.lstatSync(file,{bigint:true});
    if(stamp(before)!==stamp(after)||stamp(before)!==stamp(current)||BigInt(size)!==before.size)throw fault('DIAGNOSTIC_FILE_CHANGED');
    const result={bytes:size,sha256:hash.digest('hex')};
    if(json){try{result.value=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));}catch{throw fault('DIAGNOSTIC_METADATA_INVALID');}}
    return result;
  }finally{if(fd!==undefined)fs.closeSync(fd);}
}
function evidenceState(error){return error?.code==='ENOENT'?'missing':choice(error?.code,['DIAGNOSTIC_FILE_UNSAFE','DIAGNOSTIC_FILE_TOO_LARGE','DIAGNOSTIC_FILE_CHANGED','DIAGNOSTIC_METADATA_INVALID'])||'unreadable';}

function selectedRelease(workspace){
  try{
    const pointer=readEvidence(workspace,'.releases/selected.json',{maxBytes:4096,json:true}).value;
    if(pointer?.format!=='web-cad-frontend-selection'||pointer.version!==1||!releaseId.test(pointer.releaseId||''))throw fault('DIAGNOSTIC_METADATA_INVALID');
    const manifest=readEvidence(workspace,`.releases/${pointer.releaseId}/release.json`,{json:true}).value;
    if(manifest?.format!=='web-cad-frontend-release'||manifest.version!==1||manifest.releaseId!==pointer.releaseId||![manifest.sourceSha256,manifest.dependencyLockSha256,manifest.productionServerSha256].every(value=>typeof value==='string'&&sha256.test(value))||!Array.isArray(manifest.files)||manifest.files.length>10000)throw fault('DIAGNOSTIC_METADATA_INVALID');
    return {state:'metadata-read',releaseId:pointer.releaseId,sourceSha256:manifest.sourceSha256,dependencyLockSha256:manifest.dependencyLockSha256,productionServerSha256:manifest.productionServerSha256,fileCount:manifest.files.length,integrity:'metadata-only-not-file-certification'};
  }catch(error){return {state:evidenceState(error)};}
}

async function probe(url,{fetchImpl,timeoutMs,maxResponseBytes}){
  const controller=new AbortController();let response,reader,timer,cancelled;
  // Cleanup is best effort, never an extension of the observation deadline.
  // Handle rejection without awaiting an uncooperative stream's cancel promise.
  function cancelBody(){
    const body=reader||response?.body;if(!body||cancelled===body)return;cancelled=body;
    try{Promise.resolve(body.cancel()).catch(()=>{});}catch{/* Never export response/transport exceptions. */}
  }
  const observe=async()=>{
    try{
      response=await fetchImpl(url,{method:'GET',headers:{Accept:'application/json'},redirect:'error',credentials:'omit',cache:'no-store',signal:controller.signal});
      if(controller.signal.aborted)return {state:'timeout'};
      if(!response.headers.get('content-type')?.toLowerCase().includes('application/json'))return {state:'invalid-response',httpStatus:response.status};
      const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>maxResponseBytes))return {state:'response-limit',httpStatus:response.status};
      reader=response.body?.getReader();if(!reader)return {state:'invalid-response',httpStatus:response.status};
      const chunks=[];let bytes=0;
      for(;;){const item=await reader.read();if(controller.signal.aborted)return {state:'timeout'};if(item.done)break;bytes+=item.value.byteLength;if(bytes>maxResponseBytes)return {state:'response-limit',httpStatus:response.status};chunks.push(Buffer.from(item.value));}
      let payload;try{payload=JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));}catch{return {state:'invalid-response',httpStatus:response.status};}
      if(!object(payload))return {state:'invalid-response',httpStatus:response.status};
      return {state:'observed',httpStatus:response.status,payload};
    }catch{return {state:controller.signal.aborted?'timeout':'unreachable'};}
    finally{cancelBody();}
  };
  const deadline=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({state:'timeout'});},timeoutMs);});
  try{return await Promise.race([observe(),deadline]);}
  finally{clearTimeout(timer);controller.abort();cancelBody();}
}

function gatewayObservation(probe){
  if(probe.state!=='observed')return {state:probe.state,...(probe.httpStatus?{httpStatus:probe.httpStatus}:{})};
  const value=probe.payload;if(typeof value.ok!=='boolean'||value.gateway!==true||typeof value.worker!=='boolean'||value.protocolVersion!==1)return {state:'incompatible-response',httpStatus:probe.httpStatus};
  const source=value.storage?.sourceRestoration,runtime=value.runtime,loading=value.documentLoading;
  const validSource=object(source)&&typeof source.blocked==='boolean'&&(source.active===null||object(source.active)&&['upload','prepare','commit','rollback','revalidate','review','abandon'].includes(source.active.action));
  return {state:value.ok&&value.worker&&probe.httpStatus===200?'ready':'not-ready',httpStatus:probe.httpStatus,workerReady:value.worker,loadedDocuments:integer(value.loadedDocuments),
    documentLoading:Object.fromEntries(['known','unloaded','loading','ready','failed'].map(key=>[key,integer(loading?.[key])])),
    runtime:{uptimeSeconds:finite(runtime?.uptimeSeconds),workerPending:integer(runtime?.workerPending),workerRequests:integer(runtime?.workerRequests),memory:Object.fromEntries(['rss','heapTotal','heapUsed','external','arrayBuffers'].map(key=>[key,integer(runtime?.gatewayMemory?.[key])]))},
    lifecycle:{state:choice(value.lifecycle?.state,['running','draining','stopping','complete','interrupted']),activeDocuments:integer(value.lifecycle?.activeDocuments),queuedDocumentActions:integer(value.lifecycle?.queuedDocumentActions)},
    writerProtection:object(value.storage?.writer)?choice(value.storage.writer.mechanism,['windows-kernel-file-sharing']):null,
    sourceRestoration:source===undefined?{supported:false}:!validSource?{supported:true,state:'invalid-response',blocked:null,active:null,activeAction:null}:{supported:true,state:'observed',blocked:source.blocked,active:source.active!==null,activeAction:choice(source.active?.action,['upload','prepare','commit','rollback','revalidate','review','abandon'])}};
}
function frontendObservation(probe){
  if(probe.state!=='observed')return {state:probe.state,...(probe.httpStatus?{httpStatus:probe.httpStatus}:{})};
  const value=probe.payload;if(value.format!=='web-cad-frontend'||value.version!==1||typeof value.ok!=='boolean'||!releaseId.test(value.releaseId||''))return {state:'incompatible-response',httpStatus:probe.httpStatus};
  return {state:value.ok&&value.clientAssetsValid===true&&probe.httpStatus===200?'ready':'not-ready',httpStatus:probe.httpStatus,mode:choice(value.mode,['Production','Development']),releaseId:value.releaseId,clientAssetsValid:bool(value.clientAssetsValid),apiMode:choice(value.apiMode,['same-origin'])};
}

/** This collector never reads .data, logs, .env, providers or model contents.
 * Network observations are independent in time, not a transactional snapshot. */
export async function collectDiagnostics({workspace,frontend='http://127.0.0.1:3000/',gateway='http://127.0.0.1:8788/api',offline=false,timeoutMs=3000,maxResponseBytes=128*1024,fetchImpl=fetch}={}){
  const front=diagnosticEndpoint(frontend,'frontend'),back=diagnosticEndpoint(gateway,'gateway');
  if(typeof workspace!=='string'||typeof offline!=='boolean'||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>5000||!Number.isInteger(maxResponseBytes)||maxResponseBytes<1024||maxResponseBytes>1024*1024)throw fault('DIAGNOSTIC_OPTIONS_INVALID');
  const selected=selectedRelease(workspace),files=[];let budget=128*1024*1024;
  for(const [component,file] of [['dependency-lock','package-lock.json'],['geometry-worker','geometry-worker/build/occt_geometry_worker.exe'],['snapshot-inspector','geometry-worker/build/cad_snapshot_source_inspector.exe'],['source-swap','geometry-worker/build/cad_source_file_swap.exe'],['mesh-worker','mesh-worker/build-gmsh/gmsh_mesh_worker.exe']]){
    try{const value=readEvidence(workspace,file,{maxBytes:Math.max(0,Math.min(budget,32*1024*1024)),onRead:bytes=>{budget-=bytes;}});files.push({component,state:'hashed',...value});}catch(error){files.push({component,state:evidenceState(error)});}
  }
  const options={fetchImpl,timeoutMs,maxResponseBytes},notObserved={state:'not-observed'};
  const [frontProbe,backProbe,bridgeProbe]=offline?[notObserved,notObserved,notObserved]:await Promise.all([probe(new URL('/__cad/health',front),options),probe(new URL('/api/health',back),options),probe(new URL('/api/health',front),options)]);
  const frontendState=frontendObservation(frontProbe),gatewayState=gatewayObservation(backProbe),bridge=gatewayObservation(bridgeProbe);
  let advertisedMatches=null;
  try{if(frontProbe.payload?.gatewayApi)advertisedMatches=diagnosticEndpoint(frontProbe.payload.gatewayApi,'gateway').href===back.href;}catch{/* Invalid advertised URLs are not included. */}
  const directInstance=backProbe.payload?.storage?.writer?.instanceId,bridgeInstance=bridgeProbe.payload?.storage?.writer?.instanceId;
  const comparisons={runningMatchesSelected:frontendState.releaseId&&selected.releaseId?frontendState.releaseId===selected.releaseId:null,advertisedGatewayMatchesConfigured:advertisedMatches,bridgeReachesSameGateway:typeof directInstance==='string'&&uuid.test(directInstance)&&typeof bridgeInstance==='string'&&uuid.test(bridgeInstance)?directInstance===bridgeInstance:null,selectedDependencyLockMatchesLocal:selected.dependencyLockSha256&&files[0].state==='hashed'?selected.dependencyLockSha256===files[0].sha256:null};
  const findings=[];const add=(code,severity,action)=>findings.push({code,severity,action});
  if(!offline&&frontendState.state!=='ready')add('FRONTEND_NOT_READY','error','前端尚未证明可用；检查受管服务状态，不要按端口结束进程。');
  if(!offline&&gatewayState.state!=='ready')add('GATEWAY_NOT_READY','error','几何后台尚未证明可用；先核对后台状态与工程记录，不要重发未确认的建模请求。');
  if(!offline&&gatewayState.state==='ready'&&bridge.state!=='ready')add('FRONTEND_BRIDGE_NOT_READY','error','后台直连可用但页面转发未就绪，请核对前端的运行版本和后台配置。');
  if(comparisons.runningMatchesSelected===false)add('RUNNING_RELEASE_DIFFERS_FROM_SELECTION','warning','运行版与下次启动选择不同；可能是尚未发布的候选。不要因此自动重启服务。');
  if(comparisons.advertisedGatewayMatchesConfigured===false||comparisons.bridgeReachesSameGateway===false)add('GATEWAY_TARGET_MISMATCH','warning','前端与本次诊断配置的后台不一致；先核对所属实例，不要执行工程修改。');
  if(comparisons.selectedDependencyLockMatchesLocal===false)add('DEPENDENCY_LOCK_MISMATCH','error','已选发布版与本地依赖锁不一致；保留当前服务，按发布流程准备匹配依赖或重新构建。');
  if(selected.state!=='metadata-read')add('RELEASE_METADATA_UNAVAILABLE','warning','未能读取有效的已选发布元数据；此报告不认证发布文件完整性。');
  if(gatewayState.sourceRestoration?.blocked||bridge.sourceRestoration?.blocked)add('SOURCE_RECOVERY_BLOCKED','error','来源事务阻断建模；打开来源恢复记录核对，不要删除材料或重放命令。');
  if(gatewayState.sourceRestoration?.state==='invalid-response'||bridge.sourceRestoration?.state==='invalid-response')add('SOURCE_RECOVERY_STATE_UNVERIFIED','warning','后台返回的来源状态结构无效；不能据此判断建模阻断已解除，请使用匹配版本重新查询。');
  if(files.some(file=>file.state!=='hashed'))add('LOCAL_COMPONENT_EVIDENCE_INCOMPLETE','warning','部分默认安装位置的文件未能读取；这不证明正在运行的组件缺失，需核对自定义部署位置。');
  return {format:'web-cad-diagnostics',version:1,reportId:randomUUID(),createdAt:new Date().toISOString(),policy:{...policy},collector:{nodeVersion:process.versions.node,platform:process.platform,architecture:process.arch},scope:offline?'offline-installed-files':'local-read-only-health-and-installed-files',selectedRelease:selected,localInstalledFiles:files,observations:{frontend:frontendState,gateway:gatewayState,frontendBridge:bridge},comparisons,findings,limitations:['不包含密钥、Provider 配置、会话、模型、工程名称、绝对路径、进程标识、控制令牌或原始日志。','健康结果来自三个独立时点，不是事务快照；就绪不代表工业性能或大模型可用。','默认安装文件哈希不认证实际已加载程序；发布元数据读取不替代完整发布校验。','未启动、停止、重启服务或重发命令；本报告不能证明断线前的操作未执行。']};
}

export function writeDiagnosticReport(workspace,report){
  if(report?.format!=='web-cad-diagnostics'||report.version!==1||!uuid.test(report.reportId||''))throw fault('DIAGNOSTIC_REPORT_INVALID');
  const relative='.artifacts/diagnostics',directory=regularPath(workspace,relative,{directory:true,missing:true});fs.mkdirSync(directory,{recursive:true});regularPath(workspace,relative,{directory:true});
  const file=path.join(directory,`diagnostics-${report.reportId}.json`),bytes=Buffer.from(JSON.stringify(report,null,2)+'\n');if(bytes.length>128*1024)throw fault('DIAGNOSTIC_REPORT_TOO_LARGE');
  const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return file;
}
