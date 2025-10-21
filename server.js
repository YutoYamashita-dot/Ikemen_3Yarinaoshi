require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ======================== 設定（環境変数で明示的に調整可能） ========================
const PORT = process.env.PORT || 10000;
const USER_AGENT = process.env.USER_AGENT || 'CoolGuysApp/1.0 (Node Backend; support@example.com)';

// 男性比 / 15–80歳比は “既知の人口内訳が無いときの係数” として明示的に使用
const MALE_RATIO      = Number(process.env.MALE_RATIO      || '0.49'); // 例: 49%
const AGE15_80_RATIO  = Number(process.env.AGE15_80_RATIO  || '0.80'); // 例: 15–80 が総人口の約80%と仮置き

// 面積欠損時の密度推定（人/km2）のベース + 名称バンプ
const BASE_DENSITY    = Number(process.env.BASE_DENSITY    || '6000'); // 中庸密度
const BUMP_WARD       = Number(process.env.BUMP_WARD       || '3000'); // 末尾「区」
const BUMP_RURAL      = Number(process.env.BUMP_RURAL      || '-2000'); // 末尾「郡/町/村」
const DENSITY_MIN     = Number(process.env.DENSITY_MIN     || '1000');
const DENSITY_MAX     = Number(process.env.DENSITY_MAX     || '20000');

// “地域全体面積 ≒ 関心円×係数” としての倍率（両方欠損時）
const REGION_AREA_MULT = Number(process.env.REGION_AREA_MULT || '8');   // 中庸
const REGION_AREA_MIN  = Number(process.env.REGION_AREA_MIN  || '10');  // km² 下限
const POP_MIN          = Number(process.env.POP_MIN          || '5000'); // 人 下限

// 混雑度の係数（半径内にのみ適用）
function crowdMultiplier(crowd) {
  if (crowd === '混雑') return 2.0;
  if (crowd === '空いている') return 0.4;
  return 1.0; // 普通/未指定
}

// ======================== Wikidata ========================
const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';
const WIKIDATA_SEARCH   = 'https://www.wikidata.org/w/api.php';

// ラベル完全一致で人口/面積（P1082, P2046）を1件取得（面積は m² → km² 換算）
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
  const pop  = b.population?.value;
  const area = b.area?.value; // 多くが m²
  const population = pop  != null ? Math.round(Number(pop)) : null;
  const area_km2   = area != null ? Number(area) / 1_000_000.0 : null;
  return { population, area_km2 };
}

// 補助検索（wbsearchentities）で候補ラベルを得る
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

// ======================== 正規分布ユーティリティ（偏差値→上側確率） ========================
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5*t + a4)*t + a3)*t + a2)*t + a1)*t) * Math.exp(-ax*ax);
  return sign * y;
}
function upperTailFromZ(z) { // Q(z) = 0.5 * (1 - erf(z/√2))
  return 0.5 * (1 - erf(z / Math.SQRT2));
}
function faceTailProportion(h) { // 偏差値H（平均50, SD=10）の上側確率
  const z = (h - 50) / 10;
  const q = upperTailFromZ(z);
  return Math.max(0, Math.min(1, q));
}

// ======================== 業務ロジック ========================
// 名称の末尾による密度バンプ
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

// 人口・面積の欠損補完（非ゼロに寄せる）
function backfillPopulationArea({ regionName, totalPop, areaKm2, radiusKm }) {
  const density = inferDensityPerKm2(regionName);
  let pop = totalPop != null ? Number(totalPop) : null;
  let area = areaKm2  != null ? Number(areaKm2)  : null;

  // 片方があればもう片方を推定
  if (pop != null && (area == null || area <= 0)) {
    area = Math.max(1, pop / density);
  } else if (area != null && area > 0 && (pop == null || pop <= 0)) {
    pop = Math.max(1000, Math.round(density * area));
  }

  // 両方欠損 → 半径から地域規模を推定
  if ((pop == null || pop <= 0) && (area == null || area <= 0)) {
    const r = Number(radiusKm || 0);
    const circleArea = r > 0 ? Math.PI * Math.pow(r, 2) : 0; // km2
    const regionArea = Math.max(REGION_AREA_MIN, circleArea * REGION_AREA_MULT);
    area = regionArea;
    pop = Math.max(POP_MIN, Math.round(density * area));
  }

  return { totalPop: pop || 0, areaKm2: area || 0 };
}

