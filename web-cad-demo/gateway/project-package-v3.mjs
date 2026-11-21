import {createHash,timingSafeEqual} from 'node:crypto';
import {validateProjectMeshArchive,MESH_ARCHIVE_LIMITS} from './project-mesh-archive.mjs';

export const PROJECT_V3_MAGIC=Buffer.from('WEBCADPROJECT3\n');
const HEADER=PROJECT_V3_MAGIC.length+4+32,MAX_MANIFEST=64*1024**2,DEFAULT_LIMIT=512*1024**2;
const hash=bytes=>createHash('sha256').update(bytes).digest(),plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value),keys=(value,names)=>plain(value)&&Object.keys(value).length===names.length&&Object.keys(value).every(key=>names.includes(key));
const fail=message=>{throw Object.assign(Error(message),{code:'INVALID_PROJECT_FILE'});};
const bounded=(size,max)=>{if(!Number.isSafeInteger(size)||size<0||size>max)throw Object.assign(Error('工程包展开后超过大小限制。'),{code:'PROJECT_TOO_LARGE'});};
function buffer(value){if(!Buffer.isBuffer(value)||value.buffer instanceof SharedArrayBuffer||value.buffer.resizable)fail('工程数据必须为调用者持有的固定二进制内容。');return value;}
function document(value){if(!plain(value)||Object.keys(value).some(key=>!['id','revision','name'].includes(key))||!/^[A-Za-z0-9_-]{1,64}$/.test(value.id)||!Number.isSafeInteger(value.revision)||value.revision<0||value.name!==undefined&&(typeof value.name!=='string'||!value.name.trim()||value.name.length>120||/[\x00-\x1f]/.test(value.name)))fail('工程名称或来源元数据无效。');}
function source(value){if(!/^[A-Za-z0-9_-]{1,96}$/.test(value.featureId)||typeof value.fileName!=='string'||value.fileName.length>240||/[\\/\x00-\x1f]/.test(value.fileName)||!/\.(?:step|stp)$/i.test(value.fileName))fail('STEP 来源身份或名称无效。');}
function geometry(value){if(value.length<32||value.subarray(0,7).toString('ascii')!=='BINFILE')fail('工程几何不是有效的 XBF 数据。');}

/** V3 keeps a small JSON index followed by exact binary segments. No nested
 * base64, decompression or user-controlled entry path is needed for mesh assets. */
export function encodeProjectPackageV3({geometry:xbf,projectData,sources=[],meshArchive,documentId,revision,name},{maxUnpackedBytes=DEFAULT_LIMIT}={}){
  buffer(xbf);geometry(xbf);const doc={id:documentId,revision,...(name?{name}:{})};document(doc);
  if(!plain(projectData)||projectData.projectDataVersion!==1||!Array.isArray(sources)||sources.length>1000)fail('新版工程包缺少完整工程数据或来源清单。');
  const archive=validateProjectMeshArchive(meshArchive);if(archive.manifest.source.documentId!==documentId||archive.manifest.source.revision!==revision)fail('网格资产与保存的工程身份或修订基线不一致。');
  const blobs=new Map();let expanded=xbf.length+archive.expandedBytes;const add=data=>{buffer(data);const sha256=hash(data).toString('hex');if(!blobs.has(sha256))blobs.set(sha256,{sha256,bytes:data.length,data});return sha256;};
  const geometryRef=add(xbf),seen=new Set(),sourceRefs=sources.map(item=>{source(item);if(seen.has(item.featureId))fail('STEP 来源特征重复。');seen.add(item.featureId);expanded+=buffer(item.bytes).length;bounded(expanded,maxUnpackedBytes);return {featureId:item.featureId,fileName:item.fileName,blob:add(item.bytes)};});
  for(const blob of archive.blobs.values())add(blob.data);bounded(expanded,maxUnpackedBytes);
  const segments=[...blobs.values()].sort((a,b)=>a.sha256.localeCompare(b.sha256)),manifest={format:'web-cad-project',version:3,createdAt:new Date().toISOString(),document:doc,geometry:geometryRef,projectData,sources:sourceRefs,meshArchive:archive.manifest,blobs:segments.map(({sha256,bytes})=>({sha256,bytes}))},json=Buffer.from(JSON.stringify(manifest));bounded(json.length,MAX_MANIFEST);
  const total=HEADER+json.length+segments.reduce((sum,item)=>sum+item.bytes,0);bounded(total,maxUnpackedBytes);
  const header=Buffer.alloc(HEADER);PROJECT_V3_MAGIC.copy(header);header.writeUInt32LE(json.length,PROJECT_V3_MAGIC.length);hash(json).copy(header,PROJECT_V3_MAGIC.length+4);
  const result=Buffer.concat([header,json,...segments.map(item=>item.data)],total);
  // Also detects a caller changing a source buffer during a shared native copy.
  decodeProjectPackageV3(result,{maxUnpackedBytes});return result;
}

