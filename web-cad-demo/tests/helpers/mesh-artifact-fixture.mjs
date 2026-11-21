import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MeshJobStore } from '../../gateway/mesh-job-store.mjs';
import { admissionFixture } from './mesh-admission-fixture.mjs';
import { tetraStrip } from './tetra-strip.mjs';
/** Conforming corner connectivity for numeric/I/O pressure. The quality values,
 * CAD inventory and MSH text remain synthetic, not a CAD mesher certificate. */
export function createArtifactFixture(root, count = 10000) {
    const f = admissionFixture(), store = new MeshJobStore(root), job = { version: 1, jobId: 'mesh-' + crypto.randomUUID(), documentId: f.source.documentId, source: f.source, state: 'complete', createdAt: new Date().toISOString(), options: { repairMode: 'strict', qualityThreshold: .2 } };
    f.index.requestId = job.jobId;
    const cell = f.index.cells[0];
    const strip = tetraStrip(count, cell);
    for (let index=0;index<strip.cells.length;index++) strip.cells[index].elementId=String(BigInt(index)+9007199254740993n);
    Object.assign(f.index, { cells: strip.cells, positions: strip.positions });
    f.mesh.nodeCount=strip.positions.length/3;
    f.mesh.boundaryMapping.surfaces[0].elementCount=strip.boundaryFaceCount;
    Object.assign(f.mesh.quality, { tetraCount: count, finiteCount: count });
    f.mesh.elementCount = count;
    fs.mkdirSync(store.directory(job), { recursive: true });
    fs.mkdirSync(path.dirname(store.output(job)), { recursive: true });
    fs.writeFileSync(store.output(job), 'synthetic numeric pressure, not a physical MSH');
    fs.writeFileSync(store.qualityOutput(job), JSON.stringify(f.index));
    f.mesh.outputPath = store.output(job);
    const result = { ok: true, requestId: job.jobId, mesh: f.mesh };
    job.artifact = store.writeResult(job, result);
    job.meshSummary = { dimension: 3, nodeCount: f.mesh.nodeCount, elementCount: count, admission: result.mesh.admission };
    store.save(job);
    return { store, job, result };
}
