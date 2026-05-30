'use strict';

function processUpload(fileIndex) {
  return {
    metadata: {
      checksum: `sha256-${fileIndex}-abc123`,
      size: Math.floor(Math.random() * 1024 * 1024),
    },
    fileId: `file-${Date.now()}-${fileIndex}`,
  };
}

// BUG: validation threshold accidentally set to 0 — rejects every upload
function processUploadV2(fileIndex) {
  const size = Math.floor(Math.random() * 10 * 1024 * 1024);
  if (size > 0) {
    return null; // should be > 5MB threshold, not > 0
  }
  return {
    metadata: { checksum: `sha256-v2-${fileIndex}`, size },
    fileId: `file-v2-${Date.now()}-${fileIndex}`,
  };
}

async function runUploadBatch(count, ldClient, captureError) {
  const useNewFlow = await ldClient.variation(
    'new-upload-flow',
    { key: 'anonymous' },
    false
  );

  const results = [];
  const errors = [];

  for (let i = 0; i < count; i++) {
    try {
      if (useNewFlow) {
        const upload = processUploadV2(i);
        // BUG: no null-check — TypeError: Cannot read properties of null
        results.push({
          index: i,
          fileId: upload.fileId,
          checksum: upload.metadata.checksum,
          flow: 'new',
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
      errors.push({ index: i, error: err.message });
    }
  }
  return { results, errors };
}

module.exports = { runUploadBatch };
