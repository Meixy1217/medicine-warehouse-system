/* Browser-only SQLite adapter for the GitHub Pages demonstration. */
window.WarehouseAPI = (() => {
  const base = new URL('.', document.baseURI);
  const storageKey = 'medicine-warehouse-demo-v1:' + base.pathname;
  let SQL, db, lastSaved;
  const masters = {
    drugs: ['code','name','specification','unit','min_stock'],
    suppliers: ['name','contact','phone'],
    warehouses: ['name','location']
  };

  function readSaved() {
    try { return localStorage.getItem(storageKey); }
    catch { throw new Error('浏览器禁止保存数据，请允许网站存储后重试'); }
  }
  function encode(bytes) {
    let value='';
    for(let offset=0;offset<bytes.length;offset+=8192) value+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
    return btoa(value);
  }
  function decode(value) {
    return Uint8Array.from(atob(value),char=>char.charCodeAt(0));
  }
  function openDatabase(bytes) {
    const next = new SQL.Database(bytes);
    next.run('PRAGMA foreign_keys=ON');
    if(db) db.close();
    db=next;
  }
  function persist() {
    const next=encode(exportDatabase());
    try { localStorage.setItem(storageKey,next); }
    catch { throw new Error('浏览器空间不足或禁止保存，本次修改未保存'); }
    lastSaved=next;
  }
  function exportDatabase() {
    const bytes=db.export();
    // sql.js reopens the connection during export, resetting connection PRAGMAs.
    db.run('PRAGMA foreign_keys=ON');
    return bytes;
  }
  async function template() {
    const response=await fetch(new URL('demo.sqlite',base));
    if(!response.ok)throw new Error('测试数据加载失败，请刷新页面重试');
    return new Uint8Array(await response.arrayBuffer());
  }
  const ready=(async()=>{
    if(typeof initSqlJs!=='function')throw new Error('数据库组件加载失败，请刷新页面重试');
    SQL=await initSqlJs({locateFile:file=>new URL('vendor/'+file,base).href});
    const saved=readSaved();
    try { openDatabase(saved?decode(saved):await template()); }
    catch(error) { throw new Error('演示数据库无法打开：'+error.message); }
    lastSaved=saved;
    if(!saved)persist();
  })();

  function syncSaved() {
    const saved=readSaved();
    if(saved&&saved!==lastSaved){openDatabase(decode(saved));lastSaved=saved;}
  }
  function query(sql,args=[]) {
    const statement=db.prepare(sql);
    try {
      statement.bind(args);
      const result=[];
      while(statement.step())result.push(statement.getAsObject());
      return result;
    } finally {statement.free();}
  }
  function text(value,label,required=false,max=120) {
    const result=String(value??'').trim();
    if(required&&!result)throw new Error(label+'不能为空');
    if(result.length>max)throw new Error(label+'不能超过'+max+'个字符');
    return result;
  }
  function integer(value,label,minimum=1) {
    const result=Number(value);
    if(typeof value==='boolean'||!Number.isSafeInteger(result)||result<minimum||String(result)!==String(value))
      throw new Error(label+'必须是'+(minimum?'正整数':'非负整数'));
    return result;
  }
  function masterValues(table,data) {
    if(table==='drugs')return [text(data.code,'药品编码',true,40),text(data.name,'药品名称',true),
      text(data.specification,'规格'),text(data.unit||'盒','单位',true,20),integer(data.min_stock??10,'预警线',0)];
    if(table==='suppliers')return [text(data.name,'供应商名称',true),text(data.contact,'联系人'),text(data.phone,'联系电话',false,40)];
    return [text(data.name,'仓库名称',true),text(data.location,'位置')];
  }
  function list(collection) {
    if(Object.hasOwn(masters,collection))return query(`SELECT * FROM ${collection} ORDER BY id DESC`);
    if(collection==='inventory')return query(`SELECT i.drug_id,i.warehouse_id,i.quantity,d.code,d.name AS drug_name,
      d.specification,d.unit,d.min_stock,w.name AS warehouse_name,
      CASE WHEN i.quantity<d.min_stock THEN 1 ELSE 0 END AS low_stock
      FROM inventory i JOIN drugs d ON d.id=i.drug_id JOIN warehouses w ON w.id=i.warehouse_id
      ORDER BY low_stock DESC,d.name,w.name`);
    if(collection==='receipts')return query(`SELECT r.*,d.name AS drug_name,d.unit,s.name AS supplier_name,w.name AS warehouse_name
      FROM receipts r JOIN drugs d ON d.id=r.drug_id JOIN suppliers s ON s.id=r.supplier_id
      JOIN warehouses w ON w.id=r.warehouse_id ORDER BY r.id DESC LIMIT 300`);
    if(collection==='issues')return query(`SELECT x.*,d.name AS drug_name,d.unit,w.name AS warehouse_name FROM issues x
      JOIN drugs d ON d.id=x.drug_id JOIN warehouses w ON w.id=x.warehouse_id ORDER BY x.id DESC LIMIT 300`);
    if(collection==='alerts')return query(`SELECT a.*,d.name AS drug_name,d.code,d.unit,d.min_stock,w.name AS warehouse_name,i.quantity
      FROM alerts a JOIN drugs d ON d.id=a.drug_id JOIN warehouses w ON w.id=a.warehouse_id
      JOIN inventory i ON i.drug_id=a.drug_id AND i.warehouse_id=a.warehouse_id
      WHERE a.status='open' ORDER BY a.created_at DESC,a.id DESC`);
    if(collection==='dashboard')return query(`SELECT (SELECT count(*) FROM drugs) drugs,
      (SELECT count(*) FROM suppliers) suppliers,(SELECT count(*) FROM warehouses) warehouses,
      (SELECT COALESCE(sum(quantity),0) FROM inventory) total_units,
      (SELECT count(*) FROM alerts WHERE status='open') alerts`)[0];
    throw new Error('接口不存在');
  }
  function mutate(collection,id,method,data) {
    if(Object.hasOwn(masters,collection)) {
      const fields=masters[collection];
      if(method==='POST'&&!id) {
        db.run(`INSERT INTO ${collection}(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`,masterValues(collection,data));
      } else if(method==='PUT'&&id) {
        db.run(`UPDATE ${collection} SET ${fields.map(field=>field+'=?').join(',')} WHERE id=?`,[...masterValues(collection,data),id]);
        if(!db.getRowsModified())throw new Error('记录不存在');
        return {id};
      } else if(method==='DELETE'&&id) {
        db.run(`DELETE FROM ${collection} WHERE id=?`,[id]);
        if(!db.getRowsModified())throw new Error('记录不存在');
        return {ok:true};
      } else throw new Error('不支持此操作');
    } else if(collection==='receipts'&&method==='POST'&&!id) {
      db.run(`INSERT INTO receipts(drug_id,supplier_id,warehouse_id,quantity,unit_price_cents,note) VALUES(?,?,?,?,?,?)`,[
        integer(data.drug_id,'药品'),integer(data.supplier_id,'供应商'),integer(data.warehouse_id,'仓库'),
        integer(data.quantity,'入库数量'),integer(data.unit_price_cents??0,'单价',0),text(data.note,'备注',false,500)]);
    } else if(collection==='issues'&&method==='POST'&&!id) {
      db.run(`INSERT INTO issues(drug_id,warehouse_id,quantity,recipient,note) VALUES(?,?,?,?,?)`,[
        integer(data.drug_id,'药品'),integer(data.warehouse_id,'仓库'),integer(data.quantity,'出库数量'),
        text(data.recipient,'领用人或部门',true),text(data.note,'备注',false,500)]);
    } else throw new Error('不支持此操作');
    return {id:query('SELECT last_insert_rowid() id')[0].id};
  }
  function friendly(error) {
    const message=error.message||String(error);
    if(message.includes('INSUFFICIENT_STOCK'))return new Error('库存不足，出库未完成');
    if(message.includes('UNIQUE constraint'))return new Error('编码或名称已存在');
    if(message.includes('FOREIGN KEY'))return new Error('关联记录不存在，或该资料已被业务单据使用');
    return error;
  }
  async function locked(action) {
    if(navigator.locks)return navigator.locks.request(storageKey,action);
    return action();
  }
  async function request(path,options={}) {
    await ready;
    const parts=path.split('/');
    if(parts.length>2)throw new Error('接口不存在');
    const collection=parts[0],id=parts.length===2?integer(parts[1],'编号'):null;
    const method=options.method||'GET';
    if(method==='GET'){syncSaved();return list(collection);}
    return locked(()=>{
      syncSaved();
      const before=exportDatabase();
      try {
        db.run('BEGIN');
        const data=options.body?JSON.parse(options.body):{};
        const result=mutate(collection,id,method,data);
        db.run('COMMIT');
        persist();
        return result;
      } catch(error) {
        try{db.run('ROLLBACK');}catch{}
        openDatabase(before);
        throw friendly(error);
      }
    });
  }
  async function reset() {
    await ready;
    const bytes=await template();
    return locked(()=>{
      syncSaved();
      const before=exportDatabase();
      try{openDatabase(bytes);persist();}
      catch(error){openDatabase(before);throw error;}
    });
  }
  window.addEventListener('storage',event=>{
    if(event.key===storageKey&&event.newValue)window.dispatchEvent(new CustomEvent('warehouse-data-change'));
  });
  return {request,reset};
})();
