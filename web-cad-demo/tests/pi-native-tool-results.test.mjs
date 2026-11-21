import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {tsImport} from '../../pi/node_modules/tsx/dist/esm/api/index.mjs';
import extension from '../gateway/pi-cad-mcp-extension.mjs';
// Use the same source SDK and loader as server.mjs's default Pi CLI, not a
// different checkout with an equal version number or a stale compiled bundle.
const loader={parentURL:import.meta.url,tsconfig:fileURLToPath(new URL('../../pi/tsconfig.json',import.meta.url))};
const {agentLoop}=await tsImport('../../pi/packages/agent/src/agent-loop.ts',loader);
const {EventStream}=await tsImport('../../pi/packages/ai/src/utils/event-stream.ts',loader);

test('actual Pi agent loop records an MCP failure as a native error and gives it back to the next model turn',async()=>{
  const handlers=new Map(),tools=[];
  const receipt={ok:false,code:'INVALID_GEOMETRY',error:'Box width must be positive',outcome:'not-started'};
  const client={
    status:()=>({state:'open'}),notify(){},requireReconciliation(){},async stop(){},
    async request(method){
      if(method==='initialize')return {capabilities:{tools:{}}};
      if(method==='tools/list')return {tools:[{name:'primitive__box',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};
      return {isError:true,content:[{type:'text',text:JSON.stringify(receipt)}]};
    },
  };
  extension({on:(name,handler)=>handlers.set(name,handler),registerTool:tool=>tools.push(tool)},{clientFactory:()=>client});
  await handlers.get('session_start')();
  const model={id:'offline-fixture',name:'Offline fixture',api:'openai-responses',provider:'fixture',baseUrl:'https://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:8192,maxTokens:1024};
  const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
  let turns=0,secondContext;
  const streamFn=(_model,context)=>{
    const stream=new EventStream(event=>event.type==='done',event=>event.message);
    const first=turns++===0;if(!first)secondContext=context;
    const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,usage,timestamp:Date.now(),stopReason:first?'toolUse':'stop',content:first?[{type:'toolCall',id:'native-cad-failure',name:'primitive__box',arguments:{}}]:[{type:'text',text:'The CAD operation failed; do not claim success.'}]};
    queueMicrotask(()=>stream.push({type:'done',reason:message.stopReason,message}));return stream;
  };
  try{
    const events=[],stream=agentLoop([{role:'user',content:'Create a box',timestamp:Date.now()}],{systemPrompt:'',messages:[],tools},{model,convertToLlm:messages=>messages,
      // This is Pi AgentSession's native tool_result extension bridge.
      afterToolCall:({toolCall,args,result,isError})=>handlers.get('tool_result')({type:'tool_result',toolName:toolCall.name,toolCallId:toolCall.id,input:args,...result,isError}),
    },undefined,streamFn);
    for await(const event of stream)events.push(event);
    const end=events.find(event=>event.type==='tool_execution_end');assert.equal(end.isError,true);
    const result=(await stream.result()).find(message=>message.role==='toolResult');assert.equal(result.isError,true);assert.deepEqual(JSON.parse(result.content[0].text),receipt);
    assert.equal(secondContext.messages.find(message=>message.role==='toolResult').isError,true);
    assert.equal(turns,2,'No hidden model retries or extra plan/edit loop');
  }finally{await handlers.get('session_shutdown')();}
});
