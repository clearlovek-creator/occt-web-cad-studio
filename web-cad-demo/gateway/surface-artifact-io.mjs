const temporaryIO=new Set(['EACCES','EPERM','ENOSPC','EDQUOT','EMFILE','ENFILE','EBUSY','EIO','EROFS']);
/** A storage refusal is not evidence that saved surface geometry is corrupt. */
export function surfaceArtifactIO(error,job){
  return ['surface-reconstruction','discrete-tetra'].includes(job?.kind)&&temporaryIO.has(error?.code)?{code:'MESH_ARTIFACT_IO',error:'离散任务材料暂时无法读取或保存，原文件保留；请检查文件占用、磁盘空间和访问权限后重新读取。'}:null;
}
