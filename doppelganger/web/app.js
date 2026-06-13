// Doppelgänger dashboard renderer. Polls /api/state and renders the constellation.
// DOM is keyed per node/edge/packet and styles are only written on change, so the
// CSS animations (pulse, halo, packets) never restart between polls.

const ACCENT = '#2dffa3';
const AMBER = '#ffb83d';
const RED = '#ff5d52';
const CORE = 'core';
const POLL_MS = 2500;

const state = { win: 'live', drawerOpen: false, selected: null, data: null };

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtClock(ts) {
  try { return new Date(ts).toLocaleTimeString('en-GB', { hour12: false }); } catch { return '--:--:--'; }
}

function fmtCost(c) { return '$' + (c || 0).toFixed(2); }

// ---- starfield (generated once per load) -----------------------------------

function genStars(n, w, h) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = Math.floor(Math.random() * w);
    const y = Math.floor(Math.random() * h);
    const a = (0.06 + Math.random() * 0.26).toFixed(2);
    out.push(`${x}px ${y}px 0 rgba(140,225,180,${a})`);
  }
  return out.join(',');
}

$('stars1').style.cssText =
  'position:absolute;left:0;top:0;width:2px;height:2px;border-radius:50%;background:transparent;' +
  `box-shadow:${genStars(46, 1800, 1000)};animation:drift1 70s linear infinite;`;
$('stars2').style.cssText =
  'position:absolute;left:0;top:0;width:1px;height:1px;border-radius:50%;background:transparent;' +
  `box-shadow:${genStars(24, 1700, 950)};animation:drift2 110s linear infinite;`;

// ---- layout -----------------------------------------------------------------

