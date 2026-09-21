'use strict';
/**
 * 서버를 실제로 띄우고 방·판 흐름을 끝까지 돌려 본다 — node test/flow.js
 *  - 서버는 DAVINCI_FAST=1 로 띄운다. 봇 뜸 · 읽는 시간 · 20초 유예가 전부 짧아진다(유예 300ms).
 *    20초라는 실제 값은 맨 끝에서 game.js 를 FAST 없이 불러 따로 확인한다.
 *  - PORT 를 주면 이미 떠 있는 서버(DAVINCI_FAST=1 로 띄운 것)에 붙는다 — wrangler dev 시험용.
 *  - 숨은 정보가 새지 않는지가 이 게임의 핵심이라, 사람 손님이 받은 메시지는 전부 모아 두었다가
 *    누출 검사기(leaks)에 통째로 넣어 본다. 검사기가 정말 잡아내는지도 따로 확인한다.
 */
const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const R = require('../rules');
const AI = require('../ai');

const USE_EXISTING = !!process.env.PORT;
const PORT = process.env.PORT || 8876;
const URL = `ws://127.0.0.1:${PORT}/ws`;
const GRACE = 300;                      // game.js 의 FAST 유예
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = n => Math.floor(Math.random() * n);

/* ─────────────── 손님 하나 ─────────────── */

const everyone = [];                    // 누출 검사용 — 지금까지 연 손님 전부
function open() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.inbox = [];
    ws.closed = null;
    ws.on('message', raw => ws.inbox.push(JSON.parse(raw)));
    ws.on('close', code => { ws.closed = code; });
    ws.once('open', () => { everyone.push(ws); resolve(ws); });
    ws.once('error', reject);
  });
}
const tx = (ws, obj) => ws.send(JSON.stringify(obj));
const act = (ws, action, args) => tx(ws, { t: 'act', action, args: args || [] });
/** 조건에 맞는 메시지를 기다린다. from 이후에 온 것만 본다(예전 메시지에 속지 않게). */
async function waitFor(ws, pred, { ms = 6000, from = 0, what = '' } = {}) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (let i = ws.inbox.length - 1; i >= from; i--) if (pred(ws.inbox[i])) return ws.inbox[i];
    await sleep(10);
  }
  throw new Error('기다리던 메시지가 오지 않음 ' + what + ': ' + JSON.stringify(ws.inbox.slice(-2)).slice(0, 500));
}
const lastState = ws => ws.inbox.filter(m => m.t === 'state').pop();
const lastView = ws => { const s = lastState(ws); return s && s.view; };
const mark = ws => ws.inbox.length;
const errsFrom = (ws, k) => ws.inbox.slice(k).filter(m => m.t === 'err');

async function create(name, extra = {}) {
  const ws = await open();
  tx(ws, Object.assign({ t: 'create', name }, extra));
  const w = await waitFor(ws, m => m.t === 'welcome', { what: '(만들기)' });
  ws.me = w; return ws;
}
async function join(code, name) {
  const ws = await open();
  tx(ws, { t: 'join', code, name });
  const w = await waitFor(ws, m => m.t === 'welcome' || m.t === 'err', { what: '(참가)' });
  if (w.t === 'err') throw new Error('참가 거절: ' + w.msg);
  ws.me = w; return ws;
}
async function listRooms() {
  const ws = await open();
  tx(ws, { t: 'rooms' });
  const m = await waitFor(ws, x => x.t === 'rooms');
  ws.close();
  return m.list;
}

/* ─────────────── 보이는 시야로 한 수 고르기 ─────────────── */

const meIn = v => v.players.find(p => p.id === v.me);
const myTurn = v => v && v.phase !== 'over' && v.players[v.turn] && v.players[v.turn].id === v.me;

/** 지금 이 사람이 할 일 — 없으면 null. 봇 판단(ai.js)을 그대로 빌려 쓴다. */
function pickMove(v) {
  if (!v || v.phase === 'over') return null;
  const me = meIn(v);
  if (!me || me.out) return null;
  if (v.phase === 'setup') {
    if (v.ready[v.me]) return null;
    if (me.hand.length < v.handSize) {
      const i = rnd(v.pool.length);
      return { action: 'draftPick', args: [i, v.pool[i].color] };
    }
    return { action: 'setupReady', args: [] };
  }
  if (v.phase === 'order') {
    const o = v.order;
    if (o.choice) return null;
    if (o.winnerId) return o.winnerId === v.me ? { action: 'orderChoose', args: [Math.random() < 0.5] } : null;
    if (o.tiles.some(t => t.by === v.me)) return null;
    const free = o.tiles.map((t, i) => (t.by ? -1 : i)).filter(i => i >= 0);
    return { action: 'orderPick', args: [free[rnd(free.length)]] };
  }
  if (!myTurn(v)) return null;
  if (v.phase === 'draw') {
    if (!v.poolCount) return { action: 'draw', args: [0] };
    const i = rnd(v.pool.length);
    return { action: 'draw', args: [i, v.pool[i].color] };
  }
  if (v.phase === 'guess') {
    let g = AI.chooseGuess(v, Math.random, 1);
    if (!g) {
      const t = v.players.find(p => p.id !== v.me && !p.out && p.hand.some(h => !h.faceUp));
      const j = t.hand.findIndex(h => !h.faceUp);
      g = { targetId: t.id, index: j, color: t.hand[j].tile.color, n: 0 };
    }
    return { action: 'guess', args: [g.targetId, g.index, g.color, g.n] };
  }
  if (v.phase === 'decide') return { action: 'decide', args: [AI.chooseDecide(v)] };
  if (v.phase === 'place') return { action: 'place', args: [AI.choosePlace(v)] };
  if (v.phase === 'penalty') return { action: 'penalty', args: [AI.choosePenalty(v)] };
  return null;
}

