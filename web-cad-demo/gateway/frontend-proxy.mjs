import http from 'node:http';
import https from 'node:https';
const hopByHop=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
export function localGateway(value){
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/api'||url.search||url.hash)throw Error('几何后台必须是无凭据的本机 HTTP(S) /api 地址。');
  return url;
}
function headersWithoutHops(input){
  const remove=new Set([...hopByHop,...String(input.connection||'').toLowerCase().split(',').map(name=>name.trim())]);
  return Object.fromEntries(Object.entries(input).filter(([name])=>!remove.has(name.toLowerCase())));
}
function unavailable(response){
  if(response.destroyed)return;
  if(response.headersSent){response.destroy();return;}
  response.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  response.end(JSON.stringify({ok:false,code:'FRONTEND_GATEWAY_UNAVAILABLE',error:'几何后台连接暂不可用。没有重发请求；若刚提交建模操作，请核对工程或任务记录。',recoverable:false}));
}
/** Streaming, backpressure-aware bridge. A disconnected mutation is never retried. */
export function proxyGeometry(request,response,gateway,{connectTimeoutMs=10000}={}){
  const incoming=new URL(request.url,'http://frontend');
  if(incoming.pathname!=='/api'&&!incoming.pathname.startsWith('/api/')){response.writeHead(400);response.end();return;}
  const target=new URL(incoming.pathname+incoming.search,gateway.origin),headers=headersWithoutHops(request.headers);
  headers.host=target.host;delete headers['x-forwarded-host'];delete headers['x-forwarded-proto'];delete headers['x-forwarded-for'];
  const upstream=(target.protocol==='https:'?https:http).request(target,{method:request.method,headers,agent:false},reply=>{
    clearTimeout(timer);
    response.writeHead(reply.statusCode||502,headersWithoutHops(reply.headers));reply.on('error',()=>response.destroy());reply.pipe(response);
  });
  const timer=setTimeout(()=>upstream.destroy(Error('Gateway connection timeout')),connectTimeoutMs);
  upstream.on('socket',socket=>{socket.setTimeout(0);if(!socket.connecting)clearTimeout(timer);else socket.once(target.protocol==='https:'?'secureConnect':'connect',()=>clearTimeout(timer));});
  upstream.once('error',()=>{clearTimeout(timer);unavailable(response);});
  request.once('aborted',()=>upstream.destroy());
  response.once('close',()=>{if(!response.writableFinished)upstream.destroy();});
  request.pipe(upstream);return upstream;
}
