const express = require('express');
const router = express.Router();

router.post('/', (req, res) => {
  const { regionName, faceScoreMin, faceScoreMax, ageMin, ageMax, radiusKm } = req.body;
  const basePop = 100000;
  const maleRatio = 0.49;
  const faceCoef = ((faceScoreMin + faceScoreMax) / 2 - 50) / 20;
  const ageCoef = (ageMax - ageMin) / 60;
  const radiusCoef = Math.min(1, radiusKm / 10);

  const estimate = Math.round(basePop * maleRatio * (0.1 + faceCoef * 0.3) * (0.2 + ageCoef * 0.6) * (0.2 + radiusCoef * 0.8));
  res.json({ regionName, estimate });
});

module.exports = router;