/* 다빈치코드 — 화면과 진행
   길이 둘이다.
   - 혼자 하기(봇과): 이 브라우저가 rules.js · ai.js 로 직접 판을 돌린다. 서버를 거치지 않는다.
   - 친구와(온라인): 서버(game.js)가 심판이다. 여기서는 받은 시야를 그리고 행동만 보낸다.
     남의 숫자는 이 브라우저에 아예 오지 않는다 — 서버가 사람마다 viewFor 로 잘라 보낸다.
   두 길 모두 같은 applyView 로 그리므로 판 화면 코드는 하나다.
   추측 결과를 붙잡아 두는 연출(heldView · queue)도 화면 쪽 일이라 두 길이 같이 쓴다. */
(function () {
  'use strict';
  var R = window.Rules, AI = window.AI;
  var $ = function (id) { return document.getElementById(id); };

  var App = {
    mode: 'solo', state: null, view: null, me: null,
    seats: [], sel: null, setupSelColor: null, started: false, botTimer: null, skill: 0.75,
    shownEvent: null, animateEv: null,
    heldView: null, holdUntil: 0, holdTimer: null, announceTimer: null
  };

  var SCREENS = ['title', 'guide', 'menu', 'lobby', 'game'];
  function show(which) {
    // 판 화면을 벗어나면 "지금 판 중"에서 뺀다
    if (which !== 'game' && window.norara && norara.live) norara.live(false);
    SCREENS.forEach(function (id) { $(id).classList.toggle('hidden', id !== which); });
    window.scrollTo(0, 0);
    // 멈춤 표시가 화면 전환 중에 남으면 판이 영영 안 눌린다.
    // (연출 도중에 방장과 끊겨 메뉴로 튕기는 경우)
    clearTimeout(App.holdTimer);
    App.holdTimer = null; App.heldView = null; App.holdUntil = 0;
    clearTimeout(App.drainTimer); App.drainTimer = null; App.queue = [];
    document.body.classList.remove('holding');
    // 결과판·예측 상자는 화면 밖에 떠 있는 것이라 화면을 바꿔도 남는다.
    // 판이 끝난 뒤 방장이 나가 메뉴로 튕기면 메뉴 위에 결과판이 그대로 덮여 있었다.
    if (which === 'title' || which === 'menu' || which === 'guide') { $('chatBtn').hidden = true; $('chat').hidden = true; }
    pollRooms(which === 'title');               // 열린 방 목록은 첫 화면에 있는 동안만 훑는다
    if (which !== 'game') {
      $('over').classList.add('hidden');
      clearTimeout(App.announceTimer);
      $('announce').className = 'announce';
      $('nowband').classList.remove('behind');
    }
  }
  var toastTimer = null;
  function toast(msg) {
    var e = $('toast'); e.textContent = msg; e.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { e.classList.remove('on'); }, 2600);
  }
  function myName() { return $('name').value.trim() || '이름없음'; }
  function seatOf(id) {
    for (var i = 0; i < App.seats.length; i++) if (App.seats[i].id === id) return App.seats[i];
    return null;
  }

  /* ---------------- 진행 (혼자 하기 — 이 브라우저가 심판) ----------------
     온라인 판은 서버(game.js)가 같은 일을 한다. 여기 있는 것은 봇과 혼자 할 때만 돈다. */
  function startEngine() {
    if (App.seats.length < 2) { toast('2명 이상이어야 시작할 수 있습니다.'); return; }
    App.started = true;
    App.state = R.newGame(App.seats.map(function (s) { return { id: s.id, name: s.name }; }),
                          Math.floor(Math.random() * 1e9));
    App.sel = null; App.setupSelColor = null; App.shownEvent = null;
    // 판 수 세기 — 혼자 하기는 내가 방장이다. 온라인 판은 countGame 이 방장 화면에서만 센다.
    App.statAt = Date.now();
    App.statOver = false;
    if (window.norara) norara.ev('start', { n: 1 });
    show('game');
    pushViews();
  }

  // 남의 예측은 "누가 · 누구의 · 몇 번째를 · 무엇으로" 네 가지를 읽어야 한다.
  // 한글 짧은 문구는 눈에 들어오는 데 0.8초 + 글자당 0.07초쯤 걸린다.
  // 시간을 상수로 박아 두면 이름이 길거나 자릿수가 두 자리일 때 모자라므로,
  // 실제로 띄운 글자 수를 세서 그만큼 붙잡아 둔다. (qa/pace.py 가 이 기준으로 검사한다)
  var PREDICT_MINE_MS = 650;  // 내가 부른 값 — 내가 아는 것이라 결과로 바로 넘어간다
  var PREDICT_MIN_MS = 1400;  // 남의 예측 최소
  var VERDICT_MIN_MS = 1500;  // 결과 최소
  function readMs(text, floor) {
    var n = String(text || '').replace(/\s/g, '').length;
    return Math.max(floor, 800 + n * 70);
  }

  function pushViews() {
    if (App.mode !== 'solo' || !App.state) return;
    applyView(R.viewFor(App.state, App.me));
  }

  // 추측이 들어오면 '예측'을 먼저 크게 띄우고 판은 이전 상태로 잠시 멈춘다.
  // 1초 뒤에 실제 결과를 반영한다. 그래야 결과가 미리 새어나가지 않는다.
  //
  // 예측·결과를 띄워 두는 동안 들어온 상태는 줄을 세웠다가 차례로 보여 준다.
  // (맞힌 사람이 곧바로 다음 추측을 하면 첫 결과가 덮여 사라지고, 판도 두 칸 건너뛰었다.)
  App.queue = [];
  function busy() { return !!App.heldView || !!App.drainTimer; }

  function applyView(nv) {
    // 지금 판 중인지 — 온라인 판은 상태를 받을 때 countGame 이 알린다
    if (App.mode === 'solo' && window.norara && norara.live) norara.live(nv.phase !== 'over');
    if (busy()) { App.queue.push(nv); return; }
    // 차례나 단계가 바뀌면 고르던 대상을 푼다 — 참가자는 doAction 을 거치지 않아 다음 차례까지 남았다
    if (App.view && (App.view.turn !== nv.turn || App.view.phase !== nv.phase)) App.sel = null;
    var ev = nv.lastEvent, key = eventKey(ev);
    var fresh = !!key && key !== App.shownEvent;

    if (fresh && ev.type === 'guess' && App.view) {
      App.shownEvent = key;
      App.heldView = nv;
      announce(ev, false);
      var wait = (ev.by === nv.me)
        ? PREDICT_MINE_MS
        : readMs($('announce').textContent, PREDICT_MIN_MS);
      App.holdUntil = Date.now() + wait;
      App.animateEv = null;
      // 이 동안 판은 이전 상태를 보여 주지만 진짜 상태는 이미 넘어가 있다.
      // 눌러도 옛 화면 기준으로 명령이 나가 거부되므로, 아예 누를 수 없게 막는다.
      document.body.classList.add('holding');
      render();                                  // 이전 판을 그대로 둔다
      clearTimeout(App.holdTimer);
      App.holdTimer = setTimeout(function () {
        App.holdTimer = null;
        App.view = App.heldView; App.heldView = null; App.holdUntil = 0;
        document.body.classList.remove('holding');
        App.animateEv = ev;                      // 부서짐 / 흔들림 연출
        announce(ev, true);
        render();
        scheduleBot();
        drainQueue();
      }, wait);
      scheduleBot();
      return;
    }

    App.view = nv;
    App.shownEvent = fresh ? key : App.shownEvent;
    App.animateEv = fresh ? ev : null;
    render();
    scheduleBot();
  }

  // 줄 선 상태를 차례로 — 다음 추측은 방금 뜬 결과를 읽을 틈을 준 뒤에, 나머지는 곧바로
  function drainQueue() {
    while (App.queue.length && !busy()) {
      var q = App.queue[0], qev = q.lastEvent, qkey = eventKey(qev);
      if (qkey && qkey !== App.shownEvent && qev.type === 'guess') {
        App.queue.shift();
        var gap = readMs($('announce').textContent, VERDICT_MIN_MS);
        App.holdUntil = Date.now() + gap;        // 봇도 그만큼 기다리게
        App.drainTimer = setTimeout(function () {
          App.drainTimer = null;
          applyView(q);
          drainQueue();
        }, gap);
        return;
      }
      App.queue.shift();
      applyView(q);
    }
  }

  function announce(ev, withResult) {
    var box = $('announce');
    box.innerHTML = '';
    box.className = 'announce on' + (withResult ? (ev.hit ? ' hit' : ' miss') : '');
    $('nowband').classList.add('behind');

    box.appendChild(el('span', 'a-who', ev.byName + ' → ' + ev.targetName + ' ' + (ev.index + 1) + '번째'));
    var t = el('div', 'tile ' + ev.guessed.color + (ev.guessed.joker ? ' joker' : ''));
    t.textContent = ev.guessed.joker ? '—' : ev.guessed.n;
    box.appendChild(t);
    box.appendChild(el('span', 'a-label', withResult ? (ev.hit ? '적중' : '빗나감') : '예측'));

    clearTimeout(App.announceTimer);
    if (withResult) {
      App.announceTimer = setTimeout(function () {
        box.className = 'announce';
        $('nowband').classList.remove('behind');
      }, readMs(box.textContent, VERDICT_MIN_MS));
    }
  }

  var ORDER_MS = 2800;       // 정해진 선공을 보여주는 시간 (글이 길면 더)
  var BANNER_MS = 1900;      // 가운데 큰 안내가 떠 있는 시간

  function scheduleBot() {
    clearTimeout(App.botTimer);
    if (App.mode !== 'solo') return;          // 온라인 판의 봇과 판 열기는 서버가 한다
    var s = App.state;
    if (!s || s.phase === 'over') return;
    if (s.phase === 'order') { scheduleOrder(s); return; }
    var hold = App.holdUntil - Date.now();
    if (hold > 0) { App.botTimer = setTimeout(scheduleBot, hold + 60); return; }
    if (s.phase === 'setup') {
      var waiting = App.seats.filter(function (st) { return st.bot && !s.ready[st.id]; });
      if (waiting.length) App.botTimer = setTimeout(botSetupStep, 420);
      return;
    }
    var seat = seatOf(R.current(s).id);
    // 무엇을 부를지 고르는 대목과 자기 타일을 스스로 까는 대목은 이 게임의 긴장이다.
    // 그때는 뜸을 들이고, 나머지(집기·놓기)는 기계적인 동작이라 빠르게 넘긴다.
    // 무엇을 부를지 · 한 번 더 갈지 · 자기 타일을 스스로 까는 대목이 이 게임의 긴장이다.
    // 그때는 뜸을 들이고, 기계적인 동작(집기·놓기)은 빠르게 넘긴다.
    var think = (s.phase === 'guess' || s.phase === 'penalty' || s.phase === 'decide') ? 1350 : 1100;
    if (seat && seat.bot) App.botTimer = setTimeout(botStep, think);
  }

  function botSetupStep() {
    var s = App.state;
    if (!s || s.phase !== 'setup') return;
    var seat = App.seats.filter(function (st) { return st.bot && !s.ready[st.id]; })[0];
    if (!seat) return;
    var p = null;
    s.players.forEach(function (x) { if (x.id === seat.id) p = x; });
    if (p && p.hand.length < s.handSize) {
      R.draftPick(s, seat.id, Math.floor(Math.random() * s.pool.length));
      pushViews();
      return;                                  // 한 장씩 집는 게 보이도록
    }
    if (p) {
      var jk = -1;
      p.hand.forEach(function (x, i) { if (R.isJoker(x.tile) && jk < 0) jk = i; });
      if (jk >= 0) R.setupMove(s, seat.id, jk, Math.floor(Math.random() * p.hand.length));
    }
    R.setupReady(s, seat.id);
    pushViews();
  }

  // 선후공 정하기: 봇은 한 장씩 뽑고, 봇이 가장 높으면 잠시 뒤 고른다.
  // 순서가 정해지면 누가 먼저인지 읽을 시간을 준 뒤에 판을 연다.
  function scheduleOrder(s) {
    var o = s.order;
    if (o.choice) {
      var txt = $('stageTitle').textContent + $('stageText').textContent;
      App.botTimer = setTimeout(function () { R.beginPlay(s); pushViews(); }, readMs(txt, ORDER_MS));
      return;
    }
    if (o.winnerId) {
      var ws = seatOf(o.winnerId);
      if (ws && ws.bot) {
        App.botTimer = setTimeout(function () {
          R.orderChoose(s, o.winnerId, Math.random() < 0.7);
          pushViews();
        }, 2400);                                // 누가 몇을 뽑았는지 볼 틈
      }
      return;
    }
    var bot = App.seats.filter(function (st) {
      if (!st.bot || o.picks.hasOwnProperty(st.id)) return false;
      var p = null; s.players.forEach(function (x) { if (x.id === st.id) p = x; });
      return p && !p.out;
    })[0];
    if (!bot) return;
    // 막 시작했으면 가운데 안내가 걷힌 뒤에 뽑기 시작한다
    var wait = (s.lastEvent && s.lastEvent.type === 'orderStart') ? BANNER_MS + 250 : 700;
    App.botTimer = setTimeout(function () {
      var taken = {};
      for (var k in o.picks) taken[o.picks[k]] = true;
      var free = [];
      o.deck.forEach(function (_, i) { if (!taken[i]) free.push(i); });
      R.orderPick(s, bot.id, free[Math.floor(Math.random() * free.length)]);
      pushViews();
    }, wait);
  }

  function anyGuess(s, id) {
    for (var i = 0; i < s.players.length; i++) {
      var p = s.players[i];
      if (p.id === id || p.out) continue;
      for (var j = 0; j < p.hand.length; j++) {
        var h = p.hand[j];
        if (!h.faceUp) return { targetId: p.id, index: j, color: h.tile.color, n: Math.floor(Math.random() * 12) };
      }
    }
    return null;
  }

  function botStep() {
    var s = App.state;
    if (!s || s.phase === 'over') return;
    var id = R.current(s).id, v = R.viewFor(s, id);
    if (s.phase === 'draw') R.draw(s, id, Math.floor(Math.random() * Math.max(1, s.pool.length)));
    else if (s.phase === 'guess') {
      var mv = AI.chooseGuess(v, Math.random, App.skill);
      if (!mv) mv = anyGuess(s, id);             // 추론할 거리가 없어도 아무 덮인 타일이나 부른다
      if (mv) R.guess(s, id, mv.targetId, mv.index, mv.color, mv.n);
    }
    else if (s.phase === 'decide') R.decide(s, id, AI.chooseDecide(v));
    else if (s.phase === 'place') R.place(s, id, AI.choosePlace(v));
    else if (s.phase === 'penalty') R.penalty(s, id, AI.choosePenalty(v));
    pushViews();
  }

  // 바닥에서 집는 동작은 누른 자리(index)로 보낸다.
  // 한 번 집으면 판이 곧바로 다시 그려지므로, 이어진 두 번째 클릭은
  // 그 자리에 새로 온 다른 타일을 집어 버린다. 사람은 더블클릭을 한다.
  var PICK_LOCK_MS = 260;
  var pickLockUntil = 0;

  function act(action, args) {
    if (action === 'draftPick' || action === 'draw' || action === 'orderPick') {
      var now = Date.now();
      if (now < pickLockUntil) return;          // 연타로 두 장 집히는 것 막기
      pickLockUntil = now + PICK_LOCK_MS;
    }
    // 온라인 판은 서버가 규칙으로 판정한다. 거절되면 이유가 err 로 와서 토스트로 뜬다.
    if (App.mode === 'online') { send({ t: 'act', action: action, args: args || [] }); return; }
    doAction(App.me, action, args);
  }

  // 바닥 타일은 뒷면이라 사람은 사실상 '색'을 고른다. (온라인 판은 서버가 같은 일을 한다) 자리 번호만 믿으면 그사이 다른 사람(봇은 0.4초마다)이
  // 먼저 집어 번호가 한 칸씩 밀려, 옆 타일 — 흔히 다른 색 — 이 딸려 온다. 색이 다르면 같은 색 중에서 준다.
  function poolIndexFor(s, idx, color) {
    if (color !== 'b' && color !== 'w') return idx;
    if (s.pool[idx] && s.pool[idx].color === color) return idx;
    var same = [];
    s.pool.forEach(function (t, i) { if (t.color === color) same.push(i); });
    return same.length ? same[Math.floor(Math.random() * same.length)] : -1;   // 그 색이 동났다 — 다른 색을 주지 않는다
  }

  function doAction(pid, action, args) {
    var s = App.state, r = null;
    if (App.mode !== 'solo' || !s) return;
    if (action === 'draftPick') r = R.draftPick(s, pid, poolIndexFor(s, args[0], args[1]));
    else if (action === 'setupMove') r = R.setupMove(s, pid, args[0], args[1]);
    else if (action === 'setupReady') r = R.setupReady(s, pid);
    else if (action === 'orderPick') r = R.orderPick(s, pid, args[0]);
    else if (action === 'orderChoose') r = R.orderChoose(s, pid, !!args[0]);
    else if (action === 'draw') r = R.draw(s, pid, poolIndexFor(s, args[0], args[1]));
    else if (action === 'guess') r = R.guess(s, pid, args[0], args[1], args[2], args[3]);
    else if (action === 'decide') r = R.decide(s, pid, args[0]);
    else if (action === 'place') r = R.place(s, pid, args[0]);
    else if (action === 'penalty') r = R.penalty(s, pid, args[0]);
    else return;
    if (!r.ok) { toast(r.error); return; }
    App.sel = null;
    pushViews();
  }

  /* ---------------- 조각 ---------------- */
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function tileEl(tile, faceUp, opts) {
    opts = opts || {};
    var e = el('div', 'tile ' + (tile.color || 'unknown') + (opts.big ? ' big' : ''));
    if (!tile.color) { e.classList.add('down'); return e; }
    var known = faceUp || opts.own;
    if (known) {
      if (tile.joker) { e.classList.add('joker'); e.textContent = '—'; }
      else e.textContent = tile.n;
      if (faceUp) e.classList.add('up'); else e.classList.add('own');
    } else {
      e.classList.add('down');
    }
    return e;
  }

  // 타일 한 칸 = 타일 + 여태 빗나간 시도들 + 방금 부른 값
  function tileCell(v, p, slot, i, opts) {
    var wrap = el('div', 'tilewrap');
    var e = tileEl(slot.tile, slot.faceUp, opts);
    wrap.appendChild(e);

    var ev = App.animateEv;
    if (ev && ev.type === 'guess' && ev.targetId === p.id && ev.index === i) {
      e.classList.add(ev.hit ? 'smash' : 'shake');   // 값은 큰 알림으로 따로 보여준다
    } else if (ev && (ev.type === 'placed' || ev.type === 'draft') && ev.by === p.id && ev.index === i) {
      e.classList.add('inserted');
    }

    return { wrap: wrap, tile: e };
  }

  function dirBar() {
    var d = el('div', 'dir');
    d.appendChild(el('span', null, '작음'));
    d.appendChild(el('span', 'line'));
    d.appendChild(el('span', null, '큼'));
    return d;
  }

  function isMyTurn(v) {
    return v.phase !== 'over' && v.players[v.turn] && v.players[v.turn].id === v.me;
  }

  /* ---------------- 자리 ---------------- */
  function playerBox(v, p, big) {
    var isMe = p.id === v.me;
    var isTurn = (inPlay(v) || (v.phase === 'order' && v.order && v.order.choice)) &&
                 v.players[v.turn] && v.players[v.turn].id === p.id;
    var box = el('div', 'player' + (isMe ? ' mine' : '') + (isTurn ? ' turn' : '') + (p.out ? ' out' : ''));

    var head = el('div', 'phead');
    if (isTurn) head.appendChild(el('span', 'turnbadge', isMe ? '내 차례' : '차례'));
    head.appendChild(el('span', 'who', p.name + (isMe ? ' (나)' : '')));
    var seat = seatOf(p.id);
    if (App.mode === 'online' && !p.out && seat && !seat.bot && !seat.connected) head.appendChild(el('span', 'meta off', '끊김'));
    if (v.firstId === p.id) head.appendChild(el('span', 'firstpill', '선공'));
    var hid = p.hand.filter(function (s) { return !s.faceUp; }).length;
    head.appendChild(el('span', 'meta', p.out ? '탈락' : ('숨은 ' + hid + '장')));
    if (isTurn && v.hasDrawn && !isMe) {
      head.appendChild(el('span', 'meta', '· ' + (v.drawnColor === 'b' ? '검정' : '흰색') + ' 집음'));
    }
    if (v.phase === 'order' && v.order && !p.out) {
      var pk = pickOf(v, p.id);
      if (!pk) head.appendChild(el('span', 'meta', '· 뽑는 중'));
      else if (pk.n === null) head.appendChild(el('span', 'meta ok', '· 뽑음'));
      else head.appendChild(el('span', 'opick' + (v.order.winnerId === p.id ? ' best' : ''),
                               pk.n + (v.order.winnerId === p.id ? ' 최고' : '')));
    }
    if (v.phase === 'setup' && !p.out) {
      if (v.ready[p.id]) {
        head.appendChild(el('span', 'meta ok', '· 준비 완료'));
      } else if (p.counts) {
        // 무엇을 몇 장 가졌는지는 알려준다. 배치만 비밀이다.
        head.appendChild(el('span', 'meta', '· ' + p.hand.length + '/' + v.handSize + '장'));
        var mix = el('span', 'mix');
        if (p.counts.b) { var mb = el('span', 'mixb'); mb.textContent = p.counts.b; mix.appendChild(mb); }
        if (p.counts.w) { var mw = el('span', 'mixw'); mw.textContent = p.counts.w; mix.appendChild(mw); }
        if (mix.childNodes.length) head.appendChild(mix);
      } else {
        head.appendChild(el('span', 'meta', '· ' + p.hand.length + '/' + v.handSize + '장'));
      }
    }
    box.appendChild(head);

    // 시작 정리 중: 손패를 다 채웠고 조커가 있으면 자리를 고를 수 있다
    if (isMe && v.phase === 'setup' && !v.ready[v.me] &&
        p.hand.length >= v.handSize && setupSelIndex(v) !== null) {
      box.appendChild(setupRow(v, p, big));
      box.appendChild(dirBar());
      return box;
    }

    // 놓을 자리를 고르는 중이면 내 손패 사이에 틈을 보여준다
    if (isMe && v.phase === 'place' && v.pending && isMyTurn(v)) {
      box.appendChild(placeRow(v, p, big));
      box.appendChild(dirBar());
      return box;
    }

    var hand = el('div', 'hand');
    p.hand.forEach(function (slot, i) {
      var cell = tileCell(v, p, slot, i, { big: big, own: isMe });
      var e = cell.tile;
      var canGuess = !isMe && !p.out && !slot.faceUp && v.phase === 'guess' && isMyTurn(v);
      var canPen = isMe && !slot.faceUp && v.phase === 'penalty' && isMyTurn(v);
      if (canGuess) {
        e.classList.add('pick');
        if (App.sel && App.sel.targetId === p.id && App.sel.index === i) e.classList.add('sel');
        e.onclick = function () { App.sel = { targetId: p.id, index: i }; render(); };
      } else if (canPen) {
        e.classList.add('pick');
        e.onclick = function () { act('penalty', [i]); };
      }
      hand.appendChild(cell.wrap);
    });
    box.appendChild(hand);
    box.appendChild(dirBar());
    return box;
  }

  // 자리는 언제나 전부 보여준다. 숫자 패도 고르는 것처럼 보여야
  // "자리를 고른다 = 조커다" 가 드러나지 않는다.
  function myPlayer(v) {
    for (var i = 0; i < v.players.length; i++) if (v.players[i].id === v.me) return v.players[i];
    return null;
  }

  // 지금 자리를 정하고 있는 조커의 손패 위치. 옮겨도 선택이 유지되도록 색으로 기억한다.
  function setupSelIndex(v) {
    var js = v.myJokers || [];
    if (!js.length) return null;
    var mine = myPlayer(v);
    if (App.setupSelColor && mine) {
      for (var i = 0; i < js.length; i++) {
        if (mine.hand[js[i]].tile.color === App.setupSelColor) return js[i];
      }
    }
    return js[0];
  }

  // 조커를 손패 안에 그대로 두고, 틈마다 자리를 만든다.
  // 조커가 빠진 채로 그리면 자리를 눌러도 화면이 안 변해 눌렸는지 알 수 없다.
  function setupRow(v, p, big) {
    var sel = setupSelIndex(v);
    var row = el('div', 'slots');

    // 화면상의 틈 -> 조커를 뺀 기준의 자리
    function toIndex(gap) { return gap <= sel ? gap : gap - 1; }
    function slotBtn(gap) {
      var e = el('div', 'slot' + (big ? ' big' : '') + ' ok');
      e.onclick = function () { act('setupMove', [sel, toIndex(gap)]); };
      return e;
    }

    row.appendChild(slotBtn(0));
    p.hand.forEach(function (slot, i) {
      var t = tileEl(slot.tile, slot.faceUp, { big: big, own: true });
      if (R.isJoker(slot.tile)) {
        t.classList.add('pick');
        if (i === sel) t.classList.add('arranging');
        t.onclick = function () { App.setupSelColor = slot.tile.color; render(); };
      }
      row.appendChild(t);
      row.appendChild(slotBtn(i + 1));
    });
    return row;
  }

  function placeRow(v, p, big) {
    var row = el('div', 'slots');
    var spots = v.pendingSpots || [];
    function snap(i) {
      if (spots.indexOf(i) >= 0) return i;
      var best = spots.length ? spots[0] : 0, bd = Infinity;
      spots.forEach(function (x) { var d = Math.abs(x - i); if (d < bd) { bd = d; best = x; } });
      return best;
    }
    function slotBtn(i) {
      var e = el('div', 'slot' + (big ? ' big' : '') + (spots.indexOf(i) >= 0 ? ' ok' : ''));
      e.onclick = function () { act('place', [snap(i)]); };
      return e;
    }
    row.appendChild(slotBtn(0));
    p.hand.forEach(function (slot, i) {
      row.appendChild(tileEl(slot.tile, slot.faceUp, { big: big, own: true }));
      row.appendChild(slotBtn(i + 1));
    });
    return row;
  }

  function floorBox(v) {
    // 시작 단계: 바닥에서 손패를 직접 골라 온다
    if (v.phase === 'setup') {
      var mine = myPlayer(v);
      var need = v.handSize - (mine ? mine.hand.length : 0);
      var canDraft = need > 0 && !v.ready[v.me];
      var w1 = el('div', 'floor' + (canDraft ? ' can' : ''));
      w1.appendChild(el('h3', null, canDraft ? '바닥 — ' + need + '장 더 고르세요' : '바닥 ' + v.poolCount + '장'));
      poolRows(w1, v, canDraft);
      return w1;
    }
    if (v.phase === 'order') return orderBoard(v);

    var wrap = el('div', 'floor');
    var canPick = v.phase === 'draw' && isMyTurn(v) && v.poolCount > 0;
    if (canPick) wrap.classList.add('can');
    var nb = 0; v.pool.forEach(function (t) { if (t.color === 'b') nb++; });
    wrap.appendChild(el('h3', null, (canPick ? '바닥 — 한 장 고르세요 · ' : '바닥 ') +
                                    v.poolCount + '장 (검정 ' + nb + ' · 흰색 ' + (v.poolCount - nb) + ')'));

    var body = el('div', 'floorbody');
    var piles = el('div', 'piles');
    poolRows(piles, v, canPick, 'draw');
    body.appendChild(piles);

    if (v.hasDrawn && isMyTurn(v) && v.drawn) {
      var b = el('div', 'drawn-box');
      b.appendChild(el('span', null, '가져온 패'));
      var de = tileEl(v.drawn, false, { own: true });
      de.classList.add('drawn');
      b.appendChild(de);
      body.appendChild(b);
    } else if (v.phase === 'place' && v.pending) {
      var b2 = el('div', 'drawn-box');
      b2.appendChild(el('span', null, v.pending.faceUp ? '공개해서 놓을 패' : '덮어서 놓을 패'));
      b2.appendChild(tileEl(v.pending.tile, v.pending.faceUp, { own: true }));
      body.appendChild(b2);
    }
    wrap.appendChild(body);
    return wrap;
  }

  // 위는 검정, 아래는 흰색. 같은 색끼리는 구별할 수 없으니 정렬해도 정보가 새지 않는다.
  function poolRows(wrap, v, canPick, action) {
    action = action || 'draftPick';
    ['b', 'w'].forEach(function (color) {
      var row = el('div', 'pile');
      var any = false;
      v.pool.forEach(function (t, i) {
        if (t.color !== color) return;
        any = true;
        var e = tileEl({ color: color, n: null, joker: null }, false, {});
        if (canPick) e.onclick = function () { act(action, [i, color]); };
        row.appendChild(e);
      });
      if (any) wrap.appendChild(row);
    });
  }

  function eventKey(ev) { return ev ? JSON.stringify(ev) : ''; }

  /* ---------------- 선후공 정하기 ---------------- */
  function pickOf(v, pid) {
    if (!v.order) return null;
    for (var i = 0; i < v.order.tiles.length; i++) if (v.order.tiles[i].by === pid) return v.order.tiles[i];
    return null;
  }
  function nameOf(v, pid) {
    for (var i = 0; i < v.players.length; i++) if (v.players[i].id === pid) return v.players[i].id === v.me ? '나' : v.players[i].name;
    return '?';
  }

  // 순서 패 열두 장. 누가 어느 패를 뽑았는지는 바로 보이고, 숫자는 다 뽑은 뒤 한꺼번에 뒤집힌다.
  function orderBoard(v) {
    var o = v.order;
    var meAlive = myPlayer(v) && !myPlayer(v).out;
    var canPick = !o.revealed && meAlive && !pickOf(v, v.me);
    var wrap = el('div', 'floor oboard' + (canPick ? ' can' : '') + (o.revealed ? ' done' : ''));
    wrap.appendChild(el('h3', null, canPick ? '순서 패 — 한 장 뽑으세요' : '순서 패 (0~11)'));
    var grid = el('div', 'ogrid');
    var ev = App.animateEv;
    o.tiles.forEach(function (t, i) {
      var cell = el('div', 'ocell');
      var tile = el('div', 'otile' + (t.n !== null ? ' open' : '') + (t.by ? ' taken' : '') +
                           (t.by === v.me ? ' minepick' : '') + (o.winnerId && t.by === o.winnerId ? ' best' : ''));
      tile.textContent = t.n !== null ? t.n : '';
      if (canPick && !t.by) {
        tile.classList.add('pick');
        tile.onclick = function () { act('orderPick', [i]); };
      }
      if (ev && ev.type === 'orderPick' && ev.index === i) tile.classList.add('lift');
      if (ev && ev.type === 'orderReveal' && t.by) tile.classList.add('flip');
      cell.appendChild(tile);
      cell.appendChild(el('span', 'otag', t.by ? nameOf(v, t.by) : ''));
      grid.appendChild(cell);
    });
    wrap.appendChild(grid);
    return wrap;
  }

  // 시계방향으로 돌 때의 자리 순서. 선공이 정해졌으면 선공부터.
  function clockwise(v) {
    var n = v.players.length, start = 0;
    for (var i = 0; i < n; i++) if (v.players[i].id === v.firstId) start = i;
    var out = [];
    for (var k = 0; k < n; k++) out.push(v.players[(start + k) % n]);
    return out;
  }

  function inPlay(v) {
    return ['draw', 'guess', 'decide', 'place', 'penalty'].indexOf(v.phase) >= 0;
  }

  /* ---------------- 가운데 안내판 ----------------
     지금 무슨 단계인지(steps), 누가 무엇을 하는지(title), 무엇을 하면 되는지(text).
     내가 할 일이면 강조되고, 누를 버튼도 여기에 있다. 눈이 판 한가운데에 머물게. */
  function stageInfo(v) {
    var me = myPlayer(v);
    var SETUP = ['손패 가져오기', '손패 정리', '선후공 정하기'];
    var PLAY = ['가져오기', '맞히기', v.phase === 'penalty' ? '내 패 공개' : '놓기'];
    var done = v.players.filter(function (p) { return !p.out && v.ready[p.id]; }).length;
    var total = v.players.filter(function (p) { return !p.out; }).length;

    if (v.phase === 'setup') {
      var need = v.handSize - (me ? me.hand.length : 0);
      if (v.ready[v.me]) return { steps: SETUP, at: 1, title: '준비 완료',
        text: '다른 사람이 손패를 정리하는 중입니다 · ' + done + '/' + total };
      if (need > 0) return { steps: SETUP, at: 0, mine: true, title: '시작 손패를 가져오세요',
        text: '바닥에서 ' + need + '장 더 고르세요. 색만 보고 고르고, 숫자는 가져온 뒤에 봅니다.' };
      var hasJk = (v.myJokers || []).length > 0;
      return { steps: SETUP, at: 1, mine: true, title: '손패를 정리하세요',
        text: hasJk ? '조커는 틈을 눌러 원하는 자리로 옮길 수 있습니다. 다 됐으면 게임 시작.'
                    : '숫자 패는 크기 순으로 자동 정렬됩니다. 확인했으면 게임 시작.',
        acts: [{ label: '게임 시작', primary: true, fn: function () { act('setupReady', []); } }] };
    }

    if (v.phase === 'order') {
      var o = v.order, mine = pickOf(v, v.me);
      if (o.choice) {
        var f = null; v.players.forEach(function (p) { if (p.id === v.firstId) f = p; });
        var seq = clockwise(v).filter(function (p) { return !p.out; })
                              .map(function (p) { return p.id === v.me ? '나' : p.name; });
        return { steps: SETUP, at: 2, mine: f && f.id === v.me,
          title: f ? (f.id === v.me ? '내가 선공입니다' : f.name + ' 선공') : '순서 결정',
          text: '시계방향으로 돕니다: ' + seq.join(' → ') };
      }
      if (o.winnerId) {
        var wp = pickOf(v, o.winnerId), wn = nameOf(v, o.winnerId);
        if (o.winnerId === v.me) return { steps: SETUP, at: 2, mine: true,
          title: '내가 가장 높습니다 · ' + wp.n,
          text: '선공은 내가 먼저, 후공은 내가 마지막입니다. 차례는 시계방향으로 돕니다.',
          acts: [{ label: '선공 — 내가 먼저', primary: true, fn: function () { act('orderChoose', [true]); } },
                 { label: '후공 — 내가 마지막', fn: function () { act('orderChoose', [false]); } }] };
        return { steps: SETUP, at: 2, title: wn + ' 가장 높음 · ' + wp.n,
          text: '선공·후공을 고르는 중입니다' };
      }
      if (mine) return { steps: SETUP, at: 2, title: '내 순서 패는 ' + mine.n,
        text: '모두 뽑으면 한꺼번에 공개합니다. 가장 높은 숫자가 선공·후공을 정합니다.' };
      return { steps: SETUP, at: 2, mine: !!(me && !me.out), title: '선후공을 정하는 중입니다',
        text: '순서 패를 한 장 뽑으세요. 가장 높은 숫자가 나오면 선공·후공을 정할 수 있습니다.' };
    }

    if (!inPlay(v)) return null;
    var cur = v.players[v.turn];
    var at = { draw: 0, guess: 1, decide: 1, place: 2, penalty: 2 }[v.phase];

    if (!isMyTurn(v)) {
      // 남의 차례는 짧게 — 1초 남짓 떠 있다가 바뀌므로 길면 못 읽는다 (qa/pace.py)
      var what = { draw: '집는 중', place: '놓는 중', guess: '지목하는 중',
                   decide: '고민하는 중', penalty: '공개하는 중' }[v.phase];
      return { steps: PLAY, at: at, title: (cur ? cur.name : '') + '의 차례', text: what };
    }

    var info = { steps: PLAY, at: at, mine: true, title: '내 차례' };
    if (v.phase === 'draw') {
      info.text = v.poolCount ? '바닥에서 패를 한 장 가져오세요. 색만 보고 고릅니다.'
                              : '바닥이 비었습니다. 가져오지 않고 바로 맞힙니다.';
      if (!v.poolCount) info.acts = [{ label: '맞히러 가기', primary: true, fn: function () { act('draw', [0]); } }];
    } else if (v.phase === 'guess') {
      var tg = selTarget(v);
      if (tg) {
        var tc = tg.hand[App.sel.index].tile.color;
        info.title = tg.name + '의 ' + (App.sel.index + 1) + '번째 ' + (tc === 'b' ? '검정' : '흰색') + ' 패는?';
        info.text = '';                          // 제목이 곧 질문이다. 줄 하나 아껴 한 화면에 담는다
        info.node = guessGrid(v, tg);
      } else {
        info.title = '상대 패 맞히기';
        info.text = '상대의 덮인 패를 하나 눌러 지목하세요.';
      }
    } else if (v.phase === 'decide') {
      info.title = '적중! 한 번 더?';
      info.text = v.hasDrawn ? '이어서 맞히다 빗나가면 가져온 패가 공개됩니다. 멈추면 덮은 채로 놓습니다.'
                             : '이어서 맞히거나 차례를 넘기세요.';
      info.acts = [{ label: '이어서 맞히기', primary: true, fn: function () { act('decide', [true]); } },
                   { label: v.hasDrawn ? '멈추고 덮어 놓기' : '차례 넘기기', fn: function () { act('decide', [false]); } }];
    } else if (v.phase === 'place') {
      info.title = v.pending && v.pending.faceUp ? '빗나감 — 패 공개해서 놓기' : '가져온 패 놓기';
      info.text = v.pending && v.pending.tile.joker ? '조커입니다. 어느 자리에나 놓을 수 있습니다. 상대를 속일 자리를 고르세요.'
                                                    : '내 손패의 밝은 틈이 순서에 맞는 자리입니다. 눌러서 놓으세요.';
    } else if (v.phase === 'penalty') {
      info.title = '내 패 하나 공개';
      info.text = '바닥이 비었는데 빗나갔습니다. 내 덮인 패 하나를 골라 공개하세요.';
    }
    return info;
  }

  function renderStage(v) {
    var st = $('stage'), info = stageInfo(v);
    st.hidden = !info;
    if (!info) return;
    var key = info.title + '|' + info.at;
    if (key !== App.stageKey) {                  // 단계가 바뀔 때만 살짝 들썩여 눈길을 끈다
      App.stageKey = key;
      st.classList.remove('fresh'); void st.offsetWidth; st.classList.add('fresh');
    }
    st.classList.toggle('mine', !!info.mine);

    var steps = $('stageSteps'); steps.innerHTML = '';
    info.steps.forEach(function (label, i) {
      if (i) steps.appendChild(el('span', 'st-arrow', '›'));
      steps.appendChild(el('span', 'st-step' + (i === info.at ? ' now' : i < info.at ? ' past' : ''), label));
    });
    $('stageTitle').textContent = info.title;
    $('stageText').textContent = info.text || '';
    var acts = $('stageActs'); acts.innerHTML = '';
    (info.acts || []).forEach(function (a) {
      var b = el('button', a.primary ? 'primary' : null, a.label);
      b.onclick = a.fn;
      acts.appendChild(b);
    });
    if (info.node) acts.appendChild(info.node);
    acts.hidden = !(info.acts && info.acts.length) && !info.node;
    acts.classList.toggle('grid', !!info.node);
  }

  // 판 위쪽 띠 — 시계방향 차례 순서. 지금 차례인 사람에게 불이 들어온다.
  function renderSeq(v) {
    var box = $('nowSeq'); box.innerHTML = '';
    var nb = $('nowband');
    var decided = !!v.firstId && (inPlay(v) || v.phase === 'order' || v.phase === 'over');
    nb.classList.toggle('mine', isMyTurn(v) && inPlay(v));
    if (!decided) {
      var done = v.players.filter(function (p) { return !p.out && v.ready[p.id]; }).length;
      var total = v.players.filter(function (p) { return !p.out; }).length;
      box.appendChild(el('span', 'nb-plain', v.phase === 'setup'
        ? '손패 정리 · 시작 ' + done + '/' + total
        : '선후공 정하는 중 · 차례는 시계방향'));
      return;
    }
    var cur = v.players[v.turn];
    clockwise(v).forEach(function (p, i) {
      if (i) box.appendChild(el('span', 'nb-arrow', '→'));
      var chip = el('span', 'nb-chip' + (cur && cur.id === p.id && v.phase !== 'over' ? ' now' : '') +
                             (p.id === v.me ? ' me' : '') + (p.out ? ' out' : ''),
                    p.id === v.me ? '나' : p.name);
      box.appendChild(chip);
    });
    box.appendChild(el('span', 'nb-cw', '↻ 시계방향'));
  }

  // 단계가 넘어가는 순간에만 화면 가운데 크게 띄운다
  var bannerTimer = null;
  function banner(title, sub) {
    var b = $('banner');
    $('bannerTitle').textContent = title;
    $('bannerSub').textContent = sub || '';
    b.classList.remove('on'); void b.offsetWidth; b.classList.add('on');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(function () { b.classList.remove('on'); }, BANNER_MS);
  }

  /* ---------------- 그리기 ---------------- */
  // 놓기·자기 패 공개는 내 손패를 눌러야 하는데, 좁은 화면에서는 내 손패가 화면 아래에 있어
  // 스크롤해야 보였다. 그 차례가 새로 오면 한 번만 내 손패가 보이게 내려 준다.
  var lastReveal = '';
  function revealMyHand(v) {
    var need = isMyTurn(v) && (v.phase === 'penalty' || (v.phase === 'place' && v.pending));
    var key = need ? v.phase + ':' + v.turn + ':' + (v.log ? v.log.length : '') : '';
    if (!need) { lastReveal = ''; return; }
    if (key === lastReveal) return;
    lastReveal = key;
    var box = $('seatMe'), r = box.getBoundingClientRect();
    if (r.bottom > window.innerHeight || r.top < 0) {
      box.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'end' });
    }
  }

  function render() {
    var v = App.view;
    if (!v) return;

    var ae = App.animateEv;
    if (ae) {
      if (ae.type === 'guess') flashBig(ae.hit ? '적중' : '빗나감', ae.hit ? 'hit' : 'miss');
      else if (ae.type === 'begin') flashBig('시작', 'go');
      else if (ae.type === 'orderStart') banner('선후공 정하기', '가장 높은 숫자를 뽑은 사람이 선공·후공을 고릅니다');
      else if (ae.type === 'orderChosen') banner(ae.firstId === v.me ? '내가 선공' : ae.firstName + ' 선공',
        (ae.by === v.me ? '나' : ae.byName) + ' — ' + (ae.choice === 'first' ? '선공' : '후공') + ' 선택 · 차례는 시계방향');
    }

    var cur = v.players[v.turn];
    $('turnInfo').innerHTML = '';
    if (v.phase === 'setup') {
      var done = v.players.filter(function (p) { return !p.out && v.ready[p.id]; }).length;
      var total = v.players.filter(function (p) { return !p.out; }).length;
      $('turnInfo').textContent = '손패 정리 — 시작 ' + done + '/' + total;
    } else if (v.phase === 'order') {
      $('turnInfo').textContent = '선후공 정하기';
    } else if (v.phase === 'over') {
      $('turnInfo').textContent = '게임 종료';
    } else if (cur) {
      var dot = el('span', 'turndot');
      var who = el('span', 'turnwho', cur.id === v.me ? '내 차례' : cur.name + '의 차례');
      if (cur.id === v.me) who.classList.add('mineturn');
      $('turnInfo').appendChild(dot);
      $('turnInfo').appendChild(who);
    }

    var others = [], meP = null, n = v.players.length;
    for (var k = 1; k <= n; k++) {
      var p = v.players[(indexOfMe(v) + k) % n];
      if (p.id === v.me) continue;
      others.push(p);
    }
    v.players.forEach(function (p) { if (p.id === v.me) meP = p; });

    // 나(아래)에서 시계방향으로 왼쪽 → 위 → 오른쪽. 엔진의 다음 차례와 같은 방향이다.
    var layout = others.length === 1 ? ['seatTop']
               : others.length === 2 ? ['seatLeft', 'seatRight']
               : ['seatLeft', 'seatTop', 'seatRight'];
    ['seatTop', 'seatLeft', 'seatRight'].forEach(function (id) { $(id).innerHTML = ''; });
    others.forEach(function (p, i) { $(layout[i]).appendChild(playerBox(v, p, false)); });

    renderStage(v);
    $('floorArea').innerHTML = '';
    $('floorArea').appendChild(floorBox(v));

    $('seatMe').innerHTML = '';
    if (meP) $('seatMe').appendChild(playerBox(v, meP, true));
    revealMyHand(v);

    syncChatVisible();
    renderSeq(v);

    if (v.phase === 'over') showOver(v);
    App.animateEv = null;
  }

  function indexOfMe(v) {
    for (var i = 0; i < v.players.length; i++) if (v.players[i].id === v.me) return i;
    return 0;
  }

  function flashBig(text, cls) {
    var f = el('div', 'hitflag ' + cls, text);
    document.body.appendChild(f);
    setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 1200);
  }

  // 지목한 패 — 이미 공개됐거나 사라졌으면 고른 것을 푼다
  function selTarget(v) {
    if (!App.sel || v.phase !== 'guess' || !isMyTurn(v)) return null;
    var target = null;
    v.players.forEach(function (p) { if (p.id === App.sel.targetId) target = p; });
    if (!target || !target.hand[App.sel.index] || target.hand[App.sel.index].faceUp) { App.sel = null; return null; }
    return target;
  }

  // 부를 숫자 — 가운데 안내판 안에 둔다. 아래에 두면 화면 밖으로 밀려 스크롤해야 보였다.
  function guessGrid(v, target) {
    var color = target.hand[App.sel.index].tile.color;
    var known = {};
    v.players.forEach(function (p) {
      p.hand.forEach(function (s) {
        if (s.tile && (s.tile.n !== null || s.tile.joker === true)) known[R.tileId(s.tile)] = true;
      });
    });
    if (v.drawn) known[R.tileId(v.drawn)] = true;

    var allowed = null;
    if ($('hint').checked) {
      allowed = {};
      AI.candidates(v, App.sel.targetId, App.sel.index).forEach(function (t) {
        allowed[t.joker ? 'J' : t.n] = true;
      });
    }

    var nums = el('div', 'nums ' + color);
    for (var i = 0; i <= R.MAX_N; i++) {
      (function (n) {
        var b = el('button', null, String(n));
        if (known[color + n] || (allowed && !allowed[n])) b.classList.add('off');
        b.onclick = function () { act('guess', [App.sel.targetId, App.sel.index, color, n]); };
        nums.appendChild(b);
      })(i);
    }
    var jb = el('button', 'jk', '조커');
    if (known[color + 'J'] || (allowed && !allowed['J'])) jb.classList.add('off');
    jb.onclick = function () { act('guess', [App.sel.targetId, App.sel.index, color, null]); };
    nums.appendChild(jb);
    return nums;
  }

  function showOver(v) {
    var win = null;
    // 판 하나에 한 번만 — 이 화면은 다시 그릴 때마다 불린다. 온라인 판은 countGame 이 방장 화면에서 센다.
    if (App.mode === 'solo' && !App.statOver && window.norara) {
      App.statOver = true;
      norara.ev('end', { n: 1, sec: Math.round((Date.now() - (App.statAt || Date.now())) / 1000) });
    }

    v.players.forEach(function (p) { if (p.id === v.winner) win = p; });
    $('overTitle').textContent = !win ? '무승부' : (win.id === v.me ? '승리' : win.name + ' 승리');
    $('overText').textContent = !win ? '남은 사람이 없습니다.'
      : (win.id === v.me ? '끝까지 숫자를 지켰습니다.' : '다음 판에 설욕하세요.');
    // 다시 하기 — 혼자면 바로, 온라인이면 방장만 누를 수 있다(모두 대기실로 돌아간다)
    var host = App.mode === 'solo' || (S && S.hostId === App.me);
    $('btnAgain').classList.toggle('hidden', !host);
    $('btnAgain').textContent = App.mode === 'solo' ? '다시하기' : '대기실로 (한 판 더)';
    $('overHint').textContent = host ? '' : '방장이 대기실로 돌아가면 모두 함께 갑니다.';
    $('overHint').classList.toggle('hidden', host);
    $('btnOverOut').textContent = App.mode === 'solo' ? '처음으로' : '나가기';
    $('over').classList.remove('hidden');
  }

  // 한 판이 끝나면 판 화면에 걸려 있던 것(연출 타이머 · 붙잡아 둔 결과 · 고르던 대상)을 모두 내려놓는다.
  // 혼자 하기는 고르는 화면으로, 온라인은 서버가 대기실 상태를 보내 올 때 이걸 거쳐 대기실로 간다.
  function resetBoard() {
    $('over').classList.add('hidden');
    clearTimeout(App.botTimer); clearTimeout(App.holdTimer); clearTimeout(App.announceTimer);
    clearTimeout(App.drainTimer); App.drainTimer = null; App.queue = [];
    $('announce').className = 'announce';
    $('nowband').classList.remove('behind');
    document.body.classList.remove('holding');
    App.state = null; App.view = null; App.heldView = null;
    App.started = false; App.sel = null; App.setupSelColor = null;
    App.shownEvent = null; App.animateEv = null; App.holdUntil = 0; App.holdTimer = null;
    App.stageKey = null;
    clearTimeout(bannerTimer); $('banner').classList.remove('on');
  }
  function backToLobby() {
    resetBoard();
    if (App.mode === 'solo') { show('menu'); return; }
    send({ t: 'again' });                      // 온라인 — 방장만. 서버가 모두를 대기실로 돌려보낸다
  }

  /* ---------------- 온라인 — 서버와 잇기 ----------------
     서버(Cloudflare 무료 플랜)는 켜져 있는 시간이 한도라서, 20분 동안 아무 조작이 없으면
     서버가 연결을 닫는다(4000). 그때는 스스로 다시 붙지 않고 화면을 다시 만질 때 이어 붙는다.
     켜 두기만 한 탭이 서버를 붙잡아 두지 않게. 자리는 탭마다 sessionStorage 에 적어 두어
     새로고침해도 같은 자리로 돌아온다. */
  var ws = null, S = null, pingT = null, resting = false, restWhy = 0, wokeUp = false;
  var store = (function () {
    try { var t = window.sessionStorage; t.getItem('x'); return t; }
    catch (e) {                                  // 막힌 브라우저에서도 판은 돌게 — 새로고침 복귀만 안 된다
      var m = {};
      return { getItem: function (k) { return m[k] || null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; } };
    }
  })();
  var seated = function () { return !!(store.getItem('davinci.code') && store.getItem('davinci.token')); };
  function unseat() { store.removeItem('davinci.code'); store.removeItem('davinci.token'); }

  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  function resume() {
    connect(function () {
      if (seated()) send({ t: 'resume', code: store.getItem('davinci.code'), token: store.getItem('davinci.token') });
    });
  }

  function wake(e) {
    if (!resting) return;
    if (e.type === 'visibilitychange' && (document.hidden || restWhy === 4001)) return;   // 넘겨준 자리는 눌러서만 되찾는다
    resting = false;
    $('toast').classList.remove('on');
    if (seated()) { wokeUp = true; resume(); }
    else if (!$('title').classList.contains('hidden')) pollRooms(true);
  }
  ['pointerdown', 'keydown'].forEach(function (t) { addEventListener(t, wake, true); });
  document.addEventListener('visibilitychange', wake);

  function connect(onOpen) {
    if (ws && ws.readyState === 1) { if (onOpen) onOpen(); return; }
    // 붙는 중이던 옛 소켓(만들기 연타 등)은 손을 떼고 닫는다. 그대로 두면 나중에 그게 닫힐 때
    // 지금 소켓의 ping 을 꺼 버려서, 멀쩡한 연결이 끊긴 것으로 처리된다.
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = null; try { ws.close(); } catch (e) {} }
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    var sock = ws = new WebSocket(proto + '://' + location.host + '/ws');

    sock.onopen = function () {
      if (sock !== ws) return;
      clearInterval(pingT);
      pingT = setInterval(function () { send({ t: 'ping' }); }, 25000);   // 서버가 끊긴 탭을 가려낼 수 있게
      if (onOpen) onOpen();
    };
    sock.onmessage = function (e) {
      if (sock !== ws) return;
      var m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.t === 'moved' || m.t === 'idle') {             // 곧 닫힌다 — 닫힘 코드가 중간에 떨어져도 알 수 있게
        sock.why = m.t;
        sock.onclose({ code: m.t === 'moved' ? 4001 : 4000 });   // 닫힘이 늦게 오거나 안 와도 여기서 멈춘다
        ws = null;
        try { sock.close(); } catch (err) {}
        return;
      }
      onServer(m);
    };
    sock.onclose = function (e) {
      if (sock !== ws) return;
      clearInterval(pingT);
      var code = sock.why === 'moved' ? 4001 : sock.why === 'idle' ? 4000 : e.code;
      // 4000: 오래 조작이 없어 서버가 닫음 · 4001: 다른 탭이 이 자리를 이어받음(탭 복제 등)
      // 둘 다 스스로 다시 붙지 않는다 — 붙으면 서로를 밀어내며 끝없이 오간다. 누를 때 다시 붙는다.
      if (code === 4000 || code === 4001) {
        resting = true; restWhy = code;
        pollRooms(false);
        if (!seated()) return;                     // 방 목록만 보던 연결 — 말없이 쉬었다가 누르면 다시 훑는다
        var t = $('toast');
        t.textContent = code === 4000
          ? '한동안 조작이 없어서 연결을 쉬고 있습니다. 아무 곳이나 누르면 다시 붙습니다.'
          : '다른 창에서 이 자리를 이어받았습니다. 여기서 계속하려면 아무 곳이나 누르세요.';
        t.classList.add('on');
        clearTimeout(toastTimer);                  // 누를 때까지 떠 있게
        return;
      }
      ws = null;
      if (seated()) {
        toast('연결이 끊겼습니다. 다시 붙는 중…');
        setTimeout(function () { if (!ws && seated() && !resting) resume(); }, 1200);
      }
    };
  }

  /** 서버 연결을 내려놓는다 — 혼자 하기에는 필요 없다. 붙여 두면 서버가 괜히 깨어 있다. */
  function hangUp() {
    pollRooms(false);
    clearInterval(pingT);
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = null; try { ws.close(); } catch (e) {} }
    ws = null;
  }

  var leaving = false;          // 끊긴 채 나가느라 잠깐 붙은 동안 — 대기실 화면이 번쩍 뜨지 않게 흘려보낸다
  function onServer(m) {
    if (leaving) {
      if (m.t !== 'left' && m.t !== 'err') return;          // 떠나는 방의 상태·채팅은 받지 않는다
      leaving = false;
      if (m.t === 'err') return;
    }
    switch (m.t) {
      case 'welcome':
        wokeUp = false; entering = 0;
        App.mode = 'online';
        if (m.code !== chatRoom) { chatRoom = m.code; chatReset(); }   // 다른 방이면 채팅을 비운다
        App.me = m.you;
        store.setItem('davinci.code', m.code);
        store.setItem('davinci.token', m.token);
        try { history.replaceState(null, '', location.pathname + '?room=' + m.code); } catch (e) {}
        pollRooms(false);
        break;

      case 'state':
        if (App.mode !== 'online') return;           // 혼자 하기로 넘어간 뒤 늦게 온 것
        countGame(m);                                // S 를 덮기 전에 — 직전 phase 가 있어야 전이를 잡는다
        S = m;
        App.me = m.you;
        App.seats = m.players;
        if (m.phase === 'lobby') {
          // 판이 끝나고 방장이 대기실로 — 판 화면에 걸린 연출을 걷고 모두 함께 돌아간다
          if (App.view || App.heldView || $('lobby').classList.contains('hidden')) resetBoard();
          show('lobby');
          renderLobby();
        } else if (m.view) {
          App.started = true;
          if ($('game').classList.contains('hidden')) {
            // 대기실에서 넘어왔거나 새로고침으로 돌아왔다 — 지난 판의 표시 상태가 첫 알림을 가리지 않게
            resetBoard();
            App.started = true;
            show('game');
          }
          syncChatVisible();
          applyView(m.view);
        }
        break;

      case 'chat':
        addChat(m.name, m.text, m.from === App.me);
        break;

      case 'ev':
        if (m.kind === 'joined' && m.by !== App.me) toast(m.name + ' 참가');
        else if (m.kind === 'left') toast(m.name + ' 나감');
        else if (m.kind === 'dropped') toast(m.name + ' — 연결이 끊겨 판에서 빠졌습니다');
        break;

      case 'rooms':
        roomList = m.list || [];
        paintRooms();
        break;

      case 'err':
        entering = 0;
        // 오래 쉬다 돌아왔는데 그사이 방이 정리된 경우 — 무엇 때문인지 알려 준다
        toast(m.fatal && wokeUp ? '오래 비워 둔 사이 방이 정리됐습니다. 새로 만들어 주세요.' : m.msg);
        if (m.fatal) {
          wokeUp = false;
          unseat();
          try { history.replaceState(null, '', location.pathname); } catch (e) {}
          App.mode = 'solo'; S = null;
          show('menu');
        }
        break;
    }
  }

  /* 판 수 세기 — 방장 화면에서만 보낸다. 사람마다 보내면 한 판이 인원수만큼 세어진다.
     "지금 판 중인가" 는 참가자도 상태를 받을 때마다 알린다. */
  function countGame(m) {
    if (window.norara && norara.live) norara.live(m.phase === 'playing');
    if (!window.norara || !m.players || m.hostId !== m.you) return;
    var humans = m.players.filter(function (p) { return !p.bot; }).length;
    // 시작은 대기실에서 넘어오는 순간만 센다 — 판 중에 새로고침으로 돌아온 방장이 한 번 더 세지 않게
    if (m.phase === 'playing' && S && S.phase === 'lobby') {
      App.statAt = Date.now();
      norara.ev('start', { n: humans });
    } else if (m.phase === 'over' && (!S || S.phase !== 'over') && App.statAt) {
      norara.ev('end', { n: humans, sec: Math.round((Date.now() - App.statAt) / 1000) });
      App.statAt = 0;
    }
  }

  // 만들기·참가를 연달아 누르면(더블탭 · Enter 와 클릭) 자리가 둘 생긴다. 답이 올 때까지 한 번만 보낸다.
  var entering = 0;
  function enter(msg) {
    if (Date.now() - entering < 4000) return;
    entering = Date.now();
    unseat();
    try { localStorage.setItem('davinci.name', myName()); } catch (e) {}
    App.mode = 'online'; S = null;
    toast('접속 중…');
    connect(function () { send(msg); });
  }

  function leave() {
    var code = store.getItem('davinci.code'), token = store.getItem('davinci.token');
    unseat();
    resting = false; wokeUp = false;
    $('toast').classList.remove('on');
    if (ws && ws.readyState === 1) send({ t: 'leave' });
    else if (code && token) {
      // 끊겨 있으면 잠깐 붙어서 자리를 비우고 나온다. 안 그러면 서버에는 자리가 그대로 남는다.
      leaving = true;
      connect(function () { send({ t: 'resume', code: code, token: token }); send({ t: 'leave' }); });
    }
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    resetBoard();
    App.mode = 'solo'; S = null;
    chatRoom = null; chatReset();                // 떠난 방의 말 · 안 읽은 수 · 탭 제목 (n) 을 들고 나가지 않는다
    show('title');
  }

  /* ---------------- 대기실 ---------------- */
  function renderLobby() {
    var isHost = S.hostId === App.me;
    syncChatVisible();                              // 대기실에서도 채팅이 되어야 한다
    $('roomCode').textContent = S.code;
    $('lobbyHint').textContent = isHost
      ? '친구에게 코드나 초대 링크를 보내세요.' + (S.cfg.priv ? ' 비공개 방이라 목록에는 안 보입니다.' : '')
      : '방장이 시작하기를 기다리는 중…';

    var box = $('seats'); box.innerHTML = '';
    S.players.forEach(function (p) {
      var row = el('div', 'seat');
      row.appendChild(el('span', null, p.name));
      var sp = el('span'); sp.style.flex = '1'; row.appendChild(sp);
      if (p.id === App.me) row.appendChild(el('span', 'pill', '나'));
      if (p.id === S.hostId) row.appendChild(el('span', 'pill host', '방장'));
      if (p.bot) row.appendChild(el('span', 'pill', '봇'));
      if (!p.bot && !p.connected) row.appendChild(el('span', 'pill off', '끊김'));
      if (isHost && p.id !== S.hostId) {
        var x = el('button', 'kick', '✕');
        x.title = '내보내기';
        x.setAttribute('aria-label', p.name + ' 내보내기');
        x.onclick = function () { send({ t: 'kick', id: p.id }); };
        row.appendChild(x);
      }
      box.appendChild(row);
    });
    for (var k = S.players.length; k < S.max; k++) {
      var e2 = el('div', 'seat'); e2.style.opacity = '.4';
      e2.appendChild(el('span', null, '빈 자리'));
      box.appendChild(e2);
    }

    $('hostControls').classList.toggle('hidden', !isHost);
    $('hostCfg').classList.toggle('hidden', !isHost);
    $('lobbySkill').value = String(S.cfg.skill);
    $('lobbyPriv').checked = !!S.cfg.priv;
    var skillName = { '0.45': '쉬움', '0.75': '보통', '1': '어려움' }[String(S.cfg.skill)] || '보통';
    $('guestCfg').textContent = '봇 실력 ' + skillName + (S.cfg.priv ? ' · 비공개 방' : '');
    $('guestCfg').classList.toggle('hidden', isHost);
    $('btnStart').disabled = S.players.length < S.min;
    $('btnAddBot').disabled = S.players.length >= S.max;
  }

  /* ---------------- 열린 방 ----------------
     첫 화면에 있는 동안만 훑는다 — 방에 들어가거나 다른 화면으로 가면 멈춘다. */
  var roomList = [], roomsT = null;
  function askRooms() {
    if (resting) return;
    connect(function () { send({ t: 'rooms' }); });
  }
  function pollRooms(on) {
    clearInterval(roomsT);
    roomsT = null;
    if (!on || seated() || !window.WebSocket) return;
    askRooms();
    roomsT = setInterval(function () { if (!document.hidden) askRooms(); }, 6000);
  }
  var ROOM_STATE = { wait: '', full: '가득 참', playing: '게임 중' };
  function paintRooms() {
    var box = $('roomsList');
    var open = roomList.filter(function (r) { return r.state === 'wait'; }).length;
    $('roomsN').textContent = roomList.length ? open + '곳' : '';
    if (!roomList.length) {
      box.innerHTML = '<p class="rooms-none">지금은 기다리는 방이 없습니다 — 방을 만들어 링크를 보내 보세요.</p>';
      return;
    }
    box.innerHTML = roomList.map(function (r) {
      var off = r.state !== 'wait';
      return '<button class="room-row' + (off ? ' off' : '') + '" data-code="' + chatEsc(r.code) + '"' + (off ? ' disabled' : '') + '>' +
        '<span class="rc">' + chatEsc(r.code) + '</span>' +
        '<span class="rn">' + chatEsc(r.host || '누군가') + ' 님 방 · ' + r.n + '/' + r.max + (r.bots ? ' (봇 ' + r.bots + ')' : '') + '</span>' +
        '<span class="rt">' + (off ? ROOM_STATE[r.state] : (r.age < 60 ? '방금' : Math.floor(r.age / 60) + '분 전')) + '</span></button>';
    }).join('');
  }
  $('roomsList').addEventListener('click', function (e) {
    var row = e.target.closest('[data-code]');
    if (!row || row.disabled) return;
    // 이름은 고르는 화면에서 정한다 — 코드를 채워 두고 그리로 보낸다
    $('joinCode').value = row.dataset.code;
    show('menu');
    toast('이름을 확인하고 참가를 누르세요.');
    $('btnJoin').classList.add('flash');
    setTimeout(function () { $('btnJoin').classList.remove('flash'); }, 1600);
  });
  $('btnRooms').onclick = askRooms;

  /* ---------------- 버튼 ---------------- */
  $('btnGo').onclick = function () { show('menu'); };
  $('btnGuide').onclick = function () { show('guide'); };
  $('btnGuideBack').onclick = function () { show('title'); };
  $('btnMenuBack').onclick = function () { show('title'); };

  $('btnSolo').onclick = function () {
    // 혼자 하기는 서버를 거치지 않는다 — 방 목록을 보느라 붙어 있던 연결도 내려놓는다
    hangUp();
    unseat();
    var count = parseInt($('soloCount').value, 10);
    App.skill = parseFloat($('soloSkill').value);
    App.mode = 'solo'; App.me = 'me'; S = null;
    App.seats = [{ id: 'me', name: myName(), bot: false }];
    var names = ['봇 하나', '봇 둘', '봇 셋'];
    for (var i = 0; i < count - 1; i++) App.seats.push({ id: 'bot' + i, name: names[i], bot: true });
    chatReset();
    startEngine();
  };
  $('btnHost').onclick = function () {
    if (!window.WebSocket) { toast('이 브라우저는 온라인 대전을 지원하지 않습니다.'); return; }
    enter({ t: 'create', name: myName(), priv: $('hostPriv').checked, skill: parseFloat($('soloSkill').value) });
  };
  function doJoin() {
    var code = $('joinCode').value.trim().toUpperCase();
    if (code.length !== 4) { toast('방 코드 4자리를 입력해 주세요.'); return; }
    if (!window.WebSocket) { toast('이 브라우저는 온라인 대전을 지원하지 않습니다.'); return; }
    enter({ t: 'join', code: code, name: myName() });
  }
  $('btnJoin').onclick = doJoin;
  $('joinCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') doJoin(); });
  $('btnAddBot').onclick = function () { send({ t: 'addBot' }); };
  $('btnStart').onclick = function () { send({ t: 'start' }); };
  $('lobbySkill').onchange = function () { send({ t: 'cfg', skill: parseFloat(this.value) }); };
  $('lobbyPriv').onchange = function () { send({ t: 'cfg', priv: this.checked }); };
  $('btnCopy').onclick = function () {
    if (!S) return;
    var url = location.origin + location.pathname + '?room=' + S.code;
    var done = function () { toast('초대 링크를 복사했습니다'); };
    try { navigator.clipboard.writeText(url).then(done, function () { toast(url); }); }
    catch (e) { toast(url); }
  };
  $('btnLeave').onclick = leave;
  // 판 중에 나가기 — 온라인이면 내 자리는 판에서 빠지고(내 패는 그대로 탈락) 남은 사람끼리 계속한다
  $('btnQuit').onclick = function () {
    var live = App.view && App.view.phase !== 'over';
    if (live && !confirm(App.mode === 'online' ? '나가면 이 판에서 빠집니다. 나갈까요?' : '이 판을 그만둘까요?')) return;
    quit();
  };
  function quit() {
    if (App.mode === 'online') { leave(); return; }
    resetBoard();
    show('title');
  }
  $('btnOverOut').onclick = quit;
  $('btnAgain').onclick = backToLobby;
  $('hint').onchange = function () { render(); };

  /* ---------------- 밝게 / 어둡게 ----------------
     고른 적이 없으면 기기 설정을 따라가고, 한 번 고르면 그 선택을 기억한다.
     첫 칠은 index.html 의 짧은 스크립트가 미리 해 둔다 (화면이 번쩍이지 않게). */
  var THEME_KEY = 'davinci.theme';
  var themeMq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  function savedTheme() {
    try { var t = localStorage.getItem(THEME_KEY); return (t === 'dark' || t === 'light') ? t : null; }
    catch (e) { return null; }
  }
  function paintTheme() {
    var t = savedTheme() || (themeMq && themeMq.matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', t);
    var b = $('themeBtn');
    b.setAttribute('aria-checked', t === 'dark' ? 'true' : 'false');
    b.setAttribute('aria-label', t === 'dark' ? '밝게 보기' : '어둡게 보기');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#10141a' : '#eceef1');
  }
  $('themeBtn').onclick = function () {
    var now = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    try { localStorage.setItem(THEME_KEY, now === 'dark' ? 'light' : 'dark'); } catch (e) {}
    paintTheme();
  };
  // 고른 적이 없는 사람은 기기가 밤낮을 바꾸면 같이 바뀐다
  if (themeMq && themeMq.addEventListener) {
    themeMq.addEventListener('change', function () { if (!savedTheme()) paintTheme(); });
  }
  paintTheme();
  $('name').value = localStorage.getItem('davinci.name') || '';
  $('name').addEventListener('change', function () { localStorage.setItem('davinci.name', myName()); });

  /* ---------------- 채팅 ----------------
     같은 방 사람끼리만 오간다. 판정과는 무관하고 어디에도 저장되지 않는다.
     서버가 받아서 같은 방 모두에게 그대로 넘겨 준다. 봇만 있는 방에서는 아예 뜨지 않는다. */

  var chatUnread = 0, chatRoom = null;
  /** 새 방에 들어오면 채팅을 비운다. 안 그러면 전 방에서 오간 말이 새 방 채팅창에 그대로 남는다. */
  function chatReset() {
    $('chatLog').textContent = '';
    $('chat').hidden = true;
    chatUnread = 0; chatBadge(); chatPeekOff();
    chatAway = 0; chatTitle();
  }
  function chatEsc(t) {
    return String(t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function chatSend(text) {
    if (App.mode === 'online') send({ t: 'chat', text: text });   // 서버가 같은 방 모두에게 돌려준다(나 포함)
  }
  function chatOpen(on) {
    $('chat').hidden = !on;
    if (!on) return;
    chatUnread = 0; chatBadge(); chatPeekOff();
    $('chatText').focus();
    var log = $('chatLog'); log.scrollTop = log.scrollHeight;
  }
  function addChat(name, text, mine) {
    var log = $('chatLog');
    var d = el('p', 'chat-msg' + (mine ? ' mine' : ''));
    d.innerHTML = '<b>' + chatEsc(name) + '</b> ' + chatEsc(text);
    log.appendChild(d);
    while (log.children.length > 60) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
    if (mine) return;
    if ($('chat').hidden) { chatUnread++; chatBadge(); chatPeek(name, text); }
    if (document.hidden || !document.hasFocus()) { chatAway++; chatTitle(); }
  }

  /* 접어 둔 동안 온 말은 세 군데로 알린다 — 버튼의 빨간 숫자(늘 때마다 통 튄다),
     버튼 옆 말풍선(읽을 만큼 떠 있다 사라진다), 다른 탭·창에 가 있으면 탭 제목 앞의 (n). */
  var chatAway = 0, chatPeekT = 0, chatTitle0 = document.title;
  function chatBadge() {
    var n = $('chatN');
    n.textContent = chatUnread > 99 ? '99+' : String(chatUnread);
    n.hidden = !chatUnread;
    $('chatBtn').setAttribute('aria-label', chatUnread ? '채팅 열기 — 안 읽은 말 ' + chatUnread + '개' : '채팅 열기');
    if (!chatUnread) return;
    n.classList.remove('pop'); void n.offsetWidth; n.classList.add('pop');
  }
  function chatPeek(name, text) {
    var p = $('chatPeek');
    p.innerHTML = '<b>' + chatEsc(name) + '</b>' + chatEsc(text);
    p.classList.remove('bye'); p.hidden = false;
    p.style.animation = 'none'; void p.offsetWidth; p.style.animation = '';
    clearTimeout(chatPeekT);
    chatPeekT = setTimeout(function () {
      p.classList.add('bye');
      chatPeekT = setTimeout(chatPeekOff, 260);
    }, Math.min(6000, Math.max(3000, 1200 + 70 * text.length)));
  }
  function chatPeekOff() {
    clearTimeout(chatPeekT);
    var p = $('chatPeek'); p.hidden = true; p.classList.remove('bye');
  }
  function chatTitle() {
    document.title = (chatAway ? '(' + (chatAway > 99 ? '99+' : chatAway) + ') ' : '') + chatTitle0;
  }
  function chatBack() {
    if (chatAway && !document.hidden && document.hasFocus()) { chatAway = 0; chatTitle(); }
  }
  document.addEventListener('visibilitychange', chatBack);
  window.addEventListener('focus', chatBack);
  /** 사람이 나 말고 또 있을 때만 채팅을 내놓는다 */
  function syncChatVisible(list) {
    var seats = list || App.seats || [];
    var humans = 0;
    seats.forEach(function (st) { if (!st.bot) humans++; });
    var on = App.mode === 'online' && humans > 1;
    $('chatBtn').hidden = !on;
    if (!on) { $('chat').hidden = true; chatPeekOff(); }
    else $('chatWho').textContent = humans + '명';
  }
  $('chatBtn').onclick = function () { chatOpen($('chat').hidden); };
  $('chatPeek').onclick = function () { chatOpen(true); };
  $('chatX').onclick = function () { chatOpen(false); };
  $('chatForm').onsubmit = function (e) {
    e.preventDefault();
    var box = $('chatText'), text = box.value.trim();
    box.value = '';
    if (text) chatSend(text);
  };
  $('chatText').onkeydown = function (e) { if (e.key === 'Escape') chatOpen(false); };

  /* ---------------- 시작 ----------------
     초대 링크(?room=CODE)로 왔으면 참가 칸에 코드를 채워 고르는 화면으로.
     이 탭이 앉아 있던 자리가 있으면(새로고침) 곧바로 그 자리로 돌아간다. */
  (function () {
    var invited = '';
    try { invited = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); } catch (e) {}
    if (invited) $('joinCode').value = invited;
    if (seated() && window.WebSocket) {
      App.mode = 'online';
      resume();
    } else if (invited) show('menu');
    else show('title');
  })();

  App.act = act; App.doAction = doAction; App.pushViews = pushViews; App.render = render;
  App.S = function () { return S; };
  window.__dv = App;
})();
