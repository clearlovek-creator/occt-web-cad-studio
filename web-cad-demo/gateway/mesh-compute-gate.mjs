const fault = (code, message) => Object.assign(Error(message), { code });
/** A Gateway-owned FIFO permit. A pool releases it only after real thread exit
 * and cleanup, never when a cancellation/terminate request is merely sent. */
export class MeshComputeGate {
    constructor() { this.active = null; this.queue = []; this.closed = false; this.started = 0; }
    status() { return { maxActive: 1, active: this.active?.kind || null, waiting: this.queue.length, grants: this.started, closed: this.closed }; }
    acquire({ kind, signal }) {
        if (!['quality', 'artifact', 'catalog'].includes(kind))
            return Promise.reject(fault('MESH_COMPUTE_INVALID', '未知网格计算类型。'));
        if (this.closed)
            return Promise.reject(fault('MESH_COMPUTE_CLOSED', '网格计算服务正在停止。'));
        if (signal?.aborted)
            return Promise.reject(fault('MESH_COMPUTE_CANCELLED', '网格计算等待已取消。'));
        return new Promise((resolve, reject) => { const entry = { kind, signal, resolve, reject }; entry.abort = () => { this.queue = this.queue.filter(row => row !== entry); signal.removeEventListener('abort', entry.abort); reject(fault('MESH_COMPUTE_CANCELLED', '网格计算等待已取消。')); }; signal?.addEventListener('abort', entry.abort, { once: true }); this.queue.push(entry); this.pump(); });
    }
    pump() {
        if (this.active || this.closed || !this.queue.length)
            return;
        const entry = this.active = this.queue.shift();
        entry.signal?.removeEventListener('abort', entry.abort);
        this.started++;
        let released = false;
        entry.resolve({ release: () => {
                if (released)
                    return;
                released = true;
                if (this.active === entry)
                    this.active = null;
                this.pump();
            } });
    }
    close() {
        this.closed = true;
        for (const entry of this.queue) {
            entry.signal?.removeEventListener('abort', entry.abort);
            entry.reject(fault('MESH_COMPUTE_CLOSED', '网格计算服务正在停止。'));
        }
        this.queue = [];
    }
}
