// Browser client: WebSocket transport feeding the same LabClient used by the
// offline verifier. Nothing is drawn from partially assembled frames.

import { LabClient, DEFAULT_CONFIG } from '/shared/session.js';
import { dequantizePosition, dequantizeRotation, KIND_NAME, toHex } from '/shared/wire.js';

const $ = (id) => document.getElementById(id);
const canvas = $('scene');
const ctx = canvas.getContext('2d');

const state = {
  client: null,
  ws: null,
  sessionId: null,
  config: { ...DEFAULT_CONFIG },
  authority: null,
  serverside: null,
  selectedId: null,
  paths: new Map(),          // id -> [{x,y,on}]
  lifecycle: new Map(),      // id -> [{tick, event, detail}]
  clientSeen: new Map(),     // id -> {tick, state}
  lastInstall: null,
  framesIncomplete: 0,
  verifyCache: [],
  linkSettings: { reorder: true, drop: true, dropEveryFrames: 5, delay: 60, jitter: 40, ackDelay: 200 },
  hoverId: null,
};
const MAX_PATH = 240;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const ws = new WebSocket(proto + location.host + '/ws');
  ws.binaryType = 'arraybuffer';
  state.ws = ws;
  setConn('connecting', '');
  ws.onopen = () => setConn('connected', 'ok');
  ws.onclose = () => {
    setConn('disconnected', 'bad');
    setTimeout(connect, 900);
  };
  ws.onerror = () => setConn('error', 'bad');
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') { onText(ev.data); return; }
    state.client?.receivePacket(new Uint8Array(ev.data));
  };
}

function onText(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.type === 'welcome') {
    state.sessionId = msg.sessionId;
    $('sessionText').textContent = `session ${msg.sessionId}`;
    setupClient(msg.config);
    return;
  }
  if (msg.type === 'status') {
    state.authority = msg.authority;
    state.serverside = msg.serverside;
    renderAuthority();
    return;
  }
  if (msg.type === 'tx') {
    state.lastTx = msg;
    return;
  }
  if (msg.type === 'ackRejected') {
    pushStatusLine(`ack rejected by authority: ${msg.reason}`);
    return;
  }
}

function setupClient(configFromServer) {
  state.config = { ...DEFAULT_CONFIG, ...configFromServer };
  if (state.client) return;
  state.client = new LabClient({
    sessionId: state.sessionId,
    config: state.config,
    onInstall: onClientInstall,
    onEvent: onClientEvent,
  });
  applyLinkSettings();
  setInterval(() => {
    state.client.watchdog();
    renderClientPanels();
  }, 100);
}

// JSON replacer: Uint8Array digests must travel as hex, not as {"0":196,...}.
function ackJson(key, value) {
  if (value instanceof Uint8Array) return toHex(value);
  return value;
}

function onClientEvent(ev) {  if (ev.type === 'ack') {
    if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(ev.ack, ackJson));
    return;
  }
  if (ev.type === 'control' && ev.action === 'checkpoint') {
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'control', action: 'checkpoint', reason: ev.reason }));
    }
    pushStatusLine(`client requested checkpoint: ${ev.reason}`);
    return;
  }
  if (ev.type === 'reject') {
    pushStatusLine(`frame rejected: ${ev.reason}`);
    return;
  }
  if (ev.type === 'incomplete') {
    state.framesIncomplete++;
    pushStatusLine(`frame ${ev.frameId} incomplete (${ev.received}/${ev.count}) — awaiting resume`);
  }
}

