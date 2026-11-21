import { createHash, timingSafeEqual } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import path from "node:path";
import {readManagedStepSource,verifyStepSource} from './step-source-integrity.mjs';
import {PROJECT_V3_MAGIC,encodeProjectPackageV3,decodeProjectPackageV3} from './project-package-v3.mjs';

export const PROJECT_MIME = "application/vnd.webcad.project";
export const PROJECT_EXTENSION = ".cadproj";
const MAGIC = Buffer.from("WEBCADPROJECT\n");
const DEFAULT_LIMIT = 512 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,96}$/;
const digest = (bytes) => createHash("sha256").update(bytes).digest();
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export class ProjectFileError extends Error { constructor(message, code="INVALID_PROJECT_FILE") { super(message); this.code=code; } }
function fail(message) { throw new ProjectFileError(message); }
function geometryCheck(bytes) { if(bytes.length<32 || bytes.subarray(0,7).toString("ascii")!=="BINFILE") fail("工程几何不是有效的 XBF 数据。"); }
function blob(bytes) { return {size:bytes.length,sha256:digest(bytes).toString("hex"),data:bytes.toString("base64")}; }
function unblob(value,limit) {
  if(!value || typeof value.data!=="string" || !Number.isSafeInteger(value.size) || value.size<1 || value.size>limit || value.data.length>Math.ceil(limit/3)*4) fail("工程文件的数据长度无效或超出限制。");
  const bytes=Buffer.from(value.data,"base64");
  if(bytes.length!==value.size || bytes.toString("base64")!==value.data || digest(bytes).toString("hex")!==value.sha256) fail("工程文件数据校验失败，文件可能已损坏。");
  return bytes;
}
export function encodeProjectPackage({geometry,propertySchema,projectData,sources=[],meshArchive,documentId,revision,name}, {maxUnpackedBytes=DEFAULT_LIMIT}={}) {
  geometryCheck(geometry);
  if(projectData&&propertySchema!==undefined&&JSON.stringify(canonical(projectData.propertySchema))!==JSON.stringify(canonical(propertySchema)))fail('新版工程数据与旧属性参数矛盾，未忽略任何一份输入。');
  if(meshArchive!==undefined)try{return encodeProjectPackageV3({geometry,projectData,sources,meshArchive,documentId,revision,name},{maxUnpackedBytes});}catch(error){throw new ProjectFileError(error.message,error.code);}
  const content={format:"web-cad-project",version:projectData?2:1,createdAt:new Date().toISOString(),document:{id:documentId,revision,...(name ? {name}: {})},geometry:blob(geometry),...(projectData?{projectData}:{propertySchema}),sources:sources.map(source=>({featureId:source.featureId,fileName:source.fileName,...blob(source.bytes)}))};
  const json=Buffer.from(JSON.stringify(content)); if(json.length>maxUnpackedBytes) throw new ProjectFileError("工程包展开后超过大小限制。","PROJECT_TOO_LARGE");
  return Buffer.concat([MAGIC,digest(json),gzipSync(json,{level:6})]);
}
export function decodeProjectPackage(bytes,{maxUnpackedBytes=DEFAULT_LIMIT}={}) {
  if(bytes.subarray(0,PROJECT_V3_MAGIC.length).equals(PROJECT_V3_MAGIC))try{return decodeProjectPackageV3(bytes,{maxUnpackedBytes});}catch(error){throw new ProjectFileError(error.message,error.code);}
  if(bytes.subarray(0,7).toString("ascii")==="BINFILE") {geometryCheck(bytes);if(bytes.length>maxUnpackedBytes) fail("XBF 文件超过大小限制。");return {legacy:true,geometry:bytes,propertySchema:{schemaVersion:1,types:[],instances:[]},sources:[]};}
  if(bytes.length<MAGIC.length+34 || !bytes.subarray(0,MAGIC.length).equals(MAGIC)) fail("请选择 .cadproj 工程包或旧版 .xbf 文件。");
  let json; try {json=gunzipSync(bytes.subarray(MAGIC.length+32),{maxOutputLength:maxUnpackedBytes});}catch{fail("工程包无法解压或展开后超过大小限制。");}
  if(!timingSafeEqual(digest(json),bytes.subarray(MAGIC.length,MAGIC.length+32))) fail("工程包完整性校验失败，未打开文件。");
  let content;try{content=JSON.parse(json.toString("utf8"));}catch{fail("工程包清单无法解析。");}
  if(content?.format!=="web-cad-project" || ![1,2].includes(content.version)) throw new ProjectFileError("不支持此工程文件版本，请使用兼容版本的工作台。","UNSUPPORTED_PROJECT_VERSION");
  if(content.version===2&&(!content.projectData||content.projectData.projectDataVersion!==1||content.propertySchema!==undefined))fail('新版工程包缺少独立工程数据或包含矛盾的旧数据字段。');
  if(content.version===1&&content.projectData!==undefined)fail('旧版工程包不能夹带新版工程数据，未忽略未知内容。');
  if(content.document?.name!==undefined && (typeof content.document.name!=="string" || !content.document.name.trim() || content.document.name.length>120 || /[\x00-\x1f]/.test(content.document.name)))fail("工程名称元数据无效。");
  const geometry=unblob(content.geometry,maxUnpackedBytes);geometryCheck(geometry);
  if(!Array.isArray(content.sources) || content.sources.length>1000) fail("STEP 来源清单无效。");
  const seen=new Set();
  const sources=content.sources.map(source=>{
    if(!ID.test(source.featureId) || seen.has(source.featureId)) fail("STEP 来源特征 ID 无效或重复。"); seen.add(source.featureId);
    if(typeof source.fileName!=="string" || source.fileName.length>240 || /[\\/\x00-\x1f]/.test(source.fileName) || !/\.(?:step|stp)$/i.test(source.fileName)) fail("STEP 来源名称无效。");
    return {featureId:source.featureId,fileName:source.fileName,bytes:unblob(source,maxUnpackedBytes)};
  });
  return {legacy:false,packageVersion:content.version,geometry,propertySchema:content.version===2?content.projectData.propertySchema:content.propertySchema,...(content.version===2?{projectData:content.projectData}:{}),sources,metadata:{createdAt:content.createdAt,document:content.document}};
}

export function collectProjectSources(features,dataDir,{maxSourceBytes=DEFAULT_LIMIT}={}) {
  let total=0;
  return features.filter(feature=>feature.type==="import.step").map(feature=>{
    const original=feature.stringParameters?.sourcePath;
    if(typeof original!=="string")throw new ProjectFileError(`STEP 来源丢失：${feature.id}。`,"PROJECT_SOURCE_MISSING");
    try{const source=readManagedStepSource(original,dataDir,{maxBytes:maxSourceBytes-total});verifyStepSource({...feature.stringParameters,decompositionVersion:feature.numberParameters?.decompositionVersion},source);total+=source.size;return {featureId:feature.id,fileName:path.basename(original),bytes:source.bytes};}
    catch(error){throw new ProjectFileError(`${feature.id}：${error.message}`,error.code||'PROJECT_SOURCE_UNAVAILABLE');}
  });
}
