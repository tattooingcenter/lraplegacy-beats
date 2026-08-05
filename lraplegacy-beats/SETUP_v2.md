# v2 セットアップ手順（投稿機能つき）

v2でできること: チームの各メンバーが合言葉でログインしてビートをアップロード → あなた(管理者)が承認したものだけ会員に公開。7秒試聴は自動生成。誰が上げたかも記録。

必要な新しい準備は **Supabase（無料）** だけです。順番にやれば大丈夫。

---

## STEP 1. Supabaseアカウント & プロジェクト作成
1. https://supabase.com → 「Start your project」→ GitHubでログインでOK。
2. 「New project」→ 名前 `lraplegacy-beats`、データベースのパスワードは自動生成でOK（メモは不要）、リージョンは `Northeast Asia (Tokyo)` を選ぶ → Create。
3. 数分でプロジェクトが立ち上がります。

## STEP 2. テーブルを作る（SQLを1回貼るだけ）
1. 左メニューの「SQL Editor」→「New query」。
2. 下をまるごと貼って「Run」：

```sql
create table if not exists beats (
  id uuid primary key,
  title text not null,
  genre text,
  bpm int,
  key text,
  file_path text not null,
  preview_path text not null,
  uploader text,
  status text not null default 'pending',
  created_at timestamptz default now()
);
```

（ビートの保管庫＝ストレージのバケットは、アプリが初回起動時に自動で作ります。手動作成は不要です。）

## STEP 3. キーを2つ取得
1. 左下「Project Settings」→「API」。
2. 次の2つを控える：
   - **Project URL**（`https://xxxxx.supabase.co`）
   - **service_role** キー（`Project API keys` の中。※`anon`ではなく`service_role`。秘密なので取り扱い注意）

## STEP 4. Renderに環境変数を追加
Renderの `lraplegacy-beats` → 左メニュー「Environment」→ 次を追加（既存のStripe/APP_SECRETはそのまま）：
- `SUPABASE_URL` = STEP3のProject URL
- `SUPABASE_SERVICE_KEY` = STEP3のservice_roleキー
- `UPLOAD_PASSWORD` = チームに配る合言葉（例: 好きな文字列）
- `ADMIN_PASSWORD` = あなただけの管理者パスワード（合言葉とは別にする）

## STEP 5. 新しいコードをGitHubへ
このzipの中身で、次のファイルを差し替え／追加します（`lraplegacy-beats` フォルダの中）：
- 差し替え: `server.js`, `package.json`, `.env.example`
- 追加: `public/upload.html`, `public/admin.html`
- （`beats/` フォルダと `catalog.json` はもう使いません。残っていても害はありません）

GitHubでリポジトリの `lraplegacy-beats` フォルダを開く →「Add file」→「Upload files」→ 上記ファイルをドラッグ → Commit。

## STEP 6. デプロイ & 動作確認
1. Render →「Manual Deploy」→「Deploy latest commit」。Liveになるまで待つ。
2. `（あなたのURL）/upload.html` を開く → 名前＋合言葉でログイン → mp3＋タイトル/BPM/キーを入れて投稿。
3. `（あなたのURL）/admin.html` を開く → 管理者パスワードでログイン →「承認待ち」に出たビートを試聴 →「公開する」。
4. トップページ（`/`）に公開され、会員だけがフルDLできることを確認。

## ページの入り口
- 会員向けトップ: `/`
- 投稿（チーム用・要合言葉）: `/upload.html`
- 承認・管理（あなた用・要管理者PW）: `/admin.html`

## 運用メモ
- 投稿者ログインは全員共通の合言葉。合言葉を変えたい時はRenderの `UPLOAD_PASSWORD` を変えて再デプロイ。
- 「誰が上げたか」はDBの `uploader` に記録済み。将来ダウンロード実績に応じて制作者に分配したくなったら、この記録を土台にできます。
