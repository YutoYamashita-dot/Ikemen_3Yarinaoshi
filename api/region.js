// api/region.js
const express = require('express');
const router = express.Router();

// api直下にlibがある想定
const { searchRegionsLLM } = require('./lib/llm');

router.get('/', async (req, res) => {
  try {
    const raw = (req.query.keyword || '').trim();
    if (!raw) return res.status(400).json({ error: 'missing keyword' });

    const limit = Math.min(parseInt(req.query.limit || '10', 10), 20);
    const lang  = (req.query.lang || 'ja').toLowerCase();
    const model = (req.query.model || 'gpt-5-mini');

    const result = await searchRegionsLLM(raw, { lang, limit, model });
    res.set('Cache-Control', 'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({
      ...result,
      source: 'openai',
      note: 'AI推定を含みます（一部不正確な可能性あり）',
      keyword: result.input // 旧クライアント互換
    });
  } catch (e) {
    console.error('[region]', e);
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
});

module.exports = router;
