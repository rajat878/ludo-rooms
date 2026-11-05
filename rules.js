'use strict';
/* Ludo rules engine: pure functions over a room object R.
   R needs: rules, order, players{color:{name}}, tokens, turn, dice, movable, last, sixes, miss, status, winner, finished, log */
const crypto = require('crypto');

const COLORS = ['red', 'green', 'yellow', 'blue'];
const START = { red: 0, green: 13, yellow: 26, blue: 39 };
const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const ORD = ['1st', '2nd', '3rd', '4th'];

const DEFAULT_RULES = {
  exitOn: 'six',
  extraTurnOnSix: true,
  maxConsecutiveSixes: 3,
  extraTurnOnCapture: true,
  extraTurnOnHome: true,
  safeSquares: true,
  stackProtect: true,
  exactHome: true,
  pitySixAfter: 0,
  turnSeconds: 25,
  pickSeconds: 12,
  onTimeout: 'auto',
  autopilotAfterMisses: 2,
  offlineGraceSeconds: 8
};
const SPEC = {
  exitOn: { t: 'enum', v: ['six', 'one_or_six'] },
  extraTurnOnSix: { t: 'bool' }, extraTurnOnCapture: { t: 'bool' }, extraTurnOnHome: { t: 'bool' },
  safeSquares: { t: 'bool' }, stackProtect: { t: 'bool' }, exactHome: { t: 'bool' },
  maxConsecutiveSixes: { t: 'int', min: 0, max: 5 }, pitySixAfter: { t: 'int', min: 0, max: 30 },
  turnSeconds: { t: 'int', min: 10, max: 90 }, pickSeconds: { t: 'int', min: 5, max: 45 },
  onTimeout: { t: 'enum', v: ['auto', 'skip'] },
  autopilotAfterMisses: { t: 'int', min: 0, max: 6 }, offlineGraceSeconds: { t: 'int', min: 0, max: 60 }
};
function sanitizeRules(input, base = DEFAULT_RULES) {
  const out = { ...base };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const k of Object.keys(SPEC)) {
    if (!Object.prototype.hasOwnProperty.call(input, k)) continue;
    const s = SPEC[k], v = input[k];
    if (s.t === 'bool' && typeof v === 'boolean') out[k] = v;
    else if (s.t === 'int' && Number.isInteger(v)) out[k] = Math.min(s.max, Math.max(s.min, v));
    else if (s.t === 'enum' && s.v.includes(v)) out[k] = v;
  }
  return out;
}

const abs = (c, p) => (START[c] + p) % 52;
const fresh = () => ({ red: [-1, -1, -1, -1], green: [-1, -1, -1, -1], yellow: [-1, -1, -1, -1], blue: [-1, -1, -1, -1] });
/* next player who has not finished yet */
const nextTurn = (R, c) => {
  const n = R.order.length, i = R.order.indexOf(c), fin = R.finished || [];
  for (let k = 1; k <= n; k++) { const o = R.order[(i + k) % n]; if (!fin.includes(o)) return o; }
  return c;
};
const nm = (R, c) => (R.players[c] && R.players[c].name) || c;
const canExit = (rules, d) => d === 6 || (rules.exitOn === 'one_or_six' && d === 1);

function startGame(R, first) {
  Object.assign(R, { status: 'playing', turn: first, tokens: fresh(), dice: null, movable: [], last: null,
    winner: null, finished: [], sixes: 0, miss: {}, hold: null, pending: null, log: 'Game started' });
}

function movable(R, c, d) {
  const r = [];
  R.tokens[c].forEach((p, i) => {
    if (p < 0) { if (canExit(R.rules, d)) r.push(i); }
    else if (!R.rules.exactHome || p + d <= 56) r.push(i);
  });
  return r;
}

function victims(R, c, p) {
  if (p > 50) return [];
  const a = abs(c, p);
  if (R.rules.safeSquares && SAFE.has(a)) return [];
  const v = [];
  for (const o of R.order) {
    if (o === c) continue;
    const hit = [];
    R.tokens[o].forEach((q, j) => { if (q >= 0 && q <= 50 && abs(o, q) === a) hit.push(j); });
    if (hit.length && !(R.rules.stackProtect && hit.length >= 2)) hit.forEach(j => v.push([o, j]));
  }
  return v;
}

