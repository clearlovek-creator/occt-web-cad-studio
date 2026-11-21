import fs from 'node:fs';
import path from 'node:path';
import {hashFile} from '../gateway/frontend-release.mjs';

// Dependency SDKs contain more files than a frontend release. Keep a separate,
// bounded inventory rather than weakening the shipping frontend limits.
export function dependencyHeaderInventory(directory,{maxFiles=40000,maxBytes=1024**3,maxFileBytes=16*1024**2,maxDirectories=10000,maxDepth=64}={}){
  for(const value of [maxFiles,maxBytes,maxFileBytes,maxDirectories,maxDepth])if(!Number.isSafeInteger(value)||value<1)throw new TypeError('Header inventory limits must be positive safe integers.');
  const files=[];let total=0,directories=0;
  function walk(folder,depth){
    const stat=fs.lstatSync(folder);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Header inventory refuses non-regular directories.');
    if(depth>maxDepth||++directories>maxDirectories)throw Error('Header directory inventory budget exceeded.');
    for(const entry of fs.readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
      const file=path.join(folder,entry.name),before=fs.lstatSync(file);
      if(before.isSymbolicLink())throw Error('Header inventory refuses links.');
      if(before.isDirectory()){walk(file,depth+1);continue;}
      if(!before.isFile()||before.nlink!==1)throw Error('Header inventory refuses non-regular files.');
      total+=before.size;
      if(files.length>=maxFiles||total>maxBytes||before.size>maxFileBytes)throw Error('Header file inventory budget exceeded.');
      const sha256=hashFile(file),after=fs.lstatSync(file);
      if(!after.isFile()||after.isSymbolicLink()||after.nlink!==1||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error('Header changed during inventory.');
      files.push({file:path.relative(directory,file).replaceAll('\\','/'),bytes:before.size,sha256});
    }
  }
  walk(directory,0);return files;
}
