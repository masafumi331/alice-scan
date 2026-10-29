# Alice Scan（UDI Ledger）公開用

GS1 バーコードから GTIN・使用期限・LOT を症例ごとに記録する静的ページ。サーバー処理なし。
- `index.html` … 本体（`../スキャン台帳.html` のコピー。元を直したら `..\deploy_github_pages.ps1` が自動でコピーする）
- `gs1.js` … GS1 分解ロジック
- `master_jan.js` … 商品登録データの JAN 辞書（45,899 件）
- データは閲覧者の端末（ブラウザ）内にのみ保存。サーバーには何も送らない。