/** 여럿이 동시에 두는 단계(시작 패 · 순서 패)에서는 남이 먼저 집어 내 화면이 한 박자 늦을 수 있다.
 *  그때 서버가 거절하는 것은 정상이다 — 다음 상태를 받고 다시 두면 된다. */
const RACE = /이미 누가 뽑은|없는 자리|이미 뽑았|이미 다 뽑았/;

/** 사람 손님들이 각자 자기 시야만 보고 판이 끝날 때까지 둔다 */
async function playOut(clients, ms = 60000) {
  const seen = clients.map(c => c.inbox.length);
  const end = Date.now() + ms;
  let moves = 0;
  while (Date.now() < end) {
    for (let k = 0; k < clients.length; k++) {
      const c = clients[k];
      for (; seen[k] < c.inbox.length; seen[k]++) {
        const m = c.inbox[seen[k]];
        if (m.t === 'err' && !RACE.test(m.msg)) throw new Error('서버가 거절: ' + m.msg);
      }
      const st = lastState(c);
      if (st && st.phase === 'over') return { over: st, moves };
      if (!st || !st.view || st === c.acted) continue;
      const mv = pickMove(st.view);
      if (!mv) continue;
      c.acted = st;
      act(c, mv.action, mv.args);
      moves++;
    }
    await sleep(3);
  }
  throw new Error(ms + 'ms 안에 판이 안 끝남');
}

/* ─────────────── 숨은 정보 누출 검사 ───────────────
   숫자까지 보이는 타일(숫자가 있거나 조커로 밝혀진 것)은 둘 중 하나여야 한다.
     (1) 내 타일 — 내 손패 · 내가 집은 패 · 내가 놓으려는 패
     (2) 이미 공개된 타일 — 그 메시지 안에서 누군가의 손패에 앞면으로 있는 것
   메시지 어디에든(시야 · 이벤트 · 기록 · 채팅 · 방 목록) 그 밖의 타일이 숫자와 함께 있으면 샌 것이다.
   누가 무엇을 불렀는지(guessed)는 부른 값일 뿐 실제 타일이 아니라서 뺀다.
   손님들이 저마다 "내 것" 이라고 본 타일은 서로 겹치면 안 된다 — 남의 패가 내 것처럼 오는 것도 잡는다. */

const tileId = t => t.color + (t.joker ? 'J' : t.n);
function walkTiles(x, out, key) {
  if (key === 'guessed' || x === null || typeof x !== 'object') return;
  if (Array.isArray(x)) { x.forEach(y => walkTiles(y, out)); return; }
  if ('color' in x && 'n' in x && ((x.n !== null && x.n !== undefined) || x.joker === true)) out.push(tileId(x));
  for (const k of Object.keys(x)) walkTiles(x[k], out, k);
}

/** 한 손님이 받은 메시지 전부를 검사한다. 문제 목록과 그 손님이 "내 것" 으로 본 타일을 돌려준다. */
function leaks(inbox) {
  const problems = [];
  const mine = new Set();
  for (const m of inbox) {
    const v = m.t === 'state' ? m.view : null;
    const open = new Set();
    if (v) {
      const me = meIn(v);
      if (me) me.hand.forEach(h => mine.add(tileId(h.tile)));
      if (v.drawn) mine.add(tileId(v.drawn));
      if (v.pending) mine.add(tileId(v.pending.tile));
      v.players.forEach(p => p.hand.forEach(h => { if (h.faceUp) open.add(tileId(h.tile)); }));

      // 모양으로도 본다 — 남의 덮인 패는 숫자 · 조커 여부가 비어 있어야 한다
      for (const p of v.players) {
        if (p.id === v.me) continue;
        const arranging = v.phase === 'setup' && !v.ready[p.id];
        p.hand.forEach((h, i) => {
          if (h.faceUp) return;
          if (h.tile.n !== null || h.tile.joker !== null) problems.push(`${p.name} ${i + 1}번째 덮인 패의 숫자가 보임`);
          if (arranging && h.tile.color !== null) problems.push(`${p.name} 정리 중 배치(색)가 보임`);
        });
      }
      if (!myTurn(v) && (v.drawn || v.pending || v.pendingSpots)) problems.push('남이 집은 패가 보임');
      if (me && v.myJokers.some(i => !me.hand[i] || !me.hand[i].tile.joker)) problems.push('myJokers 가 내 조커가 아님');
      const e = v.lastEvent;
      if (e && e.type === 'setupMove' && e.by !== v.me) problems.push('남이 조커를 옮긴 사실이 보임');
      if (e && e.type === 'draft' && e.by !== v.me && 'index' in e) problems.push('남이 시작 패를 끼운 자리가 보임');
    }
    const seen = [];
    walkTiles(m, seen);
    for (const id of seen) {
      if (!mine.has(id) && !open.has(id)) problems.push(`${m.t} 메시지에 남의 숨은 타일 ${id}`);
    }
  }
  return { problems, mine };
}

/** 여러 손님을 한꺼번에 — 각자 검사하고, "내 것" 이 서로 다른 사람 사이에 겹치지 않는지도 본다
 *  (새로고침한 탭은 같은 사람이라 겹쳐도 된다) */