// 地域全体（15–80）の男性人数
function estimateMale15_80FromTotal(totalPopulation) {
  if (!totalPopulation || totalPopulation <= 0) return 0;
  return Math.round(totalPopulation * MALE_RATIO * AGE15_80_RATIO);
}

// 半径内（15–80）の男性人数（密度×円面積×混雑度）
function estimateRadiusMale15_80(totalPopulation, areaKm2, radiusKm, crowdMul = 1.0) {
  if (!totalPopulation || totalPopulation <= 0 || !areaKm2 || areaKm2 <= 0 || !radiusKm || radiusKm <= 0) {
    return 0;
  }
  const density = totalPopulation / areaKm2;             // 人/km2
  const circleArea = Math.PI * Math.pow(radiusKm, 2);    // km2
  const circleTotal = density * circleArea * crowdMul;   // 人
  return estimateMale15_80FromTotal(Math.round(circleTotal));
}

// “イケメン人数”＝男性人数 × 偏差値の上側確率（Hの平均を採用）
function estimateIkemenFromMale(maleCount, faceMin, faceMax) {
  if (!maleCount || maleCount <= 0) return 0;
  const hMin = Number(faceMin) || 60;
  const hMax = Number(faceMax) || 75;
  const hAvg = (hMin + hMax) / 2;
  const coef = faceTailProportion(hAvg);
  return Math.round(maleCount * coef);
}

// ======================== API ========================
// 正規化（候補つき）
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

// 推定（地域全体 & 半径内。混雑度は半径内のみ適用）
app.post('/api/estimate', async (req, res) => {
  try {
    const {
      regionName,
      faceScoreMin,
      faceScoreMax,
      ageMin,  // 受け取るが式は「15〜80の重なり按分」をフロントで適用
      ageMax,  // （ここでは 15–80 基準の男性人数を返す。フロントで年齢幅按分→A/C）
      radiusKm,
      crowd
    } = req.body || {};

    const region = String(regionName || '').trim();
    const crowdMul = crowdMultiplier(crowd);
    let totalPop = null;
    let area_km2 = null;

    // 1) 地域名で取得
    if (region) {
      try {
        const info = await wdSparqlPopulationArea(region);
        totalPop = info.population ?? null;
        area_km2 = info.area_km2 ?? null;

        // 取得不可なら候補から再トライ
        if ((totalPop == null && area_km2 == null) || (totalPop === 0 && !area_km2)) {
          const cands = await wdSearchRegionCandidates(region, 3);
          if (cands.length) {
            const label = cands[0].label;
            const info2 = await wdSparqlPopulationArea(label);
            totalPop = totalPop ?? info2.population ?? null;
            area_km2 = area_km2 ?? info2.area_km2 ?? null;
          }
        }
      } catch (_) { /* 欠損補完へ */ }
    }

    // 2) 欠損補完（非ゼロ寄せ）
    const filled = backfillPopulationArea({
      regionName: region,
      totalPop,
      areaKm2: area_km2,
      radiusKm: Number(radiusKm || 0)
    });
    totalPop = filled.totalPop;
    area_km2 = filled.areaKm2;

    // 3) 地域全体（15–80）と半径内（15–80）
    const maleAll_15_80 = estimateMale15_80FromTotal(totalPop);
    const maleRadius_15_80 = estimateRadiusMale15_80(totalPop, area_km2, Number(radiusKm || 0), crowdMul);

    // 4) “イケメン”推定（顔偏差値上側確率）
    const ikemenAll   = estimateIkemenFromMale(maleAll_15_80,  faceScoreMin, faceScoreMax);
    const ikemenRadius= estimateIkemenFromMale(maleRadius_15_80,faceScoreMin, faceScoreMax);

    // 返却（互換のためプロパティ名は frontend に合わせる：male15to99 → 実質15–80）
    return res.json({
      regionName: region || '不明',
      male15to99:   maleAll_15_80,    // 実質は 15–80
      ikemenAll:    ikemenAll,
      maleRadius:   maleRadius_15_80, // 実質は 15–80
      ikemenRadius: ikemenRadius
    });
  } catch (e) {
    // 完全に失敗した場合でも 0 で返却（フロント側にローカルFBがある前提）
    return res.json({
      regionName: String(req.body?.regionName || '不明'),
      male15to99: 0,
      ikemenAll: 0,
      maleRadius: 0,
      ikemenRadius: 0
    });
  }
});

// ヘルスチェック
app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`CoolGuys backend listening on port ${PORT}`);
});