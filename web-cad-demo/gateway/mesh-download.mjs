import fs from 'node:fs';
import crypto from 'node:crypto';
const stamp = stat => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(stat[key])).join(':');
/** Backpressure and bounded buffering; withhold the last block until the
 * bytes and identity are checked, so corruption cannot complete a download. */
export async function streamCheckedMesh(file, proof, response, headers) {
    const entry = await fs.promises.lstat(file, { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== BigInt(proof.bytes))
        throw Object.assign(Error('网格下载文件类型或长度已变化。'), { code: 'MESH_ARTIFACT_INVALID' });
    const handle = await fs.promises.open(file, 'r');
    try {
        if (stamp(entry) !== stamp(await handle.stat({ bigint: true })))
            throw Error('网格下载文件身份已变化。');
        response.writeHead(200, { ...headers, 'Content-Length': proof.bytes, 'X-Content-SHA256': proof.sha256, 'Cache-Control': 'no-store' });
        const hash = crypto.createHash('sha256');
        let size = 0, last;
        const write = async (bytes) => { if (response.destroyed)
            throw Error('网格下载已关闭。'); if (!response.write(bytes))
            await new Promise((resolve, reject) => { const clean = () => { response.off('drain', drain); response.off('close', close); }, drain = () => { clean(); resolve(); }, close = () => { clean(); reject(Error('网格下载已关闭。')); }; response.once('drain', drain); response.once('close', close); if (response.destroyed)
                close(); }); };
        for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) {
            hash.update(chunk);
            size += chunk.length;
            if (size > proof.bytes)
                throw Error('网格下载文件增长。');
            if (last)
                await write(last);
            last = chunk;
        }
        if (size !== proof.bytes || hash.digest('hex') !== proof.sha256 || stamp(entry) !== stamp(await handle.stat({ bigint: true })) || stamp(entry) !== stamp(await fs.promises.lstat(file, { bigint: true })))
            throw Error('网格下载内容已变化，未完成响应。');
        if (last)
            await write(last);
        response.end();
    }
    catch (error) {
        if (response.headersSent)
            response.destroy();
        throw error;
    }
    finally {
        await handle.close();
    }
}
