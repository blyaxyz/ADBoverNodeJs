import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import { execa } from 'execa';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import multer from 'multer';
import archiver from 'archiver';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const PORT = process.env.PORT || 8080;
const ADB = process.env.ADB_PATH && process.env.ADB_PATH.trim() ? process.env.ADB_PATH.trim() : 'adb';

async function adbCmd(args, opts = {}) {
  try {
    const { stdout } = await execa(ADB, args, opts);
    return { ok: true, stdout };
  } catch (e) {
    return { ok: false, error: e.shortMessage || e.message, code: e.exitCode, stdout: e.stdout, stderr: e.stderr };
  }
}

function parseDevicesList(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const list = [];
  for (const l of lines) {
    if (l.startsWith('List of devices attached')) continue;
    const [serial, state, ...rest] = l.split(/\s+/);
    if (!serial || !state) continue;
    const info = { serial, state };
    const infoStr = rest.join(' ');
    for (const m of infoStr.split(/\s+/)) {
      const [k, v] = m.split(':');
      if (v) info[k] = v;
    }
    list.push(info);
  }
  return list;
}

// ---------- File uploads (push/install) ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      const base = crypto.randomBytes(8).toString('hex');
      cb(null, base + ext);
    }
  }),
  limits: { fileSize: 1024 * 1024 * 1024 } // 1 GB
});

// ---------- API ----------
app.get('/api/version', async (req, res) => {
  const r = await adbCmd(['version']);
  if (!r.ok) return res.status(500).json({ ok: false, error: r.error, stderr: r.stderr });
  res.json({ ok: true, version: r.stdout.trim() });
});

app.get('/api/devices', async (req, res) => {
  const r = await adbCmd(['devices', '-l']);
  if (!r.ok) return res.status(500).json({ ok: false, error: r.error, stderr: r.stderr });
  res.json({ ok: true, devices: parseDevicesList(r.stdout) });
});

app.get('/api/ip', async (req, res) => {
  const serial = req.query.serial;
  if (!serial) return res.status(400).json({ ok: false, error: 'serial required' });
  const r = await adbCmd(['-s', serial, 'shell', 'ip', '-o', 'addr', 'show', 'up', 'scope', 'global']);
  if (!r.ok) return res.status(500).json({ ok: false, error: r.error, stderr: r.stderr });
  const ips = Array.from(r.stdout.matchAll(/\binet\s+(\d+\.\d+\.\d+\.\d+)\/(\d+)/g)).map(m => m[1]);
  res.json({ ok: true, stdout: r.stdout, ipv4: ips });
});

app.post('/api/tcpip', async (req, res) => {
  const { serial, port } = req.body || {};
  if (!serial) return res.status(400).json({ ok: false, error: 'serial required' });
  const p = Number(port) || 5555;
  if (p < 1024 || p > 65535) return res.status(400).json({ ok: false, error: 'invalid port' });
  const r = await adbCmd(['-s', serial, 'tcpip', String(p)]);
  if (!r.ok) return res.status(500).json({ ok: false, error: r.error, stderr: r.stderr });
  res.json({ ok: true, stdout: r.stdout });
});

// PUSH
app.post('/api/push', upload.single('file'), async (req, res) => {
  const { serial, remote } = req.body || {};
  if (!serial) return res.status(400).json({ ok: false, error: 'serial required' });
  if (!req.file) return res.status(400).json({ ok: false, error: 'file required' });
  if (!remote) return res.status(400).json({ ok: false, error: 'remote path required' });

  const tmp = req.file.path;
  try {
    const r = await adbCmd(['-s', serial, 'push', tmp, remote]);
    if (!r.ok) return res.status(500).json({ ok: false, error: r.error, stderr: r.stderr });
    res.json({ ok: true, stdout: r.stdout });
  } finally {
    fs.unlink(tmp, () => {});
  }
});

// INSTALL
app.post('/api/install', upload.single('apk'), async (req, res) => {
  const { serial, reinstall, grant, downgrade } = req.body || {};
  if (!serial) return res.status(400).json({ ok: false, error: 'serial required' });
  if (!req.file) return res.status(400).json({ ok: false, error: 'apk file required' });
  const tmp = req.file.path;
  const args = ['-s', serial, 'install'];
  if (reinstall === 'true') args.push('-r');
  if (grant === 'true') args.push('-g');
  if (downgrade === 'true') args.push('-d');
  args.push(tmp);

  try {
    const r = await adbCmd(args, { timeout: 10 * 60 * 1000 });
    if (!r.ok) return res.status(500).json({ ok: false, error: r.error, stderr: r.stderr, stdout: r.stdout });
    res.json({ ok: true, stdout: r.stdout });
  } finally {
    fs.unlink(tmp, () => {});
  }
});

