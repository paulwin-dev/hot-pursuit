(() => {
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => 'p' + Math.random().toString(36).slice(2) + Date.now().toString(36);
const fmt = ms => { ms = Math.max(0, Math.ceil(ms / 1000)); const h = Math.floor(ms / 3600), m = Math.floor(ms % 3600 / 60), s = ms % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };

if (!localStorage.getItem('mh_pid')) localStorage.setItem('mh_pid', uid());
const S = { pid: localStorage.getItem('mh_pid'), code: null, mode: null, pendingCode: null, state: null, offset: 0,
  fix: null, watchId: null, locations: {}, map: null, fitted: false, announced: false, qrFor: null };
const socket = io({ transports: ['websocket', 'polling'] });
const me = () => S.state && S.state.players.find(p => p.id === S.pid);
const isHost = () => S.state && S.state.hostId === S.pid;
const canSee = p => p && (p.role === 'hunter' || p.status === 'caught');

function show(id) { document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== id); }
function toast(msg, kind) {
  const t = document.createElement('div'); t.className = 'toast ' + (kind || ''); t.textContent = msg;
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), 4500);
  if (kind === 'warn' && navigator.vibrate) navigator.vibrate([200, 100, 200]);
}
const session = { get: () => { try { return JSON.parse(localStorage.getItem('mh_session')); } catch { return null; } },
  set: v => localStorage.setItem('mh_session', JSON.stringify(v)), clear: () => localStorage.removeItem('mh_session') };

/* ---------- Home / join / host ---------- */
$('#goJoin').onclick = () => { S.mode = 'join'; show('v-code'); $('#codeInput').focus(); };
$('#goHost').onclick = () => { S.mode = 'host'; $('#nameTitle').textContent = 'Your name'; show('v-name'); $('#nameInput').focus(); };
document.querySelectorAll('[data-back]').forEach(b => b.onclick = () => show('v-home'));
$('#codeNext').onclick = () => {
  const c = $('#codeInput').value.trim().toUpperCase();
  if (c.length !== 4) return toast('Enter the 4-letter code', 'err');
  S.pendingCode = c; $('#nameTitle').textContent = 'Your name · ' + c; show('v-name'); $('#nameInput').focus();
};
$('#codeInput').onkeydown = e => { 
  if (e.key === 'Enter') $('#codeNext').click(); 
};

$('#nameInput').onkeydown = e => { 
  if (e.key === 'Enter') $('#nameNext').click(); 
};
$('#nameNext').onclick = () => {
  const name = $('#nameInput').value.trim();
  if (!name) return toast('Enter a name', 'err');
  localStorage.setItem('mh_name', name);
  if (S.mode === 'host') enter('game:create', { name, playerId: S.pid });
  else enter('game:join', { code: S.pendingCode, name, playerId: S.pid });
};
function enter(ev, payload, restoring) {
  socket.emit(ev, payload, res => {
    if (!res || !res.ok) {
      if (restoring) { session.clear(); show('v-home'); } else toast((res && res.error) || 'Something went wrong', 'err');
      return;
    }
    S.code = res.code; session.set({ code: res.code });
    startWatch();
  });
}
$('#btnLeave').onclick = () => socket.emit('game:leave', {}, leaveLocal);
$('#btnHome').onclick = leaveLocal;
function leaveLocal() { session.clear(); S.code = null; S.state = null; S.announced = false; S.fitted = false; S.locations = {}; $('#endOverlay').hidden = true; history.replaceState(null, '', '/'); show('v-home'); }

socket.on('connect', () => { // first connect and every reconnect
  const s = session.get();
  if (s && s.code) enter('game:join', { code: s.code, playerId: S.pid, name: localStorage.getItem('mh_name') || '' }, true);
});

/* ---------- State ---------- */
socket.on('state', st => {
  if (!S.code) return;
  S.state = st; S.offset = st.serverNow - Date.now();
  if (!me()) return leaveLocal();
  if (st.phase === 'lobby') { show('v-lobby'); renderLobby(); }
  else { show('v-game'); renderGame(); }
  $('#endOverlay').hidden = st.phase !== 'ended';
  if (st.phase === 'ended') renderEnd();
});

