/**
 * A very small server-side WebSocket (RFC 6455), so this package needs nothing at all from npm —
 * a `link:`-installed plugin resolves modules from its own directory, where a dependency would
 * not be found.
 *
 * Covers what the pet page needs and no more: one text channel both ways, fragmentation
 * reassembly, ping/pong, a close handshake. No extensions, no compression, no binary use.
 */
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1024 * 1024;

const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

export class MiniWebSocket {
  constructor(socket, head) {
    this.socket = socket;
    this.open = true;
    this.buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
    this.listeners = { message: [], close: [] };
    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => this.finish());
    socket.on('close', () => this.finish());
    if (this.buffer.length) queueMicrotask(() => this.drain());
  }

  on(event, listener) {
    (this.listeners[event] ??= []).push(listener);
    return this;
  }

  emit(event, ...args) {
    for (const listener of this.listeners[event] ?? []) {
      try { listener(...args); } catch { /* a listener bug must not kill the socket */ }
    }
  }

  onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    this.drain();
  }

  drain() {
    while (this.open) {
      const frame = readFrame(this.buffer);
      if (frame === null) return; // not a whole frame yet
      if (frame === false) { this.destroy(); return; } // protocol abuse
      this.buffer = this.buffer.subarray(frame.length);
      this.handleFrame(frame);
    }
  }

  handleFrame(frame) {
    const { fin, opcode, payload } = frame;
    if (opcode === OPCODE.ping) { this.writeFrame(OPCODE.pong, payload); return; }
    if (opcode === OPCODE.pong) return;
    if (opcode === OPCODE.close) { this.close(1000); return; }
    if (opcode === OPCODE.continuation) {
      if (this.fragmentOpcode === null) { this.destroy(); return; }
      this.fragments.push(payload);
    } else if (opcode === OPCODE.text || opcode === OPCODE.binary) {
      if (this.fragmentOpcode !== null) { this.destroy(); return; }
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
    } else {
      this.destroy();
      return;
    }
    const size = this.fragments.reduce((n, part) => n + part.length, 0);
    if (size > MAX_MESSAGE) { this.destroy(); return; }
    if (!fin) return;
    const body = Buffer.concat(this.fragments);
    const kind = this.fragmentOpcode;
    this.fragments = [];
    this.fragmentOpcode = null;
    if (kind === OPCODE.text) this.emit('message', body.toString('utf8'), false);
    else this.emit('message', body, true);
  }

  send(text) {
    if (!this.open) return false;
    try { this.writeFrame(OPCODE.text, Buffer.from(String(text), 'utf8')); return true; } catch { this.destroy(); return false; }
  }

  writeFrame(opcode, payload) {
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode;
    this.socket.write(Buffer.concat([header, payload]));
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    this.open = false;
    try {
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2, 'utf8');
      this.writeFrame(OPCODE.close, payload);
    } catch { /* the socket is already gone */ }
    try { this.socket.end(); } catch { /* idem */ }
    this.emit('close');
  }

  destroy() {
    if (!this.open) return;
    this.open = false;
    try { this.socket.destroy(); } catch { /* idem */ }
    this.emit('close');
  }

  finish() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }

  get readyState() {
    return this.open ? 1 : 3;
  }
}

/** One frame from `buffer`, `null` when it is incomplete, `false` when it is not WebSocket. */
function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(MAX_MESSAGE)) return false;
    length = Number(big);
    offset = 10;
  }
  if (length > MAX_MESSAGE) return false;
  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;
  let payload = buffer.subarray(offset, offset + length);
  if (mask) {
    const copy = Buffer.from(payload);
    for (let i = 0; i < copy.length; i++) copy[i] ^= mask[i & 3];
    payload = copy;
  }
  return { fin, opcode, payload, length: offset + length };
}

/**
 * Answers one HTTP upgrade on `socket`. Returns the socket, or null (and closes the connection)
 * when the request is not a valid WebSocket handshake.
 */
export function acceptUpgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  if (!key || upgrade !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n',
  ].join('\r\n'));
  return new MiniWebSocket(socket, head);
}
