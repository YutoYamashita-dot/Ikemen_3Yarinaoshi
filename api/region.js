// api/region.js
const express = require('express');
const router = express.Router();
const { searchRegionsLLM } = require('..api/lib/llm');

// ★ ここは「/」で定義すること（/api/region は server.js 側で付く）
router.get('/', async (req, res) => {
  try {
    const raw = (req.query.keyword || '').trim();
    const limit = Math.min(parseInt(req.query.limit || '10', 10), 20);
    const lang  = (req.query.lang || 'ja').toLowerCase();
    const model = (req.query.model || 'gpt-5-mini');

    if (!raw) return res.status(400).json({ error: 'missing keyword' });

    const result = await searchRegionsLLM(raw, { lang, limit, model });
    res.set('Cache-Control', 'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({
      ...result,
      source: 'openai',
      note: 'AI推定を含みます（一部不正確な可能性あり）',
      // 互換キー（旧クライアント用）
      keyword: result.input,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
});

module.exports = router;