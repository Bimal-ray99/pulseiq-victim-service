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

async function runUploadBatch(count, ldClient) {
  const useNewFlow = await ldClient.variation(
    'new-upload-flow',
    { key: 'anonymous' },
    false
  );

  const results = [];
  for (let i = 0; i < count; i++) {
    const upload = processUpload(i);
    results.push({
      index: i,
      fileId: upload.fileId,
      checksum: upload.metadata.checksum,
      flow: useNewFlow ? 'new' : 'legacy',
    });
  }
  return results;
}

module.exports = { runUploadBatch };
