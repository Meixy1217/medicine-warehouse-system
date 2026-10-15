const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const base=path.join(__dirname,'../docs');
const init=require(path.join(base,'vendor/sql-wasm.js'));
const SQLPromise=init({locateFile:f=>path.join(base,'vendor',f)});
const storage=new Map();
function context(){
  const sandbox={URL,Uint8Array,console,CustomEvent:class{},document:{baseURI:'https://example.test/medicine-warehouse-system/'},
    navigator:{},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
    btoa:s=>Buffer.from(s,'binary').toString('base64'),atob:s=>Buffer.from(s,'base64').toString('binary'),
    initSqlJs:()=>SQLPromise,fetch:async()=>({ok:true,arrayBuffer:async()=>new Uint8Array(fs.readFileSync(path.join(base,'demo.sqlite'))).buffer}),
    window:{addEventListener(){},dispatchEvent(){}}};
  vm.runInNewContext(fs.readFileSync(path.join(base,'browser-db.js'),'utf8'),sandbox);
  return sandbox.window.WarehouseAPI;
}
(async()=>{
  let api=context();
  assert.deepEqual(JSON.parse(JSON.stringify(await api.request('dashboard'))),{drugs:12,suppliers:4,warehouses:3,total_units:925,alerts:4});
  const inventory=await api.request('inventory');
  const zero=inventory.find(x=>x.code==='DEMO003');
  const supplier=(await api.request('suppliers'))[0].id;
  const post=(endpoint,data)=>api.request(endpoint,{method:'POST',body:JSON.stringify(data)});
  await assert.rejects(post('issues',{drug_id:zero.drug_id,warehouse_id:zero.warehouse_id,quantity:1,recipient:'校验'}),/库存不足/);
  await post('receipts',{drug_id:zero.drug_id,supplier_id:supplier,warehouse_id:zero.warehouse_id,quantity:30});
  assert.equal((await api.request('dashboard')).alerts,3);
  await assert.rejects(post('receipts',{drug_id:99999,supplier_id:supplier,warehouse_id:zero.warehouse_id,quantity:10}),/关联记录/);
  await assert.rejects(api.request('drugs/'+zero.drug_id,{method:'DELETE'}),/关联记录/);
  await post('issues',{drug_id:zero.drug_id,warehouse_id:zero.warehouse_id,quantity:1,recipient:'校验'});
  assert.equal((await api.request('dashboard')).alerts,4);
  api=context();
  assert.equal((await api.request('inventory')).find(x=>x.code==='DEMO003').quantity,29);
  await api.reset();
  assert.equal((await api.request('dashboard')).total_units,925);
  assert.equal((await api.request('receipts')).length,19);
  console.log('PASS: demo initialization, persistence, receipts/issues, insufficient stock, alerts, foreign keys, reset');
})().catch(error=>{console.error(error);process.exitCode=1;});