// SHELL
app.post('/api/shell', async (req, res) => {
  const { serial, cmd, timeoutMs } = req.body || {};
  if (!serial) return res.status(400).json({ ok: false, error: 'serial required' });
  if (!cmd || typeof cmd !== 'string') return res.status(400).json({ ok: false, error: 'cmd required' });
  const r = await adbCmd(['-s', serial, 'shell', cmd], { timeout: Math.min(Number(timeoutMs) || 30000, 5*60*1000) });
  if (!r.ok) return res.status(500).json({ ok: false, error: r.error, stderr: r.stderr, stdout: r.stdout });
  res.json({ ok: true, stdout: r.stdout, stderr: r.stderr });
});

// LOGCAT (SSE)
app.get('/api/logcat', async (req, res) => {
  const serial = req.query.serial;
  const filter = req.query.filter;
  if (!serial) return res.status(400).end('serial required');

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const args = ['-s', serial, 'logcat', '-v', 'time'];
  if (filter) args.push(...filter.split(' ').filter(Boolean));
  const child = execa(ADB, args);
  const send = (line) => res.write(`data: ${line.replace(/\r?\n/g, '\n')}\n\n`);

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    const lines = String(chunk).split(/\r?\n/);
    for (const ln of lines) if (ln) send(ln);
  });
  child.stderr.on('data', chunk => {
    const lines = String(chunk).split(/\r?\n/);
    for (const ln of lines) if (ln) send('[stderr] ' + ln);
  });

  const onClose = () => {
    child.kill('SIGTERM', { forceKillAfterTimeout: 2000 });
    res.end();
  };
  req.on('close', onClose);
});

// ADB server control (for WebUSB fallback use)
app.post('/api/adb/kill-server', async (req, res) => {
  const r = await adbCmd(['kill-server']);
  res.json({ ok: r.ok, stdout: r.stdout, stderr: r.stderr, error: r.error });
});

app.post('/api/adb/start-server', async (req, res) => {
  const r = await adbCmd(['start-server']);
  res.json({ ok: r.ok, stdout: r.stdout, stderr: r.stderr, error: r.error });
});

// Packages management
function parsePackageList(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^package:([\w.]+)(?:=.*)?$/);
    if (m) out.push({ package: m[1] });
  }
  return out;
}
function parseDumpsysPackage(text) {
  const get = (re, d='') => (text.match(re)||[])[1] || d;
  const versionName = get(/versionName=([\w.\-+]+)/);
  const versionCode = get(/versionCode=(\d+)/);
  const appId = get(/appId=(\d+)/);
  const userId = get(/userId=(\d+)/);
  const enabled = /enabled=true|pkgFlags=\[.*?HAS_CODE.*?\]/.test(text) ? true :
                  /enabled=false/.test(text) ? false : null;
  let requested = [];
  const reqMatch = text.match(/requested permissions:\s*([\s\S]*?)\n\n/);
  if (reqMatch) {
    requested = reqMatch[1].split(/\r?\n/).map(s=>s.trim()).filter(s=>s && !s.includes('granted=true'));
  }
  let granted = [];
  const grMatch = text.match(/grantedPermissions:\s*([\s\S]*?)\n\n/);
  if (grMatch) {
    granted = grMatch[1].split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  }
  return { versionName, versionCode, appId, userId, enabled, requested, granted };
}

app.get('/api/packages', async (req, res) => {
  const serial = req.query.serial;
  const type = (req.query.type || 'user').toLowerCase();
  if (!serial) return res.status(400).json({ ok: false, error: 'serial required' });
  const args = ['-s', serial, 'shell', 'pm', 'list', 'packages'];
  if (type === 'user') args.push('-3');
  else if (type === 'system') args.push('-s');
  const r = await adbCmd(args);
  if (!r.ok) return res.status(500).json({ ok: false, error: r.error, stderr: r.stderr });
  res.json({ ok: true, packages: parsePackageList(r.stdout) });
});

app.get('/api/package', async (req, res) => {
  const serial = req.query.serial;
  const pkg = req.query.pkg;
  if (!serial || !pkg) return res.status(400).json({ ok: false, error: 'serial and pkg required' });
  const r = await adbCmd(['-s', serial, 'shell', 'dumpsys', 'package', pkg]);
  if (!r.ok) return res.status(500).json({ ok: false, error: r.error, stderr: r.stderr, stdout: r.stdout });
  res.json({ ok: true, pkg, details: parseDumpsysPackage(r.stdout) });
});

app.post('/api/package/uninstall', async (req, res) => {
  const { serial, pkg, user0only } = req.body || {};
  if (!serial || !pkg) return res.status(400).json({ ok: false, error: 'serial and pkg required' });
  const args = user0only ? ['-s', serial, 'shell', 'pm', 'uninstall', '--user', '0', pkg] : ['-s', serial, 'uninstall', pkg];
  const r = await adbCmd(args);
  if (!r.ok) return res.status(500).json({ ok: false, error: r.error, stderr: r.stderr, stdout: r.stdout });
  res.json({ ok: true, stdout: r.stdout });
});

app.post('/api/package/disable', async (req, res) => {
  const { serial, pkg } = req.body || {};
  if (!serial || !pkg) return res.status(400).json({ ok: false, error: 'serial and pkg required' });
  const r = await adbCmd(['-s', serial, 'shell', 'pm', 'disable-user', '--user', '0', pkg]);
  if (!r.ok) return res.status(500).json({ ok: false, error: r.error, stderr: r.stderr, stdout: r.stdout });
  res.json({ ok: true, stdout: r.stdout });
});

