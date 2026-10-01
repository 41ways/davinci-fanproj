'use strict';
/**
 * 다빈치코드 — 방 관리와 판 진행.
 *  - 판(바닥 · 손패 · 순서 패 · 차례)과 봇은 전부 서버가 쥔다(권위 서버). 규칙 판정은 rules.js 가 한다.
 *    화면은 "이 행동 할래" 만 보내고, 서버는 사람마다 볼 수 있는 만큼(R.viewFor)만 잘라서 보낸다.
 *  - 숨은 숫자가 이 게임의 전부다. 판 상태를 통째로 보내는 길은 하나도 없다. 나가는 판 화면은
 *    모두 viewFor(s, 그 사람) 를 거치고, 그 위에서 이벤트 두 가지를 한 번 더 가린다(viewOf 참고).
 *  - 통신 방식은 모른다. 소켓은 send(문자열) · close() · readyState 만 있으면 된다.
 *    Node 서버(server.js)와 Cloudflare(worker.js)가 이 파일을 똑같이 쓴다.
 *  - 혼자 하기(봇과)는 여기를 거치지 않는다. 브라우저가 같은 rules.js · ai.js 로 직접 돌린다.
 */
const R = require('./rules');
const AI = require('./ai');

const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const MAX_SPECS = 10;                          // 방당 관전자
const SKILLS = [0.45, 0.75, 1];                // 쉬움 · 보통 · 어려움 — 화면의 고르기 칸과 같은 값
// 테스트는 판을 빨리 돌려야 해서 DAVINCI_FAST=1 로 뜸을 들이지 않게 한다
const FAST = typeof process !== 'undefined' && !!process.env && process.env.DAVINCI_FAST === '1';
const LOBBY_GRACE = FAST ? 300 : 20_000;       // 끊긴 방장을 넘기기까지 · 대기실에서 끊긴 자리를 비우기까지
const DC_GRACE = FAST ? 300 : 20_000;          // 판이 끊긴 사람을 기다려야 하면 이만큼 기다렸다가 판에서 뺀다
const BOT_NAMES = ['봇 하나', '봇 둘', '봇 셋'];

/* 연출 속도 — 예전 방장 화면(혼자 하기의 app.js)과 같은 값이다.
   남의 예측은 "누가 · 누구의 · 몇 번째를 · 무엇으로" 네 가지를 읽어야 한다.
   한글 짧은 문구는 눈에 들어오는 데 0.8초 + 글자당 0.07초쯤 걸린다. */
function readMs(text, floor) {
  if (FAST) return 0;
  const n = String(text || '').replace(/\s/g, '').length;
  return Math.max(floor, 800 + n * 70);
}
const PREDICT_MINE_MS = FAST ? 0 : 650;        // 부른 사람 말고 볼 사람이 없으면 결과로 바로 넘어간다
const PREDICT_MIN_MS = 1400;                   // 남의 예측 최소
const ORDER_MS = 2800;                         // 정해진 선공을 보여 주는 시간 (글이 길면 더)
const BANNER_MS = FAST ? 0 : 1900;             // 가운데 큰 안내가 떠 있는 시간
const BOT_SETUP = FAST ? 5 : 420;              // 봇이 시작 패를 한 장씩 집는 간격
const BOT_THINK = FAST ? 5 : 1350;             // 무엇을 부를지 · 한 번 더 갈지 · 자기 패를 까는 대목 — 뜸을 들인다
const BOT_MOVE = FAST ? 5 : 1100;              // 집기 · 놓기 — 기계적인 동작
const BOT_ORDER_PICK = FAST ? 5 : 700;         // 순서 패 한 장
const BOT_ORDER_CHOOSE = FAST ? 5 : 2400;      // 누가 몇을 뽑았는지 볼 틈

/* ─────────────────────────── 유틸 ─────────────────────────── */

const pick = a => a[Math.floor(Math.random() * a.length)];
const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
const token = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(12)),
  b => b.toString(16).padStart(2, '0')).join('');

/* ─────────────────────────── 방 ─────────────────────────── */

