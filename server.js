'use strict';
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const E = require('./rules');
const { COLORS } = E;

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN' });
  next();
});
app.use(express.static(__dirname + '/public'));
app.get('/healthz', (req, res) => res.send('ok'));
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 3e4, pingInterval: 10000, pingTimeout: 8000 });

const rooms = new Map();
const MAX_ROOMS = 300;
const HOLD_MS = +process.env.HOLD_MS || 2400;            // how long a no-move roll stays on screen
const REACTIONS = ['😂', '👏', '😡', '🔥', '❤️', '😭'];

const sha = t => crypto.createHash('sha256').update(t).digest();
const newToken = () => crypto.randomBytes(24).toString('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
function seatByToken(R, token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 64) return null;
  const h = sha(token);
  return COLORS.find(c => R.players[c] && same(R.players[c].th, h)) || null;
}
const clean = s => String(typeof s === 'string' ? s : 'Player').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12) || 'Player';
const isObj = o => !!o && typeof o === 'object' && !Array.isArray(o);
/* profile photo: small JPEG data URL, validated strictly (it is shown to the other players) */
const okAvatar = a => typeof a === 'string' && a.length <= 16000 && /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(a);
const avatarMap = R => { const m = {}; COLORS.forEach(c => { const p = R.players[c]; if (p && p.av) m[c] = p.av; }); return m; };
const pushAvatars = R => io.to(R.code).emit('avatars', avatarMap(R));
const mkCode = () => Array.from({ length: 4 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ'[crypto.randomInt(0, 23)]).join('');

function view(R, color) {
  const players = {};
  COLORS.forEach(c => { const p = R.players[c]; if (p) players[c] = { name: p.name, on: p.on, auto: !!(p.auto || p.left) }; });
  return {
    code: R.code, status: R.status, players, order: R.order, turn: R.turn, dice: R.dice, movable: R.movable,
    last: R.last, log: R.log, winner: R.winner, tokens: R.tokens, rules: R.rules, hold: R.hold || null,
    rematch: R.votes ? [...R.votes] : [], seq: R.seq || 0, rollSeq: R.rollSeq || 0,
    left: R.status === 'playing' ? Math.max(0, Math.ceil((R.deadline - Date.now()) / 1000)) : 0,
    tot: Math.round((R.turnMs || 25000) / 1000), me: color, isHost: color === R.host
  };
}
function broadcast(R) {
  COLORS.forEach(c => { const p = R.players[c]; if (p && p.sid) io.to(p.sid).emit('state', view(R, c)); });
}

function arm(R) {
  const p = R.players[R.turn]; let s;
  if (R.hold) s = HOLD_MS / 1000;
  else if (!p || p.left || p.auto) s = 1;
  else if (!p.on) s = Math.max(1, R.rules.offlineGraceSeconds);
  else s = R.dice != null ? R.rules.pickSeconds : R.rules.turnSeconds;
  R.turnMs = s * 1000; R.deadline = Date.now() + R.turnMs; R.seq = (R.seq || 0) + 1; R.touched = Date.now();
}
function tick(now = Date.now()) {
  for (const R of rooms.values()) {
    if (R.status !== 'playing' || now < R.deadline) continue;
    if (R.hold) { E.endHold(R); arm(R); broadcast(R); continue; }     // the shown roll has been seen: pass the turn
    const c = R.turn, p = R.players[c], bot = p.left || p.auto;
    if (!bot) {
      p.misses = (p.misses || 0) + 1;
      if (R.rules.autopilotAfterMisses && p.misses >= R.rules.autopilotAfterMisses) p.auto = true;
    }
    if (!bot && R.rules.onTimeout === 'skip') {
      R.dice = null; R.movable = []; R.sixes = 0; R.turn = E.nextTurn(R, c); R.log = `${p.name} ran out of time`;
    } else if (R.dice == null) E.rollDie(R, c);
    else E.applyMove(R, c, E.chooseMove(R, c, R.dice, R.movable), R.dice);
    arm(R); broadcast(R);
  }
}

function detach(socket) {
  const d = socket.data || {}, R = rooms.get(d.code);
  socket.data = {};
  if (!R) return;
  socket.leave(R.code);
  const p = R.players[d.color];
  if (p && p.sid === socket.id) { p.on = false; p.sid = null; broadcast(R); checkRematch(R); }
}
function attach(socket, R, color) {
  if (socket.data && socket.data.code) detach(socket);
  const p = R.players[color];
  if (p.sid && p.sid !== socket.id) {
    const old = io.sockets.sockets.get(p.sid);
    if (old) { old.emit('kicked', 'This seat was opened on another device'); old.data = {}; old.leave(R.code); }
  }
  Object.assign(p, { on: true, sid: socket.id, left: false, auto: false, misses: 0 });
  socket.data = { code: R.code, color }; socket.join(R.code); R.touched = Date.now();
  socket.emit('chatlog', R.chat || []);
  broadcast(R); pushAvatars(R);
}
function ctx(socket) {
  const d = socket.data || {}, R = rooms.get(d.code);
  const p = R && R.players[d.color];
  return p && p.sid === socket.id ? { R, c: d.color, p } : null;
}
function seat(R, name, avatar) {
  const token = newToken(), color = COLORS.find(c => !R.players[c]);
  R.players[color] = { name: clean(name), av: avatar, th: sha(token), on: false, sid: null, left: false, auto: false, misses: 0 };
  return { color, token };
}

function checkRematch(R) {
  if (R.status !== 'done' || !R.votes) return;
  const online = COLORS.filter(c => R.players[c] && R.players[c].on && !R.players[c].left);
  if (online.length < 2 || !online.every(c => R.votes.has(c))) return broadcast(R);
  COLORS.forEach(c => { if (R.players[c] && !online.includes(c)) delete R.players[c]; });
  R.order = COLORS.filter(c => R.players[c]);
  if (!R.players[R.host]) R.host = R.order[0];
  const first = R.order[((R.order.indexOf(R.starter) + 1) || 0) % R.order.length];
  R.starter = first; R.votes = null; E.startGame(R, first); R.log = 'Rematch! New game started';
  arm(R); broadcast(R);
}

io.on('connection', socket => {
  let bucket = 25, stamp = Date.now();
  socket.use((pkt, next) => {
    const n = Date.now(); bucket = Math.min(25, bucket + (n - stamp) / 100); stamp = n;
    if (bucket < 1) return next(new Error('slow down')); bucket--; next();
  });
  socket.on('error', () => {});
  const ack = cb => (typeof cb === 'function' ? cb : () => {});

  socket.on('create', (msg, cb) => {
    cb = ack(cb); if (!isObj(msg)) return cb({ error: 'Bad request' });
    if (!okAvatar(msg.avatar)) return cb({ error: 'Add your profile photo first' });
    if (rooms.size >= MAX_ROOMS) return cb({ error: 'Server is busy, try again later' });
    let code; do { code = mkCode(); } while (rooms.has(code));
    const R = { code, host: 'red', status: 'lobby', players: {}, order: [], turn: 'red', dice: null, movable: [], last: null,
      log: 'Room created', winner: null, tokens: E.fresh(), rules: { ...E.DEFAULT_RULES }, sixes: 0, miss: {}, rollSeq: 0, seq: 0, hold: null, pending: null, touched: Date.now(), chat: [] };
    rooms.set(code, R);
    const { color, token } = seat(R, msg.name, msg.avatar); attach(socket, R, color); cb({ code, token });
  });

  socket.on('join', (msg, cb) => {
    cb = ack(cb); if (!isObj(msg)) return cb({ error: 'Bad request' });
    const code = typeof msg.code === 'string' ? msg.code.toUpperCase() : '';
    const R = /^[A-Z]{4}$/.test(code) ? rooms.get(code) : null;
    if (!R) return cb({ error: 'No room with that code' });
    const mine = seatByToken(R, msg.token);
    if (mine) { if (okAvatar(msg.avatar)) R.players[mine].av = msg.avatar; attach(socket, R, mine); return cb({ code }); }
    if (!okAvatar(msg.avatar)) return cb({ error: 'Add your profile photo first' });
    if (R.status !== 'lobby') return cb({ error: 'That game has already started' });
    if (!COLORS.some(c => !R.players[c])) return cb({ error: 'Room is full' });
    const { color, token } = seat(R, msg.name, msg.avatar); attach(socket, R, color); cb({ code, token });
  });

  socket.on('rules', msg => {
    const x = ctx(socket); if (!x || x.c !== x.R.host || x.R.status !== 'lobby' || !isObj(msg)) return;
    x.R.rules = E.sanitizeRules(msg, x.R.rules); broadcast(x.R);
  });

  socket.on('start', () => {
    const x = ctx(socket); if (!x || x.c !== x.R.host || x.R.status !== 'lobby') return;
    const R = x.R; R.order = COLORS.filter(c => R.players[c]); if (R.order.length < 2) return;
    R.starter = R.order[0]; E.startGame(R, R.order[0]); arm(R); broadcast(R);
  });

  socket.on('rematch', () => {
    const x = ctx(socket); if (!x || x.R.status !== 'done') return;
    (x.R.votes = x.R.votes || new Set()).add(x.c); checkRematch(x.R);
  });

  socket.on('roll', () => {
    const x = ctx(socket); if (!x) return; const { R, c, p } = x;
    if (R.status !== 'playing' || R.turn !== c || R.dice != null || R.hold) return;
    p.misses = 0; p.auto = false; E.rollDie(R, c); arm(R); broadcast(R);
  });

  socket.on('move', i => {
    const x = ctx(socket); if (!x || !Number.isInteger(i)) return; const { R, c, p } = x;
    if (R.status !== 'playing' || R.turn !== c || R.hold || R.dice == null || !R.movable.includes(i)) return;
    p.misses = 0; p.auto = false; E.applyMove(R, c, i, R.dice); arm(R); broadcast(R);
  });

  socket.on('chat', text => {
    const x = ctx(socket); if (!x || typeof text !== 'string') return; const { R, c } = x, now = Date.now();
    if (now - (x.p.lastChat || 0) < 500) return; x.p.lastChat = now;
    text = text.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 140); if (!text) return;
    const m = { c, name: x.p.name, text, t: now };
    R.chat.push(m); if (R.chat.length > 50) R.chat.shift();
    R.touched = now; io.to(R.code).emit('chat', m);
  });

  socket.on('react', e => {
    const x = ctx(socket); if (!x || !REACTIONS.includes(e)) return; const now = Date.now();
    if (now - (x.p.lastReact || 0) < 400) return; x.p.lastReact = now;
    io.to(x.R.code).emit('react', { c: x.c, e });
  });

  socket.on('leave', () => {
    const x = ctx(socket); if (!x) return; const { R, c } = x;
    if (R.status === 'lobby') {
      detach(socket); delete R.players[c];
      const next = COLORS.find(k => R.players[k]);
      if (!next) rooms.delete(R.code); else { if (c === R.host) R.host = next; broadcast(R); pushAvatars(R); }
    } else {
      x.p.left = true; detach(socket);
      if (COLORS.every(k => !R.players[k] || R.players[k].left)) rooms.delete(R.code);
    }
  });

  socket.on('disconnect', () => detach(socket));
});

function cleanup() { for (const [k, R] of rooms) if (Date.now() - R.touched > 6 * 3600e3) rooms.delete(k); }
const start = port => new Promise(r => server.listen(port, () => r(server.address().port)));

if (require.main === module) {
  start(process.env.PORT || 3000).then(p => console.log('Ludo running on port ' + p));
  setInterval(() => tick(), 500); setInterval(cleanup, 600e3);
}
module.exports = { server, io, rooms, tick, start, E };
