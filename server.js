// Minimaler Server ohne Abhängigkeiten: liefert die Seite aus und speichert die Daten als JSON-Datei.
const http = require('http'), fs = require('fs'), path = require('path');
const F = path.join(process.env.DATA_DIR || '/data', 'topology.json');
const { execFile } = require('child_process'), net = require('net');
const ping = h => new Promise(r => execFile('ping', ['-c', '1', '-W', '1', h], e => r(!e)));
const tcp = (h, p) => new Promise(r => { const s = net.connect({ host: h, port: p, timeout: 1500 }); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); s.on('timeout', () => { s.destroy(); r(false); }); });
const okHost = h => /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(h || '');
let cache = { t: 0, v: {} };
// Live-Status: Ping auf die IP, ersatzweise TCP-Verbindung zum Port der URL. Ergebnis wird 15 s zwischengespeichert.
async function status() {
  if (Date.now() - cache.t < 15000) return cache.v;
  let d; try { d = JSON.parse(fs.readFileSync(F)); } catch (e) { return {}; }
  const out = {};
  await Promise.all((d.nodes || []).map(async n => {
    const h = (n.ip || '').trim(); let up = false, known = false;
    if (okHost(h)) { known = true; up = await ping(h); }
    const w = n.web || n.url; if (!up && w) { try { const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(w) ? w : 'http://' + w); if (okHost(u.hostname)) { known = true; up = await tcp(u.hostname, +u.port || (u.protocol === 'https:' ? 443 : 80)); } } catch (e) {} }
    if (known) out[n.id] = up;
  }));
  cache = { t: Date.now(), v: out }; return out;
}
const https = require('https');
const DATA = process.env.DATA_DIR || '/data', HD = path.join(DATA, 'history'), CF = path.join(DATA, 'integrations.json');
const rev = () => fs.existsSync(F) ? String(fs.statSync(F).mtimeMs) : '0';
const json = (r, o, c) => { r.statusCode = c || 200; r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(o)); };
const cfg = () => { try { return JSON.parse(fs.readFileSync(CF)); } catch (e) { return {}; } };
// Versionsverlauf: höchstens alle 10 Minuten (oder erzwungen) wird der bisherige Stand gesichert, die letzten 200 bleiben.
function snap(force) {
  try {
    if (!fs.existsSync(F)) return;
    fs.mkdirSync(HD, { recursive: true });
    const fl = fs.readdirSync(HD).filter(f => f.endsWith('.json')).sort();
    const last = fl.length ? fs.statSync(path.join(HD, fl[fl.length - 1])).mtimeMs : 0;
    if (!force && Date.now() - last < 600000) return;
    const n = new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    fs.copyFileSync(F, path.join(HD, n)); fl.push(n);
    while (fl.length > 200) fs.unlinkSync(path.join(HD, fl.shift()));
  } catch (e) {}
}
function call(base, p, headers, insecure) {
  return new Promise((res, rej) => {
    const u = new URL(base.replace(/\/$/, '') + p), lib = u.protocol === 'https:' ? https : http;
    const rq = lib.request(u, { method: 'GET', headers, rejectUnauthorized: !insecure, timeout: 8000 }, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { if (r.statusCode >= 300) return rej(new Error('HTTP ' + r.statusCode + ' bei ' + p)); try { res(JSON.parse(b)); } catch (e) { rej(new Error('Ungültige Antwort von ' + p)); } });
    });
    rq.on('timeout', () => rq.destroy(new Error('Zeitüberschreitung bei ' + p)));
    rq.on('error', rej); rq.end();
  });
}
const kv = s => Object.fromEntries(String(s || '').split(',').map(x => { const i = x.indexOf('='); return i < 0 ? [x, ''] : [x.slice(0, i), x.slice(i + 1)]; }));
const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i, IPV4 = /^\d+\.\d+\.\d+\.\d+/;
const maskLen = m => String(m || '').split('.').reduce((a, x) => a + (+x).toString(2).replace(/0/g, '').length, 0);
async function pve() {
  const c = cfg().pve;
  if (!c || !c.url || !c.tokenId || !c.secret) throw new Error('Proxmox ist nicht vollständig konfiguriert.');
  const H = { Authorization: `PVEAPIToken=${c.tokenId}=${c.secret}` }, g = p => call(c.url + '/api2/json', p, H, c.insecure).then(r => r.data), warnings = [];
  const soft = what => e => { warnings.push(`${what}: ${e.message}${/40[13]/.test(e.message) ? ' (Berechtigung fehlt)' : ''}`); return null; };
  const res = await g('/cluster/resources'), st = await g('/cluster/status').catch(() => []);
  const stats = {}; res.forEach(x => { stats[x.type] = (stats[x.type] || 0) + 1; });
  let nodes = res.filter(x => x.type === 'node').map(x => x.node);
  if (!nodes.length) nodes = ((await g('/nodes').catch(soft('Nodes'))) || []).map(x => x.node);
  const vms = res.filter(x => x.type === 'qemu' || x.type === 'lxc');
  if (!vms.length) for (const n of nodes) for (const t of ['qemu', 'lxc']) ((await g(`/nodes/${n}/${t}`).catch(soft(`${n}: ${t}-Liste`))) || []).forEach(x => vms.push({ ...x, type: t, node: n }));
  const pool = async (arr, fn, n = 6) => { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < arr.length) { const k = i++; out[k] = await fn(arr[k]); } })); return out; };
  const hosts = await pool(nodes, async n => {
    const net = (await g(`/nodes/${n}/network`).catch(soft(`${n}: Netzwerk`))) || [];
    return { k: 'pve:' + n, name: n, ifs: net.filter(i => i.iface && i.type !== 'loopback').map(i => ({
      name: i.iface, mode: i.type === 'bridge' && +i.bridge_vlan_aware ? 'trunk' : 'access',
      u: i.type === 'vlan' ? String(i['vlan-id'] || (i.iface.split('.')[1] || '')) : '', t: [],
      ip: i.cidr || (i.address ? i.address + (i.netmask ? '/' + maskLen(i.netmask) : '') : ''), main: !!i.gateway,
      up: String(i.bridge_ports || i.ovs_ports || i.slaves || i.ovs_bonds || i['vlan-raw-device'] || '').split(/[\s,]+/)[0] || '' })) };
  });
  const guests = await pool(vms, async vm => {
    const cf = (await g(`/nodes/${vm.node}/${vm.type}/${vm.vmid}/config`).catch(soft(`${vm.name || vm.vmid}: Konfiguration`))) || {}, byMac = {};
    if (vm.status === 'running') {
      if (vm.type === 'qemu' && /^(1|enabled=1)/.test(String(cf.agent || ''))) {
        const a = await g(`/nodes/${vm.node}/qemu/${vm.vmid}/agent/network-get-interfaces`).catch(() => null);
        ((a && a.result) || []).forEach(i => { const ip = (i['ip-addresses'] || []).find(x => x['ip-address-type'] === 'ipv4' && !x['ip-address'].startsWith('127.')); if (ip && i['hardware-address']) byMac[i['hardware-address'].toLowerCase()] = ip['ip-address'] + '/' + ip.prefix; });
      }
      if (vm.type === 'lxc') { const a = await g(`/nodes/${vm.node}/lxc/${vm.vmid}/interfaces`).catch(() => null); (Array.isArray(a) ? a : []).forEach(i => { if (i.inet && i.hwaddr) byMac[i.hwaddr.toLowerCase()] = i.inet; }); }
    }
    const ifs = Object.keys(cf).filter(k => /^net\d+$/.test(k)).map(k => {
      const o = kv(cf[k]), mac = (o.hwaddr || Object.values(o).find(x => MAC.test(x)) || '').toLowerCase(), tr = String(o.trunks || '').split(';').filter(Boolean);
      let ip = vm.type === 'lxc' ? o.ip : kv(cf['ipconfig' + k.slice(3)]).ip;
      if (!IPV4.test(ip || '')) ip = byMac[mac] || '';
      return { name: vm.type === 'lxc' ? (o.name || k) : k, mode: tr.length ? 'trunk' : 'access', u: o.tag || '', t: tr, ip, up: o.bridge || '' };
    });
    return { k: `pve:${vm.type}:${vm.vmid}`, name: vm.name || ('VM ' + vm.vmid), type: vm.type === 'qemu' ? 'vm' : 'lxc', host: 'pve:' + vm.node, ifs };
  });
  return { cluster: (st.find(x => x.type === 'cluster') || {}).name || null, hosts, guests, stats, warnings };
}
async function ptr() {
  const c = cfg().ptr;
  if (!c || !c.url || !c.key) throw new Error('Portainer ist nicht vollständig konfiguriert.');
  const g = p => call(c.url, p, { 'X-API-Key': c.key }, c.insecure);
  const eps = await g('/api/endpoints');
  const envs = await Promise.all(eps.map(async e => {
    const o = { id: e.Id, name: e.Name, url: e.URL || '', pub: e.PublicURL || '', containers: [] };
    try {
      const [cs, nets] = await Promise.all([g(`/api/endpoints/${e.Id}/docker/containers/json?all=true`), g(`/api/endpoints/${e.Id}/docker/networks`).catch(() => [])]);
      const drv = Object.fromEntries(nets.map(n => [n.Name, n.Driver])), isMv = k => /^(macvlan|ipvlan)$/.test(drv[k] || '');
      o.containers = cs.map(ct => {
        const name = (ct.Names[0] || '').replace(/^\//, ''), nn = (ct.NetworkSettings && ct.NetworkSettings.Networks) || {}, mv = Object.keys(nn).find(isMv);
        const mode = (ct.HostConfig && ct.HostConfig.NetworkMode) === 'host' ? 'host' : mv ? 'macvlan' : 'bridge', seen = new Set(), ports = [];
        (ct.Ports || []).forEach(p => { const k = p.PublicPort + ':' + p.PrivatePort + '/' + p.Type; if (p.PublicPort && !seen.has(k)) { seen.add(k); ports.push({ h: String(p.PublicPort), c: String(p.PrivatePort), pr: p.Type }); } });
        return { k: `ptr:${e.Id}:${name}`, name, image: ct.Image, dn: mode, ports, ip: mv ? nn[mv].IPAddress : '' };
      });
    } catch (x) { o.error = x.message; }
    return o;
  }));
  return { envs };
}
function api(q, r) {
  const u = q.url.split('?')[0];
  if (u === '/api/data') {
    if (q.method === 'PUT') {
      let b = ''; q.on('data', c => { b += c; if (b.length > 5e6) q.destroy(); });
      q.on('end', () => {
        const hv = q.headers['x-rev'];
        if (hv && hv !== '*' && hv !== rev()) { r.statusCode = 409; r.end('conflict'); return; }
        try {
          JSON.parse(b); fs.mkdirSync(DATA, { recursive: true }); snap(false);
          if (fs.existsSync(F)) fs.copyFileSync(F, F + '.bak');
          fs.writeFileSync(F + '.tmp', b); fs.renameSync(F + '.tmp', F);
          r.setHeader('x-rev', rev()); r.end('ok');
        } catch (e) { r.statusCode = 400; r.end('bad'); }
      });
      return true;
    }
    r.setHeader('x-rev', rev()); r.setHeader('content-type', 'application/json'); r.end(fs.existsSync(F) ? fs.readFileSync(F) : 'null'); return true;
  }
  if (u === '/api/history') {
    let l = []; try { l = fs.readdirSync(HD).filter(f => f.endsWith('.json')).sort().reverse().map(n => ({ name: n, time: n.slice(0, -5).replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/, 'T$1:$2:$3.$4Z'), size: fs.statSync(path.join(HD, n)).size })); } catch (e) {}
    json(r, l); return true;
  }
  if (u.startsWith('/api/history/')) {
    const n = decodeURIComponent(u.slice(13));
    if (!/^[\w.-]+\.json$/.test(n) || !fs.existsSync(path.join(HD, n))) { json(r, { error: 'nicht gefunden' }, 404); return true; }
    r.setHeader('content-type', 'application/json'); r.end(fs.readFileSync(path.join(HD, n))); return true;
  }
  if (u === '/api/snapshot' && q.method === 'POST') { snap(true); json(r, { ok: 1 }); return true; }
  if (u === '/api/integrations') {
    if (q.method === 'POST') {
      let b = ''; q.on('data', c => b += c);
      q.on('end', () => {
        try {
          const n = JSON.parse(b), c = cfg();
          if (n.pve === null) delete c.pve; if (n.ptr === null) delete c.ptr; if (n.pve) { const o = c.pve || {}; c.pve = { url: (n.pve.url || '').replace(/\/$/, ''), tokenId: n.pve.tokenId || '', secret: n.pve.secret || o.secret || '', insecure: !!n.pve.insecure }; }
          if (n.ptr) { const o = c.ptr || {}; c.ptr = { url: (n.ptr.url || '').replace(/\/$/, ''), key: n.ptr.key || o.key || '', insecure: !!n.ptr.insecure }; }
          fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(CF, JSON.stringify(c), { mode: 0o600 }); json(r, { ok: 1 });
        } catch (e) { json(r, { error: 'bad' }, 400); }
      });
      return true;
    }
    const c = cfg();
    json(r, { pve: c.pve ? { url: c.pve.url, tokenId: c.pve.tokenId, hasSecret: !!c.pve.secret, insecure: c.pve.insecure } : null, ptr: c.ptr ? { url: c.ptr.url, hasKey: !!c.ptr.key, insecure: c.ptr.insecure } : null });
    return true;
  }
  if (u === '/api/import/proxmox' || u === '/api/import/portainer') {
    (u.endsWith('proxmox') ? pve() : ptr()).then(x => json(r, x)).catch(e => json(r, { error: e.message }, 502));
    return true;
  }
  return false;
}
http.createServer((q, r) => {
  if (api(q, r)) return;
  if (q.url === '/api/status') { status().then(x => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(x)); }); return; }
  const st = ['/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];
  if (st.includes(q.url)) {
    const f = path.join(__dirname, q.url.slice(1));
    if (fs.existsSync(f)) {
      r.setHeader('content-type', { '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }[path.extname(f)]);
      r.setHeader('cache-control', 'public, max-age=86400'); r.end(fs.readFileSync(f)); return;
    }
  }
  if (q.url === '/api/data') {
    if (q.method === 'PUT') {
      let b = ''; q.on('data', c => { b += c; if (b.length > 5e6) q.destroy(); });
      q.on('end', () => {
        try {
          JSON.parse(b); fs.mkdirSync(path.dirname(F), { recursive: true });
          if (fs.existsSync(F)) fs.copyFileSync(F, F + '.bak');
          fs.writeFileSync(F + '.tmp', b); fs.renameSync(F + '.tmp', F); r.end('ok');
        } catch (e) { r.statusCode = 400; r.end('bad'); }
      });
      return;
    }
    r.setHeader('content-type', 'application/json'); r.end(fs.existsSync(F) ? fs.readFileSync(F) : 'null'); return;
  }
  r.setHeader('content-type', 'text/html;charset=utf-8'); r.end(fs.readFileSync(path.join(__dirname, 'index.html')));
}).listen(process.env.PORT || 8080, () => console.log('Homelab-Doku läuft auf Port ' + (process.env.PORT || 8080)));
