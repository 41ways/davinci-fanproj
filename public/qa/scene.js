/* 연출 길이 재기 — ?qa=pace 로 들어오면 봇끼리 한 판을 끝까지 두면서
   화면에 뜬 것이 언제 나타나고 언제 사라졌는지를 기록한다.
   헤드리스 크롬의 가상 시간으로 돌리므로 "설계된 속도"가 그대로 측정된다.
   평소에는 index.html 의 한 줄이 이 파일을 아예 부르지 않는다. */
(function () {
  var q = new URLSearchParams(location.search);
  if (q.get('qa') !== 'pace') return;

  var out = { game: '다빈치코드', n: q.get('n') || '4', ev: [], errs: [], done: false };
  window.onerror = function (m, s, l) { out.errs.push(m + ' @' + l); };

  var pre = document.createElement('pre');
  pre.id = 'qaout'; pre.style.display = 'none';
  document.body.appendChild(pre);

  var T0 = performance.now();
  function at() { return Math.round(performance.now() - T0); }
  function log(k, w, on) { out.ev.push({ t: at(), k: k, w: w, on: on ? 1 : 0 }); }
  function finish(why) {
    if (out.done) return;
    out.done = true; out.why = why;
    pre.textContent = JSON.stringify(out);
    document.title = 'QA DONE';
  }

  function ready(fn) {
    if (window.__dv && window.Rules) fn();
    else setTimeout(function () { ready(fn); }, 30);
  }

  ready(function () {
    document.getElementById('btnGo').click();
    document.getElementById('name').value = '민수';
    document.getElementById('soloCount').value = out.n;
    document.getElementById('btnSolo').click();

    var A = window.__dv;
    A.seats.forEach(function (s) { s.bot = true; });   // 사람 자리도 봇이 대신 둔다
    A.pushViews();

    var st = { ann: '', who: '', what: '', tk: '' };
    var poll = setInterval(function () {
      var a = document.getElementById('announce');
      var on = a.classList.contains('on');
      var kind = !on ? '' : a.classList.contains('hit') ? 'hit'
                          : a.classList.contains('miss') ? 'miss' : 'guess';
      if (kind !== st.ann) {
        if (st.ann) out.ev.push({ t: at(), k: 'announce', w: st.annText, on: 0, mine: st.annMine ? 1 : 0 });
        if (kind) {
          st.annText = a.textContent.trim();
          // 내가 부른 값은 내가 이미 아는 것이라 읽을 시간이 필요 없다
          var ev = A.view && A.view.lastEvent;
          st.annMine = !!(ev && ev.by === A.view.me);
          out.ev.push({ t: at(), k: 'announce', w: st.annText, on: 1, mine: st.annMine ? 1 : 0 });
        }
        st.ann = kind;
      }

      // 이름과 상태를 따로 잰다. 한 사람의 차례가 이어지는 동안 이름은 그대로 있으므로,
      // 눈이 다시 읽어야 하는 것은 뒤쪽 짧은 말뿐이다.
      // 내 차례 줄은 내가 누를 때까지 떠 있는 것이라 길이를 잴 의미가 없다 — 표시만 해 둔다.
      var v0 = A.view;
      var mineTurn = !!(v0 && v0.players[v0.turn] && v0.players[v0.turn].id === v0.me);
      var whoEl = document.getElementById('stageTitle'), whatEl = document.getElementById('stageText');   // 가운데 안내판
      [['nowwho', whoEl, 'who'], ['nowwhat', whatEl, 'what']].forEach(function (pair) {
        var kind = pair[0], node = pair[1], slot = pair[2];
        var txt = node ? node.textContent.trim() : '';
        if (txt === st[slot]) return;
        if (st[slot]) out.ev.push({ t: at(), k: kind, w: st[slot], on: 0, mine: st[slot + 'Mine'] ? 1 : 0 });
        st[slot] = txt; st[slot + 'Mine'] = mineTurn;
        if (txt) out.ev.push({ t: at(), k: kind, w: txt, on: 1, mine: mineTurn ? 1 : 0 });
      });

      var v = A.view;
      if (!v) return;
      var tk = v.phase + '/' + v.turn;
      if (tk !== st.tk) { st.tk = tk; log('turn', tk, 1); }
      if (v.phase === 'over') { clearInterval(poll); finish('판 종료'); }
    }, 20);

    setTimeout(function () { clearInterval(poll); finish('시간 초과'); }, 900000);
  });
})();
