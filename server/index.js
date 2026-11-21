// Zero-dependency HTTP + WebSocket server hosting the replication lab.
//
// Wire directions:
//   server -> client : binary tiles of authority frames (impaired: delayed,
//                      reordered, periodic middle-tile loss)
//   client -> server : binary tileless acks? No: acks are JSON, see below.
//
// Text messages carry control/metadata; binary messages carry frame tiles in
// both directions so the same impairment model applies to acks too.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Authority, LabClient, DEFAULT_CONFIG } from '../shared/session.js';
import { Impairment } from '../shared/transport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function createServer(options = {}) {
  const config = { ...DEFAULT_CONFIG, ...(options.config || {}) };
  const server = http.createServer((req, res) => serveStatic(req, res));
  const sessions = new Map(); // ws -> { authority, impairment, sessionId, timer }
  let nextSessionId = 1;
  let frameCounter = 0;

  server.on('upgrade', (req, socket) => {
    if (req.url !== '/ws') { socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    attachSession(socket);
  });

  function attachSession(socket) {
    const sessionId = nextSessionId++;
    const frames = [];
    const session = {
      sessionId,
      socket,
      authority: null,
      impairment: new Impairment({ latencyMs: 0, jitterMs: 0 }),
      lastFrameAt: 0,
      closed: false,
      ackDelayMs: config.ackDelayMs,
      queuedAcks: [],
      lastSentTiles: [],
      digests: new Map(),     // tick -> world digest of what was actually sent
      digestList: [],         // last 128 sent, in order, for the UI
      stats: { bytesToClient: 0, tilesToClient: 0, acksToServer: 0, framesDelivered: 0, framesLost: 0 },
    };
    sessions.set(socket, session);

    const authority = new Authority(config, {
      sessionId,
      onTiles: (tiles, meta) => sendFrame(session, tiles, meta),
    });
    session.authority = authority;
    authority.start();

    const statusTimer = setInterval(() => {
      if (session.closed) return;
      sendText(socket, {
        type: 'status',
        authority: {
          ...sanitizeStatus(authority.status()),
          digests: session.digestList.slice(-64),
        },
        serverside: { ...describeImpairment(session), lastAckError: session.lastAckError || null },
        sessionId,
      });
    }, 500);
    session.statusTimer = statusTimer;

    sendText(socket, {
      type: 'welcome',
      sessionId,
      config: publicConfig(config),
      protocol: 1,
    });

    let buffer = Buffer.alloc(0);
    let fragmented = null;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const parsed = parseFrame(buffer);
        if (!parsed) break;
        buffer = buffer.subarray(parsed.totalLength);
        if (parsed.opcode === 0x8) { closeSession(session); return; }
        if (parsed.opcode === 0x9) { writeFrame(socket, 0xA, parsed.payload); continue; }
        if (parsed.opcode === 0x1) handleText(session, parsed.payload.toString('utf8'));
        if (parsed.opcode === 0x2) handleBinaryAck(session, parsed.payload);
      }
    });
    socket.on('close', () => closeSession(session));
    socket.on('error', () => closeSession(session));
  }

  function handleText(session, text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.type === 'ack') {
      // Acks are deliberately slow: queue and apply after ackDelayMs.
      const deliver = () => {
        if (session.closed) return;
        session.stats.acksToServer++;
        const res = session.authority.acceptAck({
          protocol: msg.protocol,
          sessionId: msg.sessionId,
          seq: msg.seq,
          tick: msg.tick,
          digest: hexToBytes(msg.digest),
          nonce: msg.nonce,
          budget: msg.budget,
        });
        if (!res.ok) {
          session.lastAckError = res.reason;
          sendText(session.socket, { type: 'ackRejected', reason: res.reason, seq: msg.seq });
        } else {
          session.lastAckError = null;
        }
      };
      if (session.ackDelayMs > 0) setTimeout(deliver, session.ackDelayMs);
      else deliver();
      return;
    }
    if (msg.type === 'control') {
      if (msg.action === 'checkpoint') session.authority.requestCheckpoint(msg.reason);
      if (msg.action === 'impairment') {
        session.impairment = new Impairment({
          reorder: !!msg.reorder,
          latencyMs: Number(msg.latencyMs) || 0,
          jitterMs: Number(msg.jitterMs) || 0,
          dropMiddleEveryFrame: !!msg.drop,
          seed: (session.sessionId * 7919) | 0,
        });
        session.dropCadence = Number(msg.dropEveryFrames) || 0;
        session.framesUntilDrop = session.dropCadence;
      }
      if (msg.action === 'ackDelay') session.ackDelayMs = Number(msg.ms) || 0;
      return;
    }
  }

  function handleBinaryAck() { /* acks are JSON today */ }

  function sendFrame(session, tiles, meta) {
    if (session.closed) return;
    // Impairment: reorder (rotate + neighbour swap), delay, and periodically
    // drop one middle tile so reassembly must actually fail and recover.
    let list = tiles.slice();
    let dropped = null;
    if (session.impairment.reorder && list.length > 2) {
      for (let i = 0; i + 1 < list.length; i += 2) {
        [list[i], list[i + 1]] = [list[i + 1], list[i]];
      }
      const head = list.shift();
      list.push(head);
    }
    if (session.dropCadence > 0) {
      session.framesUntilDrop = (session.framesUntilDrop ?? session.dropCadence) - 1;
      if (session.framesUntilDrop <= 0 && list.length >= 2) {
        const mid = Math.floor(list.length / 2);
        dropped = list[mid];
        list.splice(mid, 1);
        session.framesUntilDrop = session.dropCadence;
        session.stats.framesLost++;
      }
    }
    const baseDelay = session.impairment.latencyMs;
    const jitter = session.impairment.jitterMs;
    list.forEach((tile, i) => {
      const delay = baseDelay + Math.floor(Math.random() * (jitter + 1)) + i;
      setTimeout(() => {
        if (session.closed) return;
        writeFrame(session.socket, 0x2, Buffer.from(tile));
        session.stats.bytesToClient += tile.length;
        session.stats.tilesToClient++;
      }, delay);
    });
    session.stats.framesDelivered++;
    session.digests.set(meta.tick, meta.worldDigest);
    session.digestList.push({ tick: meta.tick, digest: meta.worldDigest });
    if (session.digestList.length > 128) session.digestList.shift();
    sendText(session.socket, {
      type: 'tx',
      meta,
      impairment: {
        tilesSent: tiles.length,
        tilesDelivered: list.length,
        droppedTile: dropped ? tiles.indexOf(dropped) : null,
        delayMs: baseDelay,
        jitterMs: jitter,
        reordered: session.impairment.reorder,
      },
    });
  }

  function closeSession(session) {
    if (session.closed) return;
    session.closed = true;
    session.authority.stop();
    clearInterval(session.statusTimer);
    sessions.delete(session.socket);
    try { session.socket.end(); } catch {}
  }

  function serveStatic(req, res) {
    const url = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    let filePath;
    if (pathname.startsWith('/shared/')) {
      filePath = path.join(SHARED_DIR, pathname.slice('/shared/'.length));
    } else {
      filePath = path.join(PUBLIC_DIR, pathname);
    }
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(PUBLIC_DIR + path.sep) && !resolved.startsWith(SHARED_DIR + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(resolved, (err, data) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, {
        'content-type': MIME[path.extname(resolved)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(data);
    });
  }

  server.on('close', () => {
    for (const s of sessions.values()) closeSession(s);
  });

  return server;
}

function publicConfig(config) {
  return {
    tickMs: config.tickMs,
    baselineBudgetBytes: config.baselineBudgetBytes,
    clientBaselineBudgetBytes: config.clientBaselineBudgetBytes,
    maxBaselineAgeTicks: config.maxBaselineAgeTicks,
    deltaToCheckpointRatio: config.deltaToCheckpointRatio,
    frameTimeoutMs: config.frameTimeoutMs,
    maxResumesBeforeCheckpoint: config.maxResumesBeforeCheckpoint,
  };
}

function sanitizeStatus(status) {
  const out = { ...status };
  out.audit = status.audit.map(a => ({
    ...a,
    detail: a.detail,
  }));
  return out;
}

function describeImpairment(session) {
  return {
    reorder: session.impairment.reorder,
    latencyMs: session.impairment.latencyMs,
    jitterMs: session.impairment.jitterMs,
    dropEveryFrames: session.dropCadence || 0,
    ackDelayMs: session.ackDelayMs,
    stats: session.stats,
  };
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) return new Uint8Array(0);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// Minimal RFC6455 framing ----------------------------------------------------

function writeFrame(socket, opcode, payload) {
  if (socket.destroyed) return;
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  socket.write(Buffer.concat([header, payload]));
}

function sendText(socket, obj) {
  writeFrame(socket, 0x1, Buffer.from(JSON.stringify(obj)));
}

function parseFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen + len) return null;
  const mask = masked ? buf.subarray(off, off + 4) : null;
  off += maskLen;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  if (!fin) return null; // this lab's clients never fragment
  return { opcode, payload, totalLength: off + len };
}

// CLI -----------------------------------------------------------------------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '0.0.0.0';
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`object lab listening on http://${host}:${port}`);
  });
}

export { LabClient };
