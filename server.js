const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.json({ ok: true }));

const games = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REPORT_WINDOW_MS = 8000; // how long runners have to send a fresh GPS fix
const MAX_PLAYERS = 30;

const newCode = () => {
  let c;
  do { c = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join(''); }
  while (games.has(c));
  return c;
};
const clamp = (v, min, max, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d; };
const cleanName = n => String(n || '').trim().slice(0, 20);
const alive = g => [...g.players.values()].filter(p => p.role === 'runner' && p.status === 'active');
const canSee = p => p.role === 'hunter' || p.status === 'caught';

function publicState(g) {
  return {
    code: g.code, phase: g.phase, hostId: g.hostId, config: g.config,
    endsAt: g.endsAt, nextRevealAt: g.nextRevealAt, revealing: g.revealing,
    lastRevealAt: g.lastRevealAt, winner: g.winner, serverNow: Date.now(),
    players: [...g.players.values()].map(p => ({ id: p.id, name: p.name, role: p.role, status: p.status, connected: p.connected })),
  };
}
const broadcast = g => io.to(g.code).emit('state', publicState(g));
function sendLocations(g, p, quiet) {
  if (p.connected && canSee(p) && g.lastRevealAt)
    io.to(p.socketId).emit('locations:revealed', { locations: g.locations, at: g.lastRevealAt, quiet: !!quiet });
}

function assignRandom(g) {
  const ps = [...g.players.values()];
  for (let i = ps.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ps[i], ps[j]] = [ps[j], ps[i]]; }
  const h = Math.min(g.config.hunters, Math.max(1, ps.length - 1));
  ps.forEach((p, i) => { p.role = i < h ? 'hunter' : 'runner'; });
}

function startReveal(g) {
  g.revealing = true; g.fresh = {};
  g.nextRevealAt = Date.now() + g.config.revealMinutes * 60000;
  const runners = alive(g);
  g.pending = new Set(runners.filter(p => p.connected).map(p => p.id));
  runners.forEach(p => p.connected && io.to(p.socketId).emit('location:request', { timeoutMs: REPORT_WINDOW_MS }));
  if (!g.pending.size) return finishReveal(g);
  g.revealTimer = setTimeout(() => finishReveal(g), REPORT_WINDOW_MS);
  broadcast(g);
}

function finishReveal(g) {
  if (!g.revealing) return;
  clearTimeout(g.revealTimer);
  g.revealing = false;
  const locs = {};
  for (const p of alive(g)) {
    const f = g.fresh[p.id] || p.lastFix;
    if (f) locs[p.id] = { name: p.name, lat: f.lat, lng: f.lng, accuracy: f.accuracy, ts: f.ts, stale: !g.fresh[p.id] };
  }
  g.locations = locs; g.lastRevealAt = Date.now();
  for (const p of g.players.values()) {
    if (!p.connected) continue;
    if (canSee(p)) sendLocations(g, p);
    else if (p.role === 'runner') io.to(p.socketId).emit('reveal:notice', { at: g.lastRevealAt });
  }
  broadcast(g);
}

function endGame(g, winner) {
  clearTimeout(g.revealTimer);
  g.revealing = false; g.phase = 'ended'; g.winner = winner;
  broadcast(g);
}

setInterval(() => {
  const now = Date.now();
  for (const g of games.values()) {
    const anyone = [...g.players.values()].some(p => p.connected);
    if (anyone) g.emptySince = null;
    else if (!g.emptySince) g.emptySince = now;
    else if (now - g.emptySince > 2 * 3600e3) { clearTimeout(g.revealTimer); games.delete(g.code); continue; }
    if (g.phase !== 'playing') continue;
    if (now >= g.endsAt) endGame(g, 'runners');
    else if (!g.revealing && now >= g.nextRevealAt) startReveal(g);
  }
}, 1000);