function hash01(s) {
  let h = 2166136261;
  for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** CORE at center; agents on an ellipse with a deterministic per-name jitter. */
function layout(names) {
  const pos = { [CORE]: { x: 50, y: 53 } };
  const sorted = [...names].sort();
  const n = sorted.length;
  sorted.forEach((name, i) => {
    const j1 = hash01(name);
    const j2 = hash01(name + '#');
    const angle = ((-90 + (i * 360) / n + (j1 - 0.5) * 24) * Math.PI) / 180;
    const rx = 27 + (j2 - 0.5) * 10;
    const ry = 25 + (j2 - 0.5) * 8;
    pos[name] = {
      x: clamp(50 + Math.cos(angle) * rx, 12, 88),
      y: clamp(51 + Math.sin(angle) * ry, 16, 80),
    };
  });
  return pos;
}

// ---- nodes (ported from the prototype's buildNode) --------------------------

function nodeVisual(isCore, status) {
  if (isCore) return {
    col: ACCENT, glow: 'rgba(45,255,163,.7)',
    coreGlow: '0 0 12px rgba(45,255,163,.9), 0 0 28px rgba(45,255,163,.4)',
    anim: 'pulse 3.8s ease-in-out infinite', rayLen: 50, coreSize: 7, rayOp: 0.85, halo: true,
  };
  if (status === 'running') return {
    col: ACCENT, glow: 'rgba(45,255,163,.65)',
    coreGlow: '0 0 10px rgba(45,255,163,.85), 0 0 22px rgba(45,255,163,.4)',
    anim: 'pulse 1.7s ease-in-out infinite', rayLen: 38, coreSize: 6, rayOp: 0.95, halo: true,
  };
  if (status === 'error') return {
    col: RED, glow: 'rgba(255,93,82,.55)', coreGlow: '0 0 9px rgba(255,93,82,.6)',
    anim: 'breathe 5s ease-in-out infinite', rayLen: 24, coreSize: 5, rayOp: 0.7, halo: false,
  };
  if (status === 'flagged') return {
    col: AMBER, glow: 'rgba(255,184,61,.5)', coreGlow: '0 0 9px rgba(255,184,61,.55)',
    anim: 'breathe 5.5s ease-in-out infinite', rayLen: 24, coreSize: 5, rayOp: 0.7, halo: false,
  };
  if (status === 'idle') return {
    col: 'rgba(150,210,180,.4)', glow: 'transparent', coreGlow: 'none',
    anim: 'breathe 7s ease-in-out infinite', rayLen: 12, coreSize: 3.5, rayOp: 0.16, halo: false,
  };
  return { // done
    col: 'rgba(120,225,180,.7)', glow: 'rgba(45,255,163,.32)', coreGlow: '0 0 6px rgba(45,255,163,.3)',
    anim: 'breathe 5.5s ease-in-out infinite', rayLen: 20, coreSize: 4.5, rayOp: 0.5, halo: false,
  };
}

function nodeStyles(name, agent, pos, selected) {
  const isCore = name === CORE;
  const status = isCore ? null : agent.status;
  const v = nodeVisual(isCore, status);
  const active = isCore || status === 'running';
  const haloTop = 10 + v.rayLen / 2;
  const haloSize = isCore ? 96 : 76;
  const selRing = selected ? 'box-shadow:0 0 0 1px rgba(45,255,163,.45), 0 0 16px rgba(45,255,163,.22);' : '';

  let statusText = '';
  let statusStyle = 'display:none;';
  if (!isCore) {
    if (status === 'running') { statusText = '● running'; statusStyle = `font-size:8px;letter-spacing:2px;color:${ACCENT};animation:breathe 1.7s ease-in-out infinite;`; }
    else if (status === 'flagged') { statusText = '▲ flagged'; statusStyle = `font-size:8px;letter-spacing:2px;color:${AMBER};`; }
    else if (status === 'error') { statusText = '✕ error'; statusStyle = `font-size:8px;letter-spacing:2px;color:${RED};`; }
  }

  return {
    wrap: `position:absolute;left:${pos.x}%;top:${pos.y}%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;gap:${isCore ? 13 : 11}px;cursor:pointer;z-index:${isCore ? 2 : 4};padding:10px;`,
    halo: v.halo
      ? `position:absolute;left:50%;top:${haloTop}px;width:${haloSize}px;height:${haloSize}px;border-radius:50%;background:radial-gradient(circle,${v.glow},rgba(45,255,163,0) 70%);transform:translate(-50%,-50%);animation:halopulse ${isCore ? '3.8s' : '1.7s'} ease-in-out infinite;pointer-events:none;`
      : 'display:none;',
    star: `position:relative;width:${v.rayLen}px;height:${v.rayLen}px;display:flex;align-items:center;justify-content:center;border-radius:50%;animation:${v.anim};${selRing}`,
    rayH: `position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:${v.rayLen}px;height:1.5px;background:linear-gradient(90deg,transparent,${v.col} 50%,transparent);opacity:${v.rayOp};box-shadow:0 0 6px ${v.glow};`,
    rayV: `position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:1.5px;height:${v.rayLen}px;background:linear-gradient(180deg,transparent,${v.col} 50%,transparent);opacity:${v.rayOp};box-shadow:0 0 6px ${v.glow};`,
    core: `position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:${v.coreSize}px;height:${v.coreSize}px;border-radius:50%;background:${v.col};box-shadow:${v.coreGlow};`,
    label: `font-size:${isCore ? 11 : 10}px;font-weight:${isCore ? 700 : 500};letter-spacing:${isCore ? 4 : 2.5}px;color:${active ? ACCENT : 'rgba(150,210,180,.6)'};`,
    statusText, statusStyle,
  };
}

const nodeEls = new Map(); // name -> { el, parts, cache }

function setStyle(part, css, cache, key) {
  if (cache[key] !== css) { cache[key] = css; part.style.cssText = css; }
}

function renderNodes(positions, agents) {
  const container = $('nodes');
  const byName = new Map(agents.map((a) => [a.name, a]));
  const wanted = [CORE, ...byName.keys()];

  for (const [name, entry] of nodeEls) {
    if (!wanted.includes(name)) { entry.el.remove(); nodeEls.delete(name); }
  }

  for (const name of wanted) {
    let entry = nodeEls.get(name);
    if (!entry) {
      const el = document.createElement('div');
      const halo = document.createElement('div');
      const star = document.createElement('div');
      const rayH = document.createElement('div');
      const rayV = document.createElement('div');
      const core = document.createElement('div');
      const label = document.createElement('div');
      const status = document.createElement('div');
      star.append(rayH, rayV, core);
      el.append(halo, star, label, status);
      label.textContent = name === CORE ? 'CORE' : name;
      el.addEventListener('click', () => {
        state.selected = name === CORE ? null : name;
        state.drawerOpen = true;
        render();
      });
      container.appendChild(el);
      entry = { el, parts: { halo, star, rayH, rayV, core, label, status }, cache: {} };
      nodeEls.set(name, entry);
    }
    const s = nodeStyles(name, byName.get(name), positions[name], state.selected === name);
    const { parts, cache } = entry;
    setStyle(entry.el, s.wrap, cache, 'wrap');
    setStyle(parts.halo, s.halo, cache, 'halo');
    setStyle(parts.star, s.star, cache, 'star');
    setStyle(parts.rayH, s.rayH, cache, 'rayH');
    setStyle(parts.rayV, s.rayV, cache, 'rayV');
    setStyle(parts.core, s.core, cache, 'core');
    setStyle(parts.label, s.label, cache, 'label');
    setStyle(parts.status, s.statusStyle, cache, 'status');
    if (parts.status.textContent !== s.statusText) parts.status.textContent = s.statusText;
  }
}

// ---- edges + packets ---------------------------------------------------------

const edgeEls = new Map(); // key -> line element
const packetEls = new Map(); // key -> div element

function renderEdges(positions, edges) {
  const svg = $('edges');
  const wanted = new Set();
  edges.forEach((e) => {
    const pf = positions[e.from];
    const pt = positions[e.to];
    if (!pf || !pt) return;
    const key = `${e.from}→${e.to}`;
    wanted.add(key);
    let line = edgeEls.get(key);
    if (!line) {
      line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('stroke', ACCENT);
      line.setAttribute('stroke-linecap', 'round');
      line.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.appendChild(line);
      edgeEls.set(key, line);
    }
    line.setAttribute('x1', pf.x); line.setAttribute('y1', pf.y);
    line.setAttribute('x2', pt.x); line.setAttribute('y2', pt.y);
    line.setAttribute('stroke-width', e.active ? 1.4 : 0.8);
    line.setAttribute('opacity', e.active ? 0.42 : 0.13);
  });
  for (const [key, line] of edgeEls) {
    if (!wanted.has(key)) { line.remove(); edgeEls.delete(key); }
  }
}

function renderPackets(positions, edges) {
  const container = $('packets');
  const wanted = new Set();
  edges.filter((e) => e.active).forEach((e, i) => {
    const pa = positions[e.from];
    const pb = positions[e.to];
    if (!pa || !pb) return;
    const key = `${e.from}→${e.to}`;
    wanted.add(key);
    if (!packetEls.has(key)) {
      const dur = (2.0 + (i % 3) * 0.5).toFixed(1);
      const delay = ((i * 0.4) % 2).toFixed(1);
      const dot = document.createElement('div');
      dot.style.cssText =
        `position:absolute;width:5px;height:5px;border-radius:50%;background:${ACCENT};` +
        'box-shadow:0 0 9px 2px rgba(45,255,163,.85);transform:translate(-50%,-50%);' +
        `left:${pa.x}%;top:${pa.y}%;--x1:${pa.x}%;--y1:${pa.y}%;--x2:${pb.x}%;--y2:${pb.y}%;` +
        `animation:pkt ${dur}s linear infinite ${delay}s;pointer-events:none;z-index:3;`;
      container.appendChild(dot);
      packetEls.set(key, dot);
    }
  });
  for (const [key, dot] of packetEls) {
    if (!wanted.has(key)) { dot.remove(); packetEls.delete(key); }
  }
}

// ---- header ------------------------------------------------------------------

const WINDOWS = [['hour', 'HOUR'], ['today', 'TODAY'], ['live', 'LIVE']];

function renderWindows() {
  const container = $('windows');
  if (!container.childElementCount) {
    for (const [key, label] of WINDOWS) {
      const btn = document.createElement('button');
      btn.className = 'win-btn';
      btn.textContent = label;
      btn.dataset.win = key;
      btn.addEventListener('click', () => { state.win = key; refresh(); });
      container.appendChild(btn);
    }
  }
  for (const btn of container.children) btn.classList.toggle('on', btn.dataset.win === state.win);
}

function renderStats(stats) {
  $('stat-runs').textContent = stats.runs;
  $('stat-cost').textContent = fmtCost(stats.cost);
  $('stat-active').textContent = stats.active;
  $('stat-active').classList.toggle('dim', stats.active === 0);
}

// ---- drawer ------------------------------------------------------------------

function statusWord(st) { return st; }

function statusColor(st) {
  if (st === 'running') return ACCENT;
  if (st === 'flagged') return AMBER;
  if (st === 'error') return RED;
  if (st === 'idle') return 'rgba(150,210,180,.4)';
  return 'rgba(120,220,170,.65)';
}

function tagFor(row) {
  if (row.kind === 'started') return row.delegated ? ['↘', 'rgba(120,220,170,.7)'] : ['▶', 'rgba(45,255,163,.7)'];
  if (row.kind === 'died') return ['✕', RED];
  if (row.status === 'success') return ['✓', 'rgba(120,220,170,.85)'];
  if (row.status === 'flagged') return ['⚠', AMBER];
  return ['✕', RED];
}

function renderInspect(agents) {
  const el = $('inspect');
  const agent = agents.find((a) => a.name === state.selected);
  if (!agent) {
    el.innerHTML =
      '<div class="inspect-empty"><span class="diamonds">◇ ◆ ◇</span>' +
      '<span class="hint">Select a node in the constellation<br>to inspect runs,<br>cost and decisions.</span></div>';
    return;
  }
  const hist = agent.history.length ? agent.history : [0];
  const max = Math.max(...hist, 0.2);
  const bars = hist
    .map((v) => `<div style="height:${Math.max(8, Math.round((v / max) * 36))}px;"></div>`)
    .join('');
  const summary = agent.summary || (agent.running ? 'Run in progress — no summary yet.' : '—');
  el.innerHTML =
    '<div class="inspect-detail">' +
    '<div class="inspect-head"><span class="micro-label">INSPECTION</span>' +
    '<span class="inspect-back" id="inspect-back">‹ ALL EVENTS</span></div>' +
    `<div class="inspect-name">${esc(agent.name)}</div>` +
    '<div class="inspect-cards">' +
    `<div class="inspect-card"><span class="label">STATUS</span><span class="value" style="color:${statusColor(agent.status)};">${esc(statusWord(agent.status))}</span></div>` +
    `<div class="inspect-card"><span class="label">LAST COST</span><span class="value">${agent.running ? 'running…' : fmtCost(agent.cost)}</span></div>` +
    '</div>' +
    `<div class="inspect-field"><span class="label">TASK</span><span class="value">${esc(agent.task)}</span></div>` +
    `<div class="inspect-field"><span class="label">SUMMARY</span><span class="value soft">${esc(summary)}</span></div>` +
    `<div class="inspect-field"><span class="label">COST / RUN</span><div class="spark">${bars}</div></div>` +
    '</div>';
  $('inspect-back').addEventListener('click', () => { state.selected = null; render(); });
}

function renderDrawer(data) {
  $('drawer').classList.toggle('open', state.drawerOpen);
  $('caret').textContent = state.drawerOpen ? '▾' : '▴';
  $('log-count').textContent = `${data.feed.length} EVENTS`;

  const latest = data.feed[0];
  $('ticker').textContent = latest ? `${fmtClock(latest.ts)}  ${latest.agent}  ${latest.text}` : '';

  const rows = state.selected ? data.feed.filter((r) => r.agent === state.selected) : data.feed;
  $('feed-title').textContent = state.selected ? `EVENTS · ${state.selected.toUpperCase()}` : 'EVENT LOG';
  $('feed').innerHTML = rows
    .map((r) => {
      const [tag, color] = tagFor(r);
      return (
        '<div class="feed-row">' +
        `<span class="time">${fmtClock(r.ts)}</span>` +
        `<span class="tag" style="color:${color};">${tag}</span>` +
        `<span class="agent">${esc(r.agent)}</span>` +
        `<span class="text">${esc(r.text)}</span>` +
        `<span class="cost">${r.cost ? fmtCost(r.cost) : ''}</span>` +
        '</div>'
      );
    })
    .join('');

  renderInspect(data.agents);
}

$('drawer-bar').addEventListener('click', () => {
  state.drawerOpen = !state.drawerOpen;
  render();
});

// ---- main loop ----------------------------------------------------------------

function render() {
  renderWindows();
  if (!state.data) return;
  const data = state.data;
  if (state.selected && !data.agents.some((a) => a.name === state.selected)) state.selected = null;
  const positions = layout(data.agents.map((a) => a.name));
  renderStats(data.stats);
  renderNodes(positions, data.agents);
  renderEdges(positions, data.edges);
  renderPackets(positions, data.edges);
  renderDrawer(data);
}

async function refresh() {
  try {
    const res = await fetch(`/api/state?window=${state.win}`);
    if (!res.ok) return;
    state.data = await res.json();
    render();
  } catch {
    // keep the last rendered state; next poll retries
  }
}

renderWindows();
refresh();
setInterval(refresh, POLL_MS);