function assertNoLeak(clients, what) {
  const owner = new Map();
  let msgs = 0;
  for (const c of clients) {
    msgs += c.inbox.length;
    const who = c.me ? c.me.you : c;
    const { problems, mine } = leaks(c.inbox);
    assert.deepStrictEqual(problems.slice(0, 5), [], `${what}: 누출`);
    for (const id of mine) {
      assert.ok(!owner.has(id) || owner.get(id) === who, `${what}: ${id} 가 두 사람에게 내 것으로 보임`);
      owner.set(id, who);
    }
  }
  return msgs;
}

/* ─────────────── 시나리오 ─────────────── */

let pass = 0;
async function step(name, fn) {
  const t0 = Date.now();
  await fn();
  pass++;
  console.log(`  ✓ ${name}  (${Date.now() - t0}ms)`);
}

/** who 의 차례가 끝날 때까지 둔다 */
async function finishTurn(who) {
  for (let i = 0; i < 12; i++) {
    const v = lastView(who);
    if (!myTurn(v)) return;
    const mv = pickMove(v);
    const k = mark(who);
    act(who, mv.action, mv.args);
    await waitFor(who, m => m.t === 'state' || m.t === 'err', { from: k });
    const e = errsFrom(who, k)[0];
    if (e) throw new Error('거절: ' + e.msg);
  }
}

/** 시작 패를 다 고르고 준비까지 — 봇이 같이 집어도 내 상태가 바뀐 것을 보고 다음 장을 집는다 */
async function doSetup(who) {
  for (let i = 0; i < 8; i++) {
    const v = lastView(who);
    if (v.phase !== 'setup' || v.ready[v.me]) return;
    const mv = pickMove(v);
    const k = mark(who);
    const n = meIn(v).hand.length;
    act(who, mv.action, mv.args);
    await waitFor(who, m => m.t === 'err' || (m.t === 'state' && m.view && (meIn(m.view).hand.length > n || m.view.ready[m.view.me])), { from: k });
    const e = errsFrom(who, k)[0];
    if (e) throw new Error('거절: ' + e.msg);
  }
}

/** 두 사람 판을 시작 패 고르기부터 판이 열릴 때까지 — a 가 조커를 쥔 방이 나올 때까지 새로 만든다 */
async function jokerRoom() {
  for (let tries = 1; tries <= 60; tries++) {
    const a = await create('조커손');
    const b = await join(a.me.code, '맞은편');
    tx(a, { t: 'start' });
    await waitFor(b, m => m.t === 'state' && m.phase === 'playing');
    for (let i = 0; i < 4; i++) {
      const v = lastView(a);
      const k = mark(a);
      const idx = rnd(v.pool.length);
      act(a, 'draftPick', [idx, v.pool[idx].color]);
      await waitFor(a, m => m.t === 'state' && m.view && meIn(m.view).hand.length === i + 1, { from: k });
    }
    if (lastView(a).myJokers.length) return { a, b, tries };
    tx(a, { t: 'leave' }); tx(b, { t: 'leave' });
    await waitFor(a, m => m.t === 'left'); await waitFor(b, m => m.t === 'left');
    a.close(); b.close();
  }
  throw new Error('60번 만들어도 조커가 안 나옴');
}

