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

// POST /blast — fire 50 uploads to flood Sentry for demo
app.post('/blast', async (req, res) => {
  const count = parseInt(req.body?.count ?? 50, 10);
  console.log(`[blast] firing ${count} uploads...`);
  try {
    const client = await getLdClient();
    const { results, errors } = await runUploadBatch(
      count,
      client,
      (err) => {
        console.error('[blast] captured:', err.message);
        Sentry.captureException(err);
      }
    );
    console.log(`[blast] done — ${results.length} ok, ${errors.length} errors`);
    res.json({
      blasted: count,
      processed: results.length,
      errors_captured: errors.length,
      sentry_url: `https://sentry.io/organizations/`,
    });
  } catch (err) {
    Sentry.captureException(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /flag/enable — turn on new-upload-flow via LD REST API
app.post('/flag/enable', async (_req, res) => {
  await toggleFlag(true, res);
});

// POST /flag/disable — turn off new-upload-flow via LD REST API
app.post('/flag/disable', async (_req, res) => {
  await toggleFlag(false, res);
});

async function toggleFlag(on, res) {
  const token = process.env.LD_API_TOKEN;
  const projectKey = process.env.LD_PROJECT_KEY || 'default';
  const envKey = process.env.LD_ENVIRONMENT_KEY || 'production';
  const flagKey = 'new-upload-flow';

  if (!token) {
    return res.status(503).json({ error: 'LD_API_TOKEN not set in .env' });
  }

  try {
    const r = await fetch(
      `https://app.launchdarkly.com/api/v2/flags/${projectKey}/${flagKey}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json; domain-model=launchdarkly.semanticpatch',
        },
        body: JSON.stringify({
          environmentKey: envKey,
          instructions: [{ kind: on ? 'turnFlagOn' : 'turnFlagOff' }],
          comment: `PulseIQ demo — flag ${on ? 'enabled' : 'disabled'}`,
        }),
      }
    );
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: 'LD API error', details: data });
    res.json({ success: true, flag: flagKey, enabled: on });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /status — show current flag state + Sentry link
app.get('/status', async (_req, res) => {
  try {
    const client = await getLdClient();
    const flagOn = await client.variation('new-upload-flow', { key: 'demo-user' }, false);
    res.json({
      flag_new_upload_flow: flagOn,
      service: 'pulseiq-victim-service',
      endpoints: {
        blast: 'POST /blast — fire 50 uploads (generates errors when flag ON)',
        flag_enable: 'POST /flag/enable — turn ON new-upload-flow',
        flag_disable: 'POST /flag/disable — turn OFF new-upload-flow',
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


const PORT = process.env.PORT || 4001;
app.listen(PORT, () => {
  console.log(`victim-service running on :${PORT}`);
});
