import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createWorkbenchBundle} from '../gateway/workbench-bundle.mjs';
import {prepareWorkbenchBuildPaths} from '../gateway/workbench-build-paths.mjs';
import {parseWorkbenchBundleArguments} from '../scripts/workbench-bundle-arguments.mjs';

function fixture(t){
  const parent=fs.realpathSync.native(os.tmpdir());
  const root=fs.mkdtempSync(path.join(parent,'cad-bundle-paths-'));
  t.after(()=>{assert.equal(path.dirname(root),parent);assert.match(path.basename(root),/^cad-bundle-paths-/);fs.rmSync(root,{recursive:true,force:true});});
  const options={workspace:path.join(root,'workspace'),frontendRoot:path.join(root,'frontend-input'),backendRoot:path.join(root,'backend-input'),nodeSourceMaterial:path.join(root,'node-input'),outputRoot:path.join(root,'output','nested')};
  for(const key of['workspace','frontendRoot','backendRoot','nodeSourceMaterial']){fs.mkdirSync(options[key]);fs.writeFileSync(path.join(options[key],'sentinel.txt'),key);}
  return {root,options};
}

test('bundle output inside an input root is rejected without even creating an empty directory there',t=>{
  const f=fixture(t),outputRoot=path.join(f.options.frontendRoot,'must-not-create');
  assert.throws(()=>createWorkbenchBundle({...f.options,outputRoot}));
  assert.equal(fs.existsSync(outputRoot),false,'Invalid build mutated an input release root before admission.');
});
test('invalid component inputs never create the requested output or its missing parents',t=>{
  const f=fixture(t);assert.throws(()=>createWorkbenchBundle(f.options));
  assert.equal(fs.existsSync(path.join(f.root,'output')),false,'Invalid build left new output directories.');
});

