const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(express.static(__dirname + '/public'));
const server = http.createServer(app);
const io = new Server(server);

const COLORS = ['red', 'green', 'yellow', 'blue'];
const START = { red: 0, green: 13, yellow: 26, blue: 39 };
const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const abs = (c, p) => (START[c] + p) % 52;
const fresh = () => ({ red: [-1,-1,-1,-1], green: [-1,-1,-1,-1], yellow: [-1,-1,-1,-1], blue: [-1,-1,-1,-1] });
const rooms = new Map();

/* ---------- rules (the server is the only place they run) ---------- */
function movable(R, c, d) {
  const r = [];
  R.tokens[c].forEach((p, i) => { if (p < 0) { if (d === 6) r.push(i); } else if (p + d <= 56) r.push(i); });
  return r;
}
const nm = (R, c) => R.players[c].name;
const nextTurn = (R, c) => R.order[(R.order.indexOf(c) + 1) % R.order.length];

function applyMove(R, c, i, d) {
  const T = R.tokens;
  let p = T[c][i]; p = p < 0 ? 0 : p + d; T[c][i] = p;
  let cap = null;
  if (p <= 50 && !SAFE.has(abs(c, p))) {
    R.order.forEach(o => {
      if (o === c) return;
      const hits = [];
      T[o].forEach((q, j) => { if (q >= 0 && q <= 50 && abs(o, q) === abs(c, p)) hits.push(j); });
      if (hits.length === 1) { T[o][hits[0]] = -1; cap = o; }
    });
  }
  R.dice = null; R.movable = []; R.last = { c, d };
  let msg = `${nm(R, c)} moved ${d}`;
  if (cap) msg += `, sent ${nm(R, cap)} home`;
  if (p === 56) msg += ', a token got home!';
  if (T[c].every(q => q === 56)) { R.status = 'done'; R.winner = c; R.log = `${nm(R, c)} wins!`; return; }
  R.turn = (d === 6 || cap || p === 56) ? c : nextTurn(R, c);
  R.log = msg;
}

const TURN_MS = +process.env.TURN_MS || 25000;
function arm(R) {
  const p = R.players[R.turn];
  R.turnMs = p && p.on ? (R.dice != null ? 12000 : TURN_MS) : 2500;
  R.deadline = Date.now() + R.turnMs;
  R.seq = (R.seq || 0) + 1; R.touched = Date.now();
}
function doRoll(R, c) {
  const d = 1 + Math.floor(Math.random() * 6), mv = movable(R, c, d);
  R.last = { c, d }; R.rollSeq = (R.rollSeq || 0) + 1;
  if (mv.length === 1) applyMove(R, c, mv[0], d);
  else if (mv.length === 0) { R.log = `${nm(R, c)} rolled ${d}, no move`; R.turn = nextTurn(R, c); }
  else { R.dice = d; R.movable = mv; R.log = `${nm(R, c)} rolled ${d}`; }
  arm(R); broadcast(R);
}
function doPick(R, c, i) { applyMove(R, c, i, R.dice); arm(R); broadcast(R); }

/* ---------- rooms ---------- */
function view(R, color) {
  const players = {};
  COLORS.forEach(c => { if (R.players[c]) players[c] = { name: R.players[c].name, on: R.players[c].on }; });
  return {
    code: R.code, status: R.status, players, order: R.order, turn: R.turn, dice: R.dice,
    movable: R.movable, last: R.last, log: R.log, winner: R.winner, tokens: R.tokens,
    seq: R.seq || 0, rollSeq: R.rollSeq || 0,
    left: R.status === 'playing' ? Math.max(0, Math.ceil((R.deadline - Date.now()) / 1000)) : 0,
    tot: Math.round((R.turnMs || TURN_MS) / 1000),
    me: color, isHost: R.players[color] && R.players[color].pid === R.host
  };
}
function broadcast(R) {
  COLORS.forEach(c => { const p = R.players[c]; if (p && p.sid) io.to(p.sid).emit('state', view(R, c)); });
}
function attach(socket, R, color) {
  const p = R.players[color];
  p.on = true; p.sid = socket.id; R.touched = Date.now();
  socket.join(R.code); socket.data = { code: R.code, color };
  socket.emit('chatlog', R.chat || []);
  broadcast(R);
}
const clean = s => String(s || 'Player').replace(/[<>]/g, '').trim().slice(0, 12) || 'Player';