function onClientInstall(e) {
  const now = e.tick;
  // Client-side lifecycle, derived only from atomically installed worlds.
  const prev = state.clientSeen;
  const next = new Map();
  for (const [id, s] of e.states) {
    next.set(id, { tick: now, state: s });
    const before = prev.get(id);
    if (!before) recordLife(id, now, 'appeared', `seq ${e.seq} ${e.kind}`);
    else if (before.state.on !== s.on) recordLife(id, now, 'switch', `${before.state.on}→${s.on}`);
  }
  for (const id of prev.keys()) {
    if (!next.has(id)) recordLife(id, now, 'vanished', `seq ${e.seq} ${e.kind}`);
  }
  state.clientSeen = next;

  if (state.selectedId != null && e.states.has(state.selectedId)) {
    const s = e.states.get(state.selectedId);
    const path = state.paths.get(state.selectedId) || [];
    path.push({ x: dequantizePosition(s.px), y: dequantizePosition(s.py), on: s.on });
    if (path.length > MAX_PATH) path.shift();
    state.paths.set(state.selectedId, path);
  }

  state.lastInstall = {
    tick: e.tick, seq: e.seq, kind: e.kind, bytes: e.bytes,
    digest: toHex(e.digest), baseTick: e.baseTick, applyMs: e.applyMs,
  };
  state.verifyCache.push({
    tick: e.tick, seq: e.seq, kind: e.kind, bytes: e.bytes,
    digest: toHex(e.digest), baseTick: e.baseTick, at: Date.now(),
  });
  if (state.verifyCache.length > 500) state.verifyCache.shift();
  renderClientPanels();
}

function recordLife(id, tick, event, detail) {
  let list = state.lifecycle.get(id);
  if (!list) { list = []; state.lifecycle.set(id, list); }
  list.push({ tick, event, detail });
  if (list.length > 60) list.shift();
}

// ---------------------------------------------------------------------------
// Interaction

function worldFromCanvas(px, py) {
  const pad = 0.06;
  const w = canvas.width, h = canvas.height;
  const worldW = 420, worldH = 300;
  const scale = Math.min(w * (1 - pad * 2) / worldW, h * (1 - pad * 2) / worldH);
  const cx = w / 2, cy = h / 2;
  return { x: (px - cx) / scale, y: (py - cy) / scale, scale, cx, cy };
}

canvas.addEventListener('mousemove', (ev) => {
  const r = canvas.getBoundingClientRect();
  const px = (ev.clientX - r.left) * (canvas.width / r.width);
  const py = (ev.clientY - r.top) * (canvas.height / r.height);
  const pick = pickAt(px, py);
  state.hoverId = pick;
  $('hover').textContent = pick == null
    ? 'click an object to track it'
    : describeObject(pick) + ' — click to track';
  canvas.style.cursor = pick == null ? 'crosshair' : 'pointer';
});

canvas.addEventListener('click', (ev) => {
  const r = canvas.getBoundingClientRect();
  const px = (ev.clientX - r.left) * (canvas.width / r.width);
  const py = (ev.clientY - r.top) * (canvas.height / r.height);
  const id = pickAt(px, py);
  selectObject(id);
});

canvas.addEventListener('mouseleave', () => { state.hoverId = null; });

