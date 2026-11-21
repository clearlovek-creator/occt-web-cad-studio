import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const types={'.js':'application/javascript; charset=utf-8','.mjs':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.json':'application/json; charset=utf-8'};

/** Serve only certified client files. URL separators never depend on Windows paths. */
export function createAssetHandler(release){
  const assets=new Map();let invalid=false;
  const same=(a,b)=>['dev','ino','size','nlink','mtimeNs','ctimeNs'].every(key=>a[key]===b[key]);
  for(const item of release.files){
    if(!item.file.startsWith('dist/client/'))continue;
    const relative=item.file.slice('dist/client/'.length);
    if(relative.split('/').some(part=>part.startsWith('.'))||['_headers','_redirects'].includes(relative))continue;
    const file=path.join(release.directory,'dist','client',relative),stat=fs.lstatSync(file,{bigint:true});
    assets.set('/'+relative,{...item,path:file,identity:stat});
  }
  const verifiedBytes=asset=>{
    if(invalid)return null;let fd;
    try{
      if(!Number.isSafeInteger(asset.bytes)||asset.bytes<0||asset.bytes>32*1024*1024)throw Error('Asset byte budget');
      const before=fs.lstatSync(asset.path,{bigint:true});
      if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size!==BigInt(asset.bytes)||!same(before,asset.identity))throw Error('Asset identity changed');
      fd=fs.openSync(asset.path,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));const opened=fs.fstatSync(fd,{bigint:true});
      if(!opened.isFile()||!same(before,opened))throw Error('Asset open changed');
      const bytes=Buffer.allocUnsafe(asset.bytes);let offset=0;
      while(offset<bytes.length){const count=fs.readSync(fd,bytes,offset,Math.min(65536,bytes.length-offset),offset);if(!count)throw Error('Asset shortened');offset+=count;}
      if(createHash('sha256').update(bytes).digest('hex')!==asset.sha256||!same(opened,fs.fstatSync(fd,{bigint:true}))||!same(opened,fs.lstatSync(asset.path,{bigint:true})))throw Error('Asset content changed');
      return bytes;
    }catch{invalid=true;return null;}finally{if(fd!==undefined)fs.closeSync(fd);}
  };
  const handler=(request,response)=>{
    const notPublic=()=>{response.writeHead(404,{'Cache-Control':'no-store'});response.end();return true;};
    let pathname;try{pathname=decodeURIComponent(new URL(request.url,'http://frontend').pathname);}catch{return notPublic();}
    if(pathname.includes('\\')||pathname.split('/').some(part=>part.startsWith('.'))||/%(?:2f|5c)/i.test(request.url))return notPublic();
    // Never let the framework's own static fallback bypass this manifest boundary.
    // Its behavior differs across Windows/POSIX paths and versions.
    if(/^\/(?:runtime|node_modules|dist)(?:\/|$)/.test(pathname)||['/_headers','/_redirects'].includes(pathname))return notPublic();
    const asset=assets.get(pathname);if(!asset)return /^\/assets(?:\/|$)/.test(pathname)?notPublic():false;
    if(!['GET','HEAD'].includes(request.method)){response.writeHead(405,{Allow:'GET, HEAD'});response.end();return true;}
    const bytes=verifiedBytes(asset);
    if(!bytes){
      response.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});response.end(JSON.stringify({ok:false,code:'FRONTEND_ASSET_CHANGED',error:'当前发布资源缺失或已改变，请核对发布版本；未使用变更后的资源。'}));return true;
    }
    const etag='"'+asset.sha256+'"',headers={'Content-Type':types[path.extname(pathname)]||'application/octet-stream','Content-Length':asset.bytes,'Cache-Control':pathname.startsWith('/assets/')?'public, max-age=31536000, immutable':'public, max-age=3600',ETag:etag,'X-Content-Type-Options':'nosniff'};
    if(String(request.headers['if-none-match']||'').split(',').map(value=>value.trim()).some(value=>value===etag||value==='*')){response.writeHead(304,{ETag:etag,'Cache-Control':headers['Cache-Control']});response.end();return true;}
    // Reply with this exact verified snapshot, never reopen the path after hashing.
    response.writeHead(200,headers);if(request.method==='HEAD')response.end();else response.end(bytes);return true;
  };
  handler.healthy=()=>!invalid&&[...assets.values()].every(asset=>verifiedBytes(asset)!==null);return handler;
}
