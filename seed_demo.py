"""Import fictional demo data once, using the application's stock triggers."""
import csv
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import app

BASE = Path(__file__).resolve().parent


def timestamp(days, minutes=0):
    day = datetime.now(timezone(timedelta(hours=8))).replace(hour=9, minute=0, second=0, microsecond=0)
    return (day + timedelta(days=days, minutes=minutes)).strftime('%Y-%m-%d %H:%M:%S')


def record_event(db, table, values, occurred_at):
    previous_max = db.execute('SELECT COALESCE(max(id),0) FROM alerts').fetchone()[0]
    previously_open = [row[0] for row in db.execute("SELECT id FROM alerts WHERE status='open'")]
    columns = ','.join(values)
    marks = ','.join('?' for _ in values)
    db.execute(f'INSERT INTO {table}({columns},created_at) VALUES({marks},?)', (*values.values(), occurred_at))
    # Keep synthetic historical alert times aligned with the synthetic ledger.
    db.execute('UPDATE alerts SET created_at=? WHERE id>?', (occurred_at, previous_max))
    for alert_id in previously_open:
        db.execute("UPDATE alerts SET resolved_at=? WHERE id=? AND status='resolved'", (occurred_at, alert_id))


def import_demo():
    dataset = json.loads((BASE / 'demo_data.json').read_text(encoding='utf-8'))
    app.initialize()
    with app.database() as db:
        db.execute('BEGIN IMMEDIATE')
        db.execute('''CREATE TABLE IF NOT EXISTS demo_imports (
            dataset_id TEXT PRIMARY KEY, imported_at TEXT NOT NULL)''')
        if db.execute('SELECT 1 FROM demo_imports WHERE dataset_id=?', (dataset['dataset_id'],)).fetchone():
            print('此组演示数据已导入，未重复添加。')
            return
        codes = [item['code'] for item in dataset['drugs']]
        marks = ','.join('?' for _ in codes)
        if db.execute(f'SELECT 1 FROM drugs WHERE code IN ({marks})', codes).fetchone():
            raise ValueError('已存在 DEMO 药品编码，本次导入已取消；未修改原有记录。')
        drugs = {item['code']: app.create(db, 'drugs', item)['id'] for item in dataset['drugs']}
        suppliers = {item['key']: app.create(db, 'suppliers', item)['id'] for item in dataset['suppliers']}
        warehouses = {item['key']: app.create(db, 'warehouses', item)['id'] for item in dataset['warehouses']}
        for index, (code, supplier, warehouse, qty, price) in enumerate(dataset['opening_receipts']):
            record_event(db, 'receipts', {
                'drug_id': drugs[code], 'supplier_id': suppliers[supplier],
                'warehouse_id': warehouses[warehouse], 'quantity': qty,
                'unit_price_cents': price, 'note': '演示数据：首批采购入库'
            }, timestamp(-7, index * 5))
        for index, (code, warehouse, qty, recipient) in enumerate(dataset['issues']):
            record_event(db, 'issues', {
                'drug_id': drugs[code], 'warehouse_id': warehouses[warehouse],
                'quantity': qty, 'recipient': recipient, 'note': '演示数据：科室领用'
            }, timestamp(-3, index * 5))
        for index, (code, supplier, warehouse, qty, price) in enumerate(dataset['restock_receipts']):
            record_event(db, 'receipts', {
                'drug_id': drugs[code], 'supplier_id': suppliers[supplier],
                'warehouse_id': warehouses[warehouse], 'quantity': qty,
                'unit_price_cents': price, 'note': '演示数据：低库存补货，自动解除预警'
            }, timestamp(-1, index * 5))

        ids = tuple(drugs.values())
        placeholders = ','.join('?' for _ in ids)
        actual = {'drugs': len(drugs), 'suppliers': len(suppliers), 'warehouses': len(warehouses)}
        for table in ('receipts', 'issues', 'inventory'):
            actual[table] = db.execute(f'SELECT count(*) FROM {table} WHERE drug_id IN ({placeholders})', ids).fetchone()[0]
        actual['total_quantity'] = db.execute(f'SELECT sum(quantity) FROM inventory WHERE drug_id IN ({placeholders})', ids).fetchone()[0]
        for status in ('open', 'resolved'):
            actual[status + '_alerts'] = db.execute(f'SELECT count(*) FROM alerts WHERE drug_id IN ({placeholders}) AND status=?', (*ids, status)).fetchone()[0]
        if actual != dataset['expected']:
            raise ValueError(f'演示数据核对失败，已回滚：{actual}')
        db.execute('INSERT INTO demo_imports VALUES(?,?)', (dataset['dataset_id'], timestamp(0)))
        inventory = [row for row in app.get_data(db, 'inventory') if row['drug_id'] in ids]

    with (BASE / 'demo_inventory.csv').open('w', encoding='utf-8-sig', newline='') as output:
        writer = csv.writer(output)
        writer.writerow(['药品编码', '药品名称', '规格', '仓库', '当前库存', '单位', '预警线', '状态'])
        for row in inventory:
            writer.writerow([row['code'], row['drug_name'], row['specification'], row['warehouse_name'],
                             row['quantity'], row['unit'], row['min_stock'], '低库存' if row['low_stock'] else '正常'])
    print('演示数据导入成功。')
    print(json.dumps(actual, ensure_ascii=False, indent=2))
    print('库存清单：demo_inventory.csv')


if __name__ == '__main__':
    try:
        import_demo()
    except (ValueError, sqlite3.Error) as error:
        raise SystemExit(str(error)) from None
