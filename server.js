require('dotenv').config({ override: true });
const { serve } = require('@hono/node-server');
const { Hono } = require('hono');
const { serveStatic } = require('@hono/node-server/serve-static');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const MOCK_MODE = !process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === 'your_api_key_here';
const JWT_SECRET = process.env.JWT_SECRET || 'docforge-dev-secret-change-in-prod';
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;

// プラン定義
const PLANS = {
  free:  { limit: 10,  name: 'Free' },
  solo:  { limit: 100, name: 'Solo',     price: 1500 },
  team:  { limit: 1000,name: 'Team',     price: 8000 },
};

let anthropic, stripe;
if (!MOCK_MODE) {
  const Anthropic = require('@anthropic-ai/sdk');
  anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
}
if (STRIPE_SECRET) {
  stripe = require('stripe')(STRIPE_SECRET);
}

const app = new Hono();

// ── ミドルウェア: JWTから現在ユーザーを取得 ──
async function getUser(c) {
  const auth = c.req.header('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return db.findUserById(payload.userId);
  } catch {
    return null;
  }
}

// ── 静的ファイル ──
app.get('/', serveStatic({ path: './public/index.html' }));
app.get('/login', serveStatic({ path: './public/login.html' }));
app.get('/upgrade', serveStatic({ path: './public/upgrade.html' }));

// ── 認証API ──
app.post('/api/auth/signup', async (c) => {
  const { email, password } = await c.req.json();
  if (!email || !password) return c.json({ error: 'メールアドレスとパスワードを入力してください' }, 400);
  if (password.length < 8) return c.json({ error: 'パスワードは8文字以上にしてください' }, 400);
  if (db.findUserByEmail(email)) return c.json({ error: 'このメールアドレスは既に登録されています' }, 409);

  const hashed = await bcrypt.hash(password, 10);
  const user = db.createUser({ id: uuidv4(), email, password: hashed, plan: 'free', createdAt: new Date().toISOString() });
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  return c.json({ token, user: { id: user.id, email: user.email, plan: user.plan } });
});

app.post('/api/auth/login', async (c) => {
  const { email, password } = await c.req.json();
  const user = db.findUserByEmail(email);
  if (!user) return c.json({ error: 'メールアドレスまたはパスワードが正しくありません' }, 401);
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return c.json({ error: 'メールアドレスまたはパスワードが正しくありません' }, 401);
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  return c.json({ token, user: { id: user.id, email: user.email, plan: user.plan } });
});

app.get('/api/auth/me', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const usage = db.getMonthlyUsage(user.id);
  const plan = PLANS[user.plan] || PLANS.free;
  return c.json({ user: { id: user.id, email: user.email, plan: user.plan }, usage, limit: plan.limit });
});

// ── ドキュメント生成API ──
app.post('/api/generate', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'ログインが必要です', code: 'UNAUTHORIZED' }, 401);

  const plan = PLANS[user.plan] || PLANS.free;
  const usage = db.getMonthlyUsage(user.id);
  if (usage >= plan.limit) {
    return c.json({ error: `今月の利用上限（${plan.limit}回）に達しました`, code: 'LIMIT_EXCEEDED', usage, limit: plan.limit }, 429);
  }

  const { code, docType } = await c.req.json();
  if (!code || !code.trim()) return c.json({ error: 'コードを入力してください' }, 400);
  if (code.length > 20000) return c.json({ error: 'コードが長すぎます（20,000文字以内）' }, 400);

  const prompts = {
    readme: `あなたは優秀なテクニカルライターです。以下のコードを解析し、日本語のREADMEを生成してください。\n\n含める内容:\n- プロジェクト概要（2〜3文）\n- 主な機能\n- インストール方法\n- 使い方（コード例付き）\n- 動作要件\n\nマークダウン形式で出力してください。\n\nコード:\n\`\`\`\n${code}\n\`\`\``,
    functions: `あなたは優秀なテクニカルライターです。以下のコードに含まれる関数・メソッドを解析し、日本語の仕様書を生成してください。\n\n各関数について:\n- 関数名と概要\n- 引数（名前・型・説明）\n- 戻り値（型・説明）\n- 使用例\n\nマークダウン形式で出力してください。\n\nコード:\n\`\`\`\n${code}\n\`\`\``,
    api: `あなたは優秀なテクニカルライターです。以下のコードを解析し、日本語のAPI仕様書を生成してください。\n\n含める内容:\n- エンドポイント一覧\n- 各エンドポイントのHTTPメソッド・パス・説明\n- リクエストパラメータ（型・必須/任意・説明）\n- レスポンス形式（例付き）\n- エラーレスポンス\n\nマークダウン形式で出力してください。\n\nコード:\n\`\`\`\n${code}\n\`\`\``,
  };

  if (MOCK_MODE) {
    await new Promise(r => setTimeout(r, 1000));
    db.incrementUsage(user.id);
    const newUsage = db.getMonthlyUsage(user.id);
    return c.json({
      content: `# モック生成ドキュメント\n\n> ⚠️ モックモードです。APIキーを設定すると実際のAIが生成します。\n\n入力コード文字数: ${code.length}文字\nドキュメント種類: ${docType}`,
      usage: newUsage,
      limit: plan.limit,
      mock: true
    });
  }

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompts[docType] || prompts.readme }],
    });
    db.incrementUsage(user.id);
    const newUsage = db.getMonthlyUsage(user.id);
    return c.json({ content: message.content[0].text, usage: newUsage, limit: plan.limit });
  } catch (err) {
    console.error('Claude API error:', err.message);
    return c.json({ error: 'ドキュメント生成に失敗しました' }, 500);
  }
});

// ── Stripe決済API ──
app.post('/api/checkout', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'ログインが必要です' }, 401);
  if (!stripe) return c.json({ error: 'Stripe未設定です' }, 503);

  const { planId } = await c.req.json();
  const plan = PLANS[planId];
  if (!plan || planId === 'free') return c.json({ error: '無効なプランです' }, 400);

  const priceMap = {
    solo: process.env.STRIPE_PRICE_SOLO,
    team: process.env.STRIPE_PRICE_TEAM,
  };

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: user.email,
    line_items: [{ price: priceMap[planId], quantity: 1 }],
    success_url: `http://localhost:${PORT}/upgrade?success=1&plan=${planId}`,
    cancel_url: `http://localhost:${PORT}/upgrade?canceled=1`,
    metadata: { userId: user.id, planId },
  });

  return c.json({ url: session.url });
});

// Stripe Webhook (決済完了 → プランアップグレード)
app.post('/api/webhook', async (c) => {
  if (!stripe) return c.json({ error: 'Stripe未設定' }, 503);
  const sig = c.req.header('stripe-signature');
  const body = await c.req.text();
  let event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return c.json({ error: 'Webhook verification failed' }, 400);
  }

  if (event.type === 'checkout.session.completed') {
    const { userId, planId } = event.data.object.metadata;
    db.updateUser(userId, { plan: planId, stripeCustomerId: event.data.object.customer });
    console.log(`✅ プランアップグレード: userId=${userId} → ${planId}`);
  }

  return c.json({ received: true });
});

const PORT = process.env.PORT || 3000;
const mode = MOCK_MODE ? '⚠️  モックモード' : '✅ 本番モード (Claude API)';
const stripeMode = STRIPE_SECRET ? '✅ Stripe接続済み' : '⚠️  Stripe未設定';
console.log(`\nDocForge 起動中... http://localhost:${PORT}`);
console.log(`Claude: ${mode} / Stripe: ${stripeMode}\n`);
serve({ fetch: app.fetch, port: PORT });
