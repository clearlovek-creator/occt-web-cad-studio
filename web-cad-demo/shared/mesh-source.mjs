const identityPattern = /^[a-f0-9]{32}$/;
const bodyId = body => body.bodyId || body.id;

/** The exact input set, not the document's potentially reused revision number. */
export function captureMeshSource(view, documentId = view?.documentId) {
  const bodies = view?.bodyMetadata || view?.bodies;
  if (view?.ok === false || !documentId || !Array.isArray(bodies)) throw new Error("无法读取可验证的网格几何来源。");
  if (Number.isSafeInteger(view.bodyCount) && view.bodyCount!==bodies.length) throw new Error("几何来源的 Body 清单不完整。");
  const source = bodies.map(body => ({ bodyId: bodyId(body), kind: body.kind || "shape",
    bodyIdentity: body.bodyIdentity, topologyIdentity: body.topologyIdentity, topologyRevision: body.topologyRevision }));
  if (new Set(source.map(body => body.bodyId)).size !== source.length || source.some(body => !body.bodyId
      || !identityPattern.test(body.bodyIdentity || "") || !identityPattern.test(body.topologyIdentity || "")
      || !Number.isSafeInteger(body.topologyRevision) || body.topologyRevision < 0))
    throw new Error("几何来源缺少完整的持久身份，请升级几何服务后重新剖分。");
  return {version:1,documentId,revision:Number.isSafeInteger(view.revision)?view.revision:null,
    bodies:source.sort((a,b)=>a.bodyId.localeCompare(b.bodyId))};
}

export function assessMeshSource(source, view, documentId = view?.documentId) {
  const result = (status, reason, changedBodyIds = []) => ({status,reason,changedBodyIds});
  if (!source || source.version !== 1 || !Array.isArray(source.bodies) || !source.bodies.length)
    return result("unverified","网格缺少持久几何来源，不能仅凭修订号确认有效，请重新剖分。");
  try { captureMeshSource({bodyMetadata:source.bodies},source.documentId); }
  catch { return result("unverified","网格的来源身份不完整，请重新剖分。"); }
  if (!documentId || source.documentId !== documentId) return result("stale","网格属于另一个工程。");
  let current;
  try { current=captureMeshSource(view,documentId); }
  catch { return result("unverified","当前几何身份尚不可验证，网格保持隐藏。"); }
  const old = new Map(source.bodies.map(body=>[body.bodyId,body]));
  const live = new Map(current.bodies.map(body=>[body.bodyId,body]));
  const changed = new Set();
  for (const [id,body] of old) {
    const next=live.get(id);
    if (!next || next.bodyIdentity!==body.bodyIdentity || next.topologyIdentity!==body.topologyIdentity
        || next.topologyRevision!==body.topologyRevision || next.kind!==body.kind) changed.add(id);
  }
  for (const id of live.keys()) if (!old.has(id)) changed.add(id);
  return changed.size ? result("stale","几何或完整 Body 集合已变化，旧网格不适用于当前工程，请重新剖分。",[...changed].sort())
    : result("current","几何身份与剖分输入一致。");
}

export function qualifyMeshGroups(groups, source) {
  const bodies=new Map(source.bodies.map(body=>[body.bodyId,body]));
  return groups.map(group=>{
    const body=bodies.get(group.bodyId);
    if (!body) throw new Error(`网格组 ${group.groupId || ""} 没有可验证的来源 Body。`);
    return {...group,bodyIdentity:body.bodyIdentity,topologyIdentity:body.topologyIdentity,
      ...(Array.isArray(group.faces)?{faces:qualifyMeshGroups(group.faces,source)}:{})};
  });
}
