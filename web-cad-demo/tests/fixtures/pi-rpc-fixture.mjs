/* Deterministic native-RPC transport fixture. No LLM, no CAD mutation, test temp files only. */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {randomUUID} from 'node:crypto';
const args=process.argv.slice(2),directory=args[args.indexOf('--session-dir')+1];if(!directory)throw Error('Fixture requires a private session directory');fs.mkdirSync(directory,{recursive:true});
// Observe fixture crashes without swallowing or recovering them. This contains
// deterministic test data only, never a provider/API key or production session.
process.on('uncaughtExceptionMonitor',(error,origin)=>{try{fs.writeFileSync(path.join(directory,`fixture-failure-${process.pid}.json`),JSON.stringify({pid:process.pid,parentPid:process.ppid,origin,name:error.name,code:error.code||null,message:String(error.message).slice(0,4000)}));}catch{/* Preserve the original crash. */}});
const historyFile=path.join(directory,'fixture-history.json'),commandFile=path.join(directory,'fixture-commands.jsonl');
let messages=(args.includes('--continue')||args.includes('--session'))&&fs.existsSync(historyFile)?JSON.parse(fs.readFileSync(historyFile,'utf8')):[],streaming=false,race=false,clock=Date.now();const timers=new Set();
if(!fs.existsSync(path.join(directory,'fixture-session.jsonl')))fs.writeFileSync(path.join(directory,'fixture-session.jsonl'),JSON.stringify({type:'session',version:3,id:randomUUID(),timestamp:new Date().toISOString(),cwd:process.cwd()})+'\n');
const save=()=>{
  const temporary=historyFile+'.'+randomUUID()+'.tmp',bytes=JSON.stringify(messages);let fd;
  try{
    fd=fs.openSync(temporary,'wx');
    if(process.env.CAD_TEST_PI_FIXTURE_EXIT_BEFORE_RENAME==='1'){fs.writeFileSync(fd,bytes.slice(0,Math.max(1,Math.floor(bytes.length/2))));process.exit(86);}
    fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,historyFile);
  }finally{if(fd!==undefined)fs.closeSync(fd);fs.rmSync(temporary,{force:true});}
};
const output=value=>process.stdout.write(JSON.stringify(value)+'\n');
const event=value=>output(value);
const response=(command,data={})=>output({type:'response',id:command.id,success:true,data});
const later=(fn,ms)=>{const timer=setTimeout(()=>{timers.delete(timer);fn();},ms);timers.add(timer);};
function completeTool(message,progress=false,failed=false,large=false){
  const callId='fixture-call-'+(++clock),args={parameters:{width:12,depth:16,height:24}};
  message.content.push({type:'toolCall',id:callId,name:'primitive__box',arguments:args});event({type:'message_end',message});
  event({type:'tool_execution_start',toolCallId:callId,toolName:'primitive__box',args});
  const finish=()=>{
    const content=[{type:'text',text:JSON.stringify(failed?{ok:false,code:'MCP_CALL_TIMEOUT',outcome:'unknown',retryableByModel:false}:{ok:true,bodyId:'transport-fixture-only',revision:1,...(large?{payload:'LARGE_NATIVE_BEGIN'+('x'.repeat(5*1024*1024))+'LARGE_NATIVE_END'}:{})})}];
    event({type:'tool_execution_end',toolCallId:callId,toolName:'primitive__box',result:{content,isError:failed},isError:failed});
    const tool={role:'toolResult',toolCallId:callId,toolName:'primitive__box',timestamp:++clock,content,isError:failed};messages.push(tool);event({type:'message_end',message:tool});streaming=false;save();event({type:'agent_end'});
  };
  if(progress){
    for(const [index,text] of ['Progress snapshot one','Progress snapshot one and two'].entries())later(()=>event({type:'tool_execution_update',toolCallId:callId,toolName:'primitive__box',args,partialResult:{content:[{type:'text',text}]}}),(index+1)*200);
    later(finish,1800);
  }else finish();
}
async function handle(command){
  fs.appendFileSync(commandFile,JSON.stringify({type:command.type,...(command.type==='prompt'?{message:command.message}:{})})+'\n');
  if(command.type==='get_state')return response(command,{model:{id:'fixture',provider:'fixture',name:'RPC Fixture'},isStreaming:streaming,isCompacting:false,pendingMessageCount:0,thinkingLevel:'off'});
  if(command.type==='get_available_models')return response(command,{models:[{id:'fixture',provider:'fixture',name:'RPC Fixture'}]});
  if(command.type==='get_available_thinking_levels')return response(command,{levels:['off']});
  if(command.type==='get_messages'){
    const snapshot=structuredClone(messages);
    if(race){const overlap=race==='overlap';race=false;const text=overlap?'during snapshot reply':'after snapshot response',message={role:'assistant',timestamp:++clock,content:[{type:'text',text}]};messages.push(message);save();const reply=JSON.stringify({type:'response',id:command.id,success:true,data:{messages:snapshot}}),update=JSON.stringify({type:'message_update',message,assistantMessageEvent:{type:'text_delta',delta:text}});process.stdout.write((overlap?[update,reply]:[reply,update]).join('\n')+'\n');return;}
    return response(command,{messages:snapshot});
  }
  if(command.type==='get_entries')return response(command,{entries:messages.map((message,index)=>({type:'message',id:'entry-'+index,timestamp:message.timestamp}))});
  if(command.type==='new_session'){messages=[];streaming=false;save();return response(command);}
  if(command.type==='abort'){for(const timer of timers)clearTimeout(timer);timers.clear();streaming=false;save();event({type:'agent_end'});return response(command);}
  if(command.type!=='prompt')return response(command);
  if(command.message==='fixture:malformed-protocol'){process.stdout.write('INVALID_JSON_PRIVATE_KEY\n');return;}
  if(command.message==='fixture:arm-race'){race=true;response(command);return;}
  if(command.message==='fixture:arm-overlap'){race='overlap';response(command);return;}
  messages.push({role:'user',timestamp:++clock,content:[{type:'text',text:command.message}]});streaming=true;save();response(command);event({type:'agent_start'});
  if(command.message.includes('fixture:pending'))return;
  const message={role:'assistant',timestamp:++clock,content:[{type:'thinking',thinking:'Checking the RPC transport fixture.'},{type:'text',text:''}]};messages.push(message);event({type:'message_start',message});
  if(command.message.includes('fixture:burst')){for(let index=0;index<1200;index++){message.content[1].text='burst-'+index;event({type:'message_update',message,assistantMessageEvent:{type:'text_delta',delta:String(index)}});}save();streaming=false;event({type:'message_end',message});event({type:'agent_end'});return;}
  for(let index=1;index<=5;index++)later(()=>{message.content[1].text='Transport fixture phase '+index;save();event({type:'message_update',message,assistantMessageEvent:{type:'text_delta',delta:String(index)}});if(index===5)completeTool(message,command.message.includes('fixture:progress'),command.message.includes('fixture:failed-mutation'),command.message.includes('fixture:large-result'));},index*80);
}
const input=readline.createInterface({input:process.stdin});input.on('line',line=>{try{void handle(JSON.parse(line));}catch(error){process.stderr.write(error.message+'\n');}});input.on('close',()=>{for(const timer of timers)clearTimeout(timer);process.exit(0);});
