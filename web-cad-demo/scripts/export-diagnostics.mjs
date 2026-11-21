import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {collectDiagnostics,writeDiagnosticReport,DiagnosticError} from '../gateway/diagnostic-report.mjs';

export function diagnosticArguments(args){
  const options={},seen=new Set();
  for(let index=0;index<args.length;index++){
    const key=args[index];if(seen.has(key)||!['--frontend','--gateway','--offline','--timeout-ms'].includes(key))throw new DiagnosticError('DIAGNOSTIC_ARGUMENTS_INVALID');seen.add(key);
    if(key==='--offline'){options.offline=true;continue;}
    const value=args[++index];if(!value||value.startsWith('--'))throw new DiagnosticError('DIAGNOSTIC_ARGUMENTS_INVALID');
    if(key==='--timeout-ms'){if(!/^\d{3,4}$/.test(value)||Number(value)<100||Number(value)>5000)throw new DiagnosticError('DIAGNOSTIC_ARGUMENTS_INVALID');options.timeoutMs=Number(value);}
    else options[key==='--frontend'?'frontend':'gateway']=value;
  }
  return options;
}
async function main(){
  try{
    const workspace=path.resolve(import.meta.dirname,'..'),options=diagnosticArguments(process.argv.slice(2)),report=await collectDiagnostics({workspace,...options}),file=writeDiagnosticReport(workspace,report);
    console.log(JSON.stringify({ok:true,format:report.format,reportId:report.reportId,file:path.relative(workspace,file).replaceAll('\\','/'),findings:report.findings.map(item=>item.code),servicesModified:false}));
  }catch(error){console.error(JSON.stringify({ok:false,code:error instanceof DiagnosticError?error.code:'DIAGNOSTIC_EXPORT_FAILED',error:'诊断导出未完成。未启动、停止或重试任何服务操作，未输出原始错误或配置内容。'}));process.exitCode=1;}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)await main();
