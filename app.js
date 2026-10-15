function icon(name, extraClass='') {
  return `<svg class="ui-icon ${extraClass}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#icon-${name}"></use></svg>`;
}
const sections = [
  {key:'dashboard',label:'总览',icon:'layout-dashboard'},
  {key:'inventory',label:'库存查询',icon:'packages'},
  {key:'receipts',label:'入库管理',icon:'package-import'},
  {key:'issues',label:'出库管理',icon:'package-export'},
  {key:'drugs',label:'药品资料',icon:'pill'},
  {key:'suppliers',label:'供应商',icon:'truck-delivery'},
  {key:'warehouses',label:'仓库资料',icon:'building-warehouse'},
  {key:'alerts',label:'库存预警',icon:'alert-triangle'}
];
const state = {page:'dashboard', data:{}, query:'', lowOnly:false, editor:null};
const main = document.getElementById('main');
const dialog = document.getElementById('editor');
const form = document.getElementById('editorForm');
let toastTimer;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtDate(value) { return esc(value ? value.replace('T',' ').slice(0,16) : '—'); }
function money(cents) { return `¥${(Number(cents || 0) / 100).toFixed(2)}`; }
function toast(message, error=false) {
  const el = document.getElementById('toast');
  el.textContent = message; el.className = `toast-message show${error ? ' error' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.className = 'toast-message', 3500);
}
async function api(path, options={}) {
  const response = await fetch('/api/' + path, {
    ...options,
    headers: {'Content-Type':'application/json', ...(options.headers || {})}
  });
  let result;
  try { result = await response.json(); } catch { throw new Error('服务器响应无效'); }
  if (!response.ok) throw new Error(result.error || '操作失败');
  return result;
}
async function refresh() {
  const keys = ['dashboard','inventory','receipts','issues','drugs','suppliers','warehouses','alerts'];
  const results = await Promise.all(keys.map(key => api(key)));
  keys.forEach((key,index) => state.data[key] = results[index]);
  renderNav(); render();
}
function renderNav() {
  document.getElementById('nav').innerHTML = sections.map(item => `
    <button type="button" class="nav-item ${state.page === item.key ? 'active' : ''}" data-page="${item.key}" ${state.page === item.key ? 'aria-current="page"' : ''}>
      <span class="nav-icon" aria-hidden="true">${icon(item.icon)}</span><span>${item.label}</span>
      ${item.key === 'alerts' && state.data.dashboard?.alerts ? `<span class="nav-count">${state.data.dashboard.alerts}</span>` : ''}
    </button>`).join('');
}
function heading(title, subtitle, action='') {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div><div class="heading-actions">${action}</div></div>`;
}
function empty(title, detail='') {
  return `<div class="empty"><strong>${title}</strong>${detail}</div>`;
}
function table(headers, body, message='暂无记录') {
  if (!body) return empty(message);
  return `<div class="panel-table"><table class="table table-vcenter"><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
}
function stockBadge(item) {
  return item.low_stock ? `<span class="badge-low">${icon('alert-triangle')}库存偏低</span>` : `<span class="badge-ok">${icon('check')}正常</span>`;
}
function renderDashboard() {
  const d = state.data.dashboard || {};
  const inventory = state.data.inventory || [];
  const alerts = state.data.alerts || [];
  const recent = (state.data.receipts || []).slice(0,5);
  const stockRows = inventory.slice(0,7).map(x=>`<tr><td><strong>${esc(x.drug_name)}</strong><div class="subline">${esc(x.code)} · ${esc(x.specification || '无规格')}</div></td><td>${esc(x.warehouse_name)}</td><td><span class="${x.low_stock?'qty-low':'qty-normal'}">${x.quantity}</span> ${esc(x.unit)}</td><td>${stockBadge(x)}</td></tr>`).join('');
  const alertRows = alerts.slice(0,5).map(x=>`<div class="alert-row">${icon('alert-triangle')}<strong>${esc(x.drug_name)} · ${esc(x.warehouse_name)}</strong><span>现有 ${x.quantity} ${esc(x.unit)}，预警线 ${x.min_stock} ${esc(x.unit)}</span></div>`).join('');
  const receiptRows = recent.map(x=>`<tr><td>${fmtDate(x.created_at)}</td><td>${esc(x.drug_name)}</td><td>${esc(x.warehouse_name)}</td><td>+${x.quantity} ${esc(x.unit)}</td></tr>`).join('');
  main.innerHTML = heading('库存总览','集中查看仓储状态与近期流转',`<button class="btn btn-outline-primary" data-open="receipts">${icon('package-import')}办理入库</button><button class="btn btn-primary" data-open="issues">${icon('package-export')}办理出库</button>`) +
    `<div class="overview">
      <div class="metric"><div class="metric-label">药品品种</div><div class="metric-value">${d.drugs||0}</div></div>
      <div class="metric"><div class="metric-label">库存总件数</div><div class="metric-value">${d.total_units||0}</div></div>
      <div class="metric"><div class="metric-label">仓库数量</div><div class="metric-value">${d.warehouses||0}</div></div>
      <div class="metric alert-metric"><div class="metric-label">待处理预警</div><div class="metric-value">${d.alerts||0}</div></div>
    </div>
    <div class="section-grid"><div>
      <section class="panel"><div class="panel-head"><h2>当前库存</h2><button class="btn btn-sm btn-outline-secondary" data-page="inventory">查看全部</button></div>${table(['药品','仓库','数量','状态'],stockRows,'还没有库存记录')}</section>
      <section class="panel"><div class="panel-head"><h2>最近入库</h2></div>${table(['时间','药品','仓库','数量'],receiptRows,'还没有入库记录')}</section>
    </div><section class="panel"><div class="panel-head"><h2>库存预警</h2><button class="btn btn-sm btn-outline-secondary" data-page="alerts">查看全部</button></div><div class="panel-body">${alertRows ? `<div class="alert-list">${alertRows}</div>` : empty('暂无库存预警','库存低于药品预警线时会显示在这里。')}</div></section></div>`;
}
function renderInventory() {
  let data = state.data.inventory || [];
  const q = state.query.toLowerCase();
  if(q) data = data.filter(x => [x.drug_name,x.code,x.warehouse_name,x.specification].some(y => String(y||'').toLowerCase().includes(q)));
  if(state.lowOnly) data = data.filter(x => x.low_stock);
  const body = data.map(x=>`<tr><td><strong>${esc(x.drug_name)}</strong><div class="subline">${esc(x.code)} · ${esc(x.specification || '无规格')}</div></td><td>${esc(x.warehouse_name)}</td><td><span class="${x.low_stock?'qty-low':'qty-normal'}">${x.quantity}</span> ${esc(x.unit)}</td><td>${x.min_stock} ${esc(x.unit)}</td><td>${stockBadge(x)}</td></tr>`).join('');
  main.innerHTML = heading('库存查询','按药品和仓库查看实时结存',`<button class="btn btn-primary" data-open="receipts">${icon('package-import')}新增入库</button>`) +
    `<section class="panel"><div class="panel-head"><h2>库存明细</h2><span class="hint">${data.length} 条记录</span></div>
    <div class="toolbar"><input id="search" class="form-control" type="search" placeholder="搜索药品、编码或仓库" value="${esc(state.query)}" aria-label="搜索库存"><label class="check-wrap"><input id="lowOnly" type="checkbox" ${state.lowOnly?'checked':''}>只看低库存</label></div>
    ${table(['药品','仓库','当前库存','预警线','状态'],body,'没有符合条件的库存记录')}</section>`;
}
const masterConfig = {
  drugs:{title:'药品资料',subtitle:'维护药品编码、规格和预警线',add:'新增药品',headers:['编码','药品名称','规格','单位','预警线','操作']},
  suppliers:{title:'供应商',subtitle:'维护入库业务使用的供应商信息',add:'新增供应商',headers:['名称','联系人','联系电话','操作']},
  warehouses:{title:'仓库资料',subtitle:'管理存放药品的仓库',add:'新增仓库',headers:['名称','位置','操作']}
};
function masterRow(key,x) {
  const actions = `<td><div class="actions"><button class="btn btn-sm btn-outline-primary" data-edit="${key}" data-id="${x.id}">编辑</button><button class="btn btn-sm btn-outline-secondary" data-delete="${key}" data-id="${x.id}">删除</button></div></td>`;
  if(key==='drugs') return `<tr><td>${esc(x.code)}</td><td><strong>${esc(x.name)}</strong></td><td>${esc(x.specification || '—')}</td><td>${esc(x.unit)}</td><td>${x.min_stock}</td>${actions}</tr>`;
  if(key==='suppliers') return `<tr><td><strong>${esc(x.name)}</strong></td><td>${esc(x.contact || '—')}</td><td>${esc(x.phone || '—')}</td>${actions}</tr>`;
  return `<tr><td><strong>${esc(x.name)}</strong></td><td>${esc(x.location || '—')}</td>${actions}</tr>`;
}
function renderMaster(key) {
  const config = masterConfig[key], data=state.data[key]||[];
  const q=state.query.toLowerCase();
  const filtered=q?data.filter(x=>Object.values(x).some(v=>String(v).toLowerCase().includes(q))):data;
  main.innerHTML=heading(config.title,config.subtitle,`<button class="btn btn-primary" data-open="${key}">${icon('plus')}${config.add}</button>`) +
    `<section class="panel"><div class="panel-head"><h2>${config.title}列表</h2><span class="hint">${filtered.length} 条记录</span></div><div class="toolbar"><input id="search" class="form-control" type="search" placeholder="搜索${config.title}" value="${esc(state.query)}" aria-label="搜索${config.title}"></div>${table(config.headers,filtered.map(x=>masterRow(key,x)).join(''),'尚无记录，请先新增')}</section>`;
}
function renderReceipts() {
  const data=state.data.receipts||[];
  const body=data.map(x=>`<tr><td>${fmtDate(x.created_at)}</td><td><strong>${esc(x.drug_name)}</strong></td><td>${esc(x.supplier_name)}</td><td>${esc(x.warehouse_name)}</td><td class="qty-normal">+${x.quantity} ${esc(x.unit)}</td><td>${money(x.unit_price_cents)}</td><td>${esc(x.note||'—')}</td></tr>`).join('');
  main.innerHTML=heading('入库管理','登记入库后自动更新库存',`<button class="btn btn-primary" data-open="receipts">${icon('package-import')}新增入库单</button>`) + `<section class="panel"><div class="panel-head"><h2>入库记录</h2><span class="hint">显示最近 300 条</span></div>${table(['时间','药品','供应商','仓库','数量','单价','备注'],body,'尚无入库记录')}</section>`;
}
function renderIssues() {
  const data=state.data.issues||[];
  const body=data.map(x=>`<tr><td>${fmtDate(x.created_at)}</td><td><strong>${esc(x.drug_name)}</strong></td><td>${esc(x.warehouse_name)}</td><td class="qty-out">−${x.quantity} ${esc(x.unit)}</td><td>${esc(x.recipient)}</td><td>${esc(x.note||'—')}</td></tr>`).join('');
  main.innerHTML=heading('出库管理','出库时校验可用库存并自动扣减',`<button class="btn btn-primary" data-open="issues">${icon('package-export')}新增出库单</button>`) + `<section class="panel"><div class="panel-head"><h2>出库记录</h2><span class="hint">显示最近 300 条</span></div>${table(['时间','药品','仓库','数量','领用人或部门','备注'],body,'尚无出库记录')}</section>`;
}
function renderAlerts() {
  const data=state.data.alerts||[];
  const body=data.map(x=>`<tr><td><strong>${esc(x.drug_name)}</strong><div class="subline">${esc(x.code)}</div></td><td>${esc(x.warehouse_name)}</td><td class="qty-low">${x.quantity} ${esc(x.unit)}</td><td>${x.min_stock} ${esc(x.unit)}</td><td>${fmtDate(x.created_at)}</td><td><span class="badge-low">${icon('alert-triangle')}待补货</span></td></tr>`).join('');
  main.innerHTML=heading('库存预警','库存低于预警线时自动生成，补货达标后自动解除',`<button class="btn btn-primary" data-open="receipts">${icon('package-import')}办理补货入库</button>`) + `<section class="panel"><div class="panel-head"><h2>待处理预警</h2><span class="hint">${data.length} 条</span></div>${table(['药品','仓库','当前库存','预警线','首次提醒','状态'],body,'目前没有待处理预警')}</section>`;
}
function render() {
  if(state.page==='dashboard') renderDashboard();
  else if(state.page==='inventory') renderInventory();
  else if(state.page==='receipts') renderReceipts();
  else if(state.page==='issues') renderIssues();
  else if(state.page==='alerts') renderAlerts();
  else renderMaster(state.page);
}
function changePage(page) {
  state.page=page; state.query=''; state.lowOnly=false;
  document.querySelector('.sidebar').classList.remove('open');
  document.getElementById('menuButton').setAttribute('aria-expanded','false');
  renderNav(); render(); window.scrollTo(0,0);
}
function field(name,label,value='',type='text',required=false,note='') {
  return `<div><label class="field-label" for="f_${name}">${label}${required?' *':''}</label><input class="form-control" id="f_${name}" name="${name}" type="${type}" value="${esc(value)}" ${required?'required':''} ${type==='number'?'min="0" step="1"':''}>${note?`<div class="field-note">${note}</div>`:''}</div>`;
}
function select(name,label,items,selected='',detail='') {
  return `<div><label class="field-label" for="f_${name}">${label} *</label><select class="form-select" id="f_${name}" name="${name}" required><option value="">请选择${label}</option>${items.map(x=>`<option value="${x.id}" ${Number(selected)===x.id?'selected':''}>${esc(x.name)}${detail&&x[detail]?` · ${esc(x[detail])}`:''}</option>`).join('')}</select></div>`;
}
function openEditor(key,id=null) {
  const record=id?(state.data[key]||[]).find(x=>x.id===id):null;
  state.editor={key,id};
  const titles={drugs:'药品',suppliers:'供应商',warehouses:'仓库',receipts:'入库单',issues:'出库单'};
  document.getElementById('editorTitle').textContent=(record?'编辑':'新增')+titles[key];
  let html='';
  if(key==='drugs') html=field('code','药品编码',record?.code||'','text',true)+field('name','药品名称',record?.name||'','text',true)+field('specification','规格',record?.specification||'')+field('unit','单位',record?.unit||'盒','text',true)+field('min_stock','库存预警线',record?.min_stock??10,'number',true,'库存低于此数量时提醒');
  else if(key==='suppliers') html=field('name','供应商名称',record?.name||'','text',true)+field('contact','联系人',record?.contact||'')+field('phone','联系电话',record?.phone||'','tel');
  else if(key==='warehouses') html=field('name','仓库名称',record?.name||'','text',true)+field('location','位置',record?.location||'');
  else if(key==='receipts') html=select('drug_id','药品',state.data.drugs||[],'','code')+select('supplier_id','供应商',state.data.suppliers||[])+select('warehouse_id','仓库',state.data.warehouses||[])+field('quantity','入库数量','','number',true)+field('unit_price','单价（元）','0','number',true)+field('note','备注');
  else if(key==='issues') html=select('drug_id','药品',state.data.drugs||[],'','code')+select('warehouse_id','仓库',state.data.warehouses||[])+field('quantity','出库数量','','number',true)+field('recipient','领用人或部门','','text',true)+field('note','备注');
  document.getElementById('editorFields').innerHTML=html;
  if(key==='receipts') { const price=document.getElementById('f_unit_price'); price.step='0.01'; }
  dialog.showModal();
  document.getElementById('editorFields').querySelector('input,select')?.focus();
}
async function saveEditor(event) {
  event.preventDefault();
  if(!state.editor) return;
  const {key,id}=state.editor;
  const data=Object.fromEntries(new FormData(form).entries());
  if(key==='receipts') {
    const price=Number(data.unit_price);
    if(!Number.isFinite(price)||price<0||Math.abs(price*100-Math.round(price*100))>1e-6) {toast('单价须为非负金额，最多两位小数',true);return;}
    data.unit_price_cents=Math.round(price*100);delete data.unit_price;
  }
  try {
    await api(id?`${key}/${id}`:key,{method:id?'PUT':'POST',body:JSON.stringify(data)});
    dialog.close();state.editor=null;
    await refresh();toast(id?'修改已保存':'记录已保存');
  } catch(error) {toast(error.message,true);}
}
async function removeMaster(key,id) {
  const item=(state.data[key]||[]).find(x=>x.id===id);
  if(!item||!window.confirm(`确定删除“${item.name}”吗？已有业务记录关联的资料无法删除。`))return;
  try {await api(`${key}/${id}`,{method:'DELETE'});await refresh();toast('已删除');}
  catch(error){toast(error.message,true);}
}
document.addEventListener('click',event=>{
  const page=event.target.closest('[data-page]'); if(page){changePage(page.dataset.page);return;}
  const open=event.target.closest('[data-open]'); if(open){openEditor(open.dataset.open);return;}
  const edit=event.target.closest('[data-edit]'); if(edit){openEditor(edit.dataset.edit,Number(edit.dataset.id));return;}
  const del=event.target.closest('[data-delete]'); if(del){removeMaster(del.dataset.delete,Number(del.dataset.id));}
});
main.addEventListener('input',event=>{
  if(event.target.id==='search'){
    state.query=event.target.value;
    const position=event.target.selectionStart;
    render();const current=document.getElementById('search');current?.focus();current?.setSelectionRange(position,position);
  }
});
main.addEventListener('change',event=>{if(event.target.id==='lowOnly'){state.lowOnly=event.target.checked;render();}});
form.addEventListener('submit',saveEditor);
document.getElementById('closeEditor').onclick=()=>dialog.close();
document.getElementById('cancelEditor').onclick=()=>dialog.close();
document.getElementById('menuButton').onclick=()=>{
  const open=document.querySelector('.sidebar').classList.toggle('open');
  document.getElementById('menuButton').setAttribute('aria-expanded',String(open));
};
document.getElementById('today').textContent=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long'}).format(new Date());
refresh().catch(error=>{main.innerHTML=empty('系统暂时无法载入',esc(error.message));toast(error.message,true);});
