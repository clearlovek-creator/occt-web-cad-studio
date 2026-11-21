import fs from 'node:fs';
import path from 'node:path';

const INPUTS=['workspace','frontendRoot','backendRoot','nodeSourceMaterial'];
const OWNED=['.git','.codex','.agents','.aws','.data','.releases','.backend-releases','runtime-logs','node_modules','app','shared','gateway','scripts','public','build','worker','geometry-worker','mesh-worker','tests','docs'];
const VERSION=/^(?:workbench|frontend|backend)-[0-9]{13}-[a-f0-9-]{36}$/i;
const FORMATS=new Set(['web-cad-frontend-release','web-cad-backend-release','web-cad-workbench-bundle','web-cad-frontend-selection','web-cad-backend-selection']);
const fail=message=>Object.assign(Error(message),{code:'WORKBENCH_BUILD_PATH_INVALID'});
const key=value=>process.platform==='win32'?value.toLowerCase():value;
const within=(parent,child)=>{const relative=path.relative(parent,child);return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const nativePath=value=>value.startsWith('\\\\?\\UNC\\')?'\\\\'+value.slice(8):value.startsWith('\\\\?\\')?value.slice(4):value;

function absolute(value){
  if(typeof value!=='string'||!value.trim()||/[\x00-\x1f]/.test(value)||value.startsWith('\\\\?\\')||value.startsWith('\\\\.\\')||value.startsWith('\\??\\'))throw fail('Build paths must be nonempty ordinary filesystem paths, not device namespaces.');
  if(process.platform==='win32'&&/^[A-Za-z]:(?:$|[^\\/])/.test(value))throw fail('Drive-relative build paths are ambiguous. Use an absolute path or an ordinary relative directory.');
  const resolved=path.resolve(value),volume=path.parse(resolved).root,parts=resolved.slice(volume.length).split(path.sep).filter(Boolean);
  if(parts.length>64)throw fail('Build path depth exceeds 64 components.');
  if(process.platform==='win32')for(const part of parts){
    if(/[<>:"|?*]/.test(part)||/[. ]$/.test(part)||/^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(part))throw fail('Build paths contain a reserved name, stream or ambiguous Windows component.');
  }
  return resolved;
}
function directory(file){
  const stat=fs.lstatSync(file,{bigint:true});
  if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('Build directory paths cannot contain links, junctions or ordinary files.');
  if(stat.ino===0n)throw fail('Build directory identity is unavailable on this filesystem.');
  return {path:nativePath(fs.realpathSync.native(file)),dev:String(stat.dev),ino:String(stat.ino)};
}
function observe(value,{missing=false,capture}={}){
  const resolved=absolute(value),volume=path.parse(resolved).root,parts=resolved.slice(volume.length).split(path.sep).filter(Boolean);
  let current=volume,record=directory(current);const ancestors=[record];capture?.(record);let absent=false;const tail=[];
  for(const part of parts){
    if(absent){tail.push(part);continue;}
    const next=path.join(current,part);
    try{record=directory(next);ancestors.push(record);capture?.(record);current=record.path;}
    catch(error){if(error.code!=='ENOENT'||!missing)throw error;absent=true;tail.push(part);}
  }
  return {path:path.join(current,...tail),parent:current,missing:tail,ancestors};
}
function managedAncestor(output){
  for(let current=output;;){
    let exists=true;try{directory(current);}catch(error){if(error.code==='ENOENT')exists=false;else throw error;}
    if(exists){
      if(VERSION.test(path.basename(current))||/^\.pending-[a-f0-9-]{36}$/i.test(path.basename(current)))throw fail('Build output cannot be placed in a managed release or retained staging directory.');
      for(const name of['workbench.json','release.json','selected.json']){
        const file=path.join(current,name);let stat;try{stat=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
        if(name==='workbench.json')throw fail('Build output cannot be placed under an existing workbench manifest.');
        if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>2*1024*1024)continue;
        let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch{continue;}
        if(FORMATS.has(value?.format))throw fail('Build output cannot be placed under a release or selection manifest.');
      }
    }
    const parent=path.dirname(current);if(parent===current)break;current=parent;
  }
}

/** Admission for ordinary operator-controlled paths. Rechecks are not native
 * handle-relative operations or an OS lock against a malicious directory race. */
export function prepareWorkbenchBuildPaths(options){
  if(!options||!INPUTS.concat('outputRoot').every(name=>typeof options[name]==='string'&&options[name].trim()))throw fail('Explicit workspace, frontend/backend roots, Node material and output root are required.');
  const observations=new Map(),capture=record=>{const previous=observations.get(key(record.path));if(previous&&(previous.dev!==record.dev||previous.ino!==record.ino))throw fail('Build directory identity changed during admission.');observations.set(key(record.path),record);};
  const paths={},inputIds=new Map();for(const name of INPUTS){const input=observe(options[name],{capture});paths[name]=input.path;const last=input.ancestors.at(-1);inputIds.set(name,last.dev+':'+last.ino);}
  const additionalInputs=[];
  let output=observe(options.outputRoot,{missing:true,capture});paths.outputRoot=output.path;
  function scope(){
    if(key(paths.outputRoot)===key(path.parse(paths.outputRoot).root)||key(paths.outputRoot)===key(paths.workspace))throw fail('Build output requires a dedicated directory, not a volume or workspace root.');
    for(const name of['frontendRoot','backendRoot','nodeSourceMaterial'])if(within(paths[name],paths.outputRoot))throw fail('Build output overlaps an input release or Node material root.');
    for(const input of additionalInputs)if(within(input.path,paths.outputRoot))throw fail('Build output overlaps an observed input directory.');
    for(const name of OWNED)if(within(path.join(paths.workspace,name),paths.outputRoot))throw fail('Build output overlaps workspace source, data, dependencies or service records.');
    // File IDs also cover alternate ordinary spellings (e.g. volume aliases)
    // that do not share a textual drive/prefix with an input directory.
    for(const ancestor of observe(paths.outputRoot,{missing:true}).ancestors){
      const identity=ancestor.dev+':'+ancestor.ino;
      for(const name of['frontendRoot','backendRoot','nodeSourceMaterial'])if(identity===inputIds.get(name))throw fail('Build output overlaps an input directory identity.');
      if(additionalInputs.some(input=>input.identity===identity))throw fail('Build output overlaps an observed input directory identity.');
      if(identity===inputIds.get('workspace')){
        const relative=path.relative(ancestor.path,paths.outputRoot),first=relative.split(path.sep)[0];
        if(!relative)throw fail('Build output requires a dedicated directory, not a workspace identity alias.');
        if(OWNED.some(name=>key(name)===key(first)))throw fail('Build output overlaps workspace source, data, dependencies or service records through an identity alias.');
      }
    }
    managedAncestor(paths.outputRoot);
  }
  scope();Object.freeze(paths);
  function recheck(){
    for(const old of observations.values()){
      const current=directory(old.path);if(key(current.path)!==key(old.path)||current.dev!==old.dev||current.ino!==old.ino)throw fail('Build directory identity changed; no new build material was authorized.');
    }
    for(const name of INPUTS)if(key(observe(paths[name]).path)!==key(paths[name]))throw fail('Build input directory changed.');
    const current=observe(paths.outputRoot,{missing:true});
    if(key(current.path)!==key(paths.outputRoot)||current.missing.length!==output.missing.length||current.missing.some((part,index)=>key(part)!==key(output.missing[index])))throw fail('Build output appeared or changed after admission. Inspect it before starting another build.');
    scope();
  }
  function createOutputRoot(){
    recheck();let current=output.parent;
    for(const part of [...output.missing]){
      const next=path.join(current,part);fs.mkdirSync(next);const record=directory(next);capture(record);current=record.path;
      output={path:paths.outputRoot,parent:current,missing:output.missing.slice(1)};recheck();
    }
    recheck();return paths.outputRoot;
  }
  function observeInputDirectory(value){
    const input=observe(value,{capture}),last=input.ancestors.at(-1);additionalInputs.push({path:input.path,identity:last.dev+':'+last.ino});scope();return input.path;
  }
  return Object.freeze({paths,recheck,createOutputRoot,observeInputDirectory});
}
