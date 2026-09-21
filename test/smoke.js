'use strict';
/**
 * 떠 있는 서버에 붙어서 한 판의 뼈대를 확인한다 — 어느 서버든 주소만 주면 된다.
 *   node test/smoke.js http://127.0.0.1:8876          (node server.js)
 *   node test/smoke.js http://127.0.0.1:8877          (wrangler dev)
 *   node test/smoke.js https://davinci.41ways.workers.dev (배포본)
 * 화면 파일(심볼릭 링크로 둔 rules.js · ai.js 포함) · 상태 확인 · 방 만들기 · 들어가기 · 채팅 ·
 * 열린 방 목록과 비공개 방 · 시작 패 고르기부터 첫 추측까지 · 남의 숫자가 안 오는지 · 새로고침(resume)까지.
 * 배포본에서도 돌 수 있게 봇 뜸을 기다린다(DAVINCI_FAST 가 없어도 된다).
 * IDLE=1 을 주면 조작 없는 소켓이 4000 으로 닫히는지도 본다(서버를 IDLE_MS 를 줄여 띄웠을 때만).
 */
const assert = require('assert');
const WebSocket = require('ws');
const AI = require('../ai');

const BASE = (process.argv[2] || 'http://127.0.0.1:8876').replace(/\/$/, '');
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function open() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    ws.inbox = [];
    ws.closed = null;
    ws.on('message', raw => ws.inbox.push(JSON.parse(raw)));
    ws.on('close', code => { ws.closed = code; });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
const tx = (ws, obj) => ws.send(JSON.stringify(obj));
const act = (ws, action, args) => tx(ws, { t: 'act', action, args: args || [] });
async function waitFor(ws, pred, ms = 6000, what = '') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (let i = ws.inbox.length - 1; i >= 0; i--) if (pred(ws.inbox[i])) return ws.inbox[i];
    await sleep(25);
  }
  throw new Error('기다리던 메시지가 오지 않음 ' + what + ': ' + JSON.stringify(ws.inbox.slice(-2)).slice(0, 300));
}
async function rooms() {
  const ws = await open();
  tx(ws, { t: 'rooms' });
  const m = await waitFor(ws, x => x.t === 'rooms');
  ws.close();
  return m.list;
}
const lastView = ws => { const s = ws.inbox.filter(m => m.t === 'state').pop(); return s && s.view; };
const meIn = v => v.players.find(p => p.id === v.me);
const myTurn = v => v && v.phase !== 'over' && v.players[v.turn].id === v.me;
const isView = pred => m => m.t === 'state' && m.view && pred(m.view);

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + e.message); }
}

