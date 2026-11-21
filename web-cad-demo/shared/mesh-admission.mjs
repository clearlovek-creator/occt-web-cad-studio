/** Engineering admission is distinct from successful execution and source freshness. */
export function meshAdmitted(report){return report?.version===1&&report.usable===true&&['accepted','warning'].includes(report.status);}
export function meshAdmissionLabel(report){return report?.status==='accepted'?'验收通过':report?.status==='warning'?'验收通过 · 有验收警告':report?.status==='blocked'?'验收未通过 · 仅供诊断':'尚未完成网格验收';}
export function qualityCellState(cell,index){
  const p=index.positions,at=index.positionAt||((n)=>p[n]);
  let invalid=cell.quality===null||cell.quality< -1||cell.quality>1||cell.minJacobian===null||cell.maxJacobian===null||cell.corners.some(n=>at(n*3)===null||at(n*3+1)===null||at(n*3+2)===null);
  invalid ||= cell.minJacobian!==null&&cell.maxJacobian!==null&&cell.minJacobian>cell.maxJacobian;
  const [a0,b0,c0,d0]=cell.corners;
  invalid ||= a0===b0||a0===c0||a0===d0||b0===c0||b0===d0||c0===d0;
  if(!invalid&&cell.order===1&&cell.minJacobian>0){
    const a=cell.corners[0]*3,b=cell.corners[1]*3,c=cell.corners[2]*3,d=cell.corners[3]*3;
    const u=[at(b)-at(a),at(b+1)-at(a+1),at(b+2)-at(a+2)],v=[at(c)-at(a),at(c+1)-at(a+1),at(c+2)-at(a+2)],w=[at(d)-at(a),at(d+1)-at(a+1),at(d+2)-at(a+2)];
    const scale=Math.max(...u.map(Math.abs),...v.map(Math.abs),...w.map(Math.abs));
    if(!Number.isFinite(scale)||scale===0)invalid=true;
    else{for(let i=0;i<3;i++){u[i]/=scale;v[i]/=scale;w[i]/=scale;}const determinant=u[0]*(v[1]*w[2]-v[2]*w[1])-u[1]*(v[0]*w[2]-v[2]*w[0])+u[2]*(v[0]*w[1]-v[1]*w[0]);if(!Number.isFinite(determinant)||determinant<=0)invalid=true;}
  }
  const inverted=cell.minJacobian!==null&&cell.minJacobian<0;
  const degenerate=!inverted&&cell.minJacobian!==null&&cell.maxJacobian!==null&&(cell.maxJacobian===0||cell.minJacobian<=Math.abs(cell.maxJacobian)*1e-12);
  return {invalid,inverted,degenerate};
}
