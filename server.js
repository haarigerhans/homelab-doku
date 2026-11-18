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
    if (!up && n.url) { try { const u = new URL(n.url); if (okHost(u.hostname)) { known = true; up = await tcp(u.hostname, +u.port || (u.protocol === 'https:' ? 443 : 80)); } } catch (e) {} }
    if (known) out[n.id] = up;
  }));
  cache = { t: Date.now(), v: out }; return out;
}
http.createServer((q, r) => {
  if (q.url === '/api/status') { status().then(x => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(x)); }); return; }
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