(async () => {
  console.log('다빈치코드 연결 확인 → ' + BASE);
  let a, b, code, tokenB, idA, idB;

  await check('화면 파일이 나온다', async () => {
    const html = await fetch(BASE + '/').then(r => r.text());
    assert.ok(html.includes('다빈치코드') && html.includes('app.js'), 'index.html 이 아님');
    assert.ok(!/peerjs|net\.js/.test(html), '옛 PeerJS 스크립트가 남아 있음');
    for (const f of ['/style.css', '/app.js']) {
      const r = await fetch(BASE + f);
      assert.strictEqual(r.status, 200, f + ' ' + r.status);
    }
  });

  await check('rules.js · ai.js 가 루트 원본 그대로 나온다 (심볼릭 링크)', async () => {
    const fs = require('fs'), path = require('path');
    for (const f of ['rules.js', 'ai.js']) {
      const r = await fetch(BASE + '/' + f);
      assert.strictEqual(r.status, 200, f + ' ' + r.status);
      const body = await r.text();
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      assert.strictEqual(body, src, f + ' 내용이 루트 원본과 다름');
    }
  });

  await check('서버 코드는 밖으로 안 나간다', async () => {
    for (const f of ['/game.js', '/worker.js', '/server.js', '/wrangler.toml']) {
      const r = await fetch(BASE + f);
      const body = await r.text();
      assert.ok(r.status === 404 || !/require\('\.\/rules'\)|DurableObject|WebSocketServer/.test(body), f + ' 가 그대로 나감');
    }
  });

  await check('상태 확인', async () => {
    const h = await fetch(BASE + '/healthz').then(r => r.json());
    assert.strictEqual(h.ok, true);
    assert.strictEqual(typeof h.rooms, 'number');
    assert.strictEqual(typeof h.sockets, 'number');
  });

  await check('방 만들기 · 들어가기', async () => {
    a = await open();
    tx(a, { t: 'create', name: '방장' });
    const w = await waitFor(a, m => m.t === 'welcome');
    code = w.code; idA = w.you;
    b = await open();
    tx(b, { t: 'join', code, name: '민수' });
    const wb = await waitFor(b, m => m.t === 'welcome');
    tokenB = wb.token; idB = wb.you;
    const s = await waitFor(a, m => m.t === 'state' && m.players.length === 2);
    assert.strictEqual(s.phase, 'lobby');
  });

  await check('ping 은 아무 일도 일으키지 않는다', async () => {
    const n = a.inbox.length;
    tx(a, { t: 'ping' });
    await sleep(300);
    assert.strictEqual(a.inbox.length, n);
  });

  await check('채팅이 같은 방에 간다', async () => {
    tx(b, { t: 'chat', text: '안녕하세요' });
    const c = await waitFor(a, m => m.t === 'chat');
    assert.strictEqual(c.text, '안녕하세요');
    assert.strictEqual(c.name, '민수');
  });

  await check('열린 방 목록에 보이고, 비공개로 바꾸면 사라진다', async () => {
    assert.ok((await rooms()).some(r => r.code === code), '목록에 없음');
    tx(a, { t: 'cfg', priv: true });
    await waitFor(a, m => m.t === 'state' && m.cfg.priv === true);
    assert.ok(!(await rooms()).some(r => r.code === code), '비공개인데 목록에 보임');
  });

  await check('시작 패를 고르고 준비하면 순서 패, 고르면 판이 열린다', async () => {
    tx(a, { t: 'start' });
    for (const [ws, id] of [[a, idA], [b, idB]]) {
      await waitFor(ws, isView(v => v.phase === 'setup'));
      for (let i = 0; i < 4; i++) {
        const v = lastView(ws);
        const k = Math.floor(Math.random() * v.pool.length);
        act(ws, 'draftPick', [k, v.pool[k].color]);
        await waitFor(ws, isView(x => meIn(x).hand.length === i + 1), 6000, '(시작 패)');
      }
      act(ws, 'setupReady');
      await waitFor(ws, isView(x => x.ready[id] || x.phase !== 'setup'));
    }
    const o = await waitFor(a, isView(v => v.phase === 'order'));
    act(a, 'orderPick', [0]);
    act(b, 'orderPick', [11]);
    const w = await waitFor(a, isView(v => v.order && v.order.winnerId), 6000, '(순서 패)');
    act(w.view.order.winnerId === idA ? a : b, 'orderChoose', [true]);
    // 판 열기는 서버가 선공을 읽을 시간을 준 뒤에 한다 (배포본이면 3초 남짓)
    await waitFor(a, isView(v => v.phase === 'draw'), 10000, '(판 열기)');
    assert.ok(o.view.order.tiles.length === 12);
  });

  await check('차례인 사람이 집고 추측한다 — 결과는 둘 다 받는다', async () => {
    const v = lastView(a);
    const who = myTurn(v) ? a : b, other = who === a ? b : a;
    const pv = lastView(who);
    const k = Math.floor(Math.random() * pv.pool.length);
    act(who, 'draw', [k, pv.pool[k].color]);
    const g = await waitFor(who, isView(x => x.phase === 'guess'));
    const mv = AI.chooseGuess(g.view, Math.random, 1);
    act(who, 'guess', [mv.targetId, mv.index, mv.color, mv.n]);
    await waitFor(other, isView(x => x.lastEvent && x.lastEvent.type === 'guess'), 6000, '(추측)');
  });

  await check('상대의 덮인 숫자와 집은 패는 오지 않는다', async () => {
    for (const ws of [a, b]) {
      for (const m of ws.inbox) {
        if (m.t !== 'state' || !m.view) continue;
        const v = m.view;
        for (const p of v.players) {
          if (p.id === v.me) continue;
          for (const h of p.hand) if (!h.faceUp) assert.ok(h.tile.n === null && h.tile.joker === null, p.name + ' 숫자가 보임');
        }
        if (!myTurn(v)) assert.strictEqual(v.drawn, null, '남이 집은 패가 보임');
      }
    }
  });

  await check('새로고침해도 자리를 지키고, 옛 소켓이 닫혀도 끊긴 걸로 치지 않는다', async () => {
    const b2 = await open();
    tx(b2, { t: 'resume', code, token: tokenB });
    const s = await waitFor(b2, m => m.t === 'state' && m.phase === 'playing');
    assert.strictEqual(s.view.me, idB);
    b.close();
    await sleep(800);
    const last = a.inbox.filter(m => m.t === 'state').pop();
    assert.strictEqual(last.players.find(p => p.id === idB).connected, true, '새 소켓이 붙어 있는데 끊긴 걸로 표시됨');
    b = b2;
  });

  await check('같은 자리로 다른 탭이 들어오면 먼저 탭은 4001 로 닫힌다', async () => {
    const b2 = await open();
    tx(b2, { t: 'resume', code, token: tokenB });
    await waitFor(b2, m => m.t === 'welcome');
    const end = Date.now() + 3000;
    while (b.closed == null && Date.now() < end) await sleep(25);
    assert.strictEqual(b.closed, 4001);
    b = b2;
  });

  await check('나가기를 누르면 판에서 빠지고 남은 사람이 이긴다', async () => {
    tx(b, { t: 'leave' });
    await waitFor(b, m => m.t === 'left');
    const s = await waitFor(a, m => m.t === 'state' && m.phase === 'over');
    assert.strictEqual(s.view.winner, idA);
  });

  if (process.env.IDLE) {
    await check('조작이 없으면 4000 으로 닫힌다 (ping 만 보내도)', async () => {
      const c = await open();
      tx(c, { t: 'create', name: '가만히' });
      await waitFor(c, m => m.t === 'welcome');
      const end = Date.now() + 15000;
      while (c.closed == null && Date.now() < end) { tx(c, { t: 'ping' }); await sleep(400); }
      assert.strictEqual(c.closed, 4000);
      assert.ok(c.inbox.some(m => m.t === 'idle'), 'idle 알림이 먼저 와야 함');
      // 서버가 스스로 끊은 것이라 대기실 자리는 남아 있어야 한다 — 다시 누르면 이어 붙는다
      const w = c.inbox.find(m => m.t === 'welcome');
      const c2 = await open();
      tx(c2, { t: 'resume', code: w.code, token: w.token });
      const back = await waitFor(c2, m => m.t === 'welcome' || m.t === 'err');
      assert.strictEqual(back.t, 'welcome', '자리가 지워짐: ' + JSON.stringify(back));
      c2.close();
    });
  }

  a.close(); b.close();
  console.log(`\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
