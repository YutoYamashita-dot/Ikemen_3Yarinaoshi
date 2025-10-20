const express = require('express');
const cors = require('cors');
const estimate = require('./api/estimate');
const region = require('./api/region');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/healthz', (_, res) => res.send('ok'));
app.use('/api/estimate', estimate);
app.use('/api/region', region);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));