io.on('connection', socket => {
  const ctx = () => { const R = rooms.get(socket.data && socket.data.code); return R ? { R, c: socket.data.color } : null; };

  socket.on('create', ({ name, pid }, cb) => {
    let code;
    do { code = Array.from({ length: 4 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ'[Math.floor(Math.random() * 23)]).join(''); } while (rooms.has(code));
    const R = { code, host: pid, status: 'lobby', players: { red: { pid, name: clean(name), on: false } }, order: [], turn: 'red',
      dice: null, movable: [], last: null, log: 'Room created', winner: null, tokens: fresh(), touched: Date.now() };
    rooms.set(code, R); attach(socket, R, 'red'); cb && cb({ code });
  });

  socket.on('join', ({ code, name, pid }, cb) => {
    const R = rooms.get(String(code || '').toUpperCase());
    if (!R) return cb && cb({ error: 'No room with that code' });
    let color = COLORS.find(c => R.players[c] && R.players[c].pid === pid);
    if (!color) {
      if (R.status !== 'lobby') return cb && cb({ error: 'That game has already started' });
      color = COLORS.find(c => !R.players[c]);
      if (!color) return cb && cb({ error: 'Room is full' });
      R.players[color] = { pid, name: clean(name), on: false };
    }
    attach(socket, R, color); cb && cb({ code: R.code });
  });

  socket.on('start', () => {
    const x = ctx(); if (!x || x.R.players[x.c].pid !== x.R.host) return;
    const R = x.R; if (R.status === 'playing') return;
    R.order = COLORS.filter(c => R.players[c]); if (R.order.length < 2) return;
    Object.assign(R, { status: 'playing', turn: R.order[0], tokens: fresh(), dice: null, movable: [], last: null, winner: null, log: 'Game started' });
    arm(R); broadcast(R);
  });

  socket.on('roll', () => {
    const x = ctx(); if (!x) return; const { R, c } = x;
    if (R.status !== 'playing' || R.turn !== c || R.dice != null) return;
    doRoll(R, c);
  });

  socket.on('move', i => {
    const x = ctx(); if (!x) return; const { R, c } = x;
    if (R.status !== 'playing' || R.turn !== c || R.dice == null || !R.movable.includes(i)) return;
    doPick(R, c, i);
  });

  socket.on('chat', text => {
    const x = ctx(); if (!x) return; const { R, c } = x; const now = Date.now();
    if (now - (socket.data.lt || 0) < 500) return; socket.data.lt = now;
    text = String(text || '').replace(/[<>]/g, '').trim().slice(0, 140); if (!text) return;
    const m = { c, name: nm(R, c), text, t: now };
    (R.chat = R.chat || []).push(m); if (R.chat.length > 50) R.chat.shift();
    R.touched = now; io.to(R.code).emit('chat', m);
  });

  socket.on('react', e => {
    const x = ctx(); if (!x || !['😂','👏','😡','🔥','❤️','😭'].includes(e)) return; const now = Date.now();
    if (now - (socket.data.lr || 0) < 400) return; socket.data.lr = now;
    io.to(x.R.code).emit('react', { c: x.c, e });
  });

  socket.on('leave', () => {
    const x = ctx(); if (!x) return; const { R, c } = x;
    socket.leave(R.code); socket.data = {};
    if (R.status === 'lobby') {
      const wasHost = R.players[c].pid === R.host; delete R.players[c];
      const next = COLORS.find(k => R.players[k]);
      if (!next) rooms.delete(R.code); else { if (wasHost) R.host = R.players[next].pid; broadcast(R); }
    } else { R.players[c].on = false; R.players[c].sid = null; broadcast(R); }
  });

  socket.on('disconnect', () => {
    const x = ctx(); if (!x) return; const p = x.R.players[x.c];
    if (p && p.sid === socket.id) { p.on = false; p.sid = null; broadcast(x.R); }
  });
});

// turn timer: idle or offline players are played automatically
setInterval(() => {
  const now = Date.now();
  for (const R of rooms.values()) {
    if (R.status !== 'playing' || now < R.deadline) continue;
    if (R.dice == null) doRoll(R, R.turn); else doPick(R, R.turn, R.movable[Math.floor(Math.random() * R.movable.length)]);
  }
}, 500);

// forget rooms nobody has touched for 6 hours
setInterval(() => { for (const [k, R] of rooms) if (Date.now() - R.touched > 6 * 3600e3) rooms.delete(k); }, 600e3);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Ludo running on port ' + PORT));
