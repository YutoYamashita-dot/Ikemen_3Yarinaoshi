require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ============ 環境設定（明示パラメータ） ============
const PORT = process.env.PORT || 10000;
const USER_AGENT = process.env.USER_AGENT || 'CoolGuysApp/1.0 (Node Backend; support@example.com)';

// 男性比 / 15–80歳比（地域別の内訳が無い時の係数）
const MALE_RATIO     = Number(process.env.MALE_RATIO     || '0.49'); // 男性：49%
const AGE15_80_RATIO = Number(process.env.AGE15_80_RATIO || '0.80'); // 15–80 ≒ 80%（仮置き）

// 密度（人/km²）の推定：面積欠損時の補完用
const BASE_DENSITY   = Number(process.env.BASE_DENSITY   || '6000');
const BUMP_WARD      = Number(process.env.BUMP_WARD      || '3000');   // 末尾「区」
const BUMP_RURAL     = Number(process.env.BUMP_RURAL     || '-2000');  // 末尾「郡/町/村」
const DENSITY_MIN    = Number(process.env.DENSITY_MIN    || '1000');
const DENSITY_MAX    = Number(process.env.DENSITY_MAX    || '20000');

// 地域全体面積 ≒ 関心円×係数（両方欠損時）
const REGION_AREA_MULT = Number(process.env.REGION_AREA_MULT || '8');
const REGION_AREA_MIN  = Number(process.env.REGION_AREA_MIN  || '10'); // km² 下限
const POP_MIN          = Number(process.env.POP_MIN          || '5000'); // 人 下限

// 混雑度（半径内にのみ適用）
function crowdMultiplier(crowd) {
  if (crowd === '混雑') return 2.0;
  if (crowd === '空いている') return 0.4;
  return 1.0; // 普通/未指定
}

// ============ Wikidata ============
const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';
const WIKIDATA_SEARCH   = 'https://www.wikidata.org/w/api.php';

