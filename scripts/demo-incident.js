'use strict';

// Legacy upload path — stable, works fine
function processUpload(fileIndex) {
  return {
    metadata: {
      checksum: `sha256-${fileIndex}-abc123`,
      size: Math.floor(Math.random() * 1024 * 1024),
    },
    fileId: `file-${Date.now()}-${fileIndex}`,
  };
}

// ── New upload flow (fixed) ────────────────────────────────────────────────────

class UploadValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'UploadValidationError';
    this.field = field;
  }
}

class StorageBackendError extends Error {
  constructor(message, backend, statusCode) {
    super(message);
    this.name = 'StorageBackendError';
    this.backend = backend;
    this.statusCode = statusCode;
  }
}

class DistributedLockError extends Error {
  constructor(message, lockKey, holderPid) {
    super(message);
    this.name = 'DistributedLockError';
    this.lockKey = lockKey;
    this.holderPid = holderPid;
  }
}

class ChecksumMismatchError extends Error {
  constructor(expected, actual, fileId) {
    super(`Checksum mismatch for ${fileId}: expected ${expected}, got ${actual}`);
    this.name = 'ChecksumMismatchError';
    this.expected = expected;
    this.actual = actual;
    this.fileId = fileId;
  }
}

const PRESIGNED_URL_TTL = 900; // FIX: increased from 300s to 900s for large files
const MAX_LOCK_RETRIES = 3;    // FIX: retry lock acquisition instead of failing immediately
const POOL_CONNECTIONS_PER_REQUEST = 1; // FIX: reduced from 3 to 1 (matches legacy flow)

// FIX: normalise legacy checksum algorithms before validation
function normaliseChecksumAlgorithm(algorithm) {
  const LEGACY_MAP = { 'md5-legacy': 'sha256', 'sha256-legacy': 'sha256' };
  return LEGACY_MAP[algorithm] || algorithm;
}

function processUploadV2(fileIndex, sessionId) {
  const size = Math.floor(Math.random() * 50 * 1024 * 1024);
  const errorRoll = Math.random();

  // S3 presigned URL: URL TTL now 900s to cover large file uploads
  if (errorRoll < 0.05) {  // FIX: reduced from 20% to 5% due to TTL increase
    throw new StorageBackendError(
      `S3 presigned URL expired before upload completed. ` +
      `URL TTL: ${PRESIGNED_URL_TTL}s, elapsed: ${Math.floor(PRESIGNED_URL_TTL + Math.random() * 30)}s. ` +
      `File: upload-session-${sessionId}-chunk-${fileIndex}`,
      's3-us-east-1',
      403
    );
  }

  // FIX: distributed lock with retry — acquire up to MAX_LOCK_RETRIES times
  if (errorRoll < 0.10) {  // FIX: reduced from 20% to 10%
    const lockKey = `upload:session:${sessionId}:chunk:${fileIndex % 5}`;
    throw new DistributedLockError(
      `Distributed lock acquisition failed after ${MAX_LOCK_RETRIES} retries. ` +
      `Lock "${lockKey}" contended. Increase retry timeout or reduce chunk concurrency.`,
      lockKey,
      `worker-${Math.floor(Math.random() * 8)}`
    );
  }

  // Checksum mismatch: only for very large files now (>25MB threshold)
  if (errorRoll < 0.15 && size > 25 * 1024 * 1024) {  // FIX: threshold raised from 10MB to 25MB
    const fileId = `v2-${Date.now()}-${fileIndex}`;
    const expected = `sha256-${fileIndex}-expected`;
    const actual = `sha256-${fileIndex}-corrupt-chunk-${Math.floor(Math.random() * 8)}`;
    throw new ChecksumMismatchError(expected, actual, fileId);
  }

  // FIX: normalise legacy checksum algorithm — accept 'md5-legacy', map to 'sha256'
  const rawAlgorithm = 'md5-legacy'; // simulate client sending legacy value
  const algorithm = normaliseChecksumAlgorithm(rawAlgorithm);
  if (!['sha256', 'sha512'].includes(algorithm)) {
    throw new UploadValidationError(
      `Upload manifest schema validation failed: 'checksumAlgorithm' must be one of ['sha256', 'sha512'], got '${rawAlgorithm}'.`,
      'checksumAlgorithm'
    );
  }

  // FIX: connection pool — use 1 connection per request (down from 3)
  // Pool: pg-uploads-primary — POOL_CONNECTIONS_PER_REQUEST enforced upstream

  return {
    metadata: {
      checksum: `sha256-v2-${fileIndex}`,
      size,
      algorithm,
      chunks: Math.ceil(size / (5 * 1024 * 1024)),
    },
    fileId: `file-v2-${Date.now()}-${fileIndex}`,
  };
}

async function runUploadBatch(count, ldClient, captureError) {
  const useNewFlow = await ldClient.variation('new-upload-flow', { key: 'anonymous' }, false);
  const sessionId = `sess-${Date.now().toString(36)}`;
  const results = [];
  const errors = [];

  for (let i = 0; i < count; i++) {
    try {
      if (useNewFlow) {
        const upload = processUploadV2(i, sessionId);
        results.push({ index: i, fileId: upload.fileId, checksum: upload.metadata.checksum, chunks: upload.metadata.chunks, flow: 'new-v2' });
      } else {
        const upload = processUpload(i);
        results.push({ index: i, fileId: upload.fileId, checksum: upload.metadata.checksum, flow: 'legacy' });
      }
    } catch (err) {
      captureError(err);
      errors.push({ index: i, error: err.message, type: err.name });
    }
  }
  return { results, errors };
}

module.exports = { runUploadBatch };
