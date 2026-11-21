/** Build-time only: certify the installed production runner's import closure.
 * No build/compiler dependency is needed by the resulting release. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {isBuiltin} from 'node:module';
import ts from 'typescript';
import {assertRegularDirectory,copyCertifiedFiles} from '../gateway/frontend-release.mjs';

const ENTRY='dist/server/prod-server.js';
const DYNAMIC=new Map([['dist/server/prod-server.js',new Set([
  '`${pathToFileURL(rscEntryPath).href}?t=${rscMtime}`',
  '`${pathToFileURL(serverEntryPath).href}?t=${serverMtime}`',
])]]);
const fail=message=>{throw Object.assign(Error(message),{code:'FRONTEND_RUNTIME_CLOSURE_INVALID'});};
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const relative=(root,file)=>path.relative(root,file).replaceAll('\\','/');

function readFile(root,file){
  const rel=relative(root,file);
  if(!rel||rel==='..'||rel.startsWith('../')||path.isAbsolute(rel)||rel.split('/').some(part=>!part||part==='.'||/[\\:]/.test(part)))fail('Production runtime import escapes its package.');
  let parent=root;assertRegularDirectory(parent);
  for(const segment of rel.split('/').slice(0,-1)){parent=path.join(parent,segment);assertRegularDirectory(parent);}
  const before=fs.lstatSync(file,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>1024n*1024n)fail('Production runtime input is not a bounded ordinary file.');
  const bytes=fs.readFileSync(file),after=fs.lstatSync(file,{bigint:true});
  if(['dev','ino','size','mtimeNs','ctimeNs'].some(key=>before[key]!==after[key])||BigInt(bytes.length)!==before.size)fail('Production runtime input changed while reading.');
  return {bytes,proof:{file:rel,bytes:bytes.length,sha256:sha(bytes)}};
}

export function collectProductionRuntime(packageRoot){
  packageRoot=path.resolve(packageRoot);assertRegularDirectory(packageRoot);
  const packageFile=readFile(packageRoot,path.join(packageRoot,'package.json'));
  let pkg;try{pkg=JSON.parse(packageFile.bytes);}catch{fail('Production runtime package metadata is invalid.');}
  if(pkg.name!=='vinext'||typeof pkg.version!=='string'||!pkg.version||pkg.version.length>80||pkg.type!=='module'||pkg.license!=='MIT')fail('Unsupported production runtime package identity or license.');
  const license=readFile(packageRoot,path.join(packageRoot,'LICENSE'));
  if(!license.bytes.length)fail('Production runtime license is missing.');
  const queue=[path.join(packageRoot,ENTRY)],files=new Map([[packageFile.proof.file,packageFile.proof],[license.proof.file,license.proof]]),dynamicEntries=[];
  let total=packageFile.bytes.length+license.bytes.length;
  while(queue.length){
    const file=queue.shift(),name=relative(packageRoot,file);if(files.has(name))continue;
    if(files.size>=256)fail('Production runtime closure exceeds 256 files.');
    const input=readFile(packageRoot,file);total+=input.bytes.length;if(total>8*1024*1024)fail('Production runtime closure exceeds 8 MiB.');
    if(!/\.(mjs|js)$/.test(name))fail('Unsupported production runtime module type.');
    files.set(name,input.proof);
    const source=ts.createSourceFile(file,input.bytes.toString('utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    if(source.parseDiagnostics.length)fail('Production runtime source cannot be parsed.');
    const dependency=node=>{
      if(ts.isStringLiteralLike(node)){
        const specifier=node.text;if(isBuiltin(specifier))return;
        if(!specifier.startsWith('./')&&!specifier.startsWith('../'))fail('Unsealed production runtime package dependency: '+specifier);
        const resolved=path.resolve(path.dirname(file),specifier);readFile(packageRoot,resolved);queue.push(resolved);return;
      }
      const expression=node?.getText(source);
      if(!DYNAMIC.get(name)?.has(expression))fail('Unreviewed computed production runtime import in '+name);
      dynamicEntries.push({file:name,expression,scope:'certified-build-entry'});
    };
    const visit=node=>{
      if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier)dependency(node.moduleSpecifier);
      else if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword)dependency(node.arguments[0]);
      else if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&['require','eval','createRequire'].includes(node.expression.text))fail('Unreviewed dynamic loader in production runtime.');
      ts.forEachChild(node,visit);
    };
    visit(source);
  }
  return {version:1,packageName:'vinext',packageVersion:pkg.version,license:'MIT',entry:ENTRY,files:[...files.values()].sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0),dynamicEntries:dynamicEntries.sort((a,b)=>(a.file+'\n'+a.expression).localeCompare(b.file+'\n'+b.expression,'en'))};
}

export function copyProductionRuntime(workspace,directory){
  const source=path.join(workspace,'node_modules','vinext'),before=collectProductionRuntime(source);
  copyCertifiedFiles(source,path.join(directory,'runtime/vendor/vinext'),before.files);
  if(JSON.stringify(collectProductionRuntime(source))!==JSON.stringify(before))fail('Production runtime inputs changed while copying.');
  return before;
}
