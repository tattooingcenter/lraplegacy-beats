// L RAP LEGACY BEATS v2 — membership beats + multi-uploader (approval) + Stripe
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const multer = require('multer');
const ffmpegPath = require('ffmpeg-static');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ---- config ----
const SECRET = process.env.STRIPE_SECRET_KEY || '';
const PUBLISHABLE = process.env.STRIPE_PUBLISHABLE_KEY || '';
const APP_SECRET = process.env.APP_SECRET || 'dev-only-change-me';
// Region-based pricing: Japan pays JPY 2,980 / month; overseas pays USD 40 (~JPY 6,000) / month.
const PRICES = {
  jp:   { lookup: 'lraplegacy_monthly_2980',   unit_amount: 2980, currency: 'jpy', display: '¥2,980',
          name: 'L RAP LEGACY BEATS 会員', desc: '日本語対応・ビート使い放題の月額メンバーシップ' },
  intl: { lookup: 'lraplegacy_monthly_usd_40', unit_amount: 4000, currency: 'usd', display: '$40',
          name: 'L RAP LEGACY BEATS — Membership', desc: 'Unlimited beats. Monthly membership. Commercial use OK.' },
};
const DEV_FAKE = process.env.DEV_FAKE_STRIPE === '1';
const stripe = SECRET ? require('stripe')(SECRET, { apiVersion: '2025-03-31.basil' }) : null;

const UPLOAD_PASSWORD = process.env.UPLOAD_PASSWORD || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
// In-house producer names selectable at upload time (temporary until per-user logins).
const PRODUCERS = (process.env.PRODUCERS || '京極,BlankO,baby,だいちん').split(',').map(s => s.trim()).filter(Boolean);

// Supabase (prod). If unset, fall back to local disk (dev/test).
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
}
const BEATS_BUCKET = 'beats';
const PREVIEWS_BUCKET = 'previews';
const DATA_DIR = path.join(__dirname, 'data');
const LOCAL_DB = path.join(DATA_DIR, 'beats.json');

// ---- signed cookie helpers ----
function signObj(obj) {
  const payload = Buffer.from(JSON.stringify({ ...obj, exp: Date.now() + 30 * 864e5 })).toString('base64url');
  const mac = crypto.createHmac('sha256', APP_SECRET).update(payload).digest('base64url');
  return payload + '.' + mac;
}
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, mac] = token.split('.');
  if (crypto.createHmac('sha256', APP_SECRET).update(payload).digest('base64url') !== mac) return null;
  try { const d = JSON.parse(Buffer.from(payload, 'base64url').toString()); return d.exp < Date.now() ? null : d; }
  catch { return null; }
}
function setCookie(res, name, obj) {
  res.setHeader('Set-Cookie', `${name}=${signObj(obj)}; HttpOnly; Path=/; Max-Age=${30 * 86400}; SameSite=Lax`);
}
function readCookie(req, name) {
  const hit = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}
const currentMember = req => verifyToken(readCookie(req, 'lrl_member'));
const currentStaff = req => verifyToken(readCookie(req, 'lrl_staff'));

// ---- login throttling (per IP, in-memory) ----
const _attempts = new Map();
function throttle(req, res, key, maxPerMin = 8) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
  const now = Date.now();
  const id = key + ':' + ip;
  const arr = (_attempts.get(id) || []).filter(t => now - t < 60000);
  arr.push(now);
  _attempts.set(id, arr);
  if (arr.length > maxPerMin) { res.status(429).json({ error: '試行回数が多すぎます。少し時間をおいてからお試しください。 / Too many attempts. Please try again later.' }); return false; }
  return true;
}

// ---- DB abstraction (Supabase table `beats` OR local json) ----
function localReadDB() { try { return JSON.parse(fs.readFileSync(LOCAL_DB, 'utf8')); } catch { return []; } }
function localWriteDB(rows) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(LOCAL_DB, JSON.stringify(rows, null, 2)); }
async function dbList(status) {
  if (supabase) {
    let q = supabase.from('beats').select('*').order('created_at', { ascending: false });
    if (status) q = q.eq('status', status);
    const { data, error } = await q; if (error) throw error; return data;
  }
  let rows = localReadDB(); if (status) rows = rows.filter(r => r.status === status);
  return rows.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}