/* ---------- Lobby ---------- */
function renderLobby() {
  const st = S.state, host = isHost(), cfg = st.config;
  $('#lobbyCode').textContent = st.code;
  const url = location.origin + '/?code=' + st.code;
  $('#shareUrl').textContent = url.replace(/^https?:\/\//, '');
  if (S.qrFor !== url) { S.qrFor = url; $('#qr').innerHTML = ''; new QRCode($('#qr'), { text: url, width: 132, height: 132, correctLevel: QRCode.CorrectLevel.M }); }
  const manual = cfg.roleMode === 'manual';
  document.querySelectorAll('#cfgMode button').forEach(b => { b.classList.toggle('on', b.dataset.mode === cfg.roleMode); b.disabled = !host; });
  for (const [id, v] of [['#cfgHunters', cfg.hunters], ['#cfgTotal', cfg.totalMinutes], ['#cfgReveal', cfg.revealMinutes]]) {
    const el = $(id); el.disabled = !host; if (document.activeElement !== el) el.value = v;
  }
  $('#rowHunters').hidden = manual;
  $('#btnShuffle').hidden = !(host && manual);
  $('#btnStart').hidden = !host; $('#waiting').hidden = host;
  $('#pc').textContent = st.players.length;
  $('#plist').innerHTML = st.players.map(p => {
    const role = manual && host
      ? `<select data-pid="${esc(p.id)}" aria-label="Role for ${esc(p.name)}"><option value="">Unassigned</option><option value="hunter"${p.role === 'hunter' ? ' selected' : ''}>Hunter</option><option value="runner"${p.role === 'runner' ? ' selected' : ''}>Runner</option></select>`
      : manual && p.role ? `<span class="chip ${p.role}">${p.role}</span>` : '';
    return `<li><span class="dot ${p.connected ? '' : 'off'}"></span><span class="name">${esc(p.name)}${p.id === st.hostId ? ' <span class="muted small">(host)</span>' : ''}</span>${role}</li>`;
  }).join('');
  updateGps();
}
$('#plist').onchange = e => { if (e.target.dataset.pid) socket.emit('lobby:setRole', { playerId: e.target.dataset.pid, role: e.target.value }); };
$('#cfgMode').onclick = e => { if (e.target.dataset.mode) sendCfg({ roleMode: e.target.dataset.mode }); };
['#cfgHunters', '#cfgTotal', '#cfgReveal'].forEach(id => $(id).onchange = () => sendCfg({}));
function sendCfg(extra) {
  socket.emit('lobby:config', Object.assign({ hunters: $('#cfgHunters').value, totalMinutes: $('#cfgTotal').value, revealMinutes: $('#cfgReveal').value }, extra));
}
$('#btnShuffle').onclick = () => socket.emit('lobby:randomize');
$('#btnStart').onclick = () => socket.emit('game:start', {}, r => r && !r.ok && toast(r.error, 'err'));
$('#btnEnd').onclick = () => confirm('End the game for everyone?') && socket.emit('game:end');

/* ---------- Geolocation ---------- */
function startWatch() {
  if (S.watchId != null || !navigator.geolocation) return updateGps();
  S.watchId = navigator.geolocation.watchPosition(p => {
    S.fix = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, ts: p.timestamp, recv: Date.now() };
    S.gpsErr = null; updateGps(); updateMe();
  }, e => { S.gpsErr = e.code === 1 ? 'Location permission denied' : 'No GPS signal'; updateGps(); },
  { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}
function updateGps() {
  let txt, cls = 'chip';
  if (!navigator.geolocation) { txt = 'GPS unavailable'; cls += ' bad'; }
  else if (S.gpsErr) { txt = S.gpsErr; cls += ' bad'; }
  else if (!S.fix) txt = 'Finding GPS…';
  else { txt = 'GPS ±' + Math.round(S.fix.accuracy) + ' m'; cls += S.fix.accuracy <= 20 ? ' ok' : ''; }
  ['#gpsLobby', '#gpsGame'].forEach(id => { const el = $(id); el.textContent = txt; el.className = cls; });
}
// On request, wait up to 6s for the most accurate fresh fix (stops early at <=10 m).
function gather() {
  return new Promise(resolve => {
    const t0 = Date.now(); let best = null;
    const iv = setInterval(() => {
      const f = S.fix;
      if (f && f.recv >= t0 - 3000 && (!best || f.accuracy < best.accuracy)) best = f;
      if ((best && best.accuracy <= 10) || Date.now() - t0 > 6000) {
        clearInterval(iv); const o = best || S.fix;
        resolve(o ? { lat: o.lat, lng: o.lng, accuracy: o.accuracy, ts: o.ts } : { error: 'no_fix' });
      }
    }, 250);
  });
}
socket.on('location:request', async () => socket.emit('location:report', await gather()));
socket.on('reveal:notice', () => toast('Location revealed', 'warn'));
socket.on('locations:revealed', d => {
  S.locations = d.locations || {}; S.lastRevealAt = d.at;
  drawRunners();
  if (!d.quiet) toast('Locations revealed', 'warn');
});

/* ---------- Game ---------- */
let wakeLock = null;
async function keepAwake() { try { if (navigator.wakeLock && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.onrelease = () => wakeLock = null; } } catch {} }
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && S.state && S.state.phase === 'playing' && keepAwake());

function initMap() {
  if (S.map) return;
  S.map = L.map('map', { zoomControl: false, attributionControl: true }).setView([52.52, 13.405], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '' }).addTo(S.map);
  S.runnerLayer = L.layerGroup().addTo(S.map);
  S.meLayer = L.layerGroup().addTo(S.map);
}
function renderGame() {
  const st = S.state, m = me();
  initMap(); setTimeout(() => S.map.invalidateSize(), 50);
  keepAwake();
  const label = m.status === 'caught' ? 'out' : m.role;
  $('#roleChip').textContent = label[0].toUpperCase() + label.slice(1);
  $('#roleChip').className = 'chip ' + m.role;
  $('#btnCaught').hidden = !(st.phase === 'playing' && m.role === 'runner' && m.status === 'active');
  $('#btnEnd').hidden = !(isHost() && st.phase === 'playing');
  const runners = st.players.filter(p => p.role === 'runner');
  const free = runners.filter(p => p.status === 'active').length;
  $('#freeCount').textContent = `${free} of ${runners.length} runners free`;
  $('#runnerList').innerHTML = runners.map(p => `<li class="${p.status === 'caught' ? 'out' : ''}">${esc(p.name)}</li>`).join('');
  if (!S.announced && st.phase === 'playing') {
    S.announced = true;
    toast(m.role === 'hunter' ? 'You are a hunter. Find the runners.' : 'You are a runner. Stay hidden.', 'warn');
  }
  drawRunners(); updateMe(); updateGps();
}
function updateMe() {
  if (!S.map || !S.fix) return;
  S.meLayer.clearLayers();
  const ll = [S.fix.lat, S.fix.lng];
  L.circle(ll, { radius: S.fix.accuracy, color: '#4d8dff', weight: 1, fillOpacity: .1 }).addTo(S.meLayer);
  L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#4d8dff', fillOpacity: 1 }).addTo(S.meLayer);
  if (!S.centered) { S.centered = true; S.map.setView(ll, 17); }
}
function drawRunners() {
  if (!S.map || !S.state) return;
  S.runnerLayer.clearLayers();
  if (!canSee(me())) return;
  const pts = [];
  for (const [id, l] of Object.entries(S.locations)) {
    const p = S.state.players.find(x => x.id === id);
    const out = p && p.status === 'caught';
    const col = out ? '#7d8799' : '#35d6c4', ll = [l.lat, l.lng];
    pts.push(ll);
    if (l.accuracy) L.circle(ll, { radius: l.accuracy, color: col, weight: 1, fillOpacity: .12 }).addTo(S.runnerLayer);
    L.circleMarker(ll, { radius: 9, color: '#fff', weight: 3, fillColor: col, fillOpacity: 1 })
      .bindTooltip(esc(l.name) + (l.stale ? ' (old fix)' : ''), { permanent: true, direction: 'top', offset: [0, -10], className: 'nm' })
      .addTo(S.runnerLayer);
  }
  if (pts.length && !S.fitted) { S.fitted = true; fit(); }
}
function fit() {
  const pts = Object.values(S.locations).map(l => [l.lat, l.lng]);
  if (S.fix) pts.push([S.fix.lat, S.fix.lng]);
  if (pts.length) S.map.fitBounds(pts, { padding: [70, 150], maxZoom: 18 });
}
$('#btnFit').onclick = fit;
$('#btnMe').onclick = () => S.fix && S.map.setView([S.fix.lat, S.fix.lng], Math.max(S.map.getZoom(), 17));

