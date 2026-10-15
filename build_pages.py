from pathlib import Path
import importlib.util
import io
import json
import shutil
import sys
import tarfile
import tempfile
import urllib.request

BASE = Path(__file__).resolve().parent
DOCS = BASE / 'docs'
DOCS.mkdir(exist_ok=True)
VENDOR = DOCS / 'vendor'
VENDOR.mkdir(exist_ok=True)


def package_files(name, version, selected):
    url = 'https://registry.npmjs.org/' + urllib.parse.quote(name, safe='') + '/' + version
    with urllib.request.urlopen(url, timeout=40) as response:
        metadata = json.load(response)
    with urllib.request.urlopen(metadata['dist']['tarball'], timeout=60) as response:
        archive = tarfile.open(fileobj=io.BytesIO(response.read()), mode='r:gz')
    for source, target in selected.items():
        content = archive.extractfile('package/' + source).read()
        (VENDOR / target).write_bytes(content)
    return {'package': name, 'version': version, 'source': metadata['dist']['tarball'], 'integrity': metadata['dist'].get('integrity')}


if not (VENDOR / 'sql-wasm.wasm').exists():
    sources = [package_files('sql.js', '1.13.0', {
        'dist/sql-wasm.js': 'sql-wasm.js', 'dist/sql-wasm.wasm': 'sql-wasm.wasm', 'LICENSE': 'sql.js-LICENSE'
    }), package_files('@tabler/core', '1.0.0', {
        'dist/css/tabler.min.css': 'tabler.min.css', 'LICENSE': 'tabler-LICENSE'
    })]
    (VENDOR / 'sources.json').write_text(json.dumps(sources, indent=2), encoding='utf-8')

sys.path.insert(0, str(BASE))
import app
import seed_demo
with tempfile.TemporaryDirectory() as temp:
    staging = Path(temp)
    shutil.copyfile(BASE / 'demo_data.json', staging / 'demo_data.json')
    app.DB = staging / 'demo.sqlite'
    seed_demo.BASE = staging
    seed_demo.import_demo()
    shutil.copyfile(app.DB, DOCS / 'demo.sqlite')

html = (BASE / 'index.html').read_text(encoding='utf-8')
html = html.replace('https://cdn.jsdelivr.net/npm/@tabler/core@1.0.0/dist/css/tabler.min.css', './vendor/tabler.min.css')
html = html.replace('/static/style.css?v=20261015-2', './style.css')
html = html.replace('<script src="/static/app.js?v=20261015-2" defer></script>', '<script src="./vendor/sql-wasm.js" defer></script>\n  <script src="./browser-db.js" defer></script>\n  <script src="./app.js" defer></script>')
html = html.replace('<span id="today" class="topbar-date"></span>', '<span id="today" class="topbar-date"></span>')
html = html.replace('<main id="main"', '<div class="demo-notice"><span>在线演示 · 修改仅保存在当前浏览器</span><button id="resetDemo" class="demo-reset" type="button">恢复测试数据</button></div>\n      <main id="main"')
(DOCS / 'index.html').write_text(html, encoding='utf-8')
js = (BASE / 'app.js').read_text(encoding='utf-8')
old = "async function api(path, options={}) {\n  const response = await fetch('/api/' + path, {"
assert old in js
js = js.replace(old, "async function api(path, options={}) {\n  return WarehouseAPI.request(path, options);\n}\nasync function unusedServerApi(path, options={}) {\n  const response = await fetch('/api/' + path, {")
# The published copy uses only the browser API; remove the unused server transport.
start = js.index('async function unusedServerApi(')
end = js.index('async function refresh()', start)
js = js[:start] + js[end:]
js += '''
document.getElementById('resetDemo').onclick=async()=>{
  if(!window.confirm('恢复预置测试数据会清除你在当前浏览器中的修改，是否继续？'))return;
  try{await WarehouseAPI.reset();await refresh();toast('已恢复测试数据');}
  catch(error){toast(error.message,true);}
};
window.addEventListener('warehouse-data-change',()=>refresh().catch(error=>toast(error.message,true)));
'''
(DOCS / 'app.js').write_text(js, encoding='utf-8')
css = (BASE / 'style.css').read_text(encoding='utf-8')
css += '''
.demo-notice{display:flex;justify-content:space-between;align-items:center;gap:10px;background:#edf2ed;border-bottom:1px solid #d8e2d9;color:#465f4d;padding:9px 34px;font-size:12px}
.demo-reset{background:transparent;border:0;color:#37654e;text-decoration:underline;text-underline-offset:3px;cursor:pointer;white-space:nowrap;padding:2px}
@media(max-width:700px){.demo-notice{padding:9px 15px;font-size:11px;align-items:flex-start}.demo-reset{font-size:11px}}
'''
(DOCS / 'style.css').write_text(css, encoding='utf-8')
(DOCS / '.nojekyll').touch()
print('GitHub Pages files prepared:', DOCS)
