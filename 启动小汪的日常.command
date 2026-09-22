#!/bin/zsh
cd "${0:A:h}" || exit 1
if /usr/bin/curl --max-time 1 -fsS http://127.0.0.1:8765/api/health 2>/dev/null | /usr/bin/grep -q '"ok": true'; then
  /usr/bin/open http://127.0.0.1:8765
  exit 0
fi
/usr/bin/python3 -B server.py