async function scenarios() {
  let a, b, code;

  await step('두 사람이 방을 만들고 들어온다', async () => {
    a = await create('방장');
    code = a.me.code;
    assert.match(code, /^[A-Z2-9]{4}$/);
    b = await join(code, '민수');
    const s = await waitFor(a, m => m.t === 'state' && m.players.length === 2);
    assert.strictEqual(s.phase, 'lobby');
    assert.strictEqual(s.hostId, a.me.you);
    assert.strictEqual(s.view, null, '대기실인데 판 시야가 옴');
    assert.strictEqual(typeof a.me.you, 'string');
    await waitFor(a, m => m.t === 'ev' && m.kind === 'joined' && m.name === '민수');
  });

  await step('같은 이름으로 들어오면 뒤에 숫자가 붙는다', async () => {
    const c = await join(code, '민수');
    const s = await waitFor(c, m => m.t === 'state' && m.players.length === 3);
    assert.ok(s.players.some(p => p.name === '민수2'), JSON.stringify(s.players.map(p => p.name)));
    const k = mark(a);
    tx(c, { t: 'leave' });
    await waitFor(c, m => m.t === 'left');
    await waitFor(a, m => m.t === 'state' && m.players.length === 2, { from: k });
    c.close();
  });

  await step('채팅이 같은 방 모두에게 간다(보낸 사람 포함)', async () => {
    tx(b, { t: 'chat', text: '  안녕하세요  ' });
    const c1 = await waitFor(a, m => m.t === 'chat');
    assert.strictEqual(c1.text, '안녕하세요');
    assert.strictEqual(c1.name, '민수');
    assert.strictEqual(c1.from, b.me.you);
    await waitFor(b, m => m.t === 'chat');
  });

  await step('방장이 아니면 시작 · 봇 추가 · 설정을 못 한다', async () => {
    const k = mark(a);
    tx(b, { t: 'start' }); tx(b, { t: 'addBot' }); tx(b, { t: 'cfg', priv: true });
    await sleep(200);
    assert.ok(!a.inbox.slice(k).some(m => m.t === 'state'), '방장 아닌 사람의 조작이 먹힘');
  });

  await step('비공개 방은 열린 방 목록에 안 보인다', async () => {
    let list = await listRooms();
    assert.ok(list.some(r => r.code === code), '공개 방이 목록에 없음');
    const k = mark(a);
    tx(a, { t: 'cfg', priv: true });
    await waitFor(a, m => m.t === 'state' && m.cfg.priv === true, { from: k });
    list = await listRooms();
    assert.ok(!list.some(r => r.code === code), '비공개로 바꿨는데 목록에 보임');
    const p = await create('숨은방', { priv: true });
    list = await listRooms();
    assert.ok(!list.some(r => r.code === p.me.code), '비공개로 만든 방이 목록에 보임');
    tx(p, { t: 'leave' }); await waitFor(p, m => m.t === 'left'); p.close();
    tx(a, { t: 'cfg', priv: false });
    await waitFor(a, m => m.t === 'state' && m.cfg.priv === false);
  });

  await step('봇 실력은 방 설정이다', async () => {
    const k = mark(a);
    tx(a, { t: 'cfg', skill: 1 });
    await waitFor(a, m => m.t === 'state' && m.cfg.skill === 1, { from: k });
    tx(a, { t: 'cfg', skill: 7 });         // 없는 값은 무시
    await sleep(100);
    assert.strictEqual(lastState(a).cfg.skill, 1);
  });

  let idA, idB;
  await step('시작하면 사람마다 자기 시야를 받고, 빈 손으로 시작 패를 고른다', async () => {
    const k = mark(a), kb = mark(b);
    tx(a, { t: 'start' });
    const sa = await waitFor(a, m => m.t === 'state' && m.phase === 'playing', { from: k });
    const sb = await waitFor(b, m => m.t === 'state' && m.phase === 'playing', { from: kb });
    idA = a.me.you; idB = b.me.you;
    assert.strictEqual(sa.view.me, idA);
    assert.strictEqual(sb.view.me, idB);
    assert.strictEqual(sa.view.phase, 'setup');
    assert.strictEqual(sa.view.handSize, 4);
    assert.strictEqual(sa.view.poolCount, 26);
    assert.ok(sa.view.pool.every(t => Object.keys(t).join() === 'color'), '바닥 타일에 색 말고 다른 것이 실림');
  });

  await step('시작 패는 고른 색으로 온다 · 남의 패는 몇 장인지만 보이고 끼운 자리는 안 보인다', async () => {
    for (let i = 0; i < 4; i++) {
      const v = lastView(a);
      const want = i % 2 ? 'w' : 'b';
      // 일부러 다른 색 자리 번호를 보낸다 — 서버가 같은 색 중에서 준다(예전 poolIndexFor)
      const wrong = v.pool.findIndex(t => t.color !== want);
      const k = mark(a), kb = mark(b);
      act(a, 'draftPick', [wrong, want]);
      const s = await waitFor(a, m => m.t === 'state' && m.view && meIn(m.view).hand.length === i + 1, { from: k });
      assert.strictEqual(s.view.lastEvent.type, 'draft');
      assert.ok(Number.isInteger(s.view.lastEvent.index), '내 시야에는 끼운 자리가 있어야 함');
      const sb = await waitFor(b, m => m.t === 'state' && m.view && m.view.players.find(p => p.id === idA).hand.length === i + 1, { from: kb });
      assert.ok(!('index' in sb.view.lastEvent), '남의 시작 패를 끼운 자리가 보임');
      const pa = sb.view.players.find(p => p.id === idA);
      assert.deepStrictEqual(pa.counts, { b: Math.ceil((i + 1) / 2), w: Math.floor((i + 1) / 2) }, '고른 색이 안 옴');
      assert.ok(pa.hand.every(h => h.tile.color === null && h.tile.n === null), '정리 중인 남의 배치가 보임');
    }
    const k = mark(a);
    act(a, 'draftPick', [0, 'b']);
    const e = await waitFor(a, m => m.t === 'err', { from: k });
    assert.strictEqual(e.msg, '이미 다 골랐습니다');
    act(a, 'draftPick', ['length', 'b']);            // 모양이 틀린 인자는 규칙에 닿기 전에 거절
    await waitFor(a, m => m.t === 'err' && m.msg === '잘못된 요청입니다.', { from: k });
    for (let i = 0; i < 4; i++) {
      const v = lastView(b);
      const kk = mark(b);
      act(b, 'draftPick', [rnd(v.pool.length)]);
      await waitFor(b, m => m.t === 'state' && m.view && meIn(m.view).hand.length === i + 1, { from: kk });
    }
  });

  await step('준비를 누르면 배치(색)가 공개되고 숫자는 여전히 숨는다 · 모두 준비하면 순서 패', async () => {
    const kb = mark(b);
    act(a, 'setupReady');
    const sb = await waitFor(b, m => m.t === 'state' && m.view && m.view.ready[idA], { from: kb });
    const pa = sb.view.players.find(p => p.id === idA);
    assert.ok(pa.hand.every(h => (h.tile.color === 'b' || h.tile.color === 'w') && h.tile.n === null && h.tile.joker === null));
    act(b, 'setupReady');
    const s = await waitFor(a, m => m.t === 'state' && m.view && m.view.phase === 'order');
    assert.strictEqual(s.view.order.tiles.length, 12);
    assert.ok(s.view.order.tiles.every(t => t.n === null), '뽑기 전인데 순서 패 숫자가 보임');
  });

  await step('순서 패 — 내 것만 먼저 보이고, 다 뽑으면 공개 · 가장 높은 사람이 고르면 서버가 판을 연다', async () => {
    let k = mark(a), kb = mark(b);
    act(a, 'orderPick', [3]);
    const sa = await waitFor(a, m => m.t === 'state' && m.view && m.view.order.tiles[3].by === idA, { from: k });
    const sb = await waitFor(b, m => m.t === 'state' && m.view && m.view.order.tiles[3].by === idA, { from: kb });
    assert.strictEqual(typeof sa.view.order.tiles[3].n, 'number');
    assert.strictEqual(sb.view.order.tiles[3].n, null, '남이 뽑은 순서 패 숫자가 다 뽑기 전에 보임');
    kb = mark(b);
    act(b, 'orderPick', [3]);
    assert.strictEqual((await waitFor(b, m => m.t === 'err', { from: kb })).msg, '이미 누가 뽑은 패입니다');
    act(b, 'orderPick', [7]);
    const s = await waitFor(a, m => m.t === 'state' && m.view && m.view.order && m.view.order.winnerId);
    const w = s.view.order.winnerId === idA ? a : b;
    k = mark(a);
    act(w, 'orderChoose', [true]);
    const go = await waitFor(a, m => m.t === 'state' && m.view && m.view.phase === 'draw', { from: k });
    assert.strictEqual(go.view.firstId, w.me.you);
    assert.strictEqual(go.view.players[go.view.turn].id, w.me.you);
  });

  await step('남의 차례 · 규칙 위반 · 모양이 틀린 요청은 서버가 거절한다', async () => {
    const v = lastView(a);
    const cur = myTurn(v) ? a : b, other = cur === a ? b : a;
    let k = mark(other);
    act(other, 'draw', [0, 'b']);
    assert.strictEqual((await waitFor(other, m => m.t === 'err', { from: k })).msg, '당신의 차례가 아닙니다');
    k = mark(cur);
    act(cur, 'guess', [other.me.you, 0, 'b', 3]);
    assert.strictEqual((await waitFor(cur, m => m.t === 'err', { from: k })).msg, '지금은 추측할 수 없습니다');
    act(cur, 'guess', [other.me.you, 'length', 'b', 3]);
    await waitFor(cur, m => m.t === 'err' && m.msg === '잘못된 요청입니다.', { from: k });
    act(cur, 'eval', []);                               // 없는 행동은 아예 무시
    act(cur, 'constructor', []);
    await sleep(80);
  });

  await step('추측 — 맞히면 모두에게 공개, 틀리면 집은 패를 공개해서 놓는다', async () => {
    let v = lastView(a);
    const cur = myTurn(v) ? a : b, other = cur === a ? b : a;
    // 집기 — 흰색을 달라고 하면 흰색이 온다
    let k = mark(cur);
    const wi = v.pool.findIndex(t => t.color === 'w');
    act(cur, 'draw', [wi, 'w']);
    let s = await waitFor(cur, m => m.t === 'state' && m.view && m.view.phase === 'guess', { from: k });
    assert.strictEqual(s.view.drawn.color, 'w');
    const so = lastView(other);
    assert.strictEqual(so.drawn, null, '남이 집은 패가 보임');
    assert.strictEqual(so.drawnColor, 'w');
    act(cur, 'guess', [cur.me.you, 0, 'b', 0]);
    await waitFor(cur, m => m.t === 'err' && m.msg === '자기 타일은 맞힐 수 없습니다', { from: k });

    // 맞히기 — 시험이라 상대 화면(자기 패는 숫자까지 보인다)을 몰래 본다
    const theirs = meIn(lastView(other));
    const j = theirs.hand.findIndex(h => !h.faceUp);
    const t = theirs.hand[j].tile;
    k = mark(cur); let ko = mark(other);
    act(cur, 'guess', [other.me.you, j, t.color, t.joker ? null : t.n]);
    s = await waitFor(cur, m => m.t === 'state' && m.view && m.view.phase === 'decide', { from: k });
    const seen = await waitFor(other, m => m.t === 'state' && m.view && m.view.lastEvent && m.view.lastEvent.type === 'guess', { from: ko });
    assert.strictEqual(seen.view.lastEvent.hit, true);
    assert.deepStrictEqual(seen.view.lastEvent.actual, t);
    const opened = s.view.players.find(p => p.id === other.me.you).hand[j];
    assert.ok(opened.faceUp && tileId(opened.tile) === tileId(t), '맞힌 패가 공개되지 않음');

    // 이어서 — 이번엔 일부러 틀린다
    k = mark(cur);
    act(cur, 'decide', [true]);
    await waitFor(cur, m => m.t === 'state' && m.view && m.view.phase === 'guess', { from: k });
    const j2 = theirs.hand.findIndex((h, i) => i !== j && !h.faceUp);
    const t2 = theirs.hand[j2].tile;
    const wrongN = t2.joker ? 0 : (t2.n + 1) % 12;
    k = mark(cur); ko = mark(other);
    act(cur, 'guess', [other.me.you, j2, t2.color, wrongN]);
    s = await waitFor(cur, m => m.t === 'state' && m.view && m.view.phase === 'place', { from: k });
    assert.strictEqual(s.view.pending.faceUp, true);
    const miss = await waitFor(other, m => m.t === 'state' && m.view && m.view.lastEvent && m.view.lastEvent.type === 'guess', { from: ko });
    assert.strictEqual(miss.view.lastEvent.hit, false);
    assert.strictEqual(miss.view.lastEvent.actual, null, '빗나간 패의 실제 값이 샘');
    assert.strictEqual(miss.view.pending, null);
    assert.strictEqual(miss.view.players.find(p => p.id === other.me.you).hand[j2].tile.n, t2.n, '');   // 자기 패는 본다
    const drawnId = tileId(s.view.pending.tile);
    ko = mark(other);
    act(cur, 'place', [s.view.pendingSpots[0]]);
    const after = await waitFor(other, m => m.t === 'state' && m.view && m.view.lastEvent && m.view.lastEvent.type === 'placed', { from: ko });
    const put = after.view.players.find(p => p.id === cur.me.you).hand[after.view.lastEvent.index];
    assert.ok(put.faceUp && tileId(put.tile) === drawnId, '빗나간 뒤 집은 패가 공개되지 않음');
    assert.ok(myTurn(after.view), '차례가 넘어가지 않음');
  });

  await step('새로고침(resume)하면 같은 자리 · 같은 시야로 돌아온다', async () => {
    const before = lastView(b);
    const b2 = await open();
    tx(b2, { t: 'resume', code, token: b.me.token });
    const w = await waitFor(b2, m => m.t === 'welcome');
    assert.strictEqual(w.you, idB);
    const s = await waitFor(b2, m => m.t === 'state' && m.phase === 'playing');
    assert.strictEqual(s.view.me, idB);
    assert.deepStrictEqual(meIn(s.view).hand, meIn(before).hand, '돌아왔는데 손패가 다름');
    // 옛 탭은 4001 로 닫힌다 — 두 탭이 서로 밀어내지 않게
    await waitFor(b, m => m.t === 'moved');
    const end = Date.now() + 2000;
    while (b.closed == null && Date.now() < end) await sleep(10);
    assert.strictEqual(b.closed, 4001);
    await sleep(100);
    const me = lastState(a).players.find(p => p.id === idB);
    assert.strictEqual(me.connected, true, '새 소켓이 붙어 있는데 끊긴 걸로 표시됨');
    b2.me = Object.assign({}, w);
    b = b2;
  });

  await step('틀린 자리표로는 돌아올 수 없다 · 시작한 방에는 못 들어온다', async () => {
    const x = await open();
    tx(x, { t: 'resume', code, token: 'nope' });
    const e = await waitFor(x, m => m.t === 'err');
    assert.strictEqual(e.fatal, true);
    tx(x, { t: 'join', code, name: '늦음' });
    const e2 = await waitFor(x, m => m.t === 'err' && !m.fatal);
    assert.strictEqual(e2.msg, '이미 시작된 방입니다.');
    x.close();
  });

  await step('방장이 끊기면 유예 뒤에 남은 사람에게 넘어가고, 판은 이어진다', async () => {
    await finishTurn(a);                  // b 차례에 끊겨야 판이 곧바로 끝나지 않는다
    assert.ok(!myTurn(lastView(a)) || lastView(a).phase === 'over');
    const k = mark(b);
    a.close();
    await sleep(GRACE / 3);
    assert.strictEqual(lastState(b).hostId, idA, '유예 전에 방장이 넘어감');
    const s = await waitFor(b, m => m.t === 'state' && m.hostId === idB, { from: k, ms: 3000 });
    assert.strictEqual(s.phase, 'playing');
  });

  await step('끊긴 사람 차례가 오면 유예 뒤 판에서 빠지고, 남은 사람이 이긴다', async () => {
    await finishTurn(b);                  // b 가 두고 나면 끊긴 a 차례다
    const s = await waitFor(b, m => m.t === 'state' && m.phase === 'over', { ms: 4000, what: '(끊긴 사람 빠짐)' });
    assert.ok(s.view.players.find(p => p.id === idA).out, '끊긴 사람이 빠지지 않음');
    assert.strictEqual(s.view.winner, idB);
    await waitFor(b, m => m.t === 'ev' && m.kind === 'dropped');
  });

  await step('여기까지 두 사람이 받은 메시지에 숨은 숫자가 하나도 없다', async () => {
    const n = assertNoLeak(everyone.filter(c => c.me && c.me.code === code), '두 사람 판');
    console.log(`      메시지 ${n}개 검사`);
  });

  await step('끝난 뒤 방장이 대기실로를 누르면 모두 대기실로 돌아가고, 끊긴 자리는 비워진다', async () => {
    const k = mark(b);
    tx(b, { t: 'again' });
    await waitFor(b, m => m.t === 'state' && m.phase === 'lobby', { from: k });
    const s = await waitFor(b, m => m.t === 'state' && m.phase === 'lobby' && m.players.length === 1, { from: k, ms: 3000 });
    assert.strictEqual(s.view, null);
  });

  await step('대기실 새로고침은 유예 안에 돌아오면 자리가 남는다 · 방장은 내보낼 수 있다', async () => {
    const c = await join(code, '지훈');
    const idC = c.me.you;
    c.close();
    await sleep(GRACE / 3);
    const c2 = await open();
    tx(c2, { t: 'resume', code, token: c.me.token });
    const w = await waitFor(c2, m => m.t === 'welcome');
    assert.strictEqual(w.you, idC);
    await sleep(GRACE + 100);
    assert.ok(lastState(b).players.some(p => p.id === idC), '돌아왔는데 자리가 지워짐');
    const k = mark(c2);
    tx(b, { t: 'kick', id: idC });
    const e = await waitFor(c2, m => m.t === 'err' && m.fatal, { from: k });
    assert.ok(/내보냈/.test(e.msg));
    await sleep(80);
    assert.ok(!lastState(b).players.some(p => p.id === idC));
    c2.close();
  });

  await step('방장이 새로고침하면 유예 안에 돌아와 방장을 지킨다', async () => {
    const h = await create('새로고침방장');
    const d = await join(h.me.code, '기다림');
    await waitFor(h, m => m.t === 'state' && m.players.length === 2);
    h.close();
    await sleep(GRACE / 3);
    const h2 = await open();
    tx(h2, { t: 'resume', code: h.me.code, token: h.me.token });
    await waitFor(h2, m => m.t === 'welcome');
    await sleep(GRACE + 150);
    assert.strictEqual(lastState(d).hostId, h.me.you, '돌아왔는데 방장을 잃음');
    assert.strictEqual(lastState(d).players.length, 2);
    h2.close(); d.close();
  });

  await step('모두 끊겼으면 먼저 돌아온 사람이 방장을 맡는다', async () => {
    const h = await create('먼저나감');
    const d = await join(h.me.code, '먼저옴');
    tx(h, { t: 'addBot' });
    await waitFor(h, m => m.t === 'state' && m.players.length === 3);
    tx(h, { t: 'start' });
    await waitFor(d, m => m.t === 'state' && m.phase === 'playing');
    h.close(); d.close();
    await sleep(40);
    const d2 = await open();
    tx(d2, { t: 'resume', code: h.me.code, token: d.me.token });
    const s = await waitFor(d2, m => m.t === 'state');
    assert.strictEqual(s.hostId, d.me.you, '돌아온 사람이 방장을 못 맡음');
    d2.close();
  });

  await step('대기실에서 끊긴 자리는 유예 뒤 비워지고 돌아올 수 없다', async () => {
    b.close();
    await sleep(GRACE + 150);
    const x = await open();
    tx(x, { t: 'resume', code, token: b.me.token });
    const r = await waitFor(x, m => m.t === 'err' || m.t === 'welcome');
    assert.strictEqual(r.t, 'err', '대기실에서 끊긴 자리가 유예 뒤에도 남아 있음');
    x.close();
  });

  await step('조커를 옮긴 것은 본인만 안다 — 남에게는 아무것도 가지 않는다', async () => {
    const { a: j, b: o, tries } = await jokerRoom();
    for (let i = 0; i < 4; i++) {
      const v = lastView(o);
      const k = mark(o);
      act(o, 'draftPick', [rnd(v.pool.length)]);
      await waitFor(o, m => m.t === 'state' && m.view && meIn(m.view).hand.length === i + 1, { from: k });
    }
    await sleep(50);
    const v = lastView(j);
    const from = v.myJokers[0];
    const to = from === 0 ? 3 : 0;
    const k = mark(j), ko = mark(o);
    act(j, 'setupMove', [from, to]);
    const s = await waitFor(j, m => m.t === 'state' && m.view && m.view.lastEvent && m.view.lastEvent.type === 'setupMove', { from: k });
    assert.ok(meIn(s.view).hand[to].tile.joker, '조커가 옮겨지지 않음');
    await sleep(250);
    assert.strictEqual(o.inbox.length, ko, '조커를 옮겼는데 상대에게 무언가 감: ' + JSON.stringify(o.inbox.slice(ko)).slice(0, 200));
    // 준비를 누르면 상대는 배치(색)를 보지만, 방금 이벤트는 조커 옮기기가 아니라 그 전 것이다
    act(j, 'setupReady');
    const so = await waitFor(o, m => m.t === 'state' && m.view && m.view.ready[j.me.you], { from: ko });
    assert.notStrictEqual(so.view.lastEvent && so.view.lastEvent.type, 'setupMove');
    const hj = so.view.players.find(p => p.id === j.me.you).hand;
    assert.ok(hj.every(h => h.tile.joker === null && h.tile.n === null), '준비 뒤 조커 자리가 보임');
    // 끝까지 두고, 두 사람 메시지 전부를 검사한다
    const { over } = await playOut([j, o]);
    assert.ok(over.view.winner);
    const n = assertNoLeak([j, o], '조커 방');
    console.log(`      ${tries}번째 방에서 조커 · 메시지 ${n}개 검사`);
    j.close(); o.close();
  });

  await step('시작 패를 고르다 끊긴 사람은 유예 뒤 빠지고, 남은 사람끼리 순서 패로 넘어간다', async () => {
    const h = await create('남음');
    const d = await join(h.me.code, '끊김');
    tx(h, { t: 'addBot' });
    await waitFor(h, m => m.t === 'state' && m.players.length === 3);
    tx(h, { t: 'start' });
    await waitFor(d, m => m.t === 'state' && m.phase === 'playing');
    d.close();
    await doSetup(h);
    const s = await waitFor(h, m => m.t === 'state' && m.view && m.view.phase === 'order', { ms: 4000, what: '(순서 패로)' });
    assert.ok(s.view.players.find(p => p.id === d.me.you).out, '끊긴 사람이 빠지지 않음');
    await waitFor(h, m => m.t === 'ev' && m.kind === 'dropped' && m.name === '끊김');
    tx(h, { t: 'leave' }); await waitFor(h, m => m.t === 'left'); h.close();
  });

  await step('판 중에 나가기를 누르면 곧바로 판에서 빠진다', async () => {
    const h = await create('하나');
    const d = await join(h.me.code, '둘');
    const e = await join(h.me.code, '셋');
    await waitFor(h, m => m.t === 'state' && m.players.length === 3);
    tx(h, { t: 'start' });
    await waitFor(e, m => m.t === 'state' && m.phase === 'playing');
    const k = mark(h);
    tx(d, { t: 'leave' });
    await waitFor(d, m => m.t === 'left');
    const s = await waitFor(h, m => m.t === 'state' && m.players.length === 2, { from: k });
    assert.ok(s.view.players.find(p => p.id === d.me.you).out, '나간 사람이 판에 남음');
    await waitFor(h, m => m.t === 'ev' && m.kind === 'left' && m.name === '둘');
    // 남은 둘이 끝까지 — 나간 사람을 기다리며 멈추지 않는다
    const { over } = await playOut([h, e]);
    assert.ok([h.me.you, e.me.you].includes(over.view.winner));
    assertNoLeak([h, d, e], '나간 방');
    [h, d, e].forEach(x => x.close());
  });

  await step('사람 둘 + 봇 둘로 한 판을 끝까지 두고, 두 사람이 받은 모든 메시지를 누출 검사한다', async () => {
    const h = await create('사람하나');
    const g = await join(h.me.code, '사람둘');
    tx(h, { t: 'addBot' }); tx(h, { t: 'addBot' });
    await waitFor(h, m => m.t === 'state' && m.players.length === 4);
    tx(h, { t: 'start' });
    const { over, moves } = await playOut([h, g]);
    const v = over.view;
    assert.strictEqual(v.players.filter(p => !p.out).length, 1);
    assert.strictEqual(v.winner, v.players.find(p => !p.out).id);
    assert.ok(h.inbox.some(m => m.t === 'state' && m.view && m.view.lastEvent && m.view.lastEvent.type === 'guess'), '추측이 한 번도 없음');
    const n = assertNoLeak([h, g], '사람 둘 + 봇 둘');
    console.log(`      사람 수 ${moves}번 · 승자 ${v.players.find(p => p.id === v.winner).name} · 메시지 ${n}개 검사`);
    h.close(); g.close();
  });

  await step('사람 하나 + 봇 셋으로 한 판을 끝까지 둔다', async () => {
    const h = await create('혼자온라인');
    for (let i = 0; i < 3; i++) tx(h, { t: 'addBot' });
    await waitFor(h, m => m.t === 'state' && m.players.length === 4);
    tx(h, { t: 'addBot' });                    // 다섯 번째는 거절
    await waitFor(h, m => m.t === 'err' && /자리/.test(m.msg));
    tx(h, { t: 'start' });
    const { over, moves } = await playOut([h]);
    const v = over.view;
    assert.strictEqual(v.handSize, 3);
    assert.strictEqual(v.winner, v.players.find(p => !p.out).id);
    const n = assertNoLeak([h], '사람 하나 + 봇 셋');
    console.log(`      내 수 ${moves}번 · 승자 ${v.players.find(p => p.id === v.winner).name} · 메시지 ${n}개 검사`);
    h.close();
  });

  await step('ping 은 아무 일도 일으키지 않는다 · 빈 메시지는 무시한다', async () => {
    const x = await open();
    tx(x, { t: 'ping' }); x.send('not json'); tx(x, { nope: 1 }); tx(x, { t: 'act' });
    await sleep(200);
    assert.strictEqual(x.inbox.length, 0);
    x.close();
  });

  await step('누출 검사기는 판 상태가 통째로 새면 잡아낸다', async () => {
    const s = R.newGame([{ id: 'p1', name: '가' }, { id: 'p2', name: '나' }], 7);
    s.players.forEach(p => { while (p.hand.length < s.handSize) R.draftPick(s, p.id, 0); R.setupReady(s, p.id); });
    const good = { t: 'state', view: R.viewFor(s, 'p1') };
    assert.deepStrictEqual(leaks([good]).problems, [], '멀쩡한 시야를 누출로 봄');
    // (1) 남의 손패를 원본 그대로 끼워 넣은 시야
    const bad1 = JSON.parse(JSON.stringify(good));
    bad1.view.players[1].hand = s.players[1].hand;
    assert.ok(leaks([bad1]).problems.length > 0, '남의 손패가 통째로 온 것을 못 잡음');
    // (2) 바닥 숫자까지 실린 시야
    const bad2 = JSON.parse(JSON.stringify(good));
    bad2.view.pool = s.pool;
    assert.ok(leaks([bad2]).problems.length > 0, '바닥 숫자가 온 것을 못 잡음');
    // (3) 이벤트 한 줄에 남의 타일이 실린 것
    const bad3 = JSON.parse(JSON.stringify(good));
    bad3.view.lastEvent = { type: 'placed', by: 'p2', tile: s.players[1].hand[0].tile };
    assert.ok(leaks([bad3]).problems.length > 0, '이벤트에 실린 남의 타일을 못 잡음');
    // (4) 남이 조커를 옮겼다는 이벤트
    const bad4 = JSON.parse(JSON.stringify(good));
    bad4.view.lastEvent = { type: 'setupMove' };
    assert.ok(leaks([bad4]).problems.length > 0, '남의 조커 옮기기를 못 잡음');
  });
}