function pickAt(px, py) {
  const c = state.client;
  if (!c) return null;
  const { scale, cx, cy } = worldFromCanvas(px, py);
  let best = null, bestD = 14 * 14;
  for (const [id, s] of c.states) {
    const x = cx + dequantizePosition(s.px) * scale;
    const y = cy + dequantizePosition(s.py) * scale;
    const d = (x - px) ** 2 + (y - py) ** 2;
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}

function selectObject(id) {
  if (state.selectedId === id) return;
  state.selectedId = id;
  if (id != null) {
    const s = state.client?.states.get(id);
    if (s) {
      state.paths.set(id, [{ x: dequantizePosition(s.px), y: dequantizePosition(s.py), on: s.on }]);
    }
  }
  renderTracker();
}

// ---------------------------------------------------------------------------
// Rendering

function draw() {
  const c = state.client;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGrid();
  if (!c) { requestAnimationFrame(draw); return; }
  const { scale, cx, cy } = worldFromCanvas(0, 0);

  const selPath = state.selectedId != null ? state.paths.get(state.selectedId) : null;
  if (selPath && selPath.length > 1) {
    ctx.beginPath();
    selPath.forEach((p, i) => {
      const x = cx + p.x * scale, y = cy + p.y * scale;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'rgba(76,194,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  for (const [id, s] of c.states) {
    const x = cx + dequantizePosition(s.px) * scale;
    const y = cy + dequantizePosition(s.py) * scale;
    const kind = KIND_NAME[s.kind] || 'stationary';
    const color = kind === 'moving' ? '#6ee7b7'
      : kind === 'transient' ? '#c084fc'
        : kind === 'pulser' ? '#f0b955' : '#8b96a5';
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(dequantizeRotation(s.rot));
    const r = kind === 'moving' ? 7 : kind === 'transient' ? 6 : kind === 'pulser' ? 5 : 5;
    ctx.beginPath();
    ctx.rect(-r, -r, r * 2, r * 2);
    ctx.fillStyle = s.on ? color : '#1b2330';
    ctx.fill();
    ctx.lineWidth = s.on ? 1.2 : 1;
    ctx.strokeStyle = color;
    ctx.stroke();
    if (kind === 'stationary') {
      ctx.beginPath();
      ctx.moveTo(0, -r - 3); ctx.lineTo(0, -r + 1);
      ctx.strokeStyle = s.on ? '#dfe9f2' : color;
      ctx.stroke();
    }
    ctx.restore();

    if (id === state.selectedId) {
      ctx.beginPath();
      ctx.arc(x, y, 13, 0, Math.PI * 2);
      ctx.strokeStyle = '#4cc2ff';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#bfe7ff';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText(`#${id}`, x + 16, y - 10);
    } else if (id === state.hoverId) {
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  ctx.fillStyle = 'rgba(215,224,234,.55)';
  ctx.font = '11px ui-monospace, monospace';
  const status = `client tick ${c.tick} · seq ${c.seq} · ${c.states.size} objects handled`;
  ctx.fillText(status, canvas.width - ctx.measureText(status).width - 16, canvas.height - 14);
  requestAnimationFrame(draw);
}

function drawGrid() {
  const step = 40 * worldFromCanvas(0, 0).scale;
  ctx.save();
  ctx.strokeStyle = '#141c25';
  ctx.lineWidth = 1;
  const ox = worldFromCanvas(0, 0).cx % step;
  const oy = worldFromCanvas(0, 0).cy % step;
  for (let x = ox; x < canvas.width; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
  }
  for (let y = oy; y < canvas.height; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Panels

function renderClientPanels() {
  const c = state.client;
  const a = state.authority;
  if (!c) return;
  const st = c.status();
  $('clientTick').textContent = c.tick;
  if (a) {
    $('authTick').textContent = a.tick;
    $('confTick').textContent = a.client.confirmedTick ?? '-';
    $('frameCounts').textContent = `${st.stats.framesInstalled} / ${a.framesSent}`;
    $('kindCounts').textContent = `${st.stats.deltas} / ${st.stats.checkpoints}`;
    $('byteCount').textContent = fmtBytes(st.stats.bytesReceived);
    renderDecision(a.lastDecision);
    renderBaselines(a.baselines, st.baselines, st.collector);
    renderRecovery(st);
    renderAuthorityLink();
  }
  renderTracker();
  renderVerify();
  $('statusLine').textContent =
    `client tick ${c.tick} · seq ${c.seq} · digest ${st.digest?.slice(0, 16) ?? '-'} · ` +
    `acks ${st.stats.framesInstalled} · rejects ${st.stats.framesRejected} · incomplete ${state.framesIncomplete}`;
}

function renderAuthority() {
  const a = state.authority;
  if (!a) return;
  $('authTick').textContent = a.tick;
  $('confTick').textContent = a.client.confirmedTick ?? '-';
  $('frameCounts').textContent = `${state.client?.stats.framesInstalled ?? 0} / ${a.framesSent}`;
  renderDecision(a.lastDecision);
  if (state.client) {
    const st = state.client.status();
    renderBaselines(a.baselines, st.baselines, st.collector);
  } else {
    renderBaselines(a.baselines, null, null);
  }
  renderAuthorityLink();
}

function renderDecision(d) {
  const el = $('decision');
  if (!d) { el.textContent = 'no decision yet'; el.className = 'decision'; return; }
  el.className = 'decision ' + d.kind;
  el.innerHTML = `<b>${d.kind}</b> — ${escapeHtml(d.reason)}<br>${escapeHtml(d.detail || '')}`;
}

function renderBaselines(authB, cliB, collector) {
  const budget = authB.budgetBytes;
  setBar('srvBar', authB.bytes, budget);
  $('srvText').textContent = `${authB.bytes} / ${budget}B`;
  if (cliB) {
    setBar('cliBar', cliB.bytes, cliB.budgetBytes);
    $('cliText').textContent = `${cliB.bytes} / ${cliB.budgetBytes}B`;
  }
  if (collector) {
    const cap = 12000;
    setBar('bufBar', collector.bufferedBytes, cap);
    $('bufText').textContent = `${collector.bufferedBytes}B`;
  }
  const list = $('baselineList');
  list.innerHTML = '';
  const confirmed = state.authority?.client?.confirmedTick;
  for (const e of authB.entries) {
    const li = document.createElement('li');
    li.textContent = `t${e.tick}`;
    if (e.pinned) li.classList.add('pin');
    if (e.tick === confirmed) li.classList.add('confirmed');
    li.title = `${e.bytes} bytes${e.pinned ? ' · pinned (client confirmed)' : ''}`;
    list.appendChild(li);
  }
}

function renderRecovery(st) {
  const list = $('recoveryList');
  const items = [];
  if (st.recovery) items.push({ live: true, ...st.recovery });
  for (const r of [...(st.recoveryLog || [])].reverse()) items.push(r);
  list.innerHTML = '';
  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'no recovery yet';
    list.appendChild(li);
    return;
  }
  for (const r of items.slice(0, 8)) {
    const li = document.createElement('li');
    if (r.live) {
      li.innerHTML = `<span class="cp">… recovering</span> ${escapeHtml(r.reason)} from t${r.fromTick} (${escapeHtml(r.strategy)})`;
    } else {
      li.innerHTML = `<span class="ok">✓</span> t${r.fromTick}→${r.resolvedTick} after ${Math.round(r.ms)}ms ` +
        `(${r.installedKind}) · ${escapeHtml(r.reason)}`;
    }
    list.appendChild(li);
  }
}

function renderAuthorityLink() {
  const s = state.serverside;
  if (!s) return;
  const st = s.stats || {};
  $('byteCount').title =
    `to client ${fmtBytes(st.bytesToClient || 0)} · tiles ${st.tilesToClient || 0} · ` +
    `acks ${st.acksToServer || 0} · frames lost ${st.framesLost || 0}`;
}

function newestMatch() {
  const a = state.authority;
  if (!a || !a.digests) return null;
  for (let i = state.verifyCache.length - 1; i >= 0; i--) {
    const rec = a.digests.find(d => d.tick === state.verifyCache[i].tick);
    if (rec && rec.digest === state.verifyCache[i].digest) {
      return { tick: rec.tick, digest: rec.digest, at: state.verifyCache[i].at || Date.now() };
    }
  }
  return null;
}

function renderTracker() {
  const id = state.selectedId;
  const c = state.client;
  const a = state.authority;
  const empty = $('trackEmpty'), body = $('trackBody');
  if (id == null || !c) {
    empty.hidden = false; body.hidden = true;
    return;
  }
  empty.hidden = true; body.hidden = false;
  const cs = c.states.get(id);
  const authObj = a ? a.lifecycle.find(o => o.id === id) : null;
  $('tId').textContent = id;
  $('trackLabel').textContent = cs ? cs.label : '(not in client world)';
  $('trackKind').textContent = cs ? KIND_NAME[cs.kind] : '?';
  $('tAuth').textContent = authObj
    ? `${authObj.bornTick != null ? 'born t' + authObj.bornTick : ''}${authObj.diedTick ? ' · died t' + authObj.diedTick : ' · alive'}`
    : 'unknown';
  const pushed = (a && a.digests) || [];
  const lastRec = state.lastInstall
    ? pushed.find(d => d.tick === state.lastInstall.tick) || null
    : null;
  const lastMatches = !!lastRec && lastRec.digest === state.lastInstall.digest;
  const verified = lastMatches ? lastRec : newestMatch();
  const truthNewest = pushed.length ? pushed[pushed.length - 1] : null;
  if (cs) {
    $('tClient').textContent =
      `x ${dequantizePosition(cs.px).toFixed(3)} · y ${dequantizePosition(cs.py).toFixed(3)} · ` +
      `θ ${(dequantizeRotation(cs.rot) * 180 / Math.PI).toFixed(1)}° · on ${cs.on}`;
    $('tLevels').textContent = `px ${cs.px} py ${cs.py} rot ${cs.rot} on ${cs.on} kind ${cs.kind}`;
    const truth = verified || truthNewest;
    $('tTruth').textContent = truth
      ? `t${truth.tick}: ${truth.digest.slice(0, 12)}…`
      : '-';
    if (!a || !a.digests || a.digests.length === 0) {
      $('tSync').innerHTML = `<span>installed at t${c.tick}</span>`;
    } else if (lastMatches) {
      $('tSync').innerHTML = `<span class="syncYes">world matches authority at t${c.tick}</span>`;
    } else if (lastRec) {
      // The authority reported a digest for exactly the tick we installed,
      // and it disagrees. That is a real divergence, not a lag.
      $('tSync').innerHTML = `<span class="syncNo">digest differs from authority at t${lastRec.tick}</span>`;
    } else if (verified) {
      // The authority's status push is 2 Hz; a frame installed after the last
      // push is not a disagreement, it is simply not reported yet.
      $('tSync').innerHTML = `<span class="syncYes">last verified t${verified.tick}</span>` +
        `<span class="tiny"> · status push lags client t${c.tick}</span>`;
    } else {
      $('tSync').innerHTML = `<span>installed at t${c.tick}; awaiting first cross-check</span>`;
    }
  } else {
    $('tClient').textContent = 'absent from installed world';
    $('tLevels').textContent = '-';
    $('tTruth').textContent = '-';
    $('tSync').innerHTML = `<span class="syncNo">not present</span>`;
  }
  const life = state.lifecycle.get(id) || [];
  const ul = $('trackLife');
  ul.innerHTML = '';
  if (life.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'watching for changes…';
    ul.appendChild(li);
  } else {
    for (const e of [...life].reverse().slice(0, 12)) {
      const li = document.createElement('li');
      li.textContent = `t${e.tick}  ${e.event}  ${e.detail}`;
      ul.appendChild(li);
    }
  }
}

function renderVerify() {
  const el = $('verifyState');
  const c = state.client;
  if (!c || !state.lastInstall) { el.textContent = 'waiting for first install…'; el.className = 'muted'; return; }
  const li = state.lastInstall;
  el.className = '';
  el.innerHTML =
    `last install <b>t${li.tick}</b> (${li.kind}` +
    `${li.baseTick ? ` from t${li.baseTick}` : ''}, ${li.bytes}B, ${li.applyMs.toFixed(2)}ms) ` +
    `<span class="tiny">digest ${li.digest.slice(0, 12)}…</span>`;
}

function setBar(id, value, max) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  $(id).style.width = pct.toFixed(1) + '%';
}

function setConn(text, cls) {
  $('connText').textContent = text;
  $('connDot').className = 'dot' + (cls ? ' ' + cls : '');
}

let statusLines = [];
function pushStatusLine(line) {
  statusLines.push(`[t${state.client?.tick ?? '?'}] ${line}`);
  if (statusLines.length > 4) statusLines.shift();
  $('statusLine').textContent = statusLines.join('  ·  ');
}

// ---------------------------------------------------------------------------
// Link control

function applyLinkSettings() {
  if (state.ws?.readyState !== WebSocket.OPEN) return;
  const s = state.linkSettings;
  state.ws.send(JSON.stringify({
    type: 'control', action: 'impairment',
    reorder: s.reorder, drop: s.drop, dropEveryFrames: s.dropEveryFrames,
    latencyMs: s.delay, jitterMs: s.jitter,
  }));
  state.ws.send(JSON.stringify({ type: 'control', action: 'ackDelay', ms: s.ackDelay }));
}

function readLinkInputs() {
  state.linkSettings = {
    reorder: $('optReorder').checked,
    drop: $('optDrop').checked,
    dropEveryFrames: clampInt($('dropEvery').value, 2, 30, 5),
    delay: clampInt($('optDelay').value, 0, 1200, 60),
    jitter: clampInt($('optJitter').value, 0, 600, 40),
    ackDelay: clampInt($('optAckDelay').value, 0, 2000, 200),
  };
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

$('applyLink').addEventListener('click', () => {
  readLinkInputs();
  applyLinkSettings();
  pushStatusLine('link impairment applied');
});

$('forceCheckpoint').addEventListener('click', () => {
  state.ws?.send(JSON.stringify({ type: 'control', action: 'checkpoint', reason: 'operator request' }));
  pushStatusLine('checkpoint requested by operator');
});

$('restart').addEventListener('click', () => {
  window.location.reload();
});

// Offline audit: dump what the client actually installed. The verifier replays
// the deterministic authority from the seed and checks every recorded tick.
$('runVerify').addEventListener('click', () => {
  const report = buildAuditReport();
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const aEl = document.createElement('a');
  aEl.href = url;
  aEl.download = `object-lab-audit-${Date.now()}.json`;
  aEl.click();
  URL.revokeObjectURL(url);
  $('verifySummary').textContent = `audit exported: ${report.installs.length} installs, ` +
    `${report.tracked ? 1 : 0} tracked, seed ${report.config.seed}`;
});

function buildAuditReport() {
  const c = state.client;
  const tracked = state.selectedId;
  return {
    kind: 'object-lab-audit',
    createdAt: new Date().toISOString(),
    sessionId: state.sessionId,
    seed: state.config.seed,
    config: {
      seed: state.config.seed,
      stationary: state.config.stationary,
      moving: state.config.moving,
      pulser: state.config.pulser,
      transientCap: state.config.transientCap,
      baselineBudgetBytes: state.config.baselineBudgetBytes,
      clientBaselineBudgetBytes: state.config.clientBaselineBudgetBytes,
    },
    quant: { positionStep: 0.125, positionMin: -2048, positionMax: 2047, rotLevels: 65536 },
    installs: state.verifyCache.map(i => ({ ...i })),
    peak: {
      clientBaselineBytes: c?.baselines.peakBytes ?? null,
      frameBufferBytes: c?.collector.maxBufferedBytes ?? null,
    },
    recoveries: (c?.recoveryLog || []).map(r => ({
      fromTick: r.fromTick, resolvedTick: r.resolvedTick, ticks: r.ticks,
      ms: r.ms, strategy: r.strategy, installedKind: r.installedKind,
    })),
    tracked: tracked == null ? null : {
      id: tracked,
      lifecycle: state.lifecycle.get(tracked) || [],
      path: (state.paths.get(tracked) || []).slice(-60),
    },
  };
}

// ---------------------------------------------------------------------------
// Misc

function describeObject(id) {
  const s = state.client?.states.get(id);
  if (!s) return `#${id}`;
  return `#${id} ${s.label} (${KIND_NAME[s.kind]}) on=${s.on}`;
}

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  return `${(n / 1024).toFixed(1)}KB`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

readLinkInputs();
connect();
requestAnimationFrame(draw);

// Test hooks: read-only views of what the client actually installed.
window.__labClient = () => state.client;
window.__labSelected = () => state.selectedId;
window.__labPick = (id) => selectObject(id);
window.__labServer = () => ({ authority: state.authority, serverside: state.serverside });
window.__labLifecycle = (id) => state.lifecycle.get(id) || [];
