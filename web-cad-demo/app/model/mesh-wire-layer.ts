import * as THREE from 'three';
import type { MeshRenderPayload, MeshWire, MeshWireChunk } from './mesh';
import {placeViewportObject} from './viewport-coordinates';
import {readMeshWireChunk,isMeshWireTimeout,MESH_WIRE_TIMEOUT_MESSAGE} from './mesh-wire-read';
export type MeshWireStatus = {
    visibleChunks: number;
    loadedChunks: number;
    wantedChunks: number;
    pending: number;
    residentBytes: number;
    error: string;
};
type Context = {
    jobId: string;
    documentId: string;
    render: MeshRenderPayload;
    visibleKeys: string[];
};
type Entry = {
    wireKey: string;
    index: number;
    lines: THREE.LineSegments;
    bytes: number;
};
type Pending = {
    wireKey: string;
    controller: AbortController;
    timedOut: boolean;
    deadlineAt: number;
    timer: ReturnType<typeof setTimeout>;
};
type Options = {
    apiRoot: string;
    fetchImpl?: typeof fetch;
    maxBytes?: number;
    concurrency?: number;
    onUpdate?: (state: MeshWireStatus) => void;
    onError?: (message: string) => void;
};
/** A viewport-owned layer. No hidden prefetch, no Number[] copy of the full
 * mesh, no geometry rebuilding as later blocks arrive. Shared owners use one
 * wireKey and therefore one CPU attribute / GPU geometry per block. */
