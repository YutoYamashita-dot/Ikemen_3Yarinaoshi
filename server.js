require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------- 環境変数（調整可能な係数） ----------
const PORT = process.env.PORT || 10000;
const USER_AGENT = process.env.USER_AGENT || 'CoolGuysApp/1.0 (Node Backend; support@example.com)';
const MALE_RATIO = Number(process.env.MALE_RATIO || '0.49');       // 男性比（仮置き）
const AGE15_99_RATIO = Number(process.env.AGE15_99_RATIO || '0.86'); // 15–99歳比（仮置き）

// ---------- Wikidata エンドポイント ----------
const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';
const WIKIDATA_SEARCH = 'https://www.wikidata.org/w/api.php';

// ---------- ユーティリティ：Wikidata SPARQL（人口/面積） ----------
async function wdSparqlPopulationArea(jaLabel) {
  const sparql = `
    SELECT ?population ?area WHERE {
      ?place rdfs:label "${jaLabel}"@ja .
      OPTIONAL { ?place wdt:P1082 ?population. }
      OPTIONAL { ?place wdt:P2046 ?area. }
    }
    LIMIT 1
  `;
  const res = await axios.get(WIKIDATA_ENDPOINT, {
    params: { query: sparql },
    headers: {
      'Accept': 'application/sparql-results+json',
      'User-Agent': USER_AGENT
    },
    timeout: 20000
  });
  const bindings = res.data?.results?.bindings || [];
  if (!bindings.length) return { population: null, area_km2: null };
  const b = bindings[0];
  const pop = b.population?.value;
  const area = b.area?.value; // 多くが m^2
  const population = pop != null ? Math.round(Number(pop)) : null;
  const area_km2 = area != null ? Number(area) / 1_000_000.0 : null;
  return { population, area_km2 };
}

// ---------- ユーティリティ：Wikidata 検索（候補） ----------
async function wdSearchRegionCandidates(keyword, limit = 5) {
  const res = await axios.get(WIKIDATA_SEARCH, {
    params: {
      action: 'wbsearchentities',
      search: keyword,
      language: 'ja',
      uselang: 'ja',
      format: 'json',
      type: 'item',
      limit: String(limit)
    },
    headers: { 'User-Agent': USER_AGENT },
    timeout: 20000
  });
  const results = res.data?.search || [];
  return results.map(x => ({
    id: x.id,
    label: x.label,
    description: x.description,
    match: x.match
  }));
}

// ---------- 業務ロジック（推計） ----------
function estimateMale15to99FromTotal(totalPopulation) {
  if (!totalPopulation || totalPopulation <= 0) return 0;
  return Math.round(totalPopulation * MALE_RATIO * AGE15_99_RATIO);
}

function estimateRadiusMale15to99(totalPopulation, areaKm2, radiusKm) {
  if (!totalPopulation || totalPopulation <= 0 || !areaKm2 || areaKm2 <= 0 || !radiusKm || radiusKm <= 0) {
    return 0;
  }
  const density = totalPopulation / areaKm2;                  // 人/km2
  const circleArea = Math.PI * Math.pow(radiusKm, 2);        // km2
  const circleTotal = density * circleArea;                   // 人
  return estimateMale15to99FromTotal(Math.round(circleTotal));
}

function estimateIkemenFromMale(maleCount, faceMin, faceMax) {
  if (!maleCount || maleCount <= 0) return 0;
  const pct = Math.max(0, Math.min(100, (Number(faceMin) + Number(faceMax)) / 2)) / 100;
  return Math.round(maleCount * pct);
}

// ---------- /api/region（地域名の正規化＋候補） ----------
app.get('/api/region', async (req, res) => {
  try {
    const keyword = String(req.query.keyword || '').trim();
    if (!keyword) return res.json({ input: '', normalized: null, keyword: '', candidates: [] });

    // まず完全一致で人口/面積が取れるか
    const info = await wdSparqlPopulationArea(keyword);
    let normalized = null;
    if (info.population != null || info.area_km2 != null) {
      normalized = keyword;
    }

    // 取れない時は検索候補から補完
    let candidates = [];
    if (!normalized) {
      candidates = await wdSearchRegionCandidates(keyword, 5);
      if (candidates.length) normalized = candidates[0].label || null;
    }

    return res.json({
      input: keyword,
      normalized,
      keyword,
      candidates
    });
  } catch (e) {
    // 失敗しても候補ゼロで返す（フロントは必要時にChatGPT補完）
    return res.json({
      input: String(req.query.keyword || ''),
      normalized: null,
      keyword: String(req.query.keyword || ''),
      candidates: []
    });
  }
});

// ---------- /api/estimate（推定結果） ----------
app.post('/api/estimate', async (req, res) => {
  try {
    const {
      regionName,
      faceScoreMin,
      faceScoreMax,
      ageMin,
      ageMax,
      radiusKm,
      useCurrentLocation,
      lat,
      lng,
      areaKm2,
      crowd
    } = req.body || {};

    const region = String(regionName || '').trim();
    let totalPop = null;
    let area_km2 = areaKm2 && Number(areaKm2) > 0 ? Number(areaKm2) : null;

    // 地域名から総人口/面積を取得
    if (region) {
      const info = await wdSparqlPopulationArea(region);
      totalPop = info.population ?? null;
      if (area_km2 == null) area_km2 = info.area_km2 ?? null;
    }

    // 推定：男性15–99
    const maleAll = estimateMale15to99FromTotal(totalPop);
    const maleRadius = estimateRadiusMale15to99(totalPop, area_km2, Number(radiusKm || 0));

    // “イケメン”推定（顔偏差値の平均%）
    const ikemenAll = estimateIkemenFromMale(maleAll, faceScoreMin, faceScoreMax);
    const ikemenRadius = estimateIkemenFromMale(maleRadius, faceScoreMin, faceScoreMax);

    return res.json({
      regionName: region || '不明',
      male15to99: maleAll,
      ikemenAll,
      maleRadius,
      ikemenRadius
    });
  } catch (e) {
    // 失敗時でも必ず数値を返す（0で埋める）
    return res.json({
      regionName: String(req.body?.regionName || '不明'),
      male15to99: 0,
      ikemenAll: 0,
      maleRadius: 0,
      ikemenRadius: 0
    });
  }
});

// ---------- ヘルスチェック ----------
app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`CoolGuys backend listening on port ${PORT}`);
});