io.on('connection', socket => {
  const on = (ev, fn) => socket.on(ev, (data, cb) => {
    if (typeof data === 'function') { cb = data; data = undefined; }
    cb = typeof cb === 'function' ? cb : () => {};
    try { fn(data || {}, cb); } catch (e) { console.error(e); cb({ ok: false, error: 'Server error' }); }
  });
  const ctx = () => {
    const g = games.get(socket.data.code);
    const p = g && g.players.get(socket.data.pid);
    return g && p ? { g, p } : {};
  };
  const hostCtx = () => { const { g, p } = ctx(); return g && g.hostId === p.id ? { g, p } : {}; };
  const attach = (g, p) => { p.socketId = socket.id; p.connected = true; socket.data = { code: g.code, pid: p.id }; socket.join(g.code); };

  on('game:create', ({ name, playerId }, cb) => {
    name = cleanName(name);
    if (!name || !playerId) return cb({ ok: false, error: 'Enter a name' });
    const g = {
      code: newCode(), hostId: playerId, phase: 'lobby', players: new Map(), winner: null,
      config: { hunters: 1, totalMinutes: 30, revealMinutes: 5, roleMode: 'random' },
      endsAt: null, nextRevealAt: null, revealing: false, locations: {}, lastRevealAt: null, fresh: {}, pending: new Set(),
    };
    const p = { id: String(playerId), name, role: null, status: 'active', connected: true, lastFix: null };
    g.players.set(p.id, p); games.set(g.code, g);
    attach(g, p); broadcast(g);
    cb({ ok: true, code: g.code, playerId: p.id });
  });

  on('game:join', ({ code, name, playerId }, cb) => {
    const g = games.get(String(code || '').toUpperCase().trim());
    if (!g) return cb({ ok: false, error: 'Game not found. Check the code.' });
    let p = g.players.get(String(playerId));
    if (p) { attach(g, p); }
    else {
      name = cleanName(name);
      if (!name || !playerId) return cb({ ok: false, error: 'Enter a name' });
      if (g.phase !== 'lobby') return cb({ ok: false, error: 'This game has already started.' });
      if (g.players.size >= MAX_PLAYERS) return cb({ ok: false, error: 'Game is full.' });
      if ([...g.players.values()].some(x => x.name.toLowerCase() === name.toLowerCase())) return cb({ ok: false, error: 'That name is taken.' });
      p = { id: String(playerId), name, role: null, status: 'active', connected: true, lastFix: null };
      g.players.set(p.id, p); attach(g, p);
    }
    broadcast(g); sendLocations(g, p, true);
    cb({ ok: true, code: g.code, playerId: p.id, name: p.name });
  });

  on('game:leave', (_, cb) => {
    const { g, p } = ctx();
    if (g) {
      socket.leave(g.code);
      if (g.phase === 'lobby') g.players.delete(p.id); else p.connected = false;
      if (g.hostId === p.id && g.phase === 'lobby') { const next = [...g.players.values()][0]; if (next) g.hostId = next.id; }
      broadcast(g);
    }
    socket.data = {}; cb({ ok: true });
  });

  on('lobby:config', (c, cb) => {
    const { g } = hostCtx();
    if (!g || g.phase !== 'lobby') return cb({ ok: false });
    const cfg = g.config;
    cfg.hunters = clamp(c.hunters, 1, 29, cfg.hunters);
    cfg.totalMinutes = clamp(c.totalMinutes, 1, 600, cfg.totalMinutes);
    cfg.revealMinutes = clamp(c.revealMinutes, 1, 120, cfg.revealMinutes);
    if (c.roleMode === 'random' || c.roleMode === 'manual') {
      if (c.roleMode === 'random' && cfg.roleMode !== 'random') g.players.forEach(p => { p.role = null; });
      cfg.roleMode = c.roleMode;
    }
    broadcast(g); cb({ ok: true });
  });

  on('lobby:setRole', ({ playerId, role }, cb) => {
    const { g } = hostCtx();
    const p = g && g.players.get(playerId);
    if (!p || g.phase !== 'lobby' || g.config.roleMode !== 'manual') return cb({ ok: false });
    p.role = role === 'hunter' || role === 'runner' ? role : null;
    broadcast(g); cb({ ok: true });
  });

  on('lobby:randomize', (_, cb) => {
    const { g } = hostCtx();
    if (!g || g.phase !== 'lobby') return cb({ ok: false });
    g.config.roleMode = 'manual'; assignRandom(g); broadcast(g); cb({ ok: true });
  });

  on('game:start', (_, cb) => {
    const { g } = hostCtx();
    if (!g || g.phase !== 'lobby') return cb({ ok: false, error: 'Only the host can start' });
    const ps = [...g.players.values()];
    if (ps.length < 2) return cb({ ok: false, error: 'You need at least 2 players.' });
    if (g.config.roleMode === 'random') assignRandom(g);
    if (ps.some(p => !p.role)) return cb({ ok: false, error: 'Assign a role to every player.' });
    if (!ps.some(p => p.role === 'hunter') || !ps.some(p => p.role === 'runner'))
      return cb({ ok: false, error: 'You need at least one hunter and one runner.' });
    const now = Date.now();
    g.phase = 'playing';
    g.endsAt = now + g.config.totalMinutes * 60000;
    g.nextRevealAt = now + g.config.revealMinutes * 60000;
    broadcast(g); cb({ ok: true });
  });

  on('game:end', (_, cb) => {
    const { g } = hostCtx();
    if (!g || g.phase !== 'playing') return cb({ ok: false });
    endGame(g, null); cb({ ok: true });
  });

  on('location:report', f => {
    const { g, p } = ctx();
    if (!g || p.role !== 'runner' || g.phase !== 'playing') return;
    if (f.error) {
      if (g.revealing && g.pending.delete(p.id) && !g.pending.size) finishReveal(g);
      return;
    }
    const lat = Number(f.lat), lng = Number(f.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    const fix = { lat, lng, accuracy: Number(f.accuracy) || null, ts: Number(f.ts) || Date.now() };
    p.lastFix = fix;
    if (g.revealing && g.pending.has(p.id)) {
      g.fresh[p.id] = fix; g.pending.delete(p.id);
      if (!g.pending.size) finishReveal(g);
    }
  });

  on('runner:caught', (_, cb) => {
    const { g, p } = ctx();
    if (!g || g.phase !== 'playing' || p.role !== 'runner' || p.status !== 'active') return cb({ ok: false });
    p.status = 'caught'; g.pending.delete(p.id);
    if (!alive(g).length) endGame(g, 'hunters');
    else { broadcast(g); sendLocations(g, p, true); if (g.revealing && !g.pending.size) finishReveal(g); }
    cb({ ok: true });
  });

  socket.on('disconnect', () => {
    const { g, p } = ctx();
    if (!g || p.socketId !== socket.id) return;
    p.connected = false;
    if (g.phase === 'lobby' && p.id !== g.hostId) g.players.delete(p.id);
    broadcast(g);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Manhunt server on http://localhost:${PORT}`));