function applyMove(R, c, i, d) {
  const T = R.tokens;
  let p = T[c][i]; p = p < 0 ? 0 : Math.min(56, p + d); T[c][i] = p;
  const v = victims(R, c, p); v.forEach(([o, j]) => { T[o][j] = -1; });
  const hit = [...new Set(v.map(x => x[0]))];
  R.dice = null; R.movable = []; R.last = { c, d };
  let msg = `${nm(R, c)} moved ${d}`;
  if (hit.length) msg += `, sent ${hit.map(o => nm(R, o)).join(' & ')} home`;
  if (p === 56) msg += ', a token got home!';

  if (T[c].every(q => q === 56)) {                 // this player finished all 4 tokens
    R.finished = R.finished || []; R.finished.push(c); R.sixes = 0;
    const rest = R.order.filter(o => !R.finished.includes(o));
    if (rest.length <= 1) {                        // only the last player is left: game over
      if (rest.length) R.finished.push(rest[0]);
      R.status = 'done'; R.winner = R.finished[0]; R.log = `${nm(R, R.winner)} wins!`;
      return { won: true, done: true, captured: hit, home: true };
    }
    R.turn = nextTurn(R, c);                       // game goes on without them
    R.log = `${nm(R, c)} finished ${ORD[R.finished.length - 1]}!`;
    return { won: true, captured: hit, home: true };
  }

  const extra = (d === 6 && R.rules.extraTurnOnSix) || (hit.length && R.rules.extraTurnOnCapture) || (p === 56 && R.rules.extraTurnOnHome);
  if (extra) R.turn = c; else { R.turn = nextTurn(R, c); R.sixes = 0; }
  R.log = msg;
  return { captured: hit, home: p === 56 };
}

/* A roll with no possible move does NOT pass the turn at once: the roller keeps the turn
   while R.hold is set, so every phone can read the number. The server calls endHold() after HOLD_MS. */
function endHold(R) {
  if (!R.hold) return false;
  if (R.pending) R.turn = R.pending;
  R.hold = null; R.pending = null; return true;
}

function rollDie(R, c, rand = () => crypto.randomInt(1, 7)) {
  const rules = R.rules, allHome = R.tokens[c].every(p => p < 0);
  let d = rand(), pity = false;
  if (allHome && rules.pitySixAfter && (R.miss[c] || 0) >= rules.pitySixAfter) { d = 6; pity = true; }
  R.miss[c] = allHome ? (canExit(rules, d) ? 0 : (R.miss[c] || 0) + 1) : 0;
  R.last = { c, d }; R.rollSeq = (R.rollSeq || 0) + 1;
  R.sixes = d === 6 ? (R.sixes || 0) + 1 : 0;
  R.dice = null; R.movable = [];
  if (rules.maxConsecutiveSixes && R.sixes >= rules.maxConsecutiveSixes) {
    R.log = `${nm(R, c)} rolled ${R.sixes} sixes in a row: turn lost`;
    R.sixes = 0; R.hold = 'sixes'; R.pending = nextTurn(R, c); return { event: 'sixes', d };
  }
  const mv = movable(R, c, d);
  if (!mv.length) { R.log = `${nm(R, c)} rolled ${d}, no move`; R.sixes = 0; R.hold = 'none'; R.pending = nextTurn(R, c); return { event: 'none', d }; }
  if (mv.length === 1) { const r = applyMove(R, c, mv[0], d); if (pity) R.log += ' (lucky six!)'; return { event: 'auto', d, ...r }; }
  R.dice = d; R.movable = mv; R.log = `${nm(R, c)} rolled ${d}` + (pity ? ' (lucky six!)' : '');
  return { event: 'pick', d };
}

function chooseMove(R, c, d, mv) {
  let best = mv[0], bs = -1;
  for (const i of mv) {
    const p = R.tokens[c][i], np = p < 0 ? 0 : Math.min(56, p + d);
    let s = np;
    if (victims(R, c, np).length) s += 100;
    if (np === 56) s += 80;
    if (p < 0) s += 40;
    if (np >= 51 && p < 51) s += 20;
    if (s > bs) { bs = s; best = i; }
  }
  return best;
}

module.exports = { COLORS, START, SAFE, ORD, DEFAULT_RULES, sanitizeRules, abs, fresh, nextTurn, startGame, movable, victims, applyMove, rollDie, endHold, chooseMove };