app.post('/api/package/enable', async (req, res) => {
  const { serial, pkg } = req.body || {};
  if (!serial || !pkg) return res.status(400).json({ ok: false, error: 'serial and pkg required' });
  const r = await adbCmd(['-s', serial, 'shell', 'pm', 'enable', pkg]);
  if (!r.ok) return res.status(500).json({ ok: false, error: r.error, stderr: r.stderr, stdout: r.stdout });
  res.json({ ok: true, stdout: r.stdout });
});

app.post('/api/package/grant', async (req, res) => {
  const { serial, pkg, permission } = req.body || {};
  if (!serial || !pkg || !permission) return res.status(400).json({ ok: false, error: 'serial, pkg, permission required' });
  const r = await adbCmd(['-s', serial, 'shell', 'pm', 'grant', pkg, permission]);
  if (!r.ok) return res.status(500).json({ ok: false, error: r.error, stderr: r.stderr, stdout: r.stdout });
  res.json({ ok: true, stdout: r.stdout });
});

app.post('/api/package/revoke', async (req, res) => {
  const { serial, pkg, permission } = req.body || {};
  if (!serial || !pkg || !permission) return res.status(400).json({ ok: false, error: 'serial, pkg, permission required' });
  const r = await adbCmd(['-s', serial, 'shell', 'pm', 'revoke', pkg, permission]);
  if (!r.ok) return res.status(500).json({ ok: false, error: r.error, stderr: r.stderr, stdout: r.stdout });
  res.json({ ok: true, stdout: r.stdout });
});



// Download APK (base or all splits)
app.get('/api/package/apk', async (req, res) => {
  const serial = req.query.serial;
  const pkg = req.query.pkg;
  const type = (req.query.type || 'base').toLowerCase(); // base|all
  if (!serial || !pkg) return res.status(400).json({ ok: false, error: 'serial and pkg required' });

  // 1) Discover paths via pm path
  const r = await adbCmd(['-s', serial, 'shell', 'pm', 'path', pkg]);
  if (!r.ok) return res.status(500).json({ ok: false, error: r.error, stderr: r.stderr, stdout: r.stdout });

  const lines = r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const paths = [];
  let basePath = null;
  for (const line of lines) {
    const m = line.match(/^(?:package|split):(.+)$/);
    if (m) {
      const pth = m[1];
      if (line.startsWith('package:')) basePath = pth;
      paths.push(pth);
    }
  }
  if (!paths.length) return res.status(404).json({ ok: false, error: 'paths not found' });

  // If only base requested, stream it directly when possible
  if (type === 'base' && basePath) {
    const filename = (pkg.replace(/[^\w.\-+]/g,'_') || 'app') + '.apk';
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const child = execa(ADB, ['-s', serial, 'exec-out', 'cat', basePath]);
    child.stdout.pipe(res);
    child.on('error', (e) => {
      if (!res.headersSent) res.status(500);
      res.end(String(e));
    });
    return;
  }

  // For all splits → pull into temp dir, zip, stream
  const osTmp = os.tmpdir();
  const tmpDir = fs.mkdtempSync(path.join(osTmp, 'apk-pull-'));
  const pulled = [];
  try {
    for (const pth of paths) {
      const name = pth.endsWith('/base.apk') ? 'base.apk' : ('split_' + pth.split('/').pop());
      const dest = path.join(tmpDir, name);
      const pr = await adbCmd(['-s', serial, 'pull', pth, dest], { timeout: 10 * 60 * 1000 });
      if (pr.ok && fs.existsSync(dest)) {
        pulled.push({ path: dest, name });
      } else {
        // skip missing split
      }
    }
    if (!pulled.length && basePath) {
      // fallback: at least try base via exec-out
      const filename = (pkg.replace(/[^\w.\-+]/g,'_') || 'app') + '.apk';
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      const child = execa(ADB, ['-s', serial, 'exec-out', 'cat', basePath]);
      child.stdout.pipe(res);
      child.on('error', (e) => { if (!res.headersSent) res.status(500); res.end(String(e)); });
      return;
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${pkg.replace(/[^\w.\-+]/g,'_')}.apks.zip"`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => { try { res.status(500).end(String(err)); } catch(_){} });
    archive.pipe(res);
    for (const f of pulled) {
      archive.file(f.path, { name: f.name });
    }
    archive.finalize();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message || String(e) });
  } finally {
    // cleanup temp
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {}
  }
});

app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

app.listen(PORT, async () => {
  const v = await adbCmd(['version']);
  if (!v.ok) {
    console.error('[!] adb not available:', v.error);
    console.error('    Install Android platform-tools and ensure `adb` is in PATH, or set ADB_PATH in .env');
  } else {
    console.log('[OK] ' + v.stdout.trim());
  }
  console.log('HTTP on :' + PORT);
  console.log('Open: http://localhost:' + PORT);
});
