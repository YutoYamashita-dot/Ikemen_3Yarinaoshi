const express = require('express');
const router = express.Router();

// ---- 正規分布ユーティリティ（erf 近似：Abramowitz & Stegun 7.1.26） ----
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5*t + a4)*t + a3)*t + a2)*t + a1)*t) * Math.exp(-ax*ax);
  return sign * y;
}
// 標準正規の上側確率 Q(z) = 0.5 * (1 - erf(z/√2))
function upperTailFromZ(z) {
  return 0.5 * (1 - erf(z / Math.SQRT2));
}
// 偏差値 → 上側確率（平均50, SD=10）
function faceTailProportion(h) {
  const z = (h - 50) / 10;
  const q = upperTailFromZ(z);
  return Math.max(0, Math.min(1, q));
}

router.post('/', (req, res) => {
  const { regionName, faceScoreMin, faceScoreMax, ageMin, ageMax, radiusKm } = req.body;

  // 0) 入力の下ごしらえ
  const hMin = Number(faceScoreMin) || 60;
  const hMax = Number(faceScoreMax) || 75;
  const hAvg = (hMin + hMax) / 2;
  const aMin = Math.max(15, Math.min(80, Number(ageMin) || 18));
  const aMax = Math.max(15, Math.min(80, Number(ageMax) || 35));
  const rKm  = Math.max(0, Number(radiusKm) || 0);

  // 1) 偏差値係数（上側確率：例 H=60 → ≈0.1587）
  const faceCoef = faceTailProportion(hAvg);

  // 2) 年齢レンジ係数（基準 15〜80 → 66年、「+1」含む）
  const TOTAL_YEARS = 80 - 15 + 1; // 66
  const overlapYears = Math.max(0, Math.min(aMax, 80) - Math.max(aMin, 15) + 1);
  const ageCoef = overlapYears / TOTAL_YEARS; // 0..1

  // 3) 半径面積係数（基準を 10km 円とする → (r/10)^2 にクランプ）
  const radiusCoef = Math.min(1, (rKm / 10) ** 2); // 0..1

  // 4) 基準人口（暫定）
  const basePop = 100000;   // ← 本番は Wikidata で地域人口を取得して置換
  const maleRatio = 0.49;
  const baseMale15_80 = basePop * maleRatio; // 年齢按分はあとで ageCoef を掛ける

  // 5) 推定：半径内のイケメン人数（直接法）
  //   男性(15-80) = baseMale15_80 × ageCoef × radiusCoef
  //   イケメン    = それ × faceCoef
  const maleRadius_15_80 = baseMale15_80 * ageCoef * radiusCoef;
  const estimate = Math.round(maleRadius_15_80 * faceCoef);

  res.json({ regionName, estimate, debug: {
    faceCoef: Number(faceCoef.toFixed(6)),
    ageCoef,
    radiusCoef,
    baseMale15_80: Math.round(baseMale15_80),
  }});
});

module.exports = router;