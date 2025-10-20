// api/region.js  (Express Router版 / CommonJS)
const express = require('express');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const keyword = (req.query.keyword || '').trim();
    if (!keyword) return res.status(400).json({ error: 'missing keyword' });

    const url = new URL('https://dashboard.e-stat.go.jp/api/1.0/Json/getRegionInfo');
    url.searchParams.set('keyword', keyword);
    url.searchParams.set('lang', 'J');

    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`region API ${r.status}`);

    const j = await r.json();
    const items = j?.GET_REGION_INFO?.REGION_INFOS ?? [];

    // 完全一致 > 前方一致 > 部分一致
    const sorted = items.sort((a, b) => score(b, keyword) - score(a, keyword));

    // CDNは無いが、将来のプロキシ/ブラウザ向けに軽くキャッシュ指示
    res.set('Cache-Control', 'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ keyword, candidates: sorted.slice(0, 10) });
  } catch (e) {
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
});

function score(item, kw) {
  const name = item?.regionName ?? '';
  if (name === kw) return 3;
  if (name.startsWith(kw)) return 2;
  if (name.includes(kw)) return 1;
  return 0;
}

module.exports = router;