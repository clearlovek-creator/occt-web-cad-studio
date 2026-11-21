export const diagnosticSource={version:1,documentId:'diagnostic_fixture',revision:2,bodies:[{bodyId:'body-1',kind:'solid',bodyIdentity:'a'.repeat(32),topologyIdentity:'b'.repeat(32),topologyRevision:2}]};

export function diagnosticFixture(source=diagnosticSource) {
  const stage=basis=>({valid:true,geometryBasis:basis,faceCount:6,edgeCount:12,vertexCount:8,solidCount:1,
    issueCount:0,errorCount:0,warningCount:0,infoCount:0,selfIntersectionCount:0,smallEdgeCount:0,smallFaceCount:0,sliverFaceCount:0,openBoundaryEdgeCount:0,nonManifoldEdgeCount:0,
    bounds:{min:[0,0,0],max:[10,10,10]},maxTolerance:1e-7,minimumEdgeLength:10,minimumFaceArea:100,signedVolumeSum:1000,
    smallFeatureThreshold:1e-5,highToleranceThreshold:1e-4,selfIntersectionCheck:'not-run',issuesTruncated:false,issues:[]});
  return {diagnostics:{version:1,status:'ready',stage:'complete',repairMode:'conservative',tolerance:1e-8,deepCheck:false,
    bodies:source.bodies.map(body=>({bodyId:body.bodyId,name:body.bodyId,kind:body.kind,before:stage('source'),afterRepair:stage('prepared')})),afterPartition:stage('prepared')},
    preview:{positions:[0,0,0,10,0,0,0,10,0],normals:[0,0,1,0,0,1,0,0,1],indices:[0,1,2],edges:[{edgeId:'edge-2-1',points:[0,0,0,10,0,0]}],stats:{truncated:false,triangleCount:1,faceCount:6,edgeCount:12}}};
}