async function dbGet(id) {
  if (supabase) { const { data } = await supabase.from('beats').select('*').eq('id', id).single(); return data || null; }
  return localReadDB().find(r => r.id === id) || null;
}
async function dbInsert(row) {
  if (supabase) { const { data, error } = await supabase.from('beats').insert(row).select().single(); if (error) throw error; return data; }
  const rows = localReadDB(); rows.push(row); localWriteDB(rows); return row;
}
async function dbUpdate(id, patch) {
  if (supabase) { const { error } = await supabase.from('beats').update(patch).eq('id', id); if (error) throw error; return; }
  localWriteDB(localReadDB().map(r => r.id === id ? { ...r, ...patch } : r));
}
async function dbDelete(id) {
  if (supabase) { await supabase.from('beats').delete().eq('id', id); return; }
  localWriteDB(localReadDB().filter(r => r.id !== id));
}

// ---- storage abstraction ----
async function ensureBuckets() {
  if (!supabase) { fs.mkdirSync(path.join(DATA_DIR, 'beats'), { recursive: true }); fs.mkdirSync(path.join(DATA_DIR, 'previews'), { recursive: true }); return; }
  try { await supabase.storage.createBucket(BEATS_BUCKET, { public: false }); } catch (e) {}
  try { await supabase.storage.createBucket(PREVIEWS_BUCKET, { public: true }); } catch (e) {}
}
async function putBeat(id, buffer) {
  if (supabase) { const { error } = await supabase.storage.from(BEATS_BUCKET).upload(`${id}.mp3`, buffer, { contentType: 'audio/mpeg', upsert: true }); if (error) throw error; return; }
  fs.mkdirSync(path.join(DATA_DIR, 'beats'), { recursive: true }); fs.writeFileSync(path.join(DATA_DIR, 'beats', `${id}.mp3`), buffer);
}
async function putPreview(id, buffer) {
  if (supabase) { const { error } = await supabase.storage.from(PREVIEWS_BUCKET).upload(`${id}.mp3`, buffer, { contentType: 'audio/mpeg', upsert: true }); if (error) throw error; return; }
  fs.mkdirSync(path.join(DATA_DIR, 'previews'), { recursive: true }); fs.writeFileSync(path.join(DATA_DIR, 'previews', `${id}.mp3`), buffer);
}
async function removeFiles(id) {
  if (supabase) { try { await supabase.storage.from(BEATS_BUCKET).remove([`${id}.mp3`]); } catch (e) {} try { await supabase.storage.from(PREVIEWS_BUCKET).remove([`${id}.mp3`]); } catch (e) {} return; }
  try { fs.unlinkSync(path.join(DATA_DIR, 'beats', `${id}.mp3`)); } catch (e) {}
  try { fs.unlinkSync(path.join(DATA_DIR, 'previews', `${id}.mp3`)); } catch (e) {}
}

// ---- 7s preview via bundled ffmpeg ----
function makePreview(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-y', '-i', inputPath, '-t', '7', '-af', 'afade=t=out:st=5.5:d=1.5', '-codec:a', 'libmp3lame', '-b:a', '128k', outputPath],
      (err) => err ? reject(err) : resolve());
  });
}

