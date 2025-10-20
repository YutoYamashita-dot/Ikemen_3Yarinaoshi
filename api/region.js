// api/region.js
const express = require('express');
const router = express.Router();

// lib/llm は「api の直下」とのことなので ./lib/llm でOK
const { searchRegionsLLM } = require('./lib/llm');

// ★ここは '/api/region' ではなく、必ず '/' です★
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
      // 旧クライアント互換
      keyword: result.input
    });
  } catch (e) {
    console.error('[region]', e);
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
});

module.exports = router;