const rooms = new Map();

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 헷갈리는 글자 제외
  let code;
  do {
    code = Array.from({ length: 4 }, () => pick(alphabet.split(''))).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const room = {
    code: makeCode(),
    phase: 'lobby',            // lobby | playing | over
    hostId: null,
    players: [],               // 자리 — 사람과 봇. 판이 시작되면 이 순서가 자리 순서(시계방향)다
    specs: [],                 // 관전자 — 자리(players)와 완전히 별개. 차례 · 인원 · 방장 · 승패에 끼지 않는다
    nextId: 1,
    cfg: { skill: 0.75, priv: false, spec: true },   // spec — 이미 시작했거나 꽉 찬 방에 관전자로 들어오기를 허용
    state: null,               // rules.js 의 판 상태. 대기실에서는 null
    pubEvent: null,            // 모두에게 보여도 되는 마지막 이벤트 (조커 옮기기를 가릴 때 대신 보낸다)
    heldEv: null,              // 마지막으로 읽을 시간을 준 이벤트
    holdUntil: 0,              // 이 시각까지는 봇이 다음 수를 두지 않는다
    timers: { bot: null, host: null },
    madeAt: Date.now(),
    lastActive: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

/** 같은 이름이 둘이면 화면에서 누가 누군지 모른다 — 뒤에 숫자를 붙인다 */
function uniqueName(room, name) {
  const base = name;
  let n = 2;
  while (room.players.some(p => p.name === name) || room.specs.some(p => p.name === name)) name = base + n++;
  return name;
}

function addPlayer(room, { name, bot }) {
  const n = room.nextId++;
  const p = {
    // 문자열로 둔다 — rules.js 는 순서 패를 누가 뽑았는지 객체 키로 적어서, 숫자 id 는 문자열로 돌아온다
    id: (bot ? 'b' : 'p') + n,
    token: bot ? null : token(),
    name: uniqueName(room, name || `플레이어 ${n}`),
    bot: !!bot,
    ws: null,
    connected: !!bot,
  };
  room.players.push(p);
  if (!p.bot && room.hostId == null) room.hostId = p.id;
  return p;
}

const playerOf = (room, id) => room.players.find(p => p.id === id) || null;
const specOf = (room, id) => room.specs.find(p => p.id === id) || null;

/** 관전자를 받는다 — 자리(players)에는 넣지 않는다. 같은 방 사람이 아니라 보는 사람이다. */
function addSpec(room, name) {
  const sp = { id: 'v' + room.nextId++, name: uniqueName(room, name), ws: null, spec: true };
  room.specs.push(sp);
  return sp;
}
function removeSpec(room, id) {
  const i = room.specs.findIndex(x => x.id === id);
  if (i >= 0) room.specs.splice(i, 1);
}

/** 대기실에 빈 자리가 있으면 관전자를 들어온 순서대로 앉힌다. 앉은 사람에게는 정식 자리의 welcome 을
 *  다시 보낸다(토큰 포함) — 화면이 그걸 받아 자리를 이어받는다. 앉힌 게 있으면 true. 상태는 부르는 쪽이 보낸다.
 *  사람 플레이어가 아무도 붙어 있지 않은 방에는 앉히지 않는다 — 관전자만으로 방이 살아 있게 되므로. */
function seatSpecs(room) {
  if (room.phase !== 'lobby' || !room.specs.length) return false;
  if (!room.players.some(p => !p.bot && p.connected)) return false;
  let any = false;
  while (room.players.length < MAX_PLAYERS && room.specs.length) {
    const sp = room.specs.shift();
    if (!sp.ws || sp.ws.readyState !== 1) continue;            // 이미 끊긴 소켓
    const p = addPlayer(room, { name: sp.name });
    p.ws = sp.ws; p.connected = true;
    sp.ws.playerId = p.id; sp.ws.specId = null;
    send(sp.ws, { t: 'welcome', you: p.id, token: p.token, code: room.code, role: 'player' });
    ev(room, { kind: 'joined', by: p.id, name: p.name });
    any = true;
  }
  return any;
}

/** 자리를 뺀다. 판 중이면 판에서도 빠지게 한다(R.dropPlayer — 쥔 패는 그대로 두고 탈락). */
function removePlayer(room, id) {
  const i = room.players.findIndex(p => p.id === id);
  if (i < 0) return;
  const [gone] = room.players.splice(i, 1);
  clearTimeout(gone.leaveT);
  clearTimeout(gone.dcT);

  if (room.hostId === gone.id) {
    const next = room.players.find(p => !p.bot && p.connected) || room.players.find(p => !p.bot);
    room.hostId = next ? next.id : null;
  }
  if (room.phase === 'playing' && room.state && room.state.phase !== 'over') {
    R.dropPlayer(room.state, gone.id);
    afterMove(room);
  }
}

/* ─────────────────────────── 판 진행 ─────────────────────────── */

function startGame(room) {
  clearAll(room);
  room.phase = 'playing';
  room.pubEvent = null;
  room.heldEv = null;
  room.holdUntil = 0;
  room.state = R.newGame(room.players.map(p => ({ id: p.id, name: p.name })),
    Math.floor(Math.random() * 1e9));
  pushState(room);
  scheduleBot(room);
  watchAbsent(room);
}

/** 행동 하나가 판에 반영된 뒤 — 읽을 시간 잡기 · 판 끝 확인 · 모두에게 알리기 · 다음 봇 예약 */
function afterMove(room) {
  const s = room.state;
  if (s.lastEvent && s.lastEvent.type !== 'setupMove') room.pubEvent = s.lastEvent;
  holdForEvent(room);
  if (s.phase === 'over') {
    finish(room);
    return;
  }
  pushState(room);
  scheduleBot(room);
  watchAbsent(room);
}

/** 추측이 나오면 화면은 '예측' 을 먼저 띄우고 판을 잠깐 멈춘다. 그동안 봇이 다음 수를 두면
 *  사람은 결과를 보기도 전에 판이 넘어간다. 예측을 읽을 시간만큼 다음 봇 수를 미룬다.
 *  부른 사람 말고 볼 사람이 없으면(봇들과 온라인 방) 짧게만 쉰다. */
function holdForEvent(room) {
  const ev = room.state.lastEvent;
  if (!ev || ev === room.heldEv) return;
  room.heldEv = ev;
  if (ev.type !== 'guess') return;
  const watchers = room.players.filter(p => !p.bot && p.connected && p.id !== ev.by);
  // 화면의 예측 띠와 같은 글자 — "봇 둘 → 봇 하나 2번째 [3] 예측"
  const text = ev.byName + '→' + ev.targetName + (ev.index + 1) + '번째' +
    (ev.guessed.joker ? '—' : ev.guessed.n) + '예측';
  room.holdUntil = Date.now() + (watchers.length ? readMs(text, PREDICT_MIN_MS) : PREDICT_MINE_MS);
}

function finish(room) {
  clearAll(room);
  room.phase = 'over';
  pushState(room);
}

/** 다음에 서버가 스스로 둘 것을 예약한다 — 봇의 수, 그리고 순서가 정해진 뒤 판 열기. */
function scheduleBot(room) {
  clearTimeout(room.timers.bot); room.timers.bot = null;
  const s = room.state;
  if (room.phase !== 'playing' || !s || s.phase === 'over') return;
  const hold = Math.max(0, room.holdUntil - Date.now());
  const later = (fn, ms) => { room.timers.bot = setTimeout(() => { room.timers.bot = null; step(room, fn); }, ms); };

  if (s.phase === 'setup') {
    if (setupBot(room)) later(botSetupStep, BOT_SETUP);
    return;
  }
  if (s.phase === 'order') {
    const o = s.order;
    if (o.choice) {
      // 누가 먼저인지 읽을 시간을 준 뒤에 판을 연다 (화면 가운데 안내판의 글자 수만큼)
      const first = R.current(s);
      const seq = orderSeq(s).map(p => p.name).join('→');
      later(r => R.beginPlay(r.state), readMs(first.name + '선공' + '시계방향으로돕니다:' + seq, ORDER_MS));
      return;
    }
    if (o.winnerId) {
      const w = playerOf(room, o.winnerId);
      if (w && w.bot) later(r => R.orderChoose(r.state, o.winnerId, Math.random() < 0.7), BOT_ORDER_CHOOSE);
      return;
    }
    const bot = room.players.find(p => p.bot && !o.picks.hasOwnProperty(p.id) && !seatOut(s, p.id));
    if (!bot) return;
    // 막 시작했으면 가운데 안내가 걷힌 뒤에 뽑기 시작한다
    const wait = s.lastEvent && s.lastEvent.type === 'orderStart' ? BANNER_MS + (FAST ? 0 : 250) : BOT_ORDER_PICK;
    later(r => {
      const taken = new Set(Object.values(o.picks));
      const free = o.deck.map((_, i) => i).filter(i => !taken.has(i));
      R.orderPick(r.state, bot.id, pick(free));
    }, wait);
    return;
  }
  const cur = playerOf(room, R.current(s).id);
  if (!cur || !cur.bot) return;
  const think = (s.phase === 'guess' || s.phase === 'penalty' || s.phase === 'decide') ? BOT_THINK : BOT_MOVE;
  later(botStep, hold + think);
}

/** 예약해 둔 일을 한다. 그사이 방이 사라졌거나 판이 바뀌었으면 흘려보낸다.
 *  fn 이 예상 못 한 예외를 던지면(규칙 엔진과 봇/서버 진행이 어긋난 경우) 잡아서
 *  지금 차례인 사람을 빼고 넘어간다 — 안 그러면 이 방의 다음 봇 수가 다시는 예약되지 않아
 *  판이 영영 멈춘다(메시지로 들어오는 행동은 handle 쪽에서 이미 try/catch 로 감싸지만,
 *  서버가 스스로 예약하는 봇 수는 그 경로를 안 탄다). */
function step(room, fn) {
  const s = room.state;
  if (room.phase !== 'playing' || !s || s.phase === 'over' || rooms.get(room.code) !== room) return;
  try {
    fn(room);
  } catch (err) {
    console.error('판 진행 중 오류 — 지금 차례인 사람을 빼고 계속함', room.code, err);
    if (s.phase !== 'over') {
      const cur = R.current(s);
      if (cur && !cur.out) R.dropPlayer(s, cur.id);
    }
  }
  afterMove(room);
}

const seatOut = (s, id) => { const p = s.players.find(x => x.id === id); return !p || p.out; };

/** 시작 패를 아직 다 고르지 않은 봇 */
function setupBot(room) {
  const s = room.state;
  return room.players.find(p => p.bot && !s.ready[p.id] && !seatOut(s, p.id)) || null;
}

/** 봇 하나가 시작 패를 한 장 집거나(한 장씩 집는 게 보이도록), 다 집었으면 조커를 옮기고 준비한다 */
function botSetupStep(room) {
  const s = room.state;
  const seat = setupBot(room);
  if (!seat) return;
  const p = s.players.find(x => x.id === seat.id);
  if (p.hand.length < s.handSize) {
    R.draftPick(s, seat.id, Math.floor(Math.random() * s.pool.length));
    return;
  }
  const jk = p.hand.findIndex(x => R.isJoker(x.tile));
  if (jk >= 0) R.setupMove(s, seat.id, jk, Math.floor(Math.random() * p.hand.length));
  R.setupReady(s, seat.id);
}

/** 선공부터 시계방향으로 — 남은 사람만 */
function orderSeq(s) {
  const n = s.players.length, out = [];
  for (let k = 0; k < n; k++) {
    const p = s.players[(s.turn + k) % n];
    if (!p.out) out.push(p);
  }
  return out;
}

/** 추론할 거리가 없어도 아무 덮인 타일이나 부른다 */
function anyGuess(s, id) {
  for (const p of s.players) {
    if (p.id === id || p.out) continue;
    for (let j = 0; j < p.hand.length; j++) {
      const h = p.hand[j];
      if (!h.faceUp) return { targetId: p.id, index: j, color: h.tile.color, n: Math.floor(Math.random() * 12) };
    }
  }
  return null;
}

function botStep(room) {
  const s = room.state;
  const id = R.current(s).id;
  const v = R.viewFor(s, id);            // 봇도 자기 시야만 보고 둔다
  const skill = room.cfg.skill;
  let r = null;
  if (s.phase === 'draw') r = R.draw(s, id, Math.floor(Math.random() * Math.max(1, s.pool.length)));
  else if (s.phase === 'guess') {
    const mv = AI.chooseGuess(v, Math.random, skill) || anyGuess(s, id);
    if (mv) r = R.guess(s, id, mv.targetId, mv.index, mv.color, mv.n);
  }
  else if (s.phase === 'decide') r = R.decide(s, id, AI.chooseDecide(v));
  else if (s.phase === 'place') r = R.place(s, id, AI.choosePlace(v));
  else if (s.phase === 'penalty') r = R.penalty(s, id, AI.choosePenalty(v));
  if (!r || !r.ok) {
    // 여기까지 오면 규칙 엔진과 봇이 어긋난 것이다. 판이 영영 멈추지 않게 그 봇을 판에서 뺀다.
    console.error('봇이 막힘', room.code, id, s.phase, r && r.error);
    R.dropPlayer(s, id);
  }
}

/** 판이 지금 이 사람을 기다리고 있는가 — 시작 패 고르기와 순서 패는 여럿이 한꺼번에 한다 */
function waitingOn(s, id) {
  if (seatOut(s, id) || s.phase === 'over') return false;
  if (s.phase === 'setup') return !s.ready[id];
  if (s.phase === 'order') {
    const o = s.order;
    if (o.choice) return false;                    // 판 열기는 서버가 한다
    if (o.winnerId) return o.winnerId === id;      // 선공 · 후공 고르기
    return !o.picks.hasOwnProperty(id);
  }
  return R.current(s).id === id;
}

/** 판이 끊긴 사람을 기다리게 되면 잠깐 기다렸다가(새로고침은 그 안에 돌아온다) 판에서 뺀다.
 *  빼지 않으면 남은 사람들이 그 사람 차례에서, 또는 시작 패 고르기에서 영영 멈춘다. */
function watchAbsent(room) {
  const s = room.state;
  const live = room.phase === 'playing' && s && s.phase !== 'over';
  for (const p of room.players) {
    if (p.bot) continue;
    if (!live || p.connected || !waitingOn(s, p.id)) { clearTimeout(p.dcT); p.dcT = null; continue; }
    if (p.dcT) continue;
    p.dcT = setTimeout(() => {
      p.dcT = null;
      if (room.phase !== 'playing' || room.state !== s || s.phase === 'over') return;
      if (p.connected || !waitingOn(s, p.id)) return;
      R.dropPlayer(s, p.id);
      ev(room, { kind: 'dropped', name: p.name });
      afterMove(room);
    }, DC_GRACE);
  }
}

/* ─────────────────────────── 통신 ─────────────────────────── */

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}

/** 이 사람이 볼 판 — 반드시 viewFor 를 거친다. 그 위에서 이벤트 둘을 더 가린다.
 *  - 조커 옮기기(setupMove): 옮겼다는 사실부터 본인만 안다. 남에게는 그 전 이벤트를 그대로 보여 준다.
 *    '누가' 를 지운 채로라도 보내면 "방금 누가 조커를 옮겼다" 가 드러난다(준비 안 한 사람이 하나뿐이면 그 사람).
 *  - 시작 패 집기(draft)의 자리 번호: 남의 정리 중인 패는 자리별 색도 비밀이다. 몇 번째 자리에 끼었는지와
 *    무슨 색이 늘었는지를 모으면 배치가 드러나고, 준비 뒤 배치와 견주면 조커를 옮겼는지까지 드러난다. */
function viewOf(room, me) {
  // 관전자는 자리가 없다 — 이 id 는 어떤 자리와도 맞지 않으므로 모든 플레이어가 남의 것으로 가려진다.
  // (내 패 · 집은 패 · 놓을 패 · 조커 자리가 아예 없다) 화면에는 me 가 없는 시야로 간다.
  const v = R.viewFor(room.state, me.id);
  if (me.spec) v.me = null;
  let e = v.lastEvent;
  if (e && e.type === 'setupMove' && e.by !== me.id) e = room.pubEvent;
  if (e && e.type === 'draft' && e.by !== me.id) e = { type: 'draft', by: e.by, left: e.left };
  v.lastEvent = e || null;
  return v;
}

function stateFor(room, me) {
  return {
    t: 'state',
    role: me && me.spec ? 'spec' : 'player',      // 관전자는 보기만 한다
    specs: room.specs.map(s => s.name),           // 같은 방 관전자 이름 — 플레이어도 관전자도 서로 존재를 안다
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    cfg: room.cfg,
    max: MAX_PLAYERS,          // 인원 상한은 서버 값 하나만 쓴다 (화면 표기가 어긋나지 않게)
    min: MIN_PLAYERS,
    now: Date.now(),
    you: me ? me.id : null,
    players: room.players.map(p => ({ id: p.id, name: p.name, bot: p.bot, connected: p.connected })),
    // 판 화면은 사람마다 다르다 — 남의 덮인 숫자 · 조커 자리 · 남이 집은 패는 아예 보내지 않는다
    view: room.state && room.phase !== 'lobby' && me ? viewOf(room, me) : null,
  };
}

function pushState(room) {
  for (const p of room.players) if (!p.bot) send(p.ws, stateFor(room, p));
  for (const s of room.specs) send(s.ws, stateFor(room, s));
}
function broadcast(room, obj) {
  for (const p of room.players) if (!p.bot) send(p.ws, obj);
  for (const s of room.specs) send(s.ws, obj);
}
const ev = (room, obj) => broadcast(room, Object.assign({ t: 'ev' }, obj));

function clearAll(room) {
  clearTimeout(room.timers.bot); room.timers.bot = null;
  // leaveT(대기실에서 끊긴 자리를 비우는 예약)는 대기실을 벗어나면 뜻이 없다 — 판이 시작된 뒤에도
  // 남아 있으면(방장이 누군가의 유예가 끝나기 전에 시작을 눌렀을 때) 나중에 뜬금없이 한 번 더 돈다.
  for (const p of room.players) { clearTimeout(p.dcT); p.dcT = null; clearTimeout(p.leaveT); p.leaveT = null; }
}

/* ─────────────────────────── 행동 ───────────────────────────
   화면이 보낸 인자는 믿지 않는다. 행동마다 모양을 확인해서 rules.js 에 넘긴다.
   (자리 번호 자리에 "length" 같은 것이 오면 엔진이 없는 칸을 타일로 읽는다) */

const int = x => Number.isInteger(x) ? x : null;
const color = x => (x === 'b' || x === 'w') ? x : null;

/** 바닥 타일은 뒷면이라 사람은 사실상 '색'을 고른다. 자리 번호만 믿으면 그사이 다른 사람(봇)이 먼저 집어
 *  번호가 한 칸씩 밀려 옆 타일 — 흔히 다른 색 — 이 딸려 온다. 색이 다르면 같은 색 중에서 준다.
 *  (예전 방장 화면의 poolIndexFor 그대로) */
function poolIndexFor(s, idx, c) {
  if (!c) return idx;
  if (s.pool[idx] && s.pool[idx].color === c) return idx;
  const same = [];
  s.pool.forEach((t, i) => { if (t.color === c) same.push(i); });
  return same.length ? pick(same) : -1;          // 그 색이 동났다 — 다른 색을 주지 않는다
}

const ACTIONS = {
  draftPick: (s, id, a) => int(a[0]) === null ? null : R.draftPick(s, id, poolIndexFor(s, a[0], color(a[1]))),
  setupMove: (s, id, a) => int(a[0]) === null || int(a[1]) === null ? null : R.setupMove(s, id, a[0], a[1]),
  setupReady: (s, id) => R.setupReady(s, id),
  orderPick: (s, id, a) => int(a[0]) === null ? null : R.orderPick(s, id, a[0]),
  orderChoose: (s, id, a) => R.orderChoose(s, id, !!a[0]),
  draw: (s, id, a) => int(a[0]) === null ? null : R.draw(s, id, poolIndexFor(s, a[0], color(a[1]))),
  guess: (s, id, a) => {
    if (typeof a[0] !== 'string' || int(a[1]) === null || !color(a[2])) return null;
    if (a[3] !== null && int(a[3]) === null) return null;   // null 이면 조커를 부른 것
    return R.guess(s, id, a[0], a[1], a[2], a[3]);
  },
  decide: (s, id, a) => R.decide(s, id, !!a[0]),
  place: (s, id, a) => int(a[0]) === null ? null : R.place(s, id, a[0]),
  penalty: (s, id, a) => int(a[0]) === null ? null : R.penalty(s, id, a[0]),
};

/* ─────────────────────────── 메시지 처리 ─────────────────────────── */

function attach(room, p, ws) {
  clearTimeout(p.leaveT);
  p.ws = ws; p.connected = true;
  // 방장이 자리를 비운 채면(모두 끊겼다 이 사람이 먼저 돌아온 경우 등) 돌아온 사람이 방장을 맡는다.
  // 다른 사람이 이미 붙어 있으면(방장 말고) 아직 방장의 유예(20초)가 남아 있으므로 넘겨받지 않는다 —
  // 안 그러면 방장이 잠깐 끊긴 사이 다른 사람이 들어오거나 새로고침만 해도 방장을 빼앗아 간다.
  const host = playerOf(room, room.hostId);
  const noOtherHost = !room.players.some(x => !x.bot && x.connected && x.id !== p.id);
  if (!host || host === p || (!host.connected && noOtherHost)) room.hostId = p.id;
  ws.roomCode = room.code; ws.playerId = p.id; ws.specId = null;
  room.lastActive = Date.now();
  send(ws, { t: 'welcome', you: p.id, token: p.token, code: room.code, role: 'player' });
  pushState(room);
  watchAbsent(room);             // 기다리던 사람이 돌아왔으면 빼려던 예약을 거둔다
}

/** 이 소켓이 이미 어느 자리에 앉아 있으면 거기서 떼어 낸다. create/join 을 연달아 받으면 앞 자리가
 *  소켓을 쥔 채 "접속 중" 으로 영영 남아서, 그 자리 차례에서 판이 멈추고 방도 치워지지 않는다. */
function detach(ws) {
  const room = rooms.get(ws.roomCode);
  if (room && ws.specId) {
    const sp = specOf(room, ws.specId);
    if (sp && sp.ws === ws) { removeSpec(room, sp.id); pushState(room); }
  } else if (room) {
    const p = playerOf(room, ws.playerId);
    if (p && p.ws === ws) {
      if (room.phase === 'lobby') {
        removePlayer(room, p.id);
        if (!room.players.some(x => !x.bot)) dropRoom(room);   // 빈 방은 곧바로 치운다
        else { seatSpecs(room); pushState(room); }
      } else disconnect(ws);
    }
  }
  ws.roomCode = null; ws.playerId = null; ws.specId = null;
}

function dropRoom(room) {
  clearAll(room);
  clearTimeout(room.timers.host);
  for (const p of room.players) clearTimeout(p.leaveT);
  // 사람이 없는 방을 관전자만으로 살려 둘 수 없다 — 같이 내보내고 소켓을 닫는다
  for (const sp of room.specs) {
    const w = sp.ws;
    if (!w) continue;
    w.roomCode = null; w.specId = null;
    send(w, { t: 'err', msg: '방이 닫혔어요.', fatal: true });
    try { w.close(1000, 'room closed'); } catch (_) {}
  }
  room.specs = [];
  rooms.delete(room.code);
}

/** 열린 방 목록 — 코드를 몰라도 들어갈 수 있게. 사람이 붙어 있는 방이면 시작했든 꽉 찼든 보인다.
 *  비공개 방도 "있다" 는 것만 보인다 — 코드는 싣지 않는다(코드나 초대 링크를 아는 사람만 들어온다). */
function roomList() {
  const list = [];
  const now = Date.now();
  for (const r of rooms.values()) {
    if (!r.players.some(p => !p.bot && p.connected)) continue;
    const state = r.phase !== 'lobby' ? 'playing' : r.players.length >= MAX_PLAYERS ? 'full' : 'wait';
    const host = playerOf(r, r.hostId);
    const item = {
      n: r.players.length,
      max: MAX_PLAYERS,
      bots: r.players.filter(p => p.bot).length,
      host: host ? host.name : '',
      age: Math.round((now - r.madeAt) / 1000),
      state,
      spec: r.cfg.spec !== false,
      watching: r.specs.length,
    };
    if (r.cfg.priv) item.priv = true; else item.code = r.code;
    list.push(item);
  }
  // 공개 대기 방 → 눌러서 들어갈 수 있는 방(관전) → 나머지(비공개 · 관전 불가)
  const rank = r => r.priv ? 2 : r.state === 'wait' ? 0 : r.spec ? 1 : 2;
  list.sort((a, b) => rank(a) - rank(b) || a.age - b.age);
  return list.slice(0, 12);
}

function handle(ws, msg) {
  if ((msg.t === 'create' || msg.t === 'join' || msg.t === 'resume') && ws.roomCode) detach(ws);
  switch (msg.t) {
    case 'rooms':
      return send(ws, { t: 'rooms', list: roomList() });

    case 'create': {
      const r = createRoom();
      if (msg.priv === true) r.cfg.priv = true;
      if (msg.spec === false) r.cfg.spec = false;
      if (SKILLS.includes(msg.skill)) r.cfg.skill = msg.skill;
      const p = addPlayer(r, { name: clean(msg.name, 12) || '이름없음' });
      attach(r, p, ws);
      return;
    }
    case 'join': {
      const code = clean(msg.code, 8).toUpperCase();
      const r = rooms.get(code);
      if (!r) return send(ws, { t: 'err', msg: '그런 방이 없습니다. 코드를 확인해 주세요.' });
      const name = clean(msg.name, 12) || '이름없음';
      if (r.phase === 'lobby' && r.players.length < MAX_PLAYERS) {
        const p = addPlayer(r, { name });
        attach(r, p, ws);
        ev(r, { kind: 'joined', by: p.id, name: p.name });
        return;
      }
      // 이미 시작했거나 자리가 꽉 찼다 — 관전을 허용한 방이면 보는 사람으로 들어온다
      if (r.cfg.spec === false) {
        return send(ws, { t: 'err', msg: (r.phase !== 'lobby' ? '이미 시작된 방입니다.' : '자리가 찼습니다.') + ' 관전을 허용하지 않는 방이에요.' });
      }
      if (r.specs.length >= MAX_SPECS) return send(ws, { t: 'err', msg: '관전석이 가득 찼어요.' });
      const sp = addSpec(r, name);
      sp.ws = ws;
      ws.roomCode = r.code; ws.playerId = null; ws.specId = sp.id;
      send(ws, { t: 'welcome', you: sp.id, token: null, code: r.code, role: 'spec' });
      ev(r, { kind: 'watch', by: sp.id, name: sp.name });
      pushState(r);
      return;
    }
    case 'resume': {
      const r = rooms.get(clean(msg.code, 8).toUpperCase());
      if (!r) return send(ws, { t: 'err', msg: '방이 사라졌습니다.', fatal: true });
      const p = r.players.find(x => !x.bot && x.token === msg.token);
      if (!p) return send(ws, { t: 'err', msg: '자리를 찾을 수 없습니다.', fatal: true });
      // 먼저 붙어 있던 소켓(복제한 탭 등)은 4001 로 닫는다. 그 탭은 스스로 다시 붙지 않으므로
      // 두 탭이 서로를 밀어내며 끝없이 다시 붙는 일이 없다. 닫는 코드는 중간에 떨어지기도 해서 알림을 먼저 보낸다.
      if (p.ws && p.ws !== ws) {
        const old = p.ws;
        old.roomCode = null; old.playerId = null;      // 옛 소켓이 닫혀도 이 자리를 끊긴 걸로 치지 않게
        send(old, { t: 'moved' });
        try { old.close(4001, 'moved'); } catch (_) {}
      }
      attach(r, p, ws);
      return;
    }
  }

  const room = rooms.get(ws.roomCode);
  if (!room) return;
  if (ws.specId) {                       // 관전자 — 채팅과 나가기만 받는다. 판 행동 · 설정은 조용히 무시
    const sp = specOf(room, ws.specId);
    if (sp) handleSpec(room, ws, sp, msg);
    return;
  }
  const me = playerOf(room, ws.playerId);
  if (!me) return;
  const isHost = room.hostId === me.id;
  room.lastActive = Date.now();

  switch (msg.t) {
    case 'cfg': {
      if (!isHost || room.phase !== 'lobby') return;
      if (SKILLS.includes(msg.skill)) room.cfg.skill = msg.skill;
      if (typeof msg.priv === 'boolean') room.cfg.priv = msg.priv;
      if (typeof msg.spec === 'boolean') room.cfg.spec = msg.spec;
      pushState(room);
      break;
    }

    case 'addBot': {
      if (!isHost || room.phase !== 'lobby') return;
      if (room.players.length >= MAX_PLAYERS) return send(ws, { t: 'err', msg: '자리가 찼습니다.' });
      const used = new Set(room.players.map(p => p.name));
      const name = BOT_NAMES.find(n => !used.has(n)) || `봇 ${room.players.length + 1}`;
      addPlayer(room, { name, bot: true });
      pushState(room);
      break;
    }

    case 'kick': {
      if (!isHost || room.phase !== 'lobby') return;
      const target = playerOf(room, msg.id);
      if (!target || target.id === room.hostId) return;
      if (target.ws) {
        send(target.ws, { t: 'err', msg: '방장이 내보냈습니다.', fatal: true });
        target.ws.roomCode = null; target.ws.playerId = null;
      }
      removePlayer(room, target.id);
      seatSpecs(room);                 // 빈 자리가 났으면 기다리던 관전자가 앉는다
      pushState(room);
      break;
    }

    case 'start': {
      if (!isHost || room.phase !== 'lobby') return;
      if (room.players.length < MIN_PLAYERS) return send(ws, { t: 'err', msg: '2명 이상이어야 시작할 수 있습니다.' });
      startGame(room);
      break;
    }

    case 'act': {
      if (room.phase !== 'playing' || !room.state) return;
      const fn = Object.prototype.hasOwnProperty.call(ACTIONS, msg.action) ? ACTIONS[msg.action] : null;
      if (!fn) return;
      const args = Array.isArray(msg.args) ? msg.args.slice(0, 4) : [];
      // 신원은 소켓이 정한다 — 메시지에 누구인지 적어 보내도 무시한다. 남의 차례를 가로챌 수 없다.
      const r = fn(room.state, me.id, args);
      if (!r) return send(ws, { t: 'err', msg: '잘못된 요청입니다.' });
      if (!r.ok) return send(ws, { t: 'err', msg: r.error });
      if (msg.action === 'setupMove') {
        // 조커를 옮긴 것은 본인만 안다 — 남에게는 아무것도 보내지 않는다(보내는 것 자체가 신호다)
        send(ws, stateFor(room, me));
        break;
      }
      afterMove(room);
      break;
    }

    // 같은 방 사람끼리 하는 잡담. 판정에는 아무 영향이 없고 서버는 저장하지 않는다.
    case 'chat': {
      const text = clean(msg.text, 200);
      if (!text) return;
      const now = Date.now();
      // 한 사람이 몰아치는 것만 막는다. 전체를 하나로 세면 두 사람이 동시에 말할 때 한쪽 말이 사라진다.
      if (now - (me.lastChat || 0) < 350) return;
      me.lastChat = now;
      broadcast(room, { t: 'chat', from: me.id, name: me.name, text });
      break;
    }

    // 판이 끝나면 모두 대기실로 — 한 페이지에서 여러 판을 이어서 한다
    case 'again': {
      if (!isHost || room.phase !== 'over') return;
      clearAll(room);
      room.phase = 'lobby';
      room.state = null;
      room.pubEvent = null;
      room.heldEv = null;
      // 판 중에 떠난 사람은 대기실 떠나기 예약이 없어 다음 판에 유령 자리로 남는다
      for (const p of room.players) if (!p.bot && !p.connected) armLeave(room, p);
      seatSpecs(room);                 // 다음 판부터 — 기다리던 관전자를 빈 자리에 앉힌다
      pushState(room);
      break;
    }

    case 'leave': {
      const name = me.name;
      removePlayer(room, me.id);
      ws.roomCode = null; ws.playerId = null;
      send(ws, { t: 'left' });
      if (!room.players.some(p => !p.bot)) { dropRoom(room); break; }   // 봇만 남은 방은 둘 까닭이 없다
      ev(room, { kind: 'left', name });
      seatSpecs(room);
      pushState(room);
      break;
    }
  }
}

/** 관전자가 보낸 것 — 채팅과 나가기뿐이다. 추측 · 뽑기 · 설정 · 시작 같은 건 전부 조용히 버린다.
 *  방이 살아 있는 것으로 치지 않으려고 room.lastActive 도 건드리지 않는다. */
function handleSpec(room, ws, sp, msg) {
  if (msg.t === 'chat') {
    const text = clean(msg.text, 200);
    if (!text) return;
    const now = Date.now();
    if (now - (sp.lastChat || 0) < 350) return;
    sp.lastChat = now;
    broadcast(room, { t: 'chat', from: sp.id, name: sp.name, text, spec: true });
  } else if (msg.t === 'leave') {
    removeSpec(room, sp.id);
    ws.roomCode = null; ws.specId = null;
    send(ws, { t: 'left' });
    pushState(room);
  }
}

/** 대기실에서 끊긴 자리를 잠깐 뒤에 비운다 — 그 사이 돌아오면(attach) 취소된다 */
function armLeave(room, p) {
  clearTimeout(p.leaveT);
  p.leaveT = setTimeout(() => {
    if (p.connected || room.phase !== 'lobby' || rooms.get(room.code) !== room) return;
    removePlayer(room, p.id);
    if (room.players.some(x => !x.bot)) seatSpecs(room);
    pushState(room);
  }, LOBBY_GRACE);
}

/** 소켓이 닫혔다. 그 사이 같은 자리가 새 소켓으로 다시 붙었으면(새로고침) 건드리지 않는다.
 *  keepSeat — 서버가 스스로 끊은 경우(오래 조작 없음 · 소식 없음). 사람은 나간 게 아니라서
 *  대기실 자리를 지워 버리면 "누르면 다시 붙어요" 가 거짓말이 된다. 자리는 두고 방장만 넘긴다. */
function disconnect(ws, { keepSeat = false } = {}) {
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  if (ws.specId) {                           // 관전자는 유예도 이어받기도 없다 — 끊기면 목록에서 뺀다
    const sp = specOf(room, ws.specId);
    if (sp && sp.ws === ws) { removeSpec(room, sp.id); ws.specId = null; pushState(room); }
    return;
  }
  const p = playerOf(room, ws.playerId);
  if (!p || p.ws !== ws) return;
  p.connected = false; p.ws = null;
  room.lastActive = Date.now();              // 빈 방 청소는 마지막 사람이 떠난 때부터 센다

  // 방장이 끊기면 잠깐 기다렸다가 붙어 있는 사람에게 넘긴다 — 판 중이든 끝난 뒤든.
  // 곧바로 넘기면 새로고침 한 번에 방장을 잃는다. 안 넘기면 '시작'·'대기실로'를 누를 사람이 없다.
  if (room.hostId === p.id) {
    clearTimeout(room.timers.host);
    room.timers.host = setTimeout(() => {
      if (rooms.get(room.code) !== room) return;
      const h = playerOf(room, room.hostId);
      if (h && h.connected) return;
      const next = room.players.find(x => !x.bot && x.connected);
      if (next) { room.hostId = next.id; pushState(room); }
    }, LOBBY_GRACE);
  }

  if (room.phase === 'lobby') {
    // 새로고침·앱 전환은 소켓이 먼저 닫히고 곧바로 다시 붙는다. 그 사이에 자리를 지우면
    // 돌아왔을 때 "자리를 찾을 수 없습니다" 로 쫓겨난다. 잠깐 기다렸다가 그래도 없으면 뺀다.
    clearTimeout(p.leaveT);
    if (!keepSeat) armLeave(room, p);
  }
  pushState(room);
  watchAbsent(room);
}

/** 사람이 다 떠난 방을 치운다. 통신 쪽이 30초마다 부른다.
 *  대기실에 자리만 남은 사람이 있으면(서버가 오래 조작 없는 연결을 닫은 경우) 10분까지 기다려 준다. */
function sweepRooms(now = Date.now()) {
  for (const room of [...rooms.values()]) {
    const humans = room.players.filter(p => !p.bot && p.connected).length;
    const seated = room.phase === 'lobby' && room.players.some(p => !p.bot);
    if (humans === 0 && now - room.lastActive > (seated ? 10 * 60_000 : 90_000)) dropRoom(room);
  }
}

/** 타일 구성이 어긋나면 게임 도중이 아니라 켤 때 바로 터지게 한다 */
function selfCheck() {
  const d = R.createDeck();
  const jokers = d.filter(R.isJoker).length;
  if (d.length !== 26 || jokers !== 2) throw new Error(`타일이 ${d.length}장 · 조커 ${jokers}장입니다 (26 · 2 여야 함)`);
  const s = R.newGame([{ id: 'p1', name: 'a' }, { id: 'p2', name: 'b' }], 1);
  if (R.viewFor(s, 'p1').me !== 'p1') throw new Error('viewFor 가 자리를 못 찾습니다');
  if (R.handSize(2) !== 4 || R.handSize(MAX_PLAYERS) !== 3) throw new Error('시작 손패 장수가 어긋납니다');
  console.log(`  타일 ${d.length}장(조커 ${jokers}) · 최대 ${MAX_PLAYERS}인`);
}

module.exports = {
  rooms, handle, disconnect, sweepRooms, selfCheck,
  MAX_PLAYERS, LOBBY_GRACE, DC_GRACE, FAST, readMs, viewOf,
};