export class MeshWireLayer {
    readonly group = new THREE.Group();
    private material = new THREE.LineBasicMaterial({ color: 0x48c8e8, transparent: true, opacity: .82, depthWrite: false });
    private entries = new Map<string, Entry>();
    private pending = new Map<string, Pending>();
    private wires = new Map<string, MeshWire>();
    private desired = new Set<string>();
    private context: Context | null = null;
    private signature = '';
    private epoch = 0;
    private stopped = false;
    private failure = '';
    private failedSelection = '';
    private maxBytes: number;
    private concurrency: number;
    private fetcher: typeof fetch;
    private options: Options;
    constructor(options: Options) {
        this.options = options;
        this.group.name = 'mesh-results';
        this.maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
        this.concurrency = options.concurrency ?? 4;
        this.fetcher = options.fetchImpl || ((input, init) => fetch(input, init));
        if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || !Number.isSafeInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 8)
            throw Error('网格显示资源预算无效。');
    }
    status(): MeshWireStatus {
        let visibleChunks = 0, loadedChunks = 0, wantedChunks = 0, residentBytes = 0;
        for (const entry of this.entries.values()) {
            residentBytes += entry.bytes;
            if (entry.lines.visible)
                visibleChunks++;
            if (this.desired.has(entry.wireKey))
                loadedChunks++;
        }
        for (const key of this.desired)
            wantedChunks += this.wires.get(key)?.chunks.length || 0;
        return { visibleChunks, loadedChunks, wantedChunks, pending: this.pending.size, residentBytes, error: this.failure };
    }
    private notify() {
        if (!this.stopped)
            this.options.onUpdate?.(this.status());
    }
    private clear() {
        for (const [id,pending] of this.pending)this.retire(id,pending);
        for (const entry of this.entries.values())
            entry.lines.geometry.dispose();
        this.entries.clear();
        this.group.clear();
        this.wires.clear();
        this.desired.clear();
    }
    private retire(id:string,pending:Pending) {
        if(this.pending.get(id)===pending)this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.controller.abort();
    }
    update(context: Context) {
        if (this.stopped)
            return;
        const storage = context.render.storage;
        if (storage?.version !== 1 || storage.format !== 'float64-le' || !/^[a-f0-9]{64}$/.test(storage.sha256) || !Array.isArray(context.render.wires))
            throw Error('网格缺少经过校验的分块显示清单。');
        const signature = `${context.documentId}/${context.jobId}/${storage.sha256}`;
        if (signature !== this.signature) {
            this.epoch++;
            this.clear();
            this.failure = '';
            this.failedSelection = '';
            this.signature = signature;
            for (const wire of context.render.wires) {
                if (!/^wire-[23]-[1-9]\d*$/.test(wire.key) || this.wires.has(wire.key) || !Number.isSafeInteger(wire.scalars) || wire.scalars < 0 || wire.scalars % 6 || !Array.isArray(wire.chunks))
                    throw Error('网格显示分组不合法。');
                let bytes = 0;
                for (const chunk of wire.chunks) {
                    if (!Number.isSafeInteger(chunk.bytes) || chunk.bytes <= 0 || chunk.bytes > 1024 * 1024 || chunk.bytes % 48 || !/^[a-f0-9]{64}$/.test(chunk.sha256))
                        throw Error('网格显示块凭据不合法。');
                    bytes += chunk.bytes;
                }
                if (bytes !== wire.scalars * 8)
                    throw Error('网格显示数量不一致。');
                this.wires.set(wire.key, wire);
            }
        }
        this.context = context;
        const desired = new Set(context.visibleKeys), selection = [...desired].sort().join('|');
        if (selection !== this.failedSelection)
            this.failure = '';
        let requestedBytes = 0;
        for (const key of desired) {
            const wire = this.wires.get(key);
            if (!wire)
                throw Error('显示分组没有对应的封存数据。');
            requestedBytes += wire.scalars * 4;
        }
        this.desired = desired;
        for (const [id,pending] of this.pending)
            if (!desired.has(pending.wireKey))
                this.retire(id,pending);
        for (const entry of this.entries.values())
            entry.lines.visible = desired.has(entry.wireKey) && !this.failure;
        if (requestedBytes > this.maxBytes) {
            this.fail(`所选网格超过当前视口 ${(this.maxBytes / 1048576).toFixed(1)} MiB 显示预算，请减少同时显示的 Body。`);
            return;
        }
        let bytes = this.status().residentBytes, missing = requestedBytes;
        for (const entry of this.entries.values())
            if (desired.has(entry.wireKey))
                missing -= entry.bytes;
        for (const [id, entry] of this.entries) {
            if (bytes + missing <= this.maxBytes)
                break;
            if (!desired.has(entry.wireKey)) {
                entry.lines.geometry.dispose();
                this.group.remove(entry.lines);
                this.entries.delete(id);
                bytes -= entry.bytes;
            }
        }
        this.notify();
        if (!this.failure)
            this.pump();
    }
    private fail(message: string) {
        this.failure = message;
        this.failedSelection = [...this.desired].sort().join('|');
        for (const [id,pending] of this.pending)this.retire(id,pending);
        for (const entry of this.entries.values())
            entry.lines.visible = false;
        this.options.onError?.(message);
        this.notify();
    }
    private pump() {
        if (this.stopped || this.failure || !this.context)
            return;
        for (const key of this.desired) {
            const wire = this.wires.get(key)!;
            for (let index = 0; index < wire.chunks.length; index++) {
                if (this.pending.size >= this.concurrency)
                    return;
                const id = `${key}/${index}`;
                if (this.entries.has(id) || this.pending.has(id))
                    continue;
                const controller = new AbortController(), pending: Pending = { wireKey: key, controller, timedOut: false, deadlineAt:performance.now()+15000, timer: setTimeout(() => { pending.timedOut = true; controller.abort(); }, 15000) };
                this.pending.set(id, pending);
                const epoch = this.epoch, jobId = this.context.jobId;
                void this.load(jobId, wire, index, wire.chunks[index], pending.controller.signal,pending.deadlineAt).then(local => {
                    if (this.stopped || epoch !== this.epoch || this.pending.get(id) !== pending || !this.desired.has(key) || pending.controller.signal.aborted)
                        return;
                    const geometry = new THREE.BufferGeometry();
                    geometry.setAttribute('position', new THREE.BufferAttribute(local.positions, 3));
                    const lines = new THREE.LineSegments(geometry, this.material);
                    placeViewportObject(lines,local.origin);
                    lines.renderOrder = 5;
                    lines.userData.meshWireKey = key;
                    lines.userData.meshWireChunk = index;
                    this.group.add(lines);
                    this.entries.set(id, { wireKey: key, index, lines, bytes: local.positions.byteLength });
                }).catch(reason => {
                    if (!this.stopped && epoch === this.epoch && this.pending.get(id) === pending && (pending.timedOut || !pending.controller.signal.aborted))
                        this.fail(pending.timedOut||isMeshWireTimeout(reason) ? MESH_WIRE_TIMEOUT_MESSAGE : reason instanceof Error ? reason.message : '网格显示读取失败。');
                }).finally(() => {
                    clearTimeout(pending.timer);
                    if (this.pending.get(id) === pending)
                        this.pending.delete(id);
                    if (!this.stopped && epoch === this.epoch) {
                        this.notify();
                        this.pump();
                    }
                });
            }
        }
    }
    private load(jobId: string, wire: MeshWire, index: number, chunk: MeshWireChunk, signal: AbortSignal,deadlineAt:number) {
        return readMeshWireChunk({apiRoot:this.options.apiRoot,jobId,wireKey:wire.key,index,chunk,signal,fetcher:this.fetcher,deadlineAt});
    }
    dispose() {
        if (this.stopped)
            return;
        this.stopped = true;
        this.epoch++;
        this.clear();
        this.material.dispose();
        this.context = null;
    }
}