(async () => {
  let srv = { kill() {} };
  let stderr = '';
  if (!USE_EXISTING) {
    srv = spawn(process.execPath, [require.resolve('../server.js')], {
      env: Object.assign({}, process.env, { PORT: String(PORT), DAVINCI_FAST: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    srv.stderr.on('data', d => { stderr += d; process.stderr.write(d); });
    await new Promise((r, j) => {
      srv.stdout.on('data', d => { if (String(d).includes('다빈치코드 서버')) r(); });
      srv.on('exit', c => j(new Error('서버가 뜨지 않음 ' + c)));
    });
  }
  console.log('다빈치코드 서버 흐름 → ' + URL);
  try {
    await scenarios();
    // 실제 값 — FAST 없이 불러서 유예가 20초인지 본다
    delete process.env.DAVINCI_FAST;
    const g = require('../game');
    assert.strictEqual(g.FAST, false);
    assert.strictEqual(g.LOBBY_GRACE, 20000, '방장 넘기기 유예가 20초가 아님');
    assert.strictEqual(g.DC_GRACE, 20000);
    assert.ok(g.readMs('봇 둘→봇 하나2번째3예측', 1400) > 1400);
    pass++; console.log('  ✓ 실제 유예는 20초, 읽는 시간은 글자 수만큼');

    assert.strictEqual(stderr.trim(), '', '서버가 오류를 뱉음');
    console.log(`\n통과 ${pass}\n`);
    everyone.forEach(c => { try { c.close(); } catch (_) {} });
    srv.kill();
    process.exit(0);
  } catch (e) {
    console.error('\n실패:', e.stack || e.message, '\n');
    srv.kill();
    process.exit(1);
  }
})();
