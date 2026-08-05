# デプロイ手順（非エンジニア向け・コピペでOK）

このサイトは Node の Express アプリです。`npm start` で動きます。
一番ラクな公開先として **Render** を使う手順を書きます（GitHubに置く→Renderが自動で公開）。
※難しく感じたら、Claudeに画面のスクショを送れば一緒に進められます。

---

## 用意するもの（無料）
1. GitHub アカウント … https://github.com
2. Render アカウント … https://render.com （GitHubでログインが早い）
3. Stripeの「L RAP LEGACY BEATS」アカウントのキー（pk_test / sk_test）

---

## STEP 1. GitHubにコードを置く
1. GitHubで「New repository」→ 名前を `lraplegacy-beats` に →「Create」。
2. リポジトリ画面の「uploading an existing file」をクリック。
3. このフォルダの中身（server.js / package.json / public / beats / DEPLOY.md など）を
   **まるごとドラッグ＆ドロップ**でアップロード →「Commit changes」。
   ※ `.env` と `node_modules` は入れないこと（元々このzipには入っていません）。

## STEP 2. Renderで公開
1. Renderで「New +」→「Web Service」。
2. さっきのGitHubリポジトリを選ぶ。
3. 設定はほぼ自動。以下だけ確認：
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: Free でOK
4. 「Environment」→「Add Environment Variable」で次の3つを入れる：
   - `STRIPE_PUBLISHABLE_KEY` = あなたの pk_test_...
   - `STRIPE_SECRET_KEY` = あなたの sk_test_...
   - `APP_SECRET` = 適当な長いランダム文字列（例: 英数字30文字くらい）
5. 「Create Web Service」を押す → 数分で `https://〇〇.onrender.com` が発行される。

## STEP 3. 動作テスト（テストモードのまま）
1. 発行URLを開く →「Stripeで登録する」を押す。
2. Stripeのテスト決済画面が出たら、テストカード番号を入力：
   - カード番号: `4242 4242 4242 4242`
   - 有効期限: 未来の日付なら何でも（例 12/34）
   - CVC: 適当な3桁（例 123）／ メール: 自分のメール
3. 決済完了 → サイトに戻って会員画面が開き、DLボタンが押せればOK。
4. Stripeダッシュボード（テストモード）にも支払いが記録される。

## STEP 4. 本番公開（お金を実際に取る）
1. Stripeで本人確認を済ませて本番を有効化。
2. Renderの環境変数を **本番キー（pk_live / sk_live）** に差し替え → 再デプロイ。
3. Instagramで創設メンバー募集を告知 → 発行URLに誘導。

---

## 試聴の仕組み
- 非会員は各ビートの **7秒だけ試聴**できます（`beats/previews/<id>.mp3`）。フルDL・フル再生は会員のみ。
- 試聴の長さは変更可能。ラップ販売の定番は15〜30秒 or「フル尺＋数秒おきにタグ音声」。

## 毎月ビートを増やすとき
1. `beats/` フォルダにフルmp3を追加。
2. その15秒試聴を `beats/previews/<同じid>.mp3` に置く（無いと試聴ボタンが出ません）。
   ※ mp3をClaudeに渡せば、BPM/キー解析＋試聴クリップ作成までやります。
3. `beats/catalog.json` に1行追加（id / title / genre / bpm / key / file）。
4. GitHubに上げ直す（ファイルを差し替えてCommit）→ Renderが自動で再公開。

## 補足・既知の限界
- 会員ログインは今は「登録メールを入れると入れる」簡易版です。10人規模の立ち上げには十分ですが、
  次の強化として「メールに届くリンクでログイン（マジックリンク）」を足すとより安全です。
- Renderの無料枠はしばらくアクセスが無いとスリープし、次の表示が少し遅くなります（有料化で解消）。
- ビートはリポジトリ同梱方式。数が増えたらクラウドストレージに移すと軽くなります。
