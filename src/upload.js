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

// ── New upload flow bugs (triggered when new-upload-flow flag is ON) ──────────

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

// Simulates the broken new upload pipeline
function processUploadV2(fileIndex, sessionId) {
  const size = Math.floor(Math.random() * 50 * 1024 * 1024); // up to 50MB
  const errorRoll = Math.random();

  // ~20% — S3 presigned URL expired (race between URL generation and upload start)
  if (errorRoll < 0.20) {
    throw new StorageBackendError(
      `S3 presigned URL expired before upload completed. ` +
      `URL TTL: 300s, elapsed: ${Math.floor(300 + Math.random() * 120)}s. ` +
      `File: upload-session-${sessionId}-chunk-${fileIndex}`,
      's3-us-east-1',
      403
    );
  }

  // ~20% — distributed lock timeout (two workers racing on same session)
  if (errorRoll < 0.40) {
    const lockKey = `upload:session:${sessionId}:chunk:${fileIndex % 5}`;
    throw new DistributedLockError(
      `Distributed lock acquisition timeout after 5000ms. ` +
      `Lock "${lockKey}" held by worker-${Math.floor(Math.random() * 8)}. ` +
      `Possible deadlock in chunked upload coordinator.`,
      lockKey,
      `worker-${Math.floor(Math.random() * 8)}`
    );
  }

  // ~15% — checksum mismatch (new chunked pipeline re-assembles incorrectly for >10MB files)
  if (errorRoll < 0.55 && size > 10 * 1024 * 1024) {
    const fileId = `v2-${Date.now()}-${fileIndex}`;
    const expected = `sha256-${fileIndex}-expected`;
    const actual = `sha256-${fileIndex}-corrupt-chunk-${Math.floor(Math.random() * 8)}`;
    throw new ChecksumMismatchError(expected, actual, fileId);
  }

  // ~15% — schema validation: new flow sends 'md5-legacy' algorithm, validator rejects it
  if (errorRoll < 0.70) {
    throw new UploadValidationError(
      `Upload manifest schema validation failed: ` +
      `'checksumAlgorithm' must be one of ['sha256', 'sha512'], ` +
      `got 'md5-legacy'. Migrate legacy clients before enabling new-upload-flow.`,
      'checksumAlgorithm'
    );
  }

  // ~15% — connection pool exhaustion (new flow opens 3x DB connections per upload)
  if (errorRoll < 0.85) {
    throw new Error(
      `Connection pool exhausted: all 20 connections active. ` +
      `new-upload-flow opens 3 connections per request vs 1 in legacy flow. ` +
      `Pool: pg-uploads-primary, waited: ${Math.floor(30 + Math.random() * 60)}s, gave up.`
    );
  }

  // Remaining ~15% succeed
  return {
    metadata: {
      checksum: `sha256-v2-${fileIndex}`,
      size,
      algorithm: 'sha256',
      chunks: Math.ceil(size / (5 * 1024 * 1024)),
    },
    fileId: `file-v2-${Date.now()}-${fileIndex}`,
  };
}

async function runUploadBatch(count, ldClient, captureError) {
  const useNewFlow = await ldClient.variation(
    'new-upload-flow',
    { key: 'anonymous' },
    false
  );

  const sessionId = `sess-${Date.now().toString(36)}`;
  const results = [];
  const errors = [];

  for (let i = 0; i < count; i++) {
    try {
      if (useNewFlow) {
        const upload = processUploadV2(i, sessionId);
        results.push({
          index: i,
          fileId: upload.fileId,
          checksum: upload.metadata.checksum,
          chunks: upload.metadata.chunks,
          flow: 'new-v2',
        });
      } else {
        const upload = processUpload(i);
        results.push({
          index: i,
          fileId: upload.fileId,
          checksum: upload.metadata.checksum,
          flow: 'legacy',
        });
      }
    } catch (err) {
      captureError(err);
      errors.push({ index: i, error: err.message, type: err.name });
    }
  }
  return { results, errors };
}

module.exports = { runUploadBatch };