let armed = null;
$('#btnCaught').onclick = e => {
  const b = e.currentTarget;
  if (!armed) { b.textContent = 'Tap again to confirm'; armed = setTimeout(() => { armed = null; b.textContent = 'I was caught'; }, 4000); return; }
  clearTimeout(armed); armed = null; b.textContent = 'I was caught';
  socket.emit('runner:caught', {}, r => r && r.ok && toast('You are out. You can still follow the hunt.'));
};

setInterval(() => {
  const st = S.state; if (!st || st.phase !== 'playing') return;
  const now = Date.now() + S.offset;
  $('#timeLeft').textContent = fmt(st.endsAt - now);
  $('#nextReveal').textContent = st.revealing ? 'now' : fmt(st.nextRevealAt - now);
  if (S.lastRevealAt) { const m = Math.floor((now - S.lastRevealAt) / 60000); $('#lastReveal').textContent = (m < 1 ? 'Revealed just now' : `Revealed ${m} min ago`); }
  else $('#lastReveal').textContent = 'No reveal yet';
}, 500);

function renderEnd() {
  const w = S.state.winner, m = me();
  const won = w && m && ((w === 'hunters') === (m.role === 'hunter'));
  $('#endTitle').textContent = w === 'hunters' ? 'Hunters win' : w === 'runners' ? 'Runners win' : 'Game ended';
  $('#endText').textContent = w === 'hunters' ? 'Every runner was caught.' : w === 'runners' ? 'Time ran out with runners still free.' : 'The host ended the game.';
  if (w && won) $('#endTitle').textContent += ' · you won';
  if (wakeLock) wakeLock.release();
}

/* ---------- Deep link: /?code=ABCD (QR code) skips the code step ---------- */
const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode && urlCode.length === 4) {
  session.clear();
  S.mode = 'join'; S.pendingCode = urlCode.toUpperCase();
  $('#nameTitle').textContent = 'Your name · ' + S.pendingCode;
  $('#nameInput').value = localStorage.getItem('mh_name') || '';
  show('v-name');
}
})();
