/** Test-only static module loader for trusted repository TypeScript. Resolve the
 * real import graph instead of maintaining regex replacements for each test. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import ts from 'typescript';
const cache=new Map(),building=new Set();
function moduleUrl(file){
  file=path.resolve(file);if(cache.has(file))return cache.get(file);
  if(building.has(file))throw Error('Test TypeScript loader does not support a runtime cycle: '+file);
  building.add(file);
  try{
    const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{fileName:file,compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
    const resolve=name=>{
      if(!name.startsWith('.')&&!name.startsWith('/'))return name.startsWith('node:')?name:import.meta.resolve(name);
      const candidate=path.resolve(path.dirname(file),name),resolved=[candidate,candidate+'.ts',candidate+'.tsx',candidate+'.mjs',candidate+'.js'].find(file=>fs.existsSync(file)&&fs.statSync(file).isFile());
      if(!resolved)throw Error('Missing trusted test import: '+candidate);
      return /\.tsx?$/.test(resolved)?moduleUrl(resolved):pathToFileURL(resolved).href;
    };
    const source=ts.createSourceFile(file,code,ts.ScriptTarget.ES2022,true,ts.ScriptKind.JS);
    const result=ts.transform(source,[context=>root=>{
      const visit=node=>{
        if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier))return ts.factory.updateImportDeclaration(node,node.modifiers,node.importClause,ts.factory.createStringLiteral(resolve(node.moduleSpecifier.text)),node.attributes);
        if(ts.isExportDeclaration(node)&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))return ts.factory.updateExportDeclaration(node,node.modifiers,node.isTypeOnly,node.exportClause,ts.factory.createStringLiteral(resolve(node.moduleSpecifier.text)),node.attributes);
        return ts.visitEachChild(node,visit,context);
      };return ts.visitNode(root,visit);
    }]);
    try{const url='data:text/javascript;base64,'+Buffer.from(ts.createPrinter().printFile(result.transformed[0])).toString('base64');cache.set(file,url);return url;}finally{result.dispose();}
  }finally{building.delete(file);}
}
export function importTestTypeScript(relative,base){return import(moduleUrl(fileURLToPath(new URL(relative,base))));}
