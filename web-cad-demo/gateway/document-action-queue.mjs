import {AsyncLocalStorage} from 'node:async_hooks';

export class DocumentActionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DocumentActionError';
    this.code = code;
    this.retryableByModel = false;
  }
}

const configurationError = () => new DocumentActionError('DOCUMENT_ACTION_CONFIG_INVALID', '工程操作队列配置无效；请使用规定范围内的正整数。');

function boundedInteger(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw configurationError();
  return value;
}

export function documentActionLimits(environment = process.env) {
  const setting = (name, fallback, maximum) => {
    const raw = environment[name];
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) throw configurationError();
    return boundedInteger(Number(raw), 1, maximum);
  };
  const maxQueued = setting('GEOMETRY_ACTION_QUEUE_LIMIT', 64, 256);
  const maxQueuedPerDocument = setting('GEOMETRY_ACTION_DOCUMENT_QUEUE_LIMIT', Math.min(16, maxQueued), 64);
  if (maxQueuedPerDocument > maxQueued) throw configurationError();
  return {maxQueued, maxQueuedPerDocument, waitMs: setting('GEOMETRY_ACTION_QUEUE_TIMEOUT_MS', 120000, 600000), maxQueuedInputBytes: setting('GEOMETRY_ACTION_QUEUE_BYTES', 64 * 1024 * 1024, 256 * 1024 * 1024)};
}

/**
 * One engineering action owns the shared native worker until its entire action
 * (including transaction rollback) settles. Queue cancellation never declares
 * an executing action stopped. This is admission serialization, not OS process
 * isolation or a public job-cancellation API.
 */
export class DocumentActionQueue {
  constructor({maxQueued = 64, maxQueuedPerDocument = Math.min(16, maxQueued), waitMs = 120000, maxQueuedInputBytes = 64 * 1024 * 1024} = {}) {
    this.maxQueued = boundedInteger(maxQueued, 1, 256);
    this.maxQueuedPerDocument = boundedInteger(maxQueuedPerDocument, 1, 64);
    if (maxQueuedPerDocument > maxQueued) throw configurationError();
    this.waitMs = boundedInteger(waitMs, 1, 600000);
    this.maxQueuedInputBytes = boundedInteger(maxQueuedInputBytes, 1, 256 * 1024 * 1024);
    this.queuedInputBytes = 0;
    this.waiting = [];
    this.active = null;
    this.closed = false;
    this.idleObservers = new Set();
    this.context = new AsyncLocalStorage();
    this.counters = {accepted: 0, completed: 0, failed: 0, rejected: 0, expired: 0, cancelledBeforeStart: 0};
  }

  status() {
    return {
      state: this.closed ? 'draining' : 'open',
      active: this.active ? 1 : 0,
      queued: this.waiting.length,
      queuedDocuments: new Set(this.waiting.map(item => item.documentId)).size,
      maxActive: 1,
      maxQueued: this.maxQueued,
      maxQueuedPerDocument: this.maxQueuedPerDocument,
      waitMs: this.waitMs,
      queuedInputBytes: this.queuedInputBytes,
      maxQueuedInputBytes: this.maxQueuedInputBytes,
      ...this.counters,
    };
  }

  run(documentId, action, {signal, inputBytes = 0} = {}) {
    if (typeof documentId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(documentId) || typeof action !== 'function') {
      return Promise.reject(new DocumentActionError('DOCUMENT_ACTION_INVALID', '工程操作缺少有效工程身份或执行函数。'));
    }
    if (this.closed) return Promise.reject(new DocumentActionError('SERVICE_STOPPING', '后台正在停止，未接收新的工程操作。'));
    if (this.active && this.context.getStore() === this.active) return Promise.reject(new DocumentActionError('DOCUMENT_ACTION_REENTRANT', '工程操作不能在持有共享内核时再次排队；未开始嵌套操作。'));
    if (signal?.aborted) return Promise.reject(new DocumentActionError('DOCUMENT_ACTION_CANCELLED', '工程操作尚未开始，已取消排队。'));
    if (!Number.isSafeInteger(inputBytes) || inputBytes < 0) return Promise.reject(new DocumentActionError('DOCUMENT_ACTION_INVALID', '工程操作输入字节计数无效。'));
    const perDocument = this.waiting.reduce((count, item) => count + Number(item.documentId === documentId), 0);
    if (this.active && (this.waiting.length >= this.maxQueued || perDocument >= this.maxQueuedPerDocument)) {
      this.counters.rejected++;
      return Promise.reject(new DocumentActionError('DOCUMENT_ACTION_QUEUE_LIMIT', '工程操作排队预算已满，本次操作未开始；请等待已有操作完成。'));
    }
    if (this.active && inputBytes > this.maxQueuedInputBytes - this.queuedInputBytes) {
      this.counters.rejected++;
      return Promise.reject(new DocumentActionError('DOCUMENT_ACTION_INPUT_LIMIT', '等待执行的工程输入超过字节预算，本次操作未开始。'));
    }
    let resolve, reject;
    const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
    const ticket = {documentId, action, signal, inputBytes, resolve, reject};
    ticket.abort = () => this.remove(ticket, new DocumentActionError('DOCUMENT_ACTION_CANCELLED', '工程操作尚未开始，已取消排队。'), 'cancelledBeforeStart');
    ticket.timer = setTimeout(() => this.remove(ticket, new DocumentActionError('DOCUMENT_ACTION_QUEUE_TIMEOUT', '工程操作等待超过截止时间，尚未执行；请核对队列状态后显式重试。'), 'expired'), this.waitMs);
    signal?.addEventListener('abort', ticket.abort, {once: true});
    this.waiting.push(ticket);
    this.queuedInputBytes += inputBytes;
    this.counters.accepted++;
    // A custom AbortSignal can have changed during listener registration.
    if (signal?.aborted) ticket.abort();
    this.drain();
    return promise;
  }

  detach(ticket) {
    clearTimeout(ticket.timer);
    ticket.signal?.removeEventListener('abort', ticket.abort);
  }

  remove(ticket, error, counter) {
    const index = this.waiting.indexOf(ticket);
    if (index === -1) return;
    this.waiting.splice(index, 1);
    this.queuedInputBytes -= ticket.inputBytes;
    this.detach(ticket);
    this.counters[counter]++;
    ticket.reject(error);
    this.notifyIdle();
  }

  drain() {
    if (this.active || !this.waiting.length || this.closed) return;
    const ticket = this.waiting.shift();
    this.queuedInputBytes -= ticket.inputBytes;
    this.detach(ticket);
    this.active = ticket;
    void this.execute(ticket);
  }

  async execute(ticket) {
    try {
      const value = await this.context.run(ticket, () => ticket.action({signal: ticket.signal}));
      this.counters.completed++;
      ticket.resolve(value);
    } catch (error) {
      this.counters.failed++;
      ticket.reject(error);
    } finally {
      this.active = null;
      this.drain();
      this.notifyIdle();
    }
  }

  whenIdle() {
    if (!this.active && !this.waiting.length) return Promise.resolve();
    return new Promise(resolve => this.idleObservers.add(resolve));
  }

  notifyIdle() {
    if (this.active || this.waiting.length) return;
    for (const resolve of this.idleObservers) resolve();
    this.idleObservers.clear();
  }

  close() {
    this.closed = true;
    for (const ticket of [...this.waiting]) {
      this.remove(ticket, new DocumentActionError('SERVICE_STOPPING', '该操作尚未开始，已随后台停机取消排队。'), 'cancelledBeforeStart');
    }
    this.notifyIdle();
    return this.whenIdle();
  }
}
