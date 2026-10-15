"""Local medicine warehouse system. Run: python app.py"""

import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


BASE = Path(__file__).resolve().parent
DB = Path(os.environ.get("WAREHOUSE_DB", str(BASE / "data" / "warehouse.db")))
HOST = os.environ.get("WAREHOUSE_HOST", "127.0.0.1")
PORT = int(os.environ.get("WAREHOUSE_PORT", "8000"))

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS drugs (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  specification TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT '盒',
  min_stock INTEGER NOT NULL DEFAULT 10 CHECK (min_stock >= 0)
);
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, contact TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS warehouses (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, location TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS inventory (
  drug_id INTEGER NOT NULL REFERENCES drugs(id) ON DELETE RESTRICT,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  PRIMARY KEY (drug_id, warehouse_id)
);
CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY, drug_id INTEGER NOT NULL REFERENCES drugs(id) ON DELETE RESTRICT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_cents >= 0),
  note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY, drug_id INTEGER NOT NULL REFERENCES drugs(id) ON DELETE RESTRICT,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  recipient TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY, drug_id INTEGER NOT NULL REFERENCES drugs(id) ON DELETE RESTRICT,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  resolved_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_alert ON alerts(drug_id, warehouse_id) WHERE status='open';

CREATE TRIGGER IF NOT EXISTS receipt_add_stock AFTER INSERT ON receipts BEGIN
  INSERT INTO inventory(drug_id, warehouse_id, quantity)
  VALUES (NEW.drug_id, NEW.warehouse_id, NEW.quantity)
  ON CONFLICT(drug_id, warehouse_id) DO UPDATE SET quantity=quantity+NEW.quantity;
END;
CREATE TRIGGER IF NOT EXISTS issue_check_stock BEFORE INSERT ON issues BEGIN
  SELECT CASE WHEN COALESCE((SELECT quantity FROM inventory
    WHERE drug_id=NEW.drug_id AND warehouse_id=NEW.warehouse_id),0) < NEW.quantity
    THEN RAISE(ABORT, 'INSUFFICIENT_STOCK') END;
END;
CREATE TRIGGER IF NOT EXISTS issue_deduct_stock AFTER INSERT ON issues BEGIN
  UPDATE inventory SET quantity=quantity-NEW.quantity
  WHERE drug_id=NEW.drug_id AND warehouse_id=NEW.warehouse_id;
END;
CREATE TRIGGER IF NOT EXISTS stock_low_insert AFTER INSERT ON inventory
WHEN NEW.quantity < (SELECT min_stock FROM drugs WHERE id=NEW.drug_id) BEGIN
  INSERT OR IGNORE INTO alerts(drug_id,warehouse_id) VALUES(NEW.drug_id,NEW.warehouse_id);
END;
CREATE TRIGGER IF NOT EXISTS stock_low_update AFTER UPDATE OF quantity ON inventory
WHEN NEW.quantity < (SELECT min_stock FROM drugs WHERE id=NEW.drug_id) BEGIN
  INSERT OR IGNORE INTO alerts(drug_id,warehouse_id) VALUES(NEW.drug_id,NEW.warehouse_id);
END;
CREATE TRIGGER IF NOT EXISTS stock_recovered AFTER UPDATE OF quantity ON inventory
WHEN NEW.quantity >= (SELECT min_stock FROM drugs WHERE id=NEW.drug_id) BEGIN
  UPDATE alerts SET status='resolved',resolved_at=datetime('now','localtime')
  WHERE drug_id=NEW.drug_id AND warehouse_id=NEW.warehouse_id AND status='open';
END;
CREATE TRIGGER IF NOT EXISTS drug_min_changed_low AFTER UPDATE OF min_stock ON drugs BEGIN
  INSERT OR IGNORE INTO alerts(drug_id,warehouse_id)
  SELECT drug_id,warehouse_id FROM inventory
  WHERE drug_id=NEW.id AND quantity < NEW.min_stock;
  UPDATE alerts SET status='resolved',resolved_at=datetime('now','localtime')
  WHERE drug_id=NEW.id AND status='open'
    AND (SELECT quantity FROM inventory WHERE drug_id=NEW.id AND warehouse_id=alerts.warehouse_id) >= NEW.min_stock;