export function decodeProjectPackageV3(bytes,{maxUnpackedBytes=DEFAULT_LIMIT}={}){
  buffer(bytes);bounded(bytes.length,maxUnpackedBytes);if(bytes.length<HEADER+2||!bytes.subarray(0,PROJECT_V3_MAGIC.length).equals(PROJECT_V3_MAGIC))fail('新版工程包头无效。');
  const size=bytes.readUInt32LE(PROJECT_V3_MAGIC.length);if(size<2||size>MAX_MANIFEST||HEADER+size>bytes.length)fail('新版工程包清单长度无效。');
  const json=bytes.subarray(HEADER,HEADER+size);if(!timingSafeEqual(hash(json),bytes.subarray(PROJECT_V3_MAGIC.length+4,HEADER)))fail('工程包完整性校验失败，未打开文件。');
  let manifest;try{manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(json));}catch{fail('工程包清单无法解析。');}
  if(!keys(manifest,['format','version','createdAt','document','geometry','projectData','sources','meshArchive','blobs'])||manifest.format!=='web-cad-project'||manifest.version!==3||typeof manifest.createdAt!=='string'||manifest.createdAt.length>40||!Number.isFinite(Date.parse(manifest.createdAt))||!plain(manifest.projectData)||manifest.projectData.projectDataVersion!==1||!Array.isArray(manifest.sources)||manifest.sources.length>1000||!Array.isArray(manifest.blobs)||manifest.blobs.length>MESH_ARCHIVE_LIMITS.maxBlobs+1001)fail('新版工程包清单结构无效。');document(manifest.document);
  const blobs=new Map();let offset=HEADER+size;
  for(const blob of manifest.blobs){if(!keys(blob,['sha256','bytes'])||!/^[a-f0-9]{64}$/.test(blob.sha256)||!Number.isSafeInteger(blob.bytes)||blob.bytes<1||blob.bytes>maxUnpackedBytes||blobs.has(blob.sha256)||offset+blob.bytes>bytes.length)fail('工程包二进制分段身份或长度无效。');const data=bytes.subarray(offset,offset+blob.bytes);offset+=blob.bytes;if(hash(data).toString('hex')!==blob.sha256)fail('工程包数据校验失败，文件可能已损坏。');blobs.set(blob.sha256,{...blob,data});}
  if(offset!==bytes.length)fail('工程包存在未声明的尾部内容。');
  const used=new Set(),get=key=>{if(!blobs.has(key))fail('工程包引用了缺失的数据块。');used.add(key);return blobs.get(key).data;},xbf=get(manifest.geometry);geometry(xbf);
  const seen=new Set();let expanded=xbf.length;const sources=manifest.sources.map(item=>{if(!keys(item,['featureId','fileName','blob']))fail('STEP 来源记录结构无效。');source(item);if(seen.has(item.featureId))fail('STEP 来源特征重复。');seen.add(item.featureId);const bytes=get(item.blob);expanded+=bytes.length;bounded(expanded,maxUnpackedBytes);return {featureId:item.featureId,fileName:item.fileName,bytes};});
  if(!keys(manifest.meshArchive,['version','source','assets'])||!Array.isArray(manifest.meshArchive.assets))fail('工程包网格资产索引无效。');
  const meshKeys=new Set();for(const asset of manifest.meshArchive.assets){if(!plain(asset.files))fail('工程包网格文件角色无效。');for(const key of Object.values(asset.files)){get(key);meshKeys.add(key);}}
  const meshArchive={...manifest.meshArchive,blobs:[...meshKeys].map(key=>blobs.get(key))},archive=validateProjectMeshArchive(meshArchive);expanded+=archive.expandedBytes;bounded(expanded,maxUnpackedBytes);
  if(archive.manifest.source.documentId!==manifest.document.id||archive.manifest.source.revision!==manifest.document.revision||used.size!==blobs.size)fail('工程包网格身份或修订不一致，或含未引用内容。');
  return {legacy:false,packageVersion:3,geometry:xbf,projectData:manifest.projectData,propertySchema:manifest.projectData.propertySchema,sources,meshArchive,metadata:{createdAt:manifest.createdAt,document:manifest.document}};
}
