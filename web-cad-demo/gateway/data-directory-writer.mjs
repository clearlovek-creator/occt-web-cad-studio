import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';

export class DataDirectoryWriterError extends Error {
  constructor(code,message){super(message);this.name='DataDirectoryWriterError';this.code=code;}
}
/** Lifetime lock is held by real OS handles inside this Gateway, not by a child
 * process, PID/heartbeat lease, or the mere existence of a marker file. */
export function acquireDataDirectoryWriter(directory,{helperPath=path.resolve(import.meta.dirname,'../geometry-worker/build/cad_data_directory_lock.exe')}={}){
  if(process.platform!=='win32')throw new DataDirectoryWriterError('DATA_DIRECTORY_PLATFORM_UNSUPPORTED','当前平台没有已验证的工程目录写入锁实现，已停止后台启动。');
  const canonical=fs.realpathSync.native(path.resolve(directory));
  if(!fs.existsSync(helperPath))throw new DataDirectoryWriterError('DATA_DIRECTORY_LOCK_UNAVAILABLE','缺少工程数据目录锁组件，请先运行 npm run build:worker，再启动后台。');
  const instanceId=randomUUID(),started=performance.now();
  const systemRoot=process.env.SystemRoot||process.env.SYSTEMROOT||'C:\\Windows';
  const child=spawnSync(helperPath,[canonical,String(process.pid),instanceId],{cwd:path.dirname(helperPath),env:{SystemRoot:systemRoot,WINDIR:systemRoot,PATH:path.join(systemRoot,'System32')},windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:8192});
  let result;try{result=JSON.parse(child.stdout||'null');}catch{/* Fail closed on malformed helper output. */}
  if(child.error||child.status!==0||!result?.ok){
    const code=typeof result?.code==='string'?result.code:'DATA_DIRECTORY_LOCK_FAILED';
    const message=code==='DATA_DIRECTORY_IN_USE'?'工程数据目录正在被另一个后台使用。换端口也不能重复启动；请保留现有服务，不要删除锁文件。':code==='DATA_DIRECTORY_FILESYSTEM_UNSUPPORTED'?'工程数据目录必须位于本机固定磁盘的 NTFS/ReFS 文件系统；共享盘、网络路径和未验证文件系统已拒绝写入启动。':'无法建立工程数据目录唯一写入保护，已停止启动。请检查目录权限与锁组件。';
    throw new DataDirectoryWriterError(code,message);
  }
  if(result.pid!==process.pid||result.instanceId!==instanceId||result.format!=='web-cad-writer-lock'||result.version!==1||result.mechanism!=='windows-kernel-file-sharing')throw new DataDirectoryWriterError('DATA_DIRECTORY_LOCK_PROTOCOL','工程目录锁身份核对失败，必须终止本次后台进程。');
  const lease=Object.freeze({version:1,ownerPid:process.pid,instanceId,processCreationFileTime:result.processCreationFileTime,mechanism:result.mechanism,scope:'local-fixed-ntfs-or-refs',directoryIdentity:result.directoryIdentity,acquiredAt:new Date().toISOString(),acquireMs:performance.now()-started});
  return lease;
}
