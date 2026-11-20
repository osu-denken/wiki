# 電研ウィキ

PukiWiki 1.5.4 を Cloudflare Workers 上で動かす。PHP は [php-cgi-wasm](https://www.npmjs.com/package/php-cgi-wasm) (PHP 8.5, WebAssembly)、データは R2 に保存する。

## 構成

```
pukiwiki/            PukiWiki 本体 (設定は pukiwiki.ini.php)
src/
  index.js           Worker のエントリ。リクエストの直列化・描画キャッシュ・競合時の再実行
  php.js             php-cgi (wasm) のラッパー。isolate ごとに 1 インスタンスを使い回す
  state.js           wiki/ backup/ attach/ などと R2 の同期
  session.js         ログインセッションの R2 保存
  cgi.js             Request → CGI 環境変数
  archive.js         アーカイブ形式 (ビルド成果物と R2 の pack で共用)
scripts/
  build.mjs                 build/ を生成 (php-cgi の glue へのパッチ、PukiWiki の梱包、静的ファイル)
  harvest-signatures.mjs    Node で PukiWiki を実際に動かして動作確認しつつ、
                            Workers で必要な関数ラッパー wasm と OPcache のキャッシュを事前生成
```

### R2 のレイアウト

| キー | 内容 |
| --- | --- |
| `manifest.json` | 書き込みのコミット点 (etag で楽観ロック)。シャードのキーと遅延ファイルの一覧 (パス, 日時, サイズ) |
| `pack/<n>-<uuid>.bin.gz` | wiki/ diff/ cache/ counter/ attach/*.log をパスのハッシュで 16 個に分けたもの。書き込みでは変わったシャードだけ作り直す |
| `files/backup/…`, `files/attach/…` | バックアップと添付ファイル本体。必要なリクエストでだけ読み込む (未読み込みでも filesize() 等は manifest のサイズを返す) |
| `sessions/sess_…` | ログインセッション |

### 高速化

- PHP インスタンスと展開済みファイルを isolate 内で使い回す。R2 へは manifest の etag 確認 (条件付き GET) だけで、閲覧時は 1.5 秒に 1 回に間引く
- OPcache (ファイルキャッシュ) をビルド時に生成して同梱。cold start でもコンパイルしない
- 未ログインの GET は描画結果を isolate 内にキャッシュ (manifest の etag をキーに含むので更新で自動的に無効化)
- skin/ image/ の静的ファイルは Static Assets から直接返す

### Workers 向けの工夫

Workers は実行時の wasm コンパイルを禁止しているため、`scripts/build.mjs` で php-cgi の glue にパッチを当てている。

- `dlopen` する共有ライブラリ (mbstring, oniguruma, zlib) は wrangler でコンパイル済みの `WebAssembly.Module` を渡す
- `addFunction` が生成する関数ラッパー wasm は、ビルド時に使われるシグネチャを収集して事前生成する。
  未知のシグネチャが使われるとログに `関数シグネチャ "…" が事前生成されていません` と出るので、
  `scripts/harvest-signatures.mjs` にその操作を追加して再ビルドする

### PukiWiki 本体への変更

- `pukiwiki.ini.php`: タイトル、`$script_directory_index`、パスワード類を環境変数 (シークレット) から読む、認証設定
- `lib/auth.php`: 未ログインの閲覧でセッションを開始しない (1 行)

## 開発

```sh
npm install
echo PUKIWIKI_ADMINPASS=dev-pass > .dev.vars
npm run dev      # build してから wrangler dev
```

`wrangler dev` の実行中に `npm run build` すると build/ の書き換え中に読み込まれて失敗することがあるので、dev を止めてからビルドする。

## デプロイ

```sh
npx wrangler r2 bucket create denken-wiki
npx wrangler r2 bucket lifecycle add denken-wiki expire-sessions sessions/ --expire-days 2   # 期限切れセッションの削除
npx wrangler secret put PUKIWIKI_ADMINPASS   # 管理者 (admin) のパスワード
npx wrangler secret put PUKIWIKI_USERPASS    # 一般ユーザー (user) のパスワード
npm run deploy
```

パスワードは平文のほか `{x-php-sha256}…` などの形式でもよい (`pukiwiki.ini.php` のコメント参照)。
未設定のユーザーはログインできない。

## 制限

- isolate 内のリクエストは直列に処理する (PHP インスタンスが 1 つのため)
- 添付ファイルは 1MB まで (PukiWiki の既定)。アップロード・削除は管理者のみ (既定)
- 他の isolate での更新は最大 1.5 秒遅れて見えることがある (閲覧時の R2 確認を間引いているため)

## ライセンス

PukiWiki、php-cgi-wasm ともに GPL v2 (php-cgi-wasm は Apache-2.0 との選択)。
