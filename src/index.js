require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const pino = require('pino');
const pinoHttp = require('pino-http');

const app = express();
const logger = pino({ level: 'info' });
const port = Number(process.env.PORT) || 3000;

app.set('view engine', 'ejs');
app.use(pinoHttp({
  logger,
  serializers: {
    req(req) {
      return {
        method: req.method,
        url: req.url?.split('?')[0],
        remoteAddress: req.socket?.remoteAddress
      };
    },
    res(res) {
      return { statusCode: res.statusCode };
    }
  }
}));
app.use(helmet());
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-8',
  legacyHeaders: false
}));

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.get('/about', (req, res) => {
  res.send('About page');
});

app.listen(port, () => {
  logger.info(`Mawid is running on port ${port}`);
});