// ---- Stripe helpers ----
const _priceCache = {};
async function getPriceId(region) {
  const cfg = PRICES[region] || PRICES.jp;
  if (DEV_FAKE) return 'price_dev_fake_' + (region || 'jp');
  if (_priceCache[region]) return _priceCache[region];
  const found = await stripe.prices.list({ lookup_keys: [cfg.lookup], active: true, limit: 1 });
  if (found.data.length) { _priceCache[region] = found.data[0].id; return found.data[0].id; }
  const product = await stripe.products.create({ name: cfg.name, description: cfg.desc, tax_code: 'txcd_10000000' });
  const price = await stripe.prices.create({ product: product.id, unit_amount: cfg.unit_amount, currency: cfg.currency, recurring: { interval: 'month' }, lookup_key: cfg.lookup });
  _priceCache[region] = price.id; return price.id;
}
// Domestic (Japan) vs overseas, based on the browser's Accept-Language.
function regionFromReq(req) {
  return (req.headers['accept-language'] || '').trim().toLowerCase().startsWith('ja') ? 'jp' : 'intl';
}
async function hasActiveSub(email) {
  if (DEV_FAKE) return true;
  const customers = await stripe.customers.list({ email, limit: 10 });
  for (const c of customers.data) {
    for (const st of ['active', 'trialing']) {
      const subs = await stripe.subscriptions.list({ customer: c.id, status: st, limit: 1 });
      if (subs.data.length) return true;
    }
  }
  return false;
}
const baseUrl = req => process.env.BASE_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers.host}`;

// ================= public catalog / playback =================
app.get('/api/config', (req, res) => {
  const region = regionFromReq(req);
  res.json({ publishableKey: PUBLISHABLE, region, priceDisplay: PRICES[region].display });
});
app.get('/api/me', (req, res) => { const m = currentMember(req); res.json({ member: !!m, email: m ? m.email : null }); });

app.get('/api/catalog', async (req, res) => {
  try {
    const rows = await dbList('published');
    res.json(rows.map(b => ({ id: b.id, title: b.title, genre: b.genre, bpm: b.bpm, key: b.key, type_beat: b.type_beat || null })));
  } catch (e) { console.error('catalog:', e.message); res.status(500).json([]); }
});

// Distinct list of "type beat" reference names already in use (for the upload form).
app.get('/api/typebeats', async (req, res) => {
  try {
    const rows = await dbList();
    const seen = new Set();
    for (const b of rows) { const v = (b.type_beat || '').trim(); if (v) seen.add(v); }
    res.json([...seen].sort((a, b) => a.localeCompare(b)));
  } catch (e) { console.error('typebeats:', e.message); res.status(500).json([]); }
});

app.get('/api/preview/:id', async (req, res) => {
  try {
    const b = await dbGet(req.params.id); if (!b || b.status !== 'published') return res.status(404).send('nf');
    if (supabase) { const { data } = supabase.storage.from(PREVIEWS_BUCKET).getPublicUrl(`${b.id}.mp3`); return res.redirect(data.publicUrl); }
    return res.sendFile(path.join(DATA_DIR, 'previews', `${b.id}.mp3`));
  } catch (e) { res.status(500).send('err'); }
});

async function serveFull(req, res, asDownload) {
  const m = currentMember(req); if (!m) return res.status(401).send('会員限定です');
  try { if (!DEV_FAKE && !(await hasActiveSub(m.email))) return res.status(403).send('会員が有効ではありません'); }
  catch (e) { console.error('recheck:', e.message); }
  const b = await dbGet(req.params.id); if (!b || b.status !== 'published') return res.status(404).send('nf');
  if (supabase) {
    const opts = asDownload ? { download: `${(b.title || b.id)}.mp3` } : {};
    const { data, error } = await supabase.storage.from(BEATS_BUCKET).createSignedUrl(`${b.id}.mp3`, 60, opts);
    if (error) return res.status(500).send('err'); return res.redirect(data.signedUrl);
  }
  const file = path.join(DATA_DIR, 'beats', `${b.id}.mp3`);
  if (asDownload) res.setHeader('Content-Disposition', `attachment; filename="${b.id}.mp3"`);
  res.setHeader('Content-Type', 'audio/mpeg'); fs.createReadStream(file).pipe(res);
}
app.get('/api/stream/:id', (req, res) => serveFull(req, res, false));
app.get('/api/download/:id', (req, res) => serveFull(req, res, true));

// ================= Stripe checkout / member login =================
app.post('/api/checkout', async (req, res) => {
  try {
    if (DEV_FAKE) { setCookie(res, 'lrl_member', { email: 'devtester@example.com' }); return res.json({ url: baseUrl(req) + '/success?dev=1' }); }
    const price = await getPriceId(regionFromReq(req));
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription', line_items: [{ price, quantity: 1 }], allow_promotion_codes: true, locale: 'auto',
      success_url: baseUrl(req) + '/success?session_id={CHECKOUT_SESSION_ID}', cancel_url: baseUrl(req) + '/?canceled=1',
    });
    res.json({ url: session.url });
  } catch (e) { console.error('checkout:', e.message); res.status(500).json({ error: e.message }); }
});
app.get('/success', async (req, res) => {
  try {
    if (DEV_FAKE) { setCookie(res, 'lrl_member', { email: 'devtester@example.com' }); return res.redirect('/?member=1'); }
    const s = await stripe.checkout.sessions.retrieve(req.query.session_id, { expand: ['customer', 'subscription'] });
    const email = (s.customer_details && s.customer_details.email) || (s.customer && s.customer.email);
    const paid = s.status === 'complete' || (s.subscription && ['active', 'trialing'].includes(s.subscription.status));
    if (email && paid) { setCookie(res, 'lrl_member', { email }); return res.redirect('/?member=1'); }
    res.redirect('/?error=notpaid');
  } catch (e) { console.error('success:', e.message); res.redirect('/?error=1'); }
});
app.post('/api/login', async (req, res) => {
  try {
    if (!throttle(req, res, 'login')) return;
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'メールを入力してください' });
    if (await hasActiveSub(email)) { setCookie(res, 'lrl_member', { email }); return res.json({ ok: true }); }
    res.status(403).json({ error: 'この メールで有効な会員が見つかりませんでした' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/logout', (req, res) => { res.setHeader('Set-Cookie', 'lrl_member=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax'); res.redirect('/'); });

// ================= staff (uploader / admin) =================
app.post('/api/staff-login', (req, res) => {
  if (!throttle(req, res, 'staff')) return;
  const pw = (req.body.password || '');
  const name = (req.body.name || '').trim().slice(0, 40);
  if (ADMIN_PASSWORD && pw === ADMIN_PASSWORD) { setCookie(res, 'lrl_staff', { role: 'admin', name: name || 'admin' }); return res.json({ ok: true, role: 'admin' }); }
  if (UPLOAD_PASSWORD && pw === UPLOAD_PASSWORD) { setCookie(res, 'lrl_staff', { role: 'uploader', name: name || 'producer' }); return res.json({ ok: true, role: 'uploader' }); }
  res.status(403).json({ error: '合言葉が違います' });
});
app.get('/api/staff-me', (req, res) => { const s = currentStaff(req); res.json({ staff: !!s, role: s ? s.role : null, name: s ? s.name : null }); });
app.get('/api/producers', (req, res) => { if (!currentStaff(req)) return res.status(401).json([]); res.json(PRODUCERS); });
app.get('/staff-logout', (req, res) => { res.setHeader('Set-Cookie', 'lrl_staff=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax'); res.redirect('/upload.html'); });

app.post('/api/upload', upload.single('beat'), async (req, res) => {
  const s = currentStaff(req);
  if (!s) return res.status(401).json({ error: 'ログインしてください' });
  if (!req.file) return res.status(400).json({ error: 'mp3ファイルを選んでください' });
  const title = (req.body.title || '').trim(); if (!title) return res.status(400).json({ error: 'タイトルを入力してください' });
  const pickedUploader = (req.body.uploader || '').trim();
  const uploader = PRODUCERS.includes(pickedUploader) ? pickedUploader : s.name;
  const id = crypto.randomUUID();
  const tmpIn = path.join(os.tmpdir(), id + '.mp3');
  const tmpPrev = path.join(os.tmpdir(), id + '_p.mp3');
  try {
    fs.writeFileSync(tmpIn, req.file.buffer);
    await makePreview(tmpIn, tmpPrev);
    await putBeat(id, req.file.buffer);
    await putPreview(id, fs.readFileSync(tmpPrev));
    const row = {
      id, title, genre: (req.body.genre || '').trim() || null,
      bpm: req.body.bpm ? parseInt(req.body.bpm, 10) : null, key: (req.body.key || '').trim() || null,
      type_beat: (req.body.type_beat || '').trim().slice(0, 60) || null,
      file_path: `${id}.mp3`, preview_path: `${id}.mp3`,
      uploader, status: 'pending', created_at: new Date().toISOString(),
    };
    await dbInsert(row);
    res.json({ ok: true });
  } catch (e) { console.error('upload:', e.message); res.status(500).json({ error: e.message }); }
  finally { try { fs.unlinkSync(tmpIn); } catch (e) {} try { fs.unlinkSync(tmpPrev); } catch (e) {} }
});

function requireAdmin(req, res) { const s = currentStaff(req); if (!s || s.role !== 'admin') { res.status(403).json({ error: '管理者のみ' }); return null; } return s; }
app.get('/api/pending', async (req, res) => { if (!requireAdmin(req, res)) return; try { res.json(await dbList('pending')); } catch (e) { res.status(500).json([]); } });
app.get('/api/all', async (req, res) => { if (!requireAdmin(req, res)) return; try { res.json(await dbList()); } catch (e) { res.status(500).json([]); } });
app.post('/api/approve', async (req, res) => { if (!requireAdmin(req, res)) return; try { await dbUpdate(req.body.id, { status: 'published' }); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/reject', async (req, res) => { if (!requireAdmin(req, res)) return; try { await removeFiles(req.body.id); await dbDelete(req.body.id); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
// admin can also preview a pending beat's clip
app.get('/api/pending-preview/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const b = await dbGet(req.params.id); if (!b) return res.status(404).send('nf');
  if (supabase) { const { data } = supabase.storage.from(PREVIEWS_BUCKET).getPublicUrl(`${b.id}.mp3`); return res.redirect(data.publicUrl); }
  return res.sendFile(path.join(DATA_DIR, 'previews', `${b.id}.mp3`));
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
ensureBuckets().finally(() => app.listen(PORT, () => console.log(`L RAP LEGACY BEATS v2 on ${PORT} (supabase=${!!supabase}, devfake=${DEV_FAKE})`)));
