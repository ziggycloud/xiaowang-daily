use scripting additions

on run
    tell application "Finder" to set siteFolder to POSIX path of (container of (path to me) as alias)
    set siteAddress to "http://127.0.0.1:8765"
    set healthAddress to siteAddress & "/api/health"
    set isRunning to false
    try
        set healthResult to do shell script ("/usr/bin/curl --max-time 1 -fsS " & quoted form of healthAddress)
        if healthResult contains "\"ok\": true" then set isRunning to true
    end try
    if isRunning is false then
        do shell script ("/bin/mkdir -p " & quoted form of (siteFolder & "/data"))
        do shell script ("cd " & quoted form of siteFolder & " && /usr/bin/nohup /usr/bin/python3 -B server.py --no-browser > " & quoted form of (siteFolder & "/data/server.log") & " 2>&1 < /dev/null &")
        delay 1
    end if
    try
        open location siteAddress
    end try
    activate
    set choice to button returned of (display dialog "小汪的日常已启动。" & return & return & "网页地址：" & siteAddress & return & return & "如果浏览器没有出现，请点「复制网址」，粘贴到浏览器地址栏。" buttons {"复制网址", "关闭", "再打开网页"} default button "关闭" with title "小汪的日常")
    if choice is "复制网址" then set the clipboard to siteAddress
    if choice is "再打开网页" then open location siteAddress
end run