async function wdSparqlPopulationArea(jaLabel) {
  const sparql = `
    SELECT ?population ?area WHERE {
      ?place rdfs:label "${jaLabel}"@ja .
      OPTIONAL { ?place wdt:P1082 ?population. }  # 総人口
      OPTIONAL { ?place wdt:P2046 ?area. }        # 面積 (多くが m^2)
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
  const pop  = b.population?.value;
  const area = b.area?.value; // m² 想定
  const population = pop  != null ? Math.round(Number(pop)) : null;
  const area_km2   = area != null ? Number(area) / 1_000_000.0 : null;
  return { population, area_km2 };
}

async function wdSearchRegionCandidates(keyword, limit = 5) {
  const res = await axios.get(WIKIDATA_SEARCH, {
    params: {
      action: 'wbsearchentities', search: keyword, language: 'ja', uselang: 'ja',
      format: 'json', type: 'item', limit: String(limit)
    },
    headers: { 'User-Agent': USER_AGENT },
    timeout: 20000
  });
  const results = res.data?.search || [];
  return results.map(x => ({ id: x.id, label: x.label, description: x.description, match: x.match }));
}

// ============ 正規分布（偏差値→上側確率） ============
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5*t + a4)*t + a3)*t + a2)*t + a1)*t) * Math.exp(-ax*ax);
  return sign * y;
}
function upperTailFromZ(z) { return 0.5 * (1 - erf(z / Math.SQRT2)); }
function faceTailProportion(h) {
  const z = (h - 50) / 10;
  const q = upperTailFromZ(z);
  return Math.max(0, Math.min(1, q));
}

// ============ 業務ロジック ============
function densityTypeBump(regionName = '') {
  if (/[区]$/.test(regionName)) return BUMP_WARD;
  if (/[郡町村]$/.test(regionName)) return BUMP_RURAL;
  if (/[市]$/.test(regionName)) return 0;
  return 0;
}
function inferDensityPerKm2(regionName) {
  const d = BASE_DENSITY + densityTypeBump(regionName || '');
  return Math.min(DENSITY_MAX, Math.max(DENSITY_MIN, d));
}

// 欠損補完：人口・面積をできる限り埋めて非ゼロに
function backfillPopulationArea({ regionName, totalPop, areaKm2, radiusKm }) {
  const density = inferDensityPerKm2(regionName);
  let pop = totalPop != null ? Number(totalPop) : null;
  let area = areaKm2  != null ? Number(areaKm2)  : null;

  if (pop != null && (area == null || area <= 0)) {
    area = Math.max(1, pop / density);
  } else if (area != null && area > 0 && (pop == null || pop <= 0)) {
    pop = Math.max(1000, Math.round(density * area));
  }

  if ((pop == null || pop <= 0) && (area == null || area <= 0)) {
    const r = Number(radiusKm || 0);
    const circleArea = r > 0 ? Math.PI * Math.pow(r, 2) : 0;
    const regionArea = Math.max(REGION_AREA_MIN, circleArea * REGION_AREA_MULT);
    area = regionArea;
    pop = Math.max(POP_MIN, Math.round(density * area));
  }
  return { totalPop: pop || 0, areaKm2: area || 0 };
}

// 地域全体（15–80）男性
function male15_80_total(totalPopulation) {
  if (!totalPopulation || totalPopulation <= 0) return 0;
  return Math.round(totalPopulation * MALE_RATIO * AGE15_80_RATIO);
}

// 半径内（15–80）男性（地域面積上限でクリップ＋全体超過防止）
function male15_80_inRadius(totalPopulation, areaKm2, radiusKm, crowdMul = 1.0) {
  if (!totalPopulation || totalPopulation <= 0 || !areaKm2 || areaKm2 <= 0 || !radiusKm || radiusKm <= 0) return 0;
  const density = totalPopulation / areaKm2;             // 人/km²
  const circleArea = Math.PI * Math.pow(radiusKm, 2);    // km²
  const circleAreaEff = Math.min(circleArea, areaKm2);   // 地域面積を超えない
  const peopleInCircle = Math.min(totalPopulation, density * circleAreaEff * crowdMul);
  const male = male15_80_total(Math.round(peopleInCircle));
  return Math.min(male, male15_80_total(totalPopulation)); // 半径内 ≤ 全体
}

// “イケメン”＝男性 × 偏差値上側確率（Hの平均）
function ikemenFromMale(maleCount, faceMin, faceMax) {
  if (!maleCount || maleCount <= 0) return 0;
  const hMin = Number(faceMin) || 60;
  const hMax = Number(faceMax) || 75;
  const hAvg = (hMin + hMax) / 2;
  const coef = faceTailProportion(hAvg);
  return Math.round(maleCount * coef);
}

// ============ API ============
// /api/region（正規化補助）
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
  } catch {
    return res.json({ input: String(req.query.keyword || ''), normalized: null, keyword: String(req.query.keyword || ''), candidates: [] });
  }
});

// /api/estimate（男性15–80・半径内男性15–80・各イケメン数）
app.post('/api/estimate', async (req, res) => {
  try {
    const {
      regionName,
      faceScoreMin,
      faceScoreMax,
      ageMin, ageMax,            // ← フロントで按分に使用（ここでは 15–80の実数を返す）
      radiusKm,
      crowd
    } = req.body || {};
    const region = String(regionName || '').trim();
    const crowdMul = crowdMultiplier(crowd);
    let totalPop = null;
    let area_km2 = null;

    if (region) {
      try {
        const info = await wdSparqlPopulationArea(region);
        totalPop = info.population ?? null;
        area_km2 = info.area_km2 ?? null;
        if ((totalPop == null && area_km2 == null) || (totalPop === 0 && !area_km2)) {
          const cands = await wdSearchRegionCandidates(region, 3);
          if (cands.length) {
            const label = cands[0].label;
            const info2 = await wdSparqlPopulationArea(label);
            totalPop = totalPop ?? info2.population ?? null;
            area_km2 = area_km2 ?? info2.area_km2 ?? null;
          }
        }
      } catch { /* 補完へ */ }
    }

    const filled = backfillPopulationArea({ regionName: region, totalPop, areaKm2: area_km2, radiusKm: Number(radiusKm || 0) });
    totalPop = filled.totalPop;
    area_km2 = filled.areaKm2;

    // 地域全体（15–80）
    const maleAll = male15_80_total(totalPop);

    // 半径内（15–80）— 地域面積でクリップ & 全体を上限
    const maleRadius = male15_80_inRadius(totalPop, area_km2, Number(radiusKm || 0), crowdMul);

    // “イケメン”推定（偏差値上側確率）
    const ikemenAll    = ikemenFromMale(maleAll,    faceScoreMin, faceScoreMax);
    const ikemenRadius = ikemenFromMale(maleRadius, faceScoreMin, faceScoreMax);

    // 整合チェック（安全側）
    const maleRadiusSafe    = Math.min(maleRadius, maleAll);
    const ikemenRadiusSafe  = Math.min(ikemenRadius, ikemenAll);

    return res.json({
      regionName: region || '不明',
      male15to99:   maleAll,           // ← フロント互換プロパティ（実質15–80）
      ikemenAll:    ikemenAll,
      maleRadius:   maleRadiusSafe,
      ikemenRadius: ikemenRadiusSafe
    });
  } catch {
    return res.json({ regionName: String(req.body?.regionName || '不明'), male15to99: 0, ikemenAll: 0, maleRadius: 0, ikemenRadius: 0 });
  }
});

// ヘルスチェック
app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`CoolGuys backend listening on ${PORT}`));