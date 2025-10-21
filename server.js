// server.js
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
const MALE_RATIO = Number(process.env.MALE_RATIO || '0.49');         // 男性比（仮置き）
const AGE15_99_RATIO = Number(process.env.AGE15_99_RATIO || '0.86'); // 15–99歳比（仮置き）

// 混雑度の係数（※ 今回は “半径範囲の人数” のみに適用）
function crowdMultiplier(crowd) {
  if (crowd === '混雑') return 2.0;
  if (crowd === '空いている') return 0.4;
  return 1.0; // 普通/未指定
}

// 名称からの密度バンプ（日本の自治体末尾）
function densityTypeBump(regionName = '') {
  if (/[区]$/.test(regionName)) return +3000;      // 区は高密度寄り
  if (/[郡町村]$/.test(regionName)) return -2000;  // 郡/町/村は低密度寄り
  if (/[市]$/.test(regionName)) return 0;          // 市は中庸
  return 0;
}

// 面積欠損時に使うベース密度（地域固有の平均的密度推定。混雑度は使わない）
function inferDensityPerKm2(regionName) {
  const base = 6000; // 人/km²（中庸）
  const bump = densityTypeBump(regionName || '');
  const d = base + bump;
  return Math.min(20000, Math.max(1000, d));
}

// ---------- Wikidata ----------
const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';
const WIKIDATA_SEARCH = 'https://www.wikidata.org/w/api.php';

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
    headers: { 'Accept': 'application/sparql-results+json', 'User-Agent': USER_AGENT },
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

function estimateRadiusMale15to99(totalPopulation, areaKm2, radiusKm, crowdMul = 1.0) {
  if (!totalPopulation || totalPopulation <= 0 || !areaKm2 || areaKm2 <= 0 || !radiusKm || radiusKm <= 0) {
    return 0;
  }
  const density = totalPopulation / areaKm2;           // 人/km²
  const circleArea = Math.PI * Math.pow(radiusKm, 2);  // km²
  // ★ 混雑度は “半径範囲の人数” のみに反映
  const circleTotal = density * circleArea * crowdMul; // 人
  return estimateMale15to99FromTotal(Math.round(circleTotal));
}

function estimateIkemenFromMale(maleCount, faceMin, faceMax) {
  if (!maleCount || maleCount <= 0) return 0;
  const pct = Math.max(0, Math.min(100, (Number(faceMin) + Number(faceMax)) / 2)) / 100;
  return Math.round(maleCount * pct);
}

// --- 欠損補完：人口・面積をできる限り推定して非ゼロに ---
function backfillPopulationArea({ regionName, totalPop, areaKm2, radiusKm }) {
  const density = inferDensityPerKm2(regionName);
  let pop = totalPop != null ? Number(totalPop) : null;
  let area = areaKm2 != null ? Number(areaKm2) : null;

  // 片方あればもう片方を推定
  if (pop != null && (area == null || area <= 0)) {
    area = Math.max(1, pop / density);
  } else if (area != null && area > 0 && (pop == null || pop <= 0)) {
    pop = Math.max(1000, Math.round(density * area));
  }

  // 両方欠損 → 半径から地域規模を推定（混雑度は使わない）
  if ((pop == null || pop <= 0) && (area == null || area <= 0)) {
    const r = Number(radiusKm || 0);
    const circleArea = r > 0 ? Math.PI * Math.pow(r, 2) : 0;
    const regionArea = Math.max(10, circleArea * 8); // 中庸×8倍
    area = regionArea;
    pop = Math.max(5000, Math.round(density * area));
  }

  return { totalPop: pop || 0, areaKm2: area || 0 };
}

// ---------- /api/region ----------
app.get('/api/region', async (req, res) => {
  try {
    const keyword = String(req.query.keyword || '').trim();
    if (!keyword) return res.json({ input: '', normalized: null, keyword: '', candidates: [] });

    const info = await wdSparqlPopulationArea(keyword);
    let normalized = null;
    if (info.population != null || info.area_km2 != null) normalized = keyword;

    let candidates = [];
    if (!normalized) {
      candidates = await wdSearchRegionCandidates(keyword, 5);
      if (candidates.length) normalized = candidates[0].label || null;
    }

    return res.json({ input: keyword, normalized, keyword, candidates });
  } catch (e) {
    return res.json({
      input: String(req.query.keyword || ''),
      normalized: null,
      keyword: String(req.query.keyword || ''),
      candidates: []
    });
  }
});

// ---------- /api/estimate ----------
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
    const crowdMul = crowdMultiplier(crowd); // ★ これを “半径範囲” のみで使う
    let totalPop = null;
    let area_km2 = areaKm2 && Number(areaKm2) > 0 ? Number(areaKm2) : null;

    // 地域名から人口/面積を取得（候補フォールバック込み）
    if (region) {
      try {
        const info = await wdSparqlPopulationArea(region);
        totalPop = info.population ?? null;
        if (area_km2 == null) area_km2 = info.area_km2 ?? null;

        if ((totalPop == null && area_km2 == null) || (totalPop === 0 && !area_km2)) {
          const cands = await wdSearchRegionCandidates(region, 3);
          if (cands.length) {
            const label = cands[0].label;
            const info2 = await wdSparqlPopulationArea(label);
            totalPop = totalPop ?? info2.population ?? null;
            area_km2 = area_km2 ?? info2.area_km2 ?? null;
          }
        }
      } catch (_) { /* 補完へ */ }
    }

    // 欠損補完（混雑度は使わない）
    const filled = backfillPopulationArea({
      regionName: region,
      totalPop,
      areaKm2: area_km2,
      radiusKm: Number(radiusKm || 0)
    });
    totalPop = filled.totalPop;
    area_km2 = filled.areaKm2;

    // ★ 地域全体は混雑度を反映しない（仕様どおり）
    const maleAll = estimateMale15to99FromTotal(totalPop);

    // ★ 半径範囲のみ混雑度を反映
    const maleRadius = estimateRadiusMale15to99(totalPop, area_km2, Number(radiusKm || 0), crowdMul);

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