function inputContents(f){return ['workspace','frontendRoot','backendRoot','nodeSourceMaterial'].map(key=>({key,names:fs.readdirSync(f.options[key]).sort(),sentinel:fs.readFileSync(path.join(f.options[key],'sentinel.txt'),'utf8')}));}
test('each input root, normalized descendants and Windows case aliases are protected before writes',t=>{
  const f=fixture(t),before=inputContents(f);
  for(const key of['frontendRoot','backendRoot','nodeSourceMaterial'])for(const outputRoot of[f.options[key],path.join(f.options[key],'new'),path.join(f.options[key],'unused','..','new'),f.options[key].toUpperCase()])assert.throws(()=>prepareWorkbenchBuildPaths({...f.options,outputRoot}),/overlaps an input/);
  assert.deepEqual(inputContents(f),before);assert.equal(fs.existsSync(path.join(f.root,'output')),false);
});
test('workspace source, data, dependency and service directories and volume roots are not bundle outputs',t=>{
  const f=fixture(t),before=inputContents(f);
  for(const name of['app','gateway','shared','scripts','docs','tests','node_modules','.data','.releases','.backend-releases','.git','runtime-logs','geometry-worker','mesh-worker'])assert.throws(()=>prepareWorkbenchBuildPaths({...f.options,outputRoot:path.join(f.options.workspace,name,'new')}),/workspace source/);
  for(const outputRoot of[f.options.workspace,path.parse(f.root).root])assert.throws(()=>prepareWorkbenchBuildPaths({...f.options,outputRoot}),/dedicated directory/);
  assert.deepEqual(inputContents(f),before);
});
test('ordinary sibling output paths do not collide by text prefix and missing levels are created individually',t=>{
  const f=fixture(t),outputRoot=path.join(f.root,'frontend-input-extra','发布 输出'),before=inputContents(f),admission=prepareWorkbenchBuildPaths({...f.options,outputRoot});
  assert.equal(fs.existsSync(outputRoot),false);assert.equal(admission.createOutputRoot(),outputRoot);assert.ok(fs.statSync(outputRoot).isDirectory());admission.recheck();assert.equal(admission.createOutputRoot(),outputRoot);assert.deepEqual(inputContents(f),before);
});
test('an existing independent output retains all unrelated contents',t=>{
  const f=fixture(t),outputRoot=path.join(f.root,'existing-output');fs.mkdirSync(outputRoot);fs.writeFileSync(path.join(outputRoot,'keep.txt'),'unrelated output');
  prepareWorkbenchBuildPaths({...f.options,outputRoot}).createOutputRoot();assert.deepEqual(fs.readdirSync(outputRoot),['keep.txt']);assert.equal(fs.readFileSync(path.join(outputRoot,'keep.txt'),'utf8'),'unrelated output');
});
test('output junctions and linked input roots are rejected without following them',t=>{
  const f=fixture(t),link=path.join(f.root,'alias'),before=inputContents(f);fs.symlinkSync(f.options.frontendRoot,link,'junction');
  try{assert.throws(()=>prepareWorkbenchBuildPaths({...f.options,outputRoot:path.join(link,'new')}),/links, junctions/);assert.throws(()=>prepareWorkbenchBuildPaths({...f.options,frontendRoot:link}),/links, junctions/);assert.deepEqual(inputContents(f),before);}finally{fs.unlinkSync(link);}
});
test('dangling junctions and ordinary files are not mistaken for missing directories',t=>{
  const f=fixture(t),link=path.join(f.root,'dangling'),file=path.join(f.root,'not-directory'),target=path.join(f.root,'missing-target');
  fs.mkdirSync(target);fs.symlinkSync(target,link,'junction');fs.rmdirSync(target);fs.writeFileSync(file,'preserve');
  try{for(const outputRoot of[path.join(link,'new'),path.join(file,'new')])assert.throws(()=>prepareWorkbenchBuildPaths({...f.options,outputRoot}),/links, junctions|ENOTDIR/);assert.equal(fs.existsSync(path.join(f.root,'missing-target')),false);assert.equal(fs.readFileSync(file,'utf8'),'preserve');}finally{fs.unlinkSync(link);}
});
test('other versions, retained staging and existing release or selection manifests are protected',t=>{
  const f=fixture(t);
  for(const name of['workbench-'+Date.now()+'-'+randomUUID(),'frontend-'+Date.now()+'-'+randomUUID(),'.pending-'+randomUUID()]){const directory=path.join(f.root,name);fs.mkdirSync(directory);assert.throws(()=>prepareWorkbenchBuildPaths({...f.options,outputRoot:path.join(directory,'new')}),/managed release|retained staging/);assert.deepEqual(fs.readdirSync(directory),[]);}
  for(const [name,value]of[['workbench.json','broken manifest must remain protected'],['release.json',JSON.stringify({format:'web-cad-backend-release'})],['selected.json',JSON.stringify({format:'web-cad-frontend-selection'})]]){
    const directory=path.join(f.root,randomUUID());fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,name),value);assert.throws(()=>prepareWorkbenchBuildPaths({...f.options,outputRoot:path.join(directory,'new')}),/manifest/);assert.deepEqual(fs.readdirSync(directory),[name]);
  }
});
test('reserved device, stream, drive-relative, ambiguous and overdeep Windows paths fail without creation',t=>{
  const f=fixture(t),values=['',' ',path.join(f.root,'CON.txt'),path.join(f.root,'aux'),path.join(f.root,'name:stream'),path.join(f.root,'trailing.'),path.join(f.root,'trailing '),'D:relative','D:','\\\\?\\C:\\output','\\\\.\\C:\\output',path.join(f.root,'nul\0value'),path.join(f.root,...Array(70).fill('deep'))];
  for(const outputRoot of values)assert.throws(()=>prepareWorkbenchBuildPaths({...f.options,outputRoot}));assert.equal(fs.existsSync(path.join(f.root,'output')),false);assert.equal(fs.existsSync(path.join(f.root,'deep')),false);
});
test('a replaced parent identity is rejected before output creation',t=>{
  const f=fixture(t),parent=path.join(f.root,'parent'),aside=path.join(f.root,'parent-original'),outputRoot=path.join(parent,'new');fs.mkdirSync(parent);const admission=prepareWorkbenchBuildPaths({...f.options,outputRoot});
  assert.equal(path.dirname(parent),f.root);assert.equal(path.dirname(aside),f.root);fs.renameSync(parent,aside);fs.mkdirSync(parent);assert.throws(()=>admission.createOutputRoot(),/identity changed/);assert.equal(fs.existsSync(outputRoot),false);
});
test('a parent turned into a junction after admission never creates a child in the input root',t=>{
  const f=fixture(t),parent=path.join(f.root,'parent'),aside=path.join(f.root,'parent-original');fs.mkdirSync(parent);const admission=prepareWorkbenchBuildPaths({...f.options,outputRoot:path.join(parent,'new')});
  assert.equal(path.dirname(parent),f.root);assert.equal(path.dirname(aside),f.root);fs.renameSync(parent,aside);fs.symlinkSync(f.options.frontendRoot,parent,'junction');try{assert.throws(()=>admission.createOutputRoot(),/links, junctions/);assert.equal(fs.existsSync(path.join(f.options.frontendRoot,'new')),false);}finally{fs.unlinkSync(parent);}
});
test('an output path that appears after admission is not silently adopted',t=>{
  const f=fixture(t),admission=prepareWorkbenchBuildPaths(f.options);fs.mkdirSync(f.options.outputRoot,{recursive:true});fs.writeFileSync(path.join(f.options.outputRoot,'other-owner.txt'),'preserve');assert.throws(()=>admission.createOutputRoot(),/appeared or changed/);assert.deepEqual(fs.readdirSync(f.options.outputRoot),['other-owner.txt']);
});
test('a release marker appearing after admission blocks subsequent directory creation',t=>{
  const f=fixture(t),parent=path.join(f.root,'parent');fs.mkdirSync(parent);const admission=prepareWorkbenchBuildPaths({...f.options,outputRoot:path.join(parent,'new')});fs.writeFileSync(path.join(parent,'workbench.json'),'late marker');assert.throws(()=>admission.createOutputRoot(),/manifest/);assert.equal(fs.existsSync(path.join(parent,'new')),false);
});
test('directory-creation failures propagate and do not delete or change input materials',t=>{
  const f=fixture(t),outputRoot=path.join(f.root,'refused-output'),admission=prepareWorkbenchBuildPaths({...f.options,outputRoot}),before=inputContents(f),mkdir=fs.mkdirSync;
  fs.mkdirSync=(directory,...args)=>{if(directory===outputRoot)throw Object.assign(Error('injected denied mkdir'),{code:'EACCES'});return mkdir(directory,...args);};try{assert.throws(()=>admission.createOutputRoot(),/injected denied/);}finally{fs.mkdirSync=mkdir;}assert.equal(fs.existsSync(outputRoot),false);assert.deepEqual(inputContents(f),before);
});
function sameIdentity(actual,source){const result=Object.create(Object.getPrototypeOf(actual));return Object.assign(result,actual,{dev:source.dev,ino:source.ino});}
test('simulated ordinary directory aliases are caught by file identity instead of only path prefixes',t=>{
  const f=fixture(t),alias=path.join(f.root,'ordinary-alias');fs.mkdirSync(alias);const lstat=fs.lstatSync,identity=lstat(f.options.frontendRoot,{bigint:true});
  fs.lstatSync=(file,...args)=>{const stat=lstat(file,...args);return file===alias?sameIdentity(stat,identity):stat;};try{assert.throws(()=>prepareWorkbenchBuildPaths({...f.options,outputRoot:path.join(alias,'new')}),/input directory identity/);}finally{fs.lstatSync=lstat;}assert.equal(fs.existsSync(path.join(alias,'new')),false);
});
test('simulated workspace aliases still protect data and source children',t=>{
  const f=fixture(t),alias=path.join(f.root,'workspace-alias');fs.mkdirSync(alias);const lstat=fs.lstatSync,identity=lstat(f.options.workspace,{bigint:true});
  fs.lstatSync=(file,...args)=>{const stat=lstat(file,...args);return file===alias?sameIdentity(stat,identity):stat;};try{for(const name of['.data','scripts'])assert.throws(()=>prepareWorkbenchBuildPaths({...f.options,outputRoot:path.join(alias,name,'new')}),/workspace source/);}finally{fs.lstatSync=lstat;}assert.deepEqual(fs.readdirSync(alias),[]);
});
test('an unavailable directory file identity is not downgraded to path-only proof',t=>{
  const f=fixture(t),lstat=fs.lstatSync;fs.lstatSync=(file,...args)=>{const stat=lstat(file,...args);return file===f.options.frontendRoot?Object.assign(Object.create(Object.getPrototypeOf(stat)),stat,{ino:0n}):stat;};try{assert.throws(()=>prepareWorkbenchBuildPaths(f.options),/identity is unavailable/);}finally{fs.lstatSync=lstat;}assert.equal(fs.existsSync(path.join(f.root,'output')),false);
});
test('late-observed control and executable input directories also exclude nested output',t=>{
  const f=fixture(t),input=path.join(f.root,'additional-input');fs.mkdirSync(input);const admission=prepareWorkbenchBuildPaths({...f.options,outputRoot:path.join(input,'new')});assert.throws(()=>admission.observeInputDirectory(input),/overlaps an observed input/);assert.equal(fs.existsSync(path.join(input,'new')),false);
});
test('late-observed script parent junctions are rejected and ordinary parents remain identity-bound',t=>{
  const f=fixture(t),scripts=path.join(f.options.workspace,'scripts'),aside=path.join(f.options.workspace,'scripts-original');fs.mkdirSync(scripts);const admission=prepareWorkbenchBuildPaths(f.options);admission.observeInputDirectory(scripts);assert.equal(path.dirname(scripts),f.options.workspace);assert.equal(path.dirname(aside),f.options.workspace);fs.renameSync(scripts,aside);fs.symlinkSync(aside,scripts,'junction');try{assert.throws(()=>admission.recheck(),/links, junctions/);assert.throws(()=>admission.observeInputDirectory(scripts),/links, junctions/);}finally{fs.unlinkSync(scripts);}assert.equal(fs.existsSync(path.join(f.root,'output')),false);
});
const args=['--frontend-root','front','--backend-root','back','--node-material','node','--output-root','out'];
test('bundle CLI requires exactly four unique complete path arguments',()=>{
  for(const invalid of[[],args.slice(0,-1),args.slice(0,-2),args.concat('--output-root','other'),['--bad','front',...args.slice(2)],['--frontend-root','front','--frontend-root','back',...args.slice(4)],['--frontend-root','--backend-root',...args.slice(2)],args.map(value=>value==='out'?' ':value)])assert.throws(()=>parseWorkbenchBundleArguments(invalid));
});
test('bundle CLI preserves spelling for filesystem admission instead of hiding drive-relative ambiguity',()=>{
  assert.deepEqual(parseWorkbenchBundleArguments(args),{frontendRoot:'front',backendRoot:'back',nodeSourceMaterial:'node',outputRoot:'out'});assert.equal(parseWorkbenchBundleArguments(args.map(value=>value==='out'?'D:relative':value)).outputRoot,'D:relative');
});
