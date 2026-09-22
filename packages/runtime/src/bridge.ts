import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export type BridgeConfig = { host: string; port: number; token: string };
type Pending = { resolve(value: any): void; reject(reason: Error): void; timer: NodeJS.Timeout };

/** GABP/1, Content-Length framed UTF-8. Requests are never automatically replayed. */
export class Bridge extends EventEmitter {
  private socket?: net.Socket;
  private buffer = Buffer.alloc(0);
  private pending = new Map<string, Pending>();
  private connecting?: Promise<void>;
  ready = false;
  config: BridgeConfig;
  constructor(config: BridgeConfig) { super(); this.config = config; }

  async connect() {
    if (this.ready) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async open() {
    this.buffer = Buffer.alloc(0);
    const socket = net.createConnection({ host: this.config.host, port: this.config.port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('data', bytes => { try { this.receive(bytes); } catch (error) { socket.destroy(error as Error); } });
    socket.on('error', error => this.fail(error));
    socket.on('close', () => { this.ready = false; this.fail(new Error('BRIDGE_DISCONNECTED: game connection closed; inspect results before retrying actions.')); });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => socket.destroy(new Error('Bridge connection timed out')), 5000);
      socket.once('connect', () => { clearTimeout(timeout); resolve(); });
      socket.once('error', error => { clearTimeout(timeout); reject(error); });
    });
    await this.request('session/hello', { token: this.config.token, bridgeVersion: '1.0.0', platform: 'windows', launchId: randomUUID() });
    this.ready = true;
  }
  private fail(error: Error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }
  private receive(bytes: Buffer) {
    this.buffer = Buffer.concat([this.buffer, bytes]);
    while (true) {
      const boundary = this.buffer.indexOf('\r\n\r\n');
      if (boundary < 0) { if (this.buffer.length > 8192) throw new Error('Invalid GABP frame header'); return; }
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i.exec(this.buffer.subarray(0, boundary).toString('ascii'));
      if (!match) throw new Error('GABP frame has no Content-Length');
      const length = Number(match[1]);
      if (length > 64 * 1024 * 1024) throw new Error('GABP frame exceeds 64 MiB');
      if (this.buffer.length < boundary + 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(boundary + 4, boundary + 4 + length).toString('utf8'));
      this.buffer = this.buffer.subarray(boundary + 4 + length);
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code, details: message.error.data }));
        else pending.resolve(message.result);
      } else this.emit('notification', message);
    }
  }
  request(method: string, params: unknown = {}, timeoutMs = 30000): Promise<any> {
    const id = randomUUID();
    // Lib.GAB's current receiver compares Content-Length against UTF-16 text
    // length. JSON escapes preserve names exactly while keeping bytes == chars,
    // including when a UTF-8 code point would straddle a TCP read boundary.
    const json = JSON.stringify({ v: 'gabp/1', id, type: 'request', method, params })
      .replace(/[\u007f-\uffff]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
    const body = Buffer.from(json, 'utf8');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`TIMEOUT: ${method}; outcome may be unknown, inspect before retrying.`), { code: 'TIMEOUT', requestId: id }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.socket || this.socket.destroyed) { clearTimeout(timer); this.pending.delete(id); reject(new Error('BRIDGE_DISCONNECTED')); return; }
      this.socket.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\nContent-Type: application/json\r\n\r\n`, 'ascii'), body]));
    });
  }
  async tool(name: string, parameters: Record<string, unknown> = {}, timeoutMs = 30000) {
    await this.connect();
    return this.request('tools/call', { name, parameters }, timeoutMs);
  }
  close() { this.ready = false; this.socket?.destroy(); this.fail(new Error('Bridge client closed')); }
}
