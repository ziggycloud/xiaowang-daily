#!/usr/bin/env python3
"""Local-only web server for 小汪的日常. Python standard library only."""
import argparse
import datetime as dt
import json
import os
import re
import sqlite3
import threading
import webbrowser
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA = Path(os.environ.get("XIAOWANG_DATA_DIR", str(ROOT / "data")))
DB = DATA / "xiaowang.sqlite3"
LOCK = threading.RLock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
 id INTEGER PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'work',
 planned_date TEXT, deadline_date TEXT, due_time TEXT, priority INTEGER NOT NULL DEFAULT 0,
 note TEXT NOT NULL DEFAULT '', plan_id INTEGER, parent_task_id INTEGER,
 completed_at TEXT, deleted_at TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plans (
 id INTEGER PRIMARY KEY, title TEXT NOT NULL, horizon TEXT NOT NULL DEFAULT 'short',
 description TEXT NOT NULL DEFAULT '', start_date TEXT, target_date TEXT,
 deliverable TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
 manual_progress INTEGER NOT NULL DEFAULT 0, parent_id INTEGER,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS milestones (
 id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL, title TEXT NOT NULL,
 target_date TEXT, weight INTEGER NOT NULL DEFAULT 1, completed_at TEXT,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prerequisites (
 id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL, title TEXT NOT NULL,
 completed_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS insights (
 id INTEGER PRIMARY KEY, entry_date TEXT NOT NULL UNIQUE,
 title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
 success_body TEXT NOT NULL DEFAULT '',
 mood TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_recurrences (
 key TEXT PRIMARY KEY, start_date TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_tasks_date ON tasks(planned_date);
CREATE INDEX IF NOT EXISTS idx_insights_date ON insights(entry_date);
"""


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def today():
    return dt.date.today().isoformat()


def connect():
    DATA.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(DB), timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    return con


@contextmanager
def db():
    con = connect()
    try:
        with con:
            yield con
    finally:
        con.close()


def init_db():
    with LOCK, db() as con:
        con.executescript(SCHEMA)
        columns = {row["name"] for row in con.execute("PRAGMA table_info(tasks)")}
        if "parent_task_id" not in columns:
            con.execute("ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER")
        if "deadline_date" not in columns:
            con.execute("ALTER TABLE tasks ADD COLUMN deadline_date TEXT")
        if "recurrence_key" not in columns:
            con.execute("ALTER TABLE tasks ADD COLUMN recurrence_key TEXT")
        con.execute("CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id)")
        con.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_recurrence ON tasks(planned_date,recurrence_key)")
        con.execute("INSERT OR IGNORE INTO task_recurrences(key,start_date) VALUES('daily_english',?)", (today(),))
        # The first version nested both habits under a daily parent and gave them DDLs.
        # Keep each habit's own completion history while turning it into a standalone daily task.
        con.execute("""UPDATE tasks SET parent_task_id=NULL, deadline_date=NULL
            WHERE recurrence_key IN ('english_vocab','english_listening')
              AND (parent_task_id IS NOT NULL OR deadline_date IS NOT NULL)""")
        stamp = now()
        con.execute("""UPDATE tasks SET deleted_at=?,updated_at=?
            WHERE recurrence_key='daily_english' AND deleted_at IS NULL""", (stamp, stamp))
        insight_columns = {row["name"] for row in con.execute("PRAGMA table_info(insights)")}
        if "success_body" not in insight_columns:
            con.execute("ALTER TABLE insights ADD COLUMN success_body TEXT NOT NULL DEFAULT ''")


def task_branch_ids(con, task_id):
    return [row[0] for row in con.execute("""
        WITH RECURSIVE branch(id) AS (
          SELECT id FROM tasks WHERE id=? AND deleted_at IS NULL
          UNION
          SELECT t.id FROM tasks t JOIN branch b ON t.parent_task_id=b.id WHERE t.deleted_at IS NULL
        ) SELECT id FROM branch
    """, (task_id,))]


def task_ancestor_ids(con, task_id):
    return [row[0] for row in con.execute("""
        WITH RECURSIVE ancestors(id,parent_task_id) AS (
          SELECT id,parent_task_id FROM tasks WHERE id=? AND deleted_at IS NULL
          UNION
          SELECT p.id,p.parent_task_id FROM tasks p JOIN ancestors a ON p.id=a.parent_task_id WHERE p.deleted_at IS NULL
        ) SELECT id FROM ancestors WHERE id<>?
    """, (task_id, task_id))]


def update_task_ids(con, ids, statement, values):
    if ids:
        marks = ",".join("?" for _ in ids)
        con.execute(f"UPDATE tasks SET {statement} WHERE id IN ({marks})", tuple(values) + tuple(ids))


def rows(con, query, args=()):
    return [dict(x) for x in con.execute(query, args).fetchall()]


def ensure_daily_english(con, day):
    """Make two independent daily learning tasks, without deadlines."""
    rule = con.execute("SELECT * FROM task_recurrences WHERE key='daily_english'").fetchone()
    if not rule or not rule["enabled"] or day < rule["start_date"] or day < today():
        return
    stamp = now()
    plan = con.execute("SELECT id FROM plans WHERE title LIKE '%雅思%' ORDER BY id LIMIT 1").fetchone()
    plan_id = plan[0] if plan else None
    daily_tasks = (
        ("english_vocab", "扇贝单词 · 复习 + 新词（15 分钟）",
         "打开扇贝，先完成今日到期复习，再按雅思词书学习新词；忙时只做复习也算保持节奏。https://web.shanbay.com/web/main"),
        ("english_listening", "英语听力 · 扇贝听力（15 分钟）",
         "打开扇贝听力，选 BBC 类短篇或雅思分类中一段 3—8 分钟的材料。先不看文本听一遍，再对照文本逐句听清，最后跟读 2—3 分钟；走路或通勤时可重听熟悉的音频。每周另做 2—3 次雅思真题听力，短篇磨耳朵不替代计时练习。网页：https://www.shanbay.com/listen/books/all/ ；手机可用扇贝听力口语。"),
    )
    for key, title, note in daily_tasks:
        # The unique date + recurrence key also respects a day the user deleted.
        con.execute("""INSERT OR IGNORE INTO tasks(title,category,planned_date,note,plan_id,recurrence_key,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?)""", (title, "learning", day, note, plan_id, key, stamp, stamp))


def clean_text(v, max_len=10000):
    return str(v if v is not None else "").strip()[:max_len]


def date_value(v):
    if v in (None, ""):
        return None
    s = str(v)
    try:
        dt.date.fromisoformat(s)
    except ValueError:
        raise ValueError("日期格式应为 YYYY-MM-DD")
    return s


def time_value(v):
    if v in (None, ""):
        return None
    s = str(v)
    if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", s):
        raise ValueError("时间格式应为 HH:MM")
    return s


def integer(v, low, high, default):
    if v in (None, ""):
        return default
    try:
        n = int(v)
    except (ValueError, TypeError):
        raise ValueError("数字格式不正确")
    if n < low or n > high:
        raise ValueError("数字超出允许范围")
    return n


def existing(con, table, item_id):
    if table not in ("tasks", "plans", "milestones", "prerequisites", "insights"):
        raise ValueError("未知数据类型")
    item = con.execute(f"SELECT * FROM {table} WHERE id=?", (item_id,)).fetchone()
    if item is None or (table == "tasks" and item["deleted_at"]):
        raise LookupError("记录不存在")
    return dict(item)


def bootstrap(view_day=None):
    with LOCK, db() as con:
        ensure_daily_english(con, today())
        if view_day and view_day != today():
            ensure_daily_english(con, view_day)
        return {
            "today": today(),
            "tasks": rows(con, "SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY created_at DESC"),
            "plans": rows(con, "SELECT * FROM plans ORDER BY created_at DESC"),
            "milestones": rows(con, "SELECT * FROM milestones ORDER BY created_at ASC"),
            "prerequisites": rows(con, "SELECT * FROM prerequisites ORDER BY created_at ASC"),
            "insights": rows(con, "SELECT * FROM insights ORDER BY entry_date DESC"),
        }


def mutate(collection, method, item_id, payload):
    stamp = now()
    with LOCK, db() as con:
        if method == "DELETE":
            if not item_id:
                raise ValueError("缺少记录编号")
            existing(con, collection, item_id)
            if collection == "tasks":
                update_task_ids(con, task_branch_ids(con, item_id), "deleted_at=?, updated_at=?", (stamp, stamp))
            elif collection == "plans":
                con.execute("UPDATE tasks SET plan_id=NULL WHERE plan_id=?", (item_id,))
                con.execute("UPDATE plans SET parent_id=NULL WHERE parent_id=?", (item_id,))
                con.execute("DELETE FROM milestones WHERE plan_id=?", (item_id,))
                con.execute("DELETE FROM prerequisites WHERE plan_id=?", (item_id,))
                con.execute("DELETE FROM plans WHERE id=?", (item_id,))
            else:
                con.execute(f"DELETE FROM {collection} WHERE id=?", (item_id,))
            return {"ok": True}

        if collection == "tasks":
            old = existing(con, collection, item_id) if item_id else {}
            d = {**old, **payload}
            if old.get("recurrence_key") in ("english_vocab", "english_listening"):
                d.update(category="learning", planned_date=old["planned_date"],
                         deadline_date=None, parent_task_id=None)
            title = clean_text(d.get("title"), 240)
            if not title:
                raise ValueError("请填写任务内容")
            parent_task_id = integer(d.get("parent_task_id"), 1, 1000000000, None)
            if item_id and parent_task_id != old.get("parent_task_id"):
                raise ValueError("不能修改分支所属的任务")
            parent = existing(con, "tasks", parent_task_id) if parent_task_id else None
            if parent:
                d["category"] = parent["category"]
                d["planned_date"] = parent["planned_date"]
                d["plan_id"] = parent["plan_id"]
            category = d.get("category", "work")
            if category not in ("work", "life", "learning"):
                raise ValueError("任务分类不正确")
            plan_id = integer(d.get("plan_id"), 1, 1000000000, None)
            if plan_id:
                existing(con, "plans", plan_id)
            values = (title, category, date_value(d.get("planned_date")), date_value(d.get("deadline_date", today())), time_value(d.get("due_time")),
                      integer(d.get("priority"), 0, 2, 0), clean_text(d.get("note")), plan_id,
                      stamp if d.get("completed") is True else (None if d.get("completed") is False else d.get("completed_at")), stamp)
            if item_id:
                con.execute("""UPDATE tasks SET title=?,category=?,planned_date=?,deadline_date=?,due_time=?,priority=?,note=?,plan_id=?,completed_at=?,updated_at=? WHERE id=?""", values + (item_id,))
            else:
                cur = con.execute("""INSERT INTO tasks(title,category,planned_date,deadline_date,due_time,priority,note,plan_id,completed_at,updated_at,created_at,parent_task_id)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""", values + (stamp, parent_task_id))
                item_id = cur.lastrowid
                if parent_task_id:
                    update_task_ids(con, task_ancestor_ids(con, item_id), "completed_at=NULL, updated_at=?", (stamp,))
            if not parent_task_id and item_id:
                descendants = [child_id for child_id in task_branch_ids(con, item_id) if child_id != item_id]
                update_task_ids(con, descendants, "category=?, planned_date=?, plan_id=?, updated_at=?", (category, values[2], plan_id, stamp))
            if "completed" in payload:
                branch = task_branch_ids(con, item_id)
                update_task_ids(con, branch, "completed_at=?, updated_at=?", (stamp if payload["completed"] else None, stamp))
                if not payload["completed"]:
                    update_task_ids(con, task_ancestor_ids(con, item_id), "completed_at=NULL, updated_at=?", (stamp,))
        elif collection == "plans":
            old = existing(con, collection, item_id) if item_id else {}
            d = {**old, **payload}
            title = clean_text(d.get("title"), 240)
            if not title:
                raise ValueError("请填写规划名称")
            horizon = d.get("horizon", "short")
            status = d.get("status", "active")
            if horizon not in ("long", "medium", "short") or status not in ("active", "paused", "done"):
                raise ValueError("规划类型或状态不正确")
            parent_id = integer(d.get("parent_id"), 1, 1000000000, None)
            if parent_id:
                existing(con, "plans", parent_id)
                if parent_id == item_id:
                    raise ValueError("规划不能指向自身")
            start_date, target_date = date_value(d.get("start_date")), date_value(d.get("target_date"))
            if start_date and target_date and start_date > target_date:
                raise ValueError("目标日期不能早于开始日期")
            values = (title, horizon, clean_text(d.get("description")), start_date, target_date,
                      clean_text(d.get("deliverable")), status, integer(d.get("manual_progress"), 0, 100, 0), parent_id, stamp)
            if item_id:
                con.execute("""UPDATE plans SET title=?,horizon=?,description=?,start_date=?,target_date=?,deliverable=?,status=?,manual_progress=?,parent_id=?,updated_at=? WHERE id=?""", values + (item_id,))
            else:
                cur = con.execute("""INSERT INTO plans(title,horizon,description,start_date,target_date,deliverable,status,manual_progress,parent_id,updated_at,created_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?)""", values + (stamp,))
                item_id = cur.lastrowid
        elif collection in ("milestones", "prerequisites"):
            old = existing(con, collection, item_id) if item_id else {}
            d = {**old, **payload}
            plan_id = integer(d.get("plan_id"), 1, 1000000000, None)
            if not plan_id:
                raise ValueError("请选择规划")
            existing(con, "plans", plan_id)
            title = clean_text(d.get("title"), 240)
            if not title:
                raise ValueError("请填写内容")
            completed_at = stamp if d.get("completed") is True else (None if d.get("completed") is False else d.get("completed_at"))
            if collection == "milestones":
                values = (plan_id, title, date_value(d.get("target_date")), integer(d.get("weight"), 1, 100, 1), completed_at)
                if item_id:
                    con.execute("UPDATE milestones SET plan_id=?,title=?,target_date=?,weight=?,completed_at=? WHERE id=?", values + (item_id,))
                else:
                    cur = con.execute("INSERT INTO milestones(plan_id,title,target_date,weight,completed_at,created_at) VALUES(?,?,?,?,?,?)", values + (stamp,))
                    item_id = cur.lastrowid
            else:
                values = (plan_id, title, completed_at)
                if item_id:
                    con.execute("UPDATE prerequisites SET plan_id=?,title=?,completed_at=? WHERE id=?", values + (item_id,))
                else:
                    cur = con.execute("INSERT INTO prerequisites(plan_id,title,completed_at,created_at) VALUES(?,?,?,?)", values + (stamp,))
                    item_id = cur.lastrowid
        elif collection == "insights":
            entry_date = date_value(payload.get("entry_date"))
            if not entry_date:
                raise ValueError("缺少日期")
            title = clean_text(payload.get("title"), 240)
            body = clean_text(payload.get("body"), 100000)
            previous = con.execute("SELECT success_body FROM insights WHERE entry_date=?", (entry_date,)).fetchone()
            success_body = clean_text(payload["success_body"], 100000) if "success_body" in payload else (previous[0] if previous else "")
            mood = clean_text(payload.get("mood"), 40)
            tags = clean_text(payload.get("tags"), 400)
            con.execute("""INSERT INTO insights(entry_date,title,body,success_body,mood,tags,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
                ON CONFLICT(entry_date) DO UPDATE SET title=excluded.title,body=excluded.body,success_body=excluded.success_body,mood=excluded.mood,tags=excluded.tags,updated_at=excluded.updated_at""",
                (entry_date, title, body, success_body, mood, tags, stamp, stamp))
            item_id = con.execute("SELECT id FROM insights WHERE entry_date=?", (entry_date,)).fetchone()[0]
        else:
            raise ValueError("未知数据类型")
        return dict(con.execute(f"SELECT * FROM {collection} WHERE id=?", (item_id,)).fetchone())


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if not self.path.startswith("/api/bootstrap"):
            super().log_message(fmt, *args)

    def send_bytes(self, data, mime="application/json", status=200, filename=None):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'")
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, value, status=200):
        self.send_bytes(json.dumps(value, ensure_ascii=False).encode("utf-8"), status=status)

    def route(self, method):
        path = urlparse(self.path).path
        try:
            host = self.headers.get("Host", "").split(":")[0].lower()
            if host not in ("127.0.0.1", "localhost"):
                return self.send_json({"error": "只允许本机访问"}, 403)
            if method in ("POST", "PATCH", "DELETE"):
                origin = self.headers.get("Origin", "")
                allowed = (f"http://127.0.0.1:{self.server.server_port}", f"http://localhost:{self.server.server_port}")
                if origin and origin not in allowed:
                    return self.send_json({"error": "请求来源不正确"}, 403)
                if method != "DELETE" and not self.headers.get("Content-Type", "").startswith("application/json"):
                    return self.send_json({"error": "只接受 JSON 请求"}, 415)
            if method == "GET" and path == "/api/bootstrap":
                query_day = urlparse(self.path).query
                from urllib.parse import parse_qs
                requested = parse_qs(query_day).get("day", [None])[0]
                return self.send_json(bootstrap(date_value(requested)))
            if method == "GET" and path == "/api/health":
                return self.send_json({"ok": True})
            if method == "GET" and path == "/api/backup":
                with LOCK, db() as source:
                    temp = DATA / "backup.tmp.sqlite3"
                    with sqlite3.connect(str(temp)) as dest:
                        source.backup(dest)
                    data = temp.read_bytes()
                    temp.unlink(missing_ok=True)
                return self.send_bytes(data, "application/vnd.sqlite3", filename=f"xiaowang-{today()}.sqlite3")
            match = re.fullmatch(r"/api/(tasks|plans|milestones|prerequisites|insights)(?:/(\d+))?", path)
            if match and method in ("POST", "PATCH", "DELETE"):
                size = int(self.headers.get("Content-Length", "0"))
                if size > 150000:
                    raise ValueError("内容过大")
                payload = json.loads(self.rfile.read(size) or b"{}") if method != "DELETE" else {}
                return self.send_json(mutate(match.group(1), method, int(match.group(2)) if match.group(2) else None, payload))
            if method == "GET":
                file = STATIC / (path.lstrip("/") if path.startswith("/static/") else "index.html")
                if path.startswith("/static/"):
                    file = STATIC / path.removeprefix("/static/")
                if not file.resolve().is_relative_to(STATIC.resolve()) or not file.is_file():
                    return self.send_json({"error": "文件不存在"}, 404)
                mime = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml"}.get(file.suffix, "application/octet-stream")
                return self.send_bytes(file.read_bytes(), mime)
            return self.send_json({"error": "页面不存在"}, 404)
        except LookupError as exc:
            return self.send_json({"error": str(exc)}, 404)
        except (ValueError, json.JSONDecodeError) as exc:
            return self.send_json({"error": str(exc)}, 400)
        except Exception as exc:
            self.log_error("Server error: %s", exc)
            return self.send_json({"error": "保存失败，请稍后重试"}, 500)

    def do_GET(self): self.route("GET")
    def do_POST(self): self.route("POST")
    def do_PATCH(self): self.route("PATCH")
    def do_DELETE(self): self.route("DELETE")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    init_db()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}"
    print(f"小汪的日常已启动：{url}", flush=True)
    print(f"数据位置：{DB}", flush=True)
    print("按 Control+C 结束服务。", flush=True)
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