END;
"""

MASTER_FIELDS = {
    "drugs": ("code", "name", "specification", "unit", "min_stock"),
    "suppliers": ("name", "contact", "phone"),
    "warehouses": ("name", "location"),
}


def connect():
    DB.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA busy_timeout=10000")
    return db


@contextmanager
def database():
    db = connect()
    try:
        with db:
            yield db
    finally:
        db.close()


def initialize():
    with database() as db:
        db.executescript(SCHEMA)


def rows(db, sql, args=()):
    return [dict(row) for row in db.execute(sql, args).fetchall()]


def positive_int(value, label):
    if isinstance(value, bool):
        raise ValueError(f"{label}必须是正整数")
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{label}必须是正整数") from None
    if number <= 0 or str(number) != str(value):
        raise ValueError(f"{label}必须是正整数")
    return number


def nonnegative_int(value, label):
    if isinstance(value, bool):
        raise ValueError(f"{label}必须是非负整数")
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{label}必须是非负整数") from None
    if number < 0 or str(number) != str(value):
        raise ValueError(f"{label}必须是非负整数")
    return number


def cleaned_text(value, label, required=False, limit=120):
    value = str(value if value is not None else "").strip()
    if required and not value:
        raise ValueError(f"{label}不能为空")
    if len(value) > limit:
        raise ValueError(f"{label}不能超过{limit}个字符")
    return value


def master_values(table, data):
    if table == "drugs":
        return (
            cleaned_text(data.get("code"), "药品编码", True, 40),
            cleaned_text(data.get("name"), "药品名称", True),
            cleaned_text(data.get("specification"), "规格"),
            cleaned_text(data.get("unit") or "盒", "单位", True, 20),
            nonnegative_int(data.get("min_stock", 10), "预警线"),
        )
    if table == "suppliers":
        return (
            cleaned_text(data.get("name"), "供应商名称", True),
            cleaned_text(data.get("contact"), "联系人"),
            cleaned_text(data.get("phone"), "联系电话", False, 40),
        )
    return (
        cleaned_text(data.get("name"), "仓库名称", True),
        cleaned_text(data.get("location"), "位置"),
    )


def get_data(db, collection):
    if collection in MASTER_FIELDS:
        return rows(db, f"SELECT * FROM {collection} ORDER BY id DESC")
    if collection == "inventory":
        return rows(db, """SELECT i.drug_id,i.warehouse_id,i.quantity,d.code,d.name AS drug_name,
          d.specification,d.unit,d.min_stock,w.name AS warehouse_name,
          CASE WHEN i.quantity < d.min_stock THEN 1 ELSE 0 END AS low_stock
          FROM inventory i JOIN drugs d ON d.id=i.drug_id JOIN warehouses w ON w.id=i.warehouse_id
          ORDER BY low_stock DESC,d.name,w.name""")
    if collection == "receipts":
        return rows(db, """SELECT r.*,d.name AS drug_name,d.unit,s.name AS supplier_name,
          w.name AS warehouse_name FROM receipts r JOIN drugs d ON d.id=r.drug_id
          JOIN suppliers s ON s.id=r.supplier_id JOIN warehouses w ON w.id=r.warehouse_id
          ORDER BY r.id DESC LIMIT 300""")
    if collection == "issues":
        return rows(db, """SELECT x.*,d.name AS drug_name,d.unit,w.name AS warehouse_name
          FROM issues x JOIN drugs d ON d.id=x.drug_id JOIN warehouses w ON w.id=x.warehouse_id
          ORDER BY x.id DESC LIMIT 300""")
    if collection == "alerts":
        return rows(db, """SELECT a.*,d.name AS drug_name,d.code,d.unit,d.min_stock,
          w.name AS warehouse_name,i.quantity FROM alerts a
          JOIN drugs d ON d.id=a.drug_id JOIN warehouses w ON w.id=a.warehouse_id
          JOIN inventory i ON i.drug_id=a.drug_id AND i.warehouse_id=a.warehouse_id
          WHERE a.status='open' ORDER BY a.created_at DESC,a.id DESC""")
    if collection == "dashboard":
        counts = db.execute("""SELECT (SELECT count(*) FROM drugs) drugs,
          (SELECT count(*) FROM suppliers) suppliers,
          (SELECT count(*) FROM warehouses) warehouses,
          (SELECT COALESCE(sum(quantity),0) FROM inventory) total_units,
          (SELECT count(*) FROM alerts WHERE status='open') alerts""").fetchone()
        return dict(counts)
    raise KeyError(collection)


def create(db, collection, data):
    if collection in MASTER_FIELDS:
        fields = MASTER_FIELDS[collection]
        values = master_values(collection, data)
        names = ",".join(fields)
        marks = ",".join("?" for _ in fields)
        cursor = db.execute(f"INSERT INTO {collection}({names}) VALUES({marks})", values)
        return {"id": cursor.lastrowid}
    if collection == "receipts":
        values = (
            positive_int(data.get("drug_id"), "药品"),
            positive_int(data.get("supplier_id"), "供应商"),
            positive_int(data.get("warehouse_id"), "仓库"),
            positive_int(data.get("quantity"), "入库数量"),
            nonnegative_int(data.get("unit_price_cents", 0), "单价"),
            cleaned_text(data.get("note"), "备注", False, 500),
        )
        cursor = db.execute("""INSERT INTO receipts(drug_id,supplier_id,warehouse_id,quantity,unit_price_cents,note)
          VALUES(?,?,?,?,?,?)""", values)
        return {"id": cursor.lastrowid}
    if collection == "issues":
        values = (
            positive_int(data.get("drug_id"), "药品"),
            positive_int(data.get("warehouse_id"), "仓库"),
            positive_int(data.get("quantity"), "出库数量"),
            cleaned_text(data.get("recipient"), "领用人或部门", True),
            cleaned_text(data.get("note"), "备注", False, 500),
        )
        cursor = db.execute("""INSERT INTO issues(drug_id,warehouse_id,quantity,recipient,note)
          VALUES(?,?,?,?,?)""", values)
        return {"id": cursor.lastrowid}
    raise KeyError(collection)


def update_master(db, table, item_id, data):
    fields = MASTER_FIELDS[table]
    values = master_values(table, data)
    assignments = ",".join(f"{field}=?" for field in fields)
    cursor = db.execute(f"UPDATE {table} SET {assignments} WHERE id=?", (*values, item_id))
    if not cursor.rowcount:
        raise LookupError("记录不存在")
    return {"id": item_id}


class Handler(BaseHTTPRequestHandler):
    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, filename, content_type):
        body = (BASE / filename).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 65536:
            raise ValueError("请求内容为空或过大")
        value = json.loads(self.rfile.read(length))
        if not isinstance(value, dict):
            raise ValueError("请求内容必须是对象")
        return value

    def route(self):
        path = urlparse(self.path).path
        if path == "/":
            return self.send_file("index.html", "text/html; charset=utf-8")
        static = {
            "/static/app.js": ("app.js", "text/javascript; charset=utf-8"),
            "/static/style.css": ("style.css", "text/css; charset=utf-8"),
        }
        if self.command == "GET" and path in static:
            return self.send_file(*static[path])
        parts = path.strip("/").split("/")
        if len(parts) < 2 or parts[0] != "api":
            return self.send_json({"error": "页面或接口不存在"}, 404)
        collection = parts[1]
        allowed = set(MASTER_FIELDS) | {"inventory", "receipts", "issues", "alerts", "dashboard"}
        if collection not in allowed:
            return self.send_json({"error": "接口不存在"}, 404)
        with database() as db:
            if self.command == "GET" and len(parts) == 2:
                return self.send_json(get_data(db, collection))
            if self.command == "POST" and len(parts) == 2 and collection in set(MASTER_FIELDS) | {"receipts", "issues"}:
                result = create(db, collection, self.read_json())
                db.commit()
                return self.send_json(result, 201)
            if len(parts) == 3 and collection in MASTER_FIELDS and parts[2].isdigit():
                item_id = positive_int(parts[2], "编号")
                if self.command == "PUT":
                    result = update_master(db, collection, item_id, self.read_json())
                    db.commit()
                    return self.send_json(result)
                if self.command == "DELETE":
                    cursor = db.execute(f"DELETE FROM {collection} WHERE id=?", (item_id,))
                    if not cursor.rowcount:
                        raise LookupError("记录不存在")
                    db.commit()
                    return self.send_json({"ok": True})
        return self.send_json({"error": "不支持此操作"}, 405)

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def do_PUT(self):
        self.handle_request()

    def do_DELETE(self):
        self.handle_request()

    def handle_request(self):
        try:
            self.route()
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, 400)
        except LookupError as exc:
            self.send_json({"error": str(exc)}, 404)
        except sqlite3.IntegrityError as exc:
            detail = str(exc)
            if "INSUFFICIENT_STOCK" in detail:
                message = "库存不足，出库未完成"
            elif "UNIQUE" in detail:
                message = "编码或名称已存在"
            elif "FOREIGN KEY" in detail:
                message = "关联记录不存在，或该资料已被业务单据使用"
            else:
                message = "数据不符合要求"
            self.send_json({"error": message}, 400)
        except (OSError, sqlite3.Error):
            self.send_json({"error": "服务端处理失败，请检查数据库文件权限"}, 500)


if __name__ == "__main__":
    initialize()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"仓库物资管理系统已启动：http://{HOST}:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
