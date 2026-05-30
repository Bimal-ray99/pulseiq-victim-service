'use strict';

require('dotenv').config();
const Sentry = require('@sentry/node');
const express = require('express');
const ld = require('@launchdarkly/node-server-sdk');
const { runUploadBatch } = require('./upload');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: 1.0,
});

const app = express();
app.use(express.json());
app.use(Sentry.Handlers.requestHandler());

let ldClient;
async function getLdClient() {
  if (!ldClient) {
    ldClient = ld.init(process.env.LD_SDK_KEY);
    await ldClient.waitForInitialization({ timeout: 5 });
  }
  return ldClient;
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'pulseiq-victim-service' });
});

app.post('/simulate-upload', async (req, res) => {
  const count = parseInt(req.body?.count ?? 1, 10);
  try {
    const client = await getLdClient();
    const { results, errors } = await runUploadBatch(
      count,
      client,
      (err) => Sentry.captureException(err)
    );
    const status = errors.length > 0 ? 207 : 200;
    res.status(status).json({
      success: errors.length === 0,
      processed: results.length,
      failed: errors.length,
      results,
      errors,
    });
  } catch (err) {
    Sentry.captureException(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.use(Sentry.Handlers.errorHandler());

const PORT = process.env.PORT || 4001;
app.listen(PORT, () => {
  console.log(`victim-service running on :${PORT}`);
});
