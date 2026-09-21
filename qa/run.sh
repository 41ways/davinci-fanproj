#!/bin/sh
# 화면을 실제로 돌려서 연출 속도를 잰다.
#   sh qa/run.sh [인원]
# 미리 서버를 띄워 두어야 한다:  PORT=8799 node server.js   (혼자 하기만 쓰므로 판은 브라우저에서 돈다)
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT=${PORT:-8799}
N=${1:-4}
OUT=/tmp/davinci-pace-$N.json
nice -n 10 "$CHROME" --headless --disable-gpu --hide-scrollbars --window-size=430,900 \
  --virtual-time-budget=900000 --dump-dom "http://localhost:$PORT/?qa=pace&n=$N" 2>/dev/null \
| python3 -c "
import sys, re, json
m = re.search(r'<pre id=\"qaout\"[^>]*>(.*?)</pre>', sys.stdin.read(), re.S)
if not m:
    print('{\"game\":\"?\",\"n\":\"?\",\"ev\":[],\"errs\":[\"qaout 을 못 찾음\"]}')
else:
    import html; print(html.unescape(m.group(1)))
" > "$OUT"
python3 qa/pace.py "$OUT"
