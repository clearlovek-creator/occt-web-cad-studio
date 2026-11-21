import { parentPort, workerData } from 'node:worker_threads';
import { runPagedQualityQuery } from './mesh-quality-pages.mjs';
try {
    parentPort.postMessage({ ok: true, ...runPagedQualityQuery(workerData) });
}
catch (error) {
    parentPort.postMessage({ ok: false, error: error.message, code: error.code || 'MESH_QUALITY_QUERY_FAILED' });
}
finally {
    parentPort.close();
}
