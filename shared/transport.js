// Transport abstraction. A session is created by the server and used by both
// the browser client (WebSocket relay) and the headless verifier client.
//
// Every byte flowing in both directions goes through `impair()`, which models
// reordering, latency and deliberate drop of one middle tile per frame.

export class Impairment {
  constructor(opts = {}) {
    this.reorder = opts.reorder ?? false;
    this.latencyMs = opts.latencyMs ?? 0;
    this.jitterMs = opts.jitterMs ?? 0;
    this.dropMiddleEveryFrame = opts.dropMiddleEveryFrame ?? false;
    this.seed = opts.seed ?? 12345;
    this._n = 0;
    this.dropped = 0;
    this.delivered = 0;
    this.reorderedFrames = 0;
  }

  _rand() {
    // xorshift32 for reproducible shuffles
    let x = this.seed | 0;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x | 0;
    return ((x >>> 0) % 10000) / 10000;
  }

  // tiles: array of Uint8Array for one frame. Returns a list of
  // { delayMs, bytes } in send order (the receiving end should apply delay).
  planFrame(tiles, { dropEnabled } = {}) {
    let list = tiles.slice();
    if (this.reorder && list.length > 2) {
      // Deterministic but non-trivial permutation: swap neighbours, rotate by 1.
      for (let i = 0; i + 1 < list.length; i += 2) {
        const tmp = list[i]; list[i] = list[i + 1]; list[i + 1] = tmp;
      }
      list = list.slice(1).concat(list.slice(0, 1));
      this.reorderedFrames++;
    }
    if (this.dropMiddleEveryFrame && dropEnabled && list.length >= 3) {
      const mid = Math.floor(list.length / 2);
      list = list.slice(0, mid).concat(list.slice(mid + 1));
      this.dropped++;
    }
    return list.map((bytes, i) => ({
      bytes,
      delayMs: this.latencyMs + Math.floor(this._rand() * this.jitterMs) + i,
    }));
  }
}

// A synchronous in-memory link used by tests and the verifier.
export class DirectLink {
  constructor({ a, b, impairmentAtoB, impairmentBtoA }) {
    this.a = a;
    this.b = b;
    this.impairmentAtoB = impairmentAtoB || new Impairment();
    this.impairmentBtoA = impairmentBtoA || new Impairment();
  }
  sendAtoB(tiles) {
    const plan = this.impairmentAtoB.planFrame(tiles, { dropEnabled: true });
    for (const p of plan) this.b.receive(p.bytes);
  }
  sendBtoA(tiles) {
    const plan = this.impairmentBtoA.planFrame(tiles, { dropEnabled: false });
    for (const p of plan) this.a.receive(p.bytes);
  }
}

export class Session {
  // Abstract: subclass must implement send(bytes[])
  constructor({ id, seed }) {
    this.id = id;
    this.seed = seed;
    this.sentTiles = 0;
    this.sentBytes = 0;
    this.receivedTiles = 0;
    this.receivedBytes = 0;
    this.tx = 0;
    this.rx = 0;
  }

  // Send one frame's tiles through the impairment model.
  sendFrame(tiles) {
    const plan = this.impairmentForSend().planFrame(tiles, { dropEnabled: true });
    for (const p of plan) { this.sentTiles++; this.sentBytes += p.bytes.length; }
    this.deliverToImpairedPeer(plan);
    return this.sentBytes;
  }

  impairmentForSend() { throw new Error('not implemented'); }
  deliverToImpairedPeer() { throw new Error('not implemented'); }
  receive() { throw new Error('not implemented'); }
}

// A session whose other end is a DirectLink peer.
export class DirectSession extends Session {
  constructor(params) {
    super(params);
    this.link = params.link;
    this.peer = null;
  }

  impairmentForSend() { return this.link.impairmentAtoB; }

  deliverToImpairedPeer(plan) {
    // The DirectLink peer applies the same impairment plan. We preempt that by
    // sending already-impaired tiles; DirectLink must therefore be bypassed.
    for (const p of plan) this.peer.receive(p.bytes);
  }

  receive(bytes) {
    this.receivedTiles++;
    this.receivedBytes += bytes.length;
    this.onPacket(bytes);
  }
}
