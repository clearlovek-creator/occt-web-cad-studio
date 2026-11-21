import {CadMcpProcessClient,McpProcessError} from './cad-mcp-process-client.mjs';

function catalog(value){
  if(!Array.isArray(value)||!value.length||value.length>256)throw new McpProcessError('MCP_CATALOG_INVALID','CAD 工具目录数量无效。');
  const names=new Set();
  for(const tool of value){if(!tool||typeof tool.name!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(tool.name)||names.has(tool.name)||tool.inputSchema?.type!=='object')throw new McpProcessError('MCP_CATALOG_INVALID','CAD 工具目录损坏或名称重复，未注册部分目录。');names.add(tool.name);}
  return value;
}
export default function cadMcpExtension(pi,{clientFactory=options=>new CadMcpProcessClient(options)}={}){
  const configuration={serverPath:process.env.CAD_MCP_SERVER_PATH,apiRoot:process.env.CAD_GEOMETRY_API_URL,documentId:process.env.CAD_DOCUMENT_ID,onDiagnostic:message=>pi.logger?.debug?.(message)};
  // Pi's AgentToolResult does not consume MCP's top-level isError. Use the
  // native result hook, and trust only details objects created by this adapter.
  const failedResults=new WeakSet();
  const markFailure=details=>{failedResults.add(details);return details;};
  pi.on('tool_result',event=>{
    if(event.details&&typeof event.details==='object'&&failedResults.has(event.details))return {isError:true,content:event.content,details:event.details,usage:event.usage};
  });
  let client,started,stopping,recovering,epoch=0;
  const connect=async owner=>{
    const previous=client;if(previous){await previous.stop();if(client===previous)client=undefined;}
    if(owner!==epoch)throw new McpProcessError('MCP_SESSION_CHANGED','工具会话已变化，未启动替代进程。');
    const owned=clientFactory(configuration);client=owned;
    try{
      const initialized=await owned.request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'web-cad-pi-extension',version:'1.0.0'}},{readOnly:true,timeoutMs:30000});
      if(owner!==epoch)throw new McpProcessError('MCP_SESSION_CHANGED','工具启动已取消。');
      if(!initialized?.capabilities?.tools)throw new McpProcessError('MCP_HANDSHAKE_INVALID','CAD MCP 未声明工具能力。');
      owned.notify('notifications/initialized');
      const listed=await owned.request('tools/list',{}, {readOnly:true,timeoutMs:30000}),tools=catalog(listed.tools);
      if(owner!==epoch)throw new McpProcessError('MCP_SESSION_CHANGED','工具目录已过期。');
      return {owned,tools};
    }catch(error){await owned.stop();if(client===owned)client=undefined;throw error;}
  };
  const start=()=>{
    if(started)return started;
    const owner=++epoch;
    const running=(async()=>{
      if(stopping)await stopping;
      const {tools}=await connect(owner);
        for(const tool of tools){
          const readOnly=tool.name==='query_model'||tool.annotations?.readOnlyHint===true;
          pi.registerTool({name:tool.name,label:tool.name,description:tool.description||`Call CAD tool ${tool.name}`,promptSnippet:`Use ${tool.name} for CAD document operations.`,parameters:tool.inputSchema,executionMode:'sequential',
            async execute(_toolCallId,params,signal,onUpdate){
              let active=client;
              try{
                if(owner!==epoch)throw new McpProcessError('MCP_SESSION_CHANGED','旧会话工具调用已失效，未启动进程或发送命令。');
                if(readOnly&&(!active||active.status().state!=='open')){
                  if(!recovering){const recovery=connect(owner);recovering=recovery;void recovery.finally(()=>{if(recovering===recovery)recovering=undefined;}).catch(()=>{});}
                  active=(await recovering).owned;
                }
                if(owner!==epoch)throw new McpProcessError('MCP_SESSION_CHANGED','会话已变化，未发送迟到工具请求。');
                if(!active)throw new McpProcessError('MCP_NOT_RUNNING','CAD 工具连接尚未就绪。');
                const result=await active.request('tools/call',{name:tool.name,arguments:params||{}},{signal,readOnly,onProgress:message=>onUpdate?.({content:[{type:'text',text:message}],details:{mcpTool:tool.name,outcome:'pending'}})});
                if(!result||typeof result!=='object'||!Array.isArray(result.content)||!result.content.length||result.content.length>64)throw new McpProcessError('MCP_TOOL_RESULT_INVALID','工具回复格式无效，操作结果需查询核对。',{outcome:readOnly?'unchanged':'unknown'});
                if(result.isError&&!readOnly)active.requireReconciliation();
                if(tool.name==='query_model'&&!result?.isError){
                  try{const query=JSON.parse(result.content?.find(part=>part.type==='text')?.text||'null');if(/^[a-f0-9]{64}$/.test(query?.stateToken||'')&&Number.isInteger(query?.revision))active.confirmReconciled();}catch{/* A malformed observation must not unlock writes. */}
                }
                const details={mcpTool:tool.name,cancelRequested:Boolean(signal?.aborted)};
                return {content:Array.isArray(result?.content)?result.content:[{type:'text',text:JSON.stringify(result)}],isError:Boolean(result?.isError),details:result.isError?markFailure(details):details};
              }catch(error){
                if(!readOnly&&error.outcome==='unknown')active?.requireReconciliation();
                if(active?.status().state==='failed')void active.stop().catch(()=>{});
                const outcome=error.outcome||(!readOnly?'unknown':'unchanged');
                return {content:[{type:'text',text:JSON.stringify({ok:false,code:error.code||'MCP_TRANSPORT_ERROR',error:error instanceof McpProcessError?error.message:'CAD 工具连接失败，请核对工程；未自动重发。',outcome,retryableByModel:false})}],isError:true,details:markFailure({mcpTool:tool.name,outcome})};
              }
            }
          });
        }
        pi.logger?.info?.(`Connected CAD MCP server; registered ${tools.length} tools.`);
    })().catch(error=>{if(started===running)started=undefined;throw error;});started=running;return running;
  };
  pi.on('session_start',start);
  pi.on('session_shutdown',()=>{
    if(stopping)return stopping;
    epoch++;
    const startup=started;started=undefined;
    const owned=client,retired=owned?.stop();
    retired?.catch(()=>{});
    stopping=(async()=>{if(startup)await startup.catch(()=>{});if(recovering)await recovering.catch(()=>{});if(retired)await retired;if(client===owned)client=undefined;})();// Keep the owned reference until both process and stream closure are verified.
    return stopping.finally(()=>{stopping=undefined;});
  });
}
