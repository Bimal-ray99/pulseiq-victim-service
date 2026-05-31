#!/usr/bin/env node
'use strict';

/**
 * PulseIQ Demo: Live Incident Creator
 *
 * Usage:
 *   node scripts/demo-incident.js          # full flow: enable flag → blast errors
 *   node scripts/demo-incident.js blast    # just fire errors (flag already on)
 *   node scripts/demo-incident.js reset    # disable flag (cleanup after demo)
 *   node scripts/demo-incident.js status   # check current state
 */

const BASE = 'http://localhost:4001';
const BLAST_COUNT = 50;

const cmd = process.argv[2] || 'full';

async function post(path, body = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function get(path) {
  const r = await fetch(`${BASE}${path}`);
  return r.json();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function status() {
  const s = await get('/status');
  console.log('\n── Victim Service Status ──');
  console.log(`  new-upload-flow flag: ${s.flag_new_upload_flow ? '🔴 ON (errors firing)' : '🟢 OFF (safe)'}`);
  console.log(`  service: ${s.service}`);
}

async function enableFlag() {
  console.log('\n[1/3] Enabling new-upload-flow flag in LaunchDarkly...');
  const r = await post('/flag/enable');
  if (r.success) {
    console.log('  ✓ Flag ON — next uploads will hit buggy processUploadV2');
  } else {
    console.log('  ✗ Flag toggle failed:', r.error || JSON.stringify(r));
    console.log('  → Set LD_API_TOKEN in .env and restart victim service');
    process.exit(1);
  }
}

async function blast(count = BLAST_COUNT) {
  console.log(`\n[2/3] Firing ${count} uploads → flooding Sentry with TypeErrors...`);
  const r = await post('/blast', { count });
  console.log(`  ✓ Blasted: ${r.blasted} uploads`);
  console.log(`  ✓ Errors captured to Sentry: ${r.errors_captured}`);
  console.log(`  ✓ Successful (legacy flow): ${r.processed}`);
  if (r.errors_captured === 0) {
    console.log('\n  ⚠️  Zero errors — flag may still be OFF or LD not connected');
  }
}

async function waitForPulseIQ() {
  console.log('\n[3/3] Waiting 5s for Sentry to ingest errors...');
  await sleep(5000);
  console.log('  ✓ Errors should now appear in Sentry');
  console.log('  ✓ PulseIQ Coral queries will pick them up in next poll');
  console.log('\n── What to do now ──');
  console.log('  1. Open PulseIQ → Coral Activity Log should show sentry queries');
  console.log('  2. Org Pulse Feed → should show live critical alerts');
  console.log('  3. Click an incident → Ask "Why are uploads failing?"');
  console.log('  4. Enable Autopilot → watch auto-remediation fire');
}

async function reset() {
  console.log('\n[reset] Disabling new-upload-flow flag...');
  const r = await post('/flag/disable');
  if (r.success) {
    console.log('  ✓ Flag OFF — uploads safe again');
  } else {
    console.log('  ✗', r.error || JSON.stringify(r));
  }
}

async function full() {
  console.log('═════════════════════════════════════');
  console.log('  PulseIQ Live Demo — Incident Creator');
  console.log('═════════════════════════════════════');
  await status();
  await enableFlag();
  await sleep(2000); // LD SDK needs moment to propagate
  await blast();
  await waitForPulseIQ();
}

(async () => {
  try {
    if (cmd === 'full')   await full();
    if (cmd === 'blast')  await blast(parseInt(process.argv[3] || BLAST_COUNT, 10));
    if (cmd === 'reset')  await reset();
    if (cmd === 'status') await status();
  } catch (err) {
    if (err.cause?.code === 'ECONNREFUSED') {
      console.error('\n✗ Cannot connect to victim service at', BASE);
      console.error('  Start it first: cd pulseiq-victim-service && node src/index.js');
    } else {
      console.error('\n✗', err.message);
    }
    process.exit(1);
  }
})();
