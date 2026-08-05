// L RAP LEGACY BEATS — membership beat site
// Simple, self-contained. Stripe subscription + gated downloads.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---- config ----
const SECRET = process.env.STRIPE_SECRET_KEY || '';
const PUBLISHABLE = process.env.STRIPE_PUBLISHABLE_KEY || '';
const APP_SECRET = process.env.APP_SECRET || 'dev-only-change-me';
const PRICE_JPY = 2980;
const LOOKUP_KEY = 'lraplegacy_monthly_2980';
const DEV_FAKE = process.env.DEV_FAKE_STRIPE === '1'; // local testing without Stripe network
const stripe = SECRET ? require('stripe')(SECRET) : null;

const BEATS_DIR = path.join(__dirname, 'beats');
const catalog = () => JSON.parse(fs.readFileSync(path.join(BEATS_DIR, 'catalog.json'), 'utf8'));

// ---- signed cookie helpers (no extra deps) ----
function sign(email) {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + 30 * 864e5 })).toString('base64url');
  const mac = crypto.createHmac('sha256', APP_SECRET).update(payload).digest('base64url');
  return payload + '.' + mac;
}
function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, mac] = token.split('.');
  const good = crypto.createHmac('sha256', APP_SECRET).update(payload).digest('base64url');
  if (mac !== good) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}
function setMember(res, email) {
  res.setHeader('Set-Cookie', `lrl_member=${sign(email)}; HttpOnly; Path=/; Max-Age=${30 * 86400}; SameSite=Lax`);
}
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}
function currentMember(req) {
  return verify(readCookie(req, 'lrl_member'));
}

// ---- Stripe: ensure the monthly price exists (auto-provision) ----
let cachedPriceId = null;
async function getPriceId() {
  if (DEV_FAKE) return 'price_dev_fake';
  if (cachedPriceId) return cachedPriceId;
  const found = await stripe.prices.list({ lookup_keys: [LOOKUP_KEY], active: true, limit: 1 });
  if (found.data.length) { cachedPriceId = found.data[0].id; return cachedPriceId; }
  const product = await stripe.products.create({
    name: 'L RAP LEGACY BEATS 会員',
    description: '日本語対応・ビート使い放題の月額メンバーシップ',
  });
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: PRICE_JPY,
    currency: 'jpy',
    recurring: { interval: 'month' },
    lookup_key: LOOKUP_KEY,
  });
  cachedPriceId = price.id;
  return cachedPriceId;
}
async function hasActiveSub(email) {
  if (DEV_FAKE) return true;
  const customers = await stripe.customers.list({ email, limit: 10 });
  for (const c of customers.data) {
    const subs = await stripe.subscriptions.list({ customer: c.id, status: 'active', limit: 1 });
    if (subs.data.length) return true;
    const trialing = await stripe.subscriptions.list({ customer: c.id, status: 'trialing', limit: 1 });
    if (trialing.data.length) return true;
  }
  return false;
}
function baseUrl(req) {
  return process.env.BASE_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers.host}`;
}

// ---- routes ----
app.get('/api/config', (req, res) => res.json({ publishableKey: PUBLISHABLE, price: PRICE_JPY }));

app.get('/api/me', (req, res) => {
  const m = currentMember(req);
  res.json({ member: !!m, email: m ? m.email : null });
});

app.get('/api/catalog', (req, res) => res.json(catalog()));

app.post('/api/checkout', async (req, res) => {
  try {
    if (DEV_FAKE) { // simulate: pretend paid, log the user straight in
      setMember(res, 'devtester@example.com');
      return res.json({ url: baseUrl(req) + '/success?dev=1' });
    }
    const price = await getPriceId();
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: baseUrl(req) + '/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: baseUrl(req) + '/?canceled=1',
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('checkout error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/success', async (req, res) => {
  try {
    if (DEV_FAKE) { setMember(res, 'devtester@example.com'); return res.redirect('/?member=1'); }
    const session = await stripe.checkout.sessions.retrieve(req.query.session_id, { expand: ['customer', 'subscription'] });
    const email = (session.customer_details && session.customer_details.email) || (session.customer && session.customer.email);
    const paid = session.status === 'complete' || (session.subscription && ['active', 'trialing'].includes(session.subscription.status));
    if (email && paid) { setMember(res, email); return res.redirect('/?member=1'); }
    res.redirect('/?error=notpaid');
  } catch (e) {
    console.error('success error:', e.message);
    res.redirect('/?error=1');
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'メールを入力してください' });
    if (await hasActiveSub(email)) { setMember(res, email); return res.json({ ok: true }); }
    res.status(403).json({ error: 'この メールで有効な会員が見つかりませんでした' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'lrl_member=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.redirect('/');
});

app.get('/api/download/:id', async (req, res) => {
  const m = currentMember(req);
  if (!m) return res.status(401).send('会員限定です');
  // re-check subscription is still active (safety); fail-open only in DEV
  try {
    if (!DEV_FAKE && !(await hasActiveSub(m.email))) return res.status(403).send('会員が有効ではありません');
  } catch (e) { console.error('sub recheck failed:', e.message); }
  const beat = catalog().find(b => b.id === req.params.id);
  if (!beat) return res.status(404).send('見つかりません');
  const file = path.join(BEATS_DIR, beat.file);
  if (!fs.existsSync(file)) return res.status(404).send('ファイルがありません');
  res.setHeader('Content-Disposition', `attachment; filename="${beat.id}.mp3"`);
  res.setHeader('Content-Type', 'audio/mpeg');
  fs.createReadStream(file).pipe(res);
});

// PUBLIC preview — short clip anyone can hear (to decide to join). No full track exposed.
app.get('/api/preview/:id', (req, res) => {
  const beat = catalog().find(b => b.id === req.params.id);
  if (!beat) return res.status(404).send('nf');
  const file = path.join(BEATS_DIR, 'previews', beat.id + '.mp3');
  if (!fs.existsSync(file)) return res.status(404).send('試聴がありません');
  const stat = fs.statSync(file);
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(file).pipe(res);
});

// FULL stream — members only
app.get('/api/stream/:id', (req, res) => {
  const m = currentMember(req);
  if (!m) return res.status(401).send('会員限定です');
  const beat = catalog().find(b => b.id === req.params.id);
  if (!beat) return res.status(404).send('nf');
  const file = path.join(BEATS_DIR, beat.file);
  const stat = fs.statSync(file);
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(file).pipe(res);
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`L RAP LEGACY BEATS running on ${PORT} (DEV_FAKE=${DEV_FAKE})`));
