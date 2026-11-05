
'use strict';
/* Ludo rules engine: pure functions over a room object R.
   R needs: rules, order, players{color:{name}}, tokens, turn, dice, movable, last, sixes, miss, status, winner, log */
const crypto = require('crypto');

const COLORS = ['red', 'green', 'yellow', 'blue'];
const START = { red: 0, green: 13, yellow: 26, blue: 39 };
const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

const DEFAULT_RULES = {
  exitOn: 'six',               // 'six' | 'one_or_six': dice values that bring a token out of the yard
  extraTurnOnSix: true,
  maxConsecutiveSixes: 3,      // 0 = unlimited. The Nth six in a row forfeits the move and the turn
  extraTurnOnCapture: true,
  extraTurnOnHome: true,
  safeSquares: true,           // star squares and start squares cannot be captured on
  stackProtect: true,          // 2+ tokens of one colour on a square cannot be captured
  exactHome: true,             // false = an overshooting roll still finishes the token
  pitySixAfter: 0,             // 0 = off. After N failed rolls with all tokens home, the next roll is a 6
  turnSeconds: 25,             // time to roll
  pickSeconds: 12,             // time to choose a token
  onTimeout: 'auto',           // 'auto' = server plays for the player, 'skip' = turn is passed
  autopilotAfterMisses: 2,     // consecutive timeouts before a player is put on autopilot (0 = never)
  offlineGraceSeconds: 8       // how long a disconnected player is waited for
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
/* Only known keys with valid types/ranges get through; everything else is ignored. */
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
const nextTurn = (R, c) => R.order[(R.order.indexOf(c) + 1) % R.order.length];
const nm = (R, c) => (R.players[c] && R.players[c].name) || c;
const canExit = (rules, d) => d === 6 || (rules.exitOn === 'one_or_six' && d === 1);

function startGame(R, first) {
  Object.assign(R, { status: 'playing', turn: first, tokens: fresh(), dice: null, movable: [], last: null,
    winner: null, sixes: 0, miss: {}, log: 'Game started' });
}

function movable(R, c, d) {
  const r = [];
  R.tokens[c].forEach((p, i) => {
    if (p < 0) { if (canExit(R.rules, d)) r.push(i); }
    else if (!R.rules.exactHome || p + d <= 56) r.push(i);
  });
  return r;
}

/* Opponent tokens that would be captured by c landing on progress p. */
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
  if (T[c].every(q => q === 56)) { R.status = 'done'; R.winner = c; R.log = `${nm(R, c)} wins!`; return { won: true, captured: hit, home: true }; }
  const extra = (d === 6 && R.rules.extraTurnOnSix) || (hit.length && R.rules.extraTurnOnCapture) || (p === 56 && R.rules.extraTurnOnHome);
  if (extra) R.turn = c; else { R.turn = nextTurn(R, c); R.sixes = 0; }
  R.log = msg;
  return { captured: hit, home: p === 56 };
}

/* Rolls for player c and applies everything that follows. Returns what happened. */
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
    R.sixes = 0; R.turn = nextTurn(R, c); return { event: 'sixes', d };
  }
  const mv = movable(R, c, d);
  if (!mv.length) { R.log = `${nm(R, c)} rolled ${d}, no move`; R.sixes = 0; R.turn = nextTurn(R, c); return { event: 'none', d }; }
  if (mv.length === 1) { const r = applyMove(R, c, mv[0], d); if (pity) R.log += ' (lucky six!)'; return { event: 'auto', d, ...r }; }
  R.dice = d; R.movable = mv; R.log = `${nm(R, c)} rolled ${d}` + (pity ? ' (lucky six!)' : '');
  return { event: 'pick', d };
}

/* Simple heuristic used for timeouts and autopilot. */
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

module.exports = { COLORS, START, SAFE, DEFAULT_RULES, sanitizeRules, abs, fresh, nextTurn, startGame, movable, victims, applyMove, rollDie, chooseMove };
