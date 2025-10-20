// server.js
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// 1) 基本ヘルス
app.get('/healthz', (_, res) => res.send('ok'));

// 2) デバッグ用：生存確認
app.get('/api/region-check', (req, res) => {
  res.json({ alive: true, keyword: req.query.keyword ?? null });
});

// 3) ルーターを正しくマウント
let regionRouter;
try {
  regionRouter = require('./api/region'); // ← 大文字/パスに注意
  console.log('[boot] region router loaded');
} catch (e) {
  console.error('[boot] region router load failed:', e);
}
app.use('/api/region', regionRouter);

// 4) 最後に404をJSONで返す（デバッグしやすくする）
app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));