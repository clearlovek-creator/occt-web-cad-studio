import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {selectRelease,validateRelease,releaseProductionServerPath} from '../gateway/frontend-release.mjs';
import {localGateway,proxyGeometry} from '../gateway/frontend-proxy.mjs';
import {createAssetHandler} from '../gateway/frontend-assets.mjs';

const workspace=process.cwd(),args=process.argv.slice(2);
function argument(name,fallback){const index=args.indexOf(name);return index>=0?args[index+1]:fallback;}
let running;
try{
  const port=Number(argument('--port','3000'));if(!Number.isInteger(port)||port<1024||port>65535)throw Error('前端端口必须在 1024 到 65535 之间。');
  const gateway=localGateway(argument('--gateway-api','http://127.0.0.1:8788/api'));
  const supplied=argument('--release'),release=supplied?validateRelease(path.resolve(supplied),workspace):selectRelease(path.join(workspace,'.releases'),workspace);
  process.env.NODE_ENV='production';
  const {startProdServer}=await import(pathToFileURL(releaseProductionServerPath(release,workspace)).href);
  running=await startProdServer({port,host:'127.0.0.1',outDir:path.join(release.directory,'dist')});
  const {server}=running,listeners=server.listeners('request');
  if(listeners.length!==1)throw Error('生产 HTTP 运行器协议发生变化，未启用不兼容的请求桥接。');
  server.removeListener('request',listeners[0]);
  const instanceId=crypto.randomUUID(),serveAsset=createAssetHandler(release);let ready=false;
  server.on('request',(request,response)=>{
    let url;try{url=new URL(request.url,'http://frontend');}catch{response.writeHead(400);response.end();return;}
    const allowed=new Set([`localhost:${port}`,`127.0.0.1:${port}`,`[::1]:${port}`]);
    if(!allowed.has(String(request.headers.host||'').toLowerCase())){response.writeHead(400);response.end('Invalid local host');return;}
    if(url.pathname==='/__cad/health'){
      const clientAssetsValid=serveAsset.healthy();response.writeHead(ready&&clientAssetsValid?200:503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      response.end(JSON.stringify({ok:ready&&clientAssetsValid,format:'web-cad-frontend',version:1,mode:'Production',ownerPid:process.pid,instanceId,releaseId:release.releaseId,builtAt:release.builtAt,apiMode:'same-origin',gatewayApi:gateway.href,clientAssetsValid,...(!clientAssetsValid?{code:'FRONTEND_ASSET_CHANGED'}:{})}));return;
    }
    if(url.pathname==='/api'||url.pathname.startsWith('/api/')){
      if(!ready){response.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify({ok:false,code:'SERVICE_STARTING',error:'前端发布版本仍在核验，尚未转发新的工程请求。'}));return;}
      if(request.headers.origin&&!['http://localhost:'+port,'http://127.0.0.1:'+port,'http://[::1]:'+port].includes(request.headers.origin)){response.writeHead(403,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify({ok:false,code:'FRONTEND_ORIGIN_NOT_ALLOWED',error:'不允许从其他站点操作本机几何后台。',recoverable:false}));return;}
      proxyGeometry(request,response,gateway);return;
    }
    if(serveAsset(request,response))return;
    listeners[0](request,response);
  });
  const probe=await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(10000)});
  if(probe.status!==200||!(await probe.text()).includes('OCCT Web Studio'))throw Error('发布页面的实际渲染检查失败，前端未就绪；请检查当前版本的运行依赖和启动日志。');
  for(const file of release.files.filter(item=>/^dist\/client\/assets\/.*\.(js|css)$/.test(item.file))){const reply=await fetch(`http://127.0.0.1:${port}/`+file.file.slice('dist/client/'.length),{method:'HEAD',signal:AbortSignal.timeout(10000)});if(reply.status!==200||Number(reply.headers.get('content-length'))!==file.bytes)throw Error('发布资源的实际 HTTP 检查失败，前端未就绪。');}
  ready=true;
  console.log(JSON.stringify({type:'cad.frontend',phase:'ready',ownerPid:process.pid,instanceId,releaseId:release.releaseId,port}));
}catch(error){
  console.error(JSON.stringify({type:'cad.startup',phase:'blocked',code:error.code||'FRONTEND_START_FAILED',error:error.message}));
  running?.server.closeAllConnections();running?.server.close();process.exitCode=1;
}
