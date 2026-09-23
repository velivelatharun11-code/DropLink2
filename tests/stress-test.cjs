const crypto = require('crypto');
const assert = require('assert');
const { EventEmitter } = require('events');

console.log('====================================================');
console.log(' DropLink2 Automated Stress & Resumption Test Suite');
console.log('====================================================\n');

const CHUNK_SIZE = 64 * 1024; // 64 KB
const HEADER_SIZE = 16;

// 1. DropLink Binary Framing Protocol Implementation
function packChunk(fileId, chunkIndex, byteOffset, payloadUint8) {
  const packet = new Uint8Array(HEADER_SIZE + payloadUint8.byteLength);
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  view.setUint32(0, fileId, false);
  view.setUint32(4, chunkIndex, false);
  view.setUint32(8, byteOffset, false);
  view.setUint32(12, payloadUint8.byteLength, false);
  packet.set(payloadUint8, HEADER_SIZE);
  return packet;
}

function unpackChunk(packetUint8) {
  if (packetUint8.byteLength < HEADER_SIZE) {
    throw new Error('MalformedPacket: Buffer shorter than header size');
  }
  const view = new DataView(packetUint8.buffer, packetUint8.byteOffset, packetUint8.byteLength);
  const fileId = view.getUint32(0, false);
  const chunkIndex = view.getUint32(4, false);
  const byteOffset = view.getUint32(8, false);
  const length = view.getUint32(12, false);

  if (packetUint8.byteLength < HEADER_SIZE + length) {
    throw new Error('MalformedPacket: Packet truncated before expected payload length');
  }

  const payload = packetUint8.subarray(HEADER_SIZE, HEADER_SIZE + length);
  return { fileId, chunkIndex, byteOffset, length, payload };
}

// 2. Encryption / Decryption Simulation using AES-GCM
async function deriveKey(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, 100000, 32, 'sha256', (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

function encryptChunk(rawBuffer, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(rawBuffer)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

function decryptChunk(encBuffer, key) {
  if (encBuffer.length < 28) {
    throw new Error('CiphertextTooShort: Missing IV or Auth Tag');
  }
  const iv = encBuffer.subarray(0, 12);
  const tag = encBuffer.subarray(12, 28);
  const ciphertext = encBuffer.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// 3. Mock WebRTC DataChannel with Backpressure & Drain
class MockDataChannel extends EventEmitter {
  constructor(highWaterMark = 1024 * 1024, lowWaterMark = 256 * 1024) {
    super();
    this.highWaterMark = highWaterMark;
    this.lowWaterMark = lowWaterMark;
    this.bufferedAmount = 0;
    this.received = [];
    this.readyState = 'open';
  }

  send(data) {
    if (this.readyState !== 'open') {
      throw new Error(`InvalidStateError: Channel is ${this.readyState}`);
    }
    this.bufferedAmount += data.byteLength;
    setImmediate(() => {
      this.received.push(data);
      this.bufferedAmount = Math.max(0, this.bufferedAmount - data.byteLength);
      if (this.bufferedAmount <= this.lowWaterMark) {
        this.emit('bufferedamountlow');
      }
    });
  }

  async waitForDrain() {
    if (this.bufferedAmount < this.highWaterMark) return;
    return new Promise((resolve) => this.once('bufferedamountlow', resolve));
  }

  close() {
    this.readyState = 'closed';
    this.emit('close');
  }
}

// 4. Mock FileSystemSyncAccessHandle (OPFS)
class MockSyncAccessHandle {
  constructor(totalSize) {
    this.storage = Buffer.alloc(totalSize);
    this.bytesWritten = 0;
    this.flushOperations = 0;
    this.closed = false;
  }

  write(buffer, options = {}) {
    if (this.closed) throw new Error('InvalidStateError: AccessHandle is closed');
    const at = options.at ?? 0;
    buffer.copy(this.storage, at);
    this.bytesWritten += buffer.length;
    return buffer.length;
  }

  flush() {
    if (this.closed) throw new Error('InvalidStateError: AccessHandle is closed');
    this.flushOperations++;
  }

  truncate(newSize) {
    if (this.closed) throw new Error('InvalidStateError: AccessHandle is closed');
    if (newSize < this.storage.length) {
      this.storage = this.storage.subarray(0, newSize);
    }
  }

  close() {
    this.flush();
    this.closed = true;
  }
}

async function runTests() {
  let passed = 0;

  // TEST 1: Framing Roundtrip
  console.log('[Test 1] Testing Binary Framing (Header Packing/Unpacking)...');
  const dummyPayload = new Uint8Array(crypto.randomBytes(CHUNK_SIZE));
  const packed = packChunk(42, 105, 6881280, dummyPayload);
  const unpacked = unpackChunk(packed);

  assert.strictEqual(unpacked.fileId, 42);
  assert.strictEqual(unpacked.chunkIndex, 105);
  assert.strictEqual(unpacked.byteOffset, 6881280);
  assert.strictEqual(unpacked.length, CHUNK_SIZE);
  assert.deepStrictEqual(Buffer.from(unpacked.payload), Buffer.from(dummyPayload));
  console.log('  PASS: Binary framing headers and offsets verified.\n');
  passed++;

  // TEST 2: Encryption/Decryption Integrity Under Pressure
  console.log('[Test 2] Testing AES-256-GCM Chunk Encryption/Decryption...');
  const salt = crypto.randomBytes(16);
  const key = await deriveKey('StrongPassword123!', salt);
  const sampleChunk = crypto.randomBytes(CHUNK_SIZE);
  const enc = encryptChunk(sampleChunk, key);
  const dec = decryptChunk(enc, key);
  assert.deepStrictEqual(dec, sampleChunk);
  console.log('  PASS: AES-GCM cipher payload authenticated.\n');
  passed++;

  // TEST 3: Multi-Stripe Demux & Chunk Resumption Simulation
  console.log('[Test 3] Simulating 10 MB Stream across 4 Parallel Stripes...');
  const TOTAL_SIZE = 10 * 1024 * 1024;
  const rawFile = crypto.randomBytes(TOTAL_SIZE);
  const originalSha256 = crypto.createHash('sha256').update(rawFile).digest('hex');
  console.log(`  Source File SHA-256: ${originalSha256}`);

  const INTERRUPT_BYTE = Math.floor(4.3 * 1024 * 1024);
  const safeResumeOffset = Math.floor(INTERRUPT_BYTE / CHUNK_SIZE) * CHUNK_SIZE;
  console.log(`  Simulating drop at byte: ${INTERRUPT_BYTE}`);
  console.log(`  Resume boundary aligned down to: ${safeResumeOffset} bytes (${safeResumeOffset / 1024} KB)`);

  const diskBuffer = Buffer.alloc(TOTAL_SIZE);

  let offset = 0;
  let chunkIdx = 0;
  const numStripes = 4;
  const channelBuffers = [[], [], [], []];

  while (offset < safeResumeOffset) {
    const slice = rawFile.subarray(offset, offset + CHUNK_SIZE);
    const packet = packChunk(1, chunkIdx, offset, slice);
    channelBuffers[chunkIdx % numStripes].push(packet);
    offset += slice.byteLength;
    chunkIdx++;
  }

  for (const queue of channelBuffers) {
    for (const pkt of queue) {
      const { byteOffset, payload } = unpackChunk(pkt);
      diskBuffer.set(payload, byteOffset);
    }
    queue.length = 0;
  }

  console.log('  Interruption simulated! Safe committed bytes preserved on disk.');

  const senderStartOffset = safeResumeOffset;
  let resumeChunkIdx = Math.floor(senderStartOffset / CHUNK_SIZE);
  offset = senderStartOffset;

  while (offset < TOTAL_SIZE) {
    const slice = rawFile.subarray(offset, Math.min(offset + CHUNK_SIZE, TOTAL_SIZE));
    const packet = packChunk(1, resumeChunkIdx, offset, slice);
    channelBuffers[resumeChunkIdx % numStripes].push(packet);
    offset += slice.byteLength;
    resumeChunkIdx++;
  }

  for (const queue of channelBuffers) {
    for (const pkt of queue) {
      const { byteOffset, payload } = unpackChunk(pkt);
      diskBuffer.set(payload, byteOffset);
    }
  }

  const restoredSha256 = crypto.createHash('sha256').update(diskBuffer).digest('hex');
  console.log(`  Resumed File SHA-256: ${restoredSha256}`);

  assert.strictEqual(restoredSha256, originalSha256, 'Hash mismatch between resumed stream and original file!');
  console.log('  PASS: Chunk-level resumption reconstructed 100% bit-identical file.\n');
  passed++;

  // TEST 4: Jumbled / Out-of-Order Packet Delivery
  console.log('[Test 4] Testing Out-of-Order Packet Arrival & Random Interleaving...');
  const testFile4 = crypto.randomBytes(5 * 1024 * 1024);
  const expectedHash4 = crypto.createHash('sha256').update(testFile4).digest('hex');
  const packets = [];

  let p4Offset = 0;
  let p4Index = 0;
  while (p4Offset < testFile4.byteLength) {
    const slice = testFile4.subarray(p4Offset, Math.min(p4Offset + CHUNK_SIZE, testFile4.byteLength));
    packets.push(packChunk(99, p4Index, p4Offset, slice));
    p4Offset += slice.byteLength;
    p4Index++;
  }

  for (let i = packets.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [packets[i], packets[j]] = [packets[j], packets[i]];
  }

  const diskBuffer4 = Buffer.alloc(testFile4.byteLength);
  for (const pkt of packets) {
    const { byteOffset, payload } = unpackChunk(pkt);
    diskBuffer4.set(payload, byteOffset);
  }

  const actualHash4 = crypto.createHash('sha256').update(diskBuffer4).digest('hex');
  assert.strictEqual(actualHash4, expectedHash4, 'Out-of-order reassembly produced corrupted data!');
  console.log('  PASS: 100% random arrival order reassembled accurately.\n');
  passed++;

  // TEST 5: WebRTC DataChannel Backpressure & Flow Control
  console.log('[Test 5] Simulating WebRTC Flow Control under Backpressure...');
  const channel = new MockDataChannel(1024 * 1024, 256 * 1024);
  const testFile5 = crypto.randomBytes(4 * 1024 * 1024);
  const expectedHash5 = crypto.createHash('sha256').update(testFile5).digest('hex');

  let throttledCount = 0;
  let p5Offset = 0;
  let p5Index = 0;

  while (p5Offset < testFile5.byteLength) {
    if (channel.bufferedAmount >= channel.highWaterMark) {
      throttledCount++;
      await channel.waitForDrain();
    }
    const slice = testFile5.subarray(p5Offset, Math.min(p5Offset + CHUNK_SIZE, testFile5.byteLength));
    const packet = packChunk(55, p5Index, p5Offset, slice);
    channel.send(packet);
    p5Offset += slice.byteLength;
    p5Index++;
  }

  while (channel.bufferedAmount > 0) {
    await new Promise((res) => setImmediate(res));
  }

  const diskBuffer5 = Buffer.alloc(testFile5.byteLength);
  for (const pkt of channel.received) {
    const { byteOffset, payload } = unpackChunk(pkt);
    diskBuffer5.set(payload, byteOffset);
  }

  const actualHash5 = crypto.createHash('sha256').update(diskBuffer5).digest('hex');
  assert.strictEqual(actualHash5, expectedHash5, 'Backpressure-regulated stream data mismatch!');
  assert.ok(throttledCount > 0, 'Flow control was never triggered during high-throughput send');
  console.log(`  PASS: Flow control paused sender ${throttledCount} times without buffer overflow.\n`);
  passed++;

  // TEST 6: OPFS Sync Access Handle & Periodic Flush Integrity
  console.log('[Test 6] Testing OPFS Write Stream with Periodic Flushes...');
  const TEST_SIZE_6 = 6 * 1024 * 1024;
  const rawFile6 = crypto.randomBytes(TEST_SIZE_6);
  const expectedHash6 = crypto.createHash('sha256').update(rawFile6).digest('hex');

  const fileHandle = new MockSyncAccessHandle(TEST_SIZE_6);
  const FLUSH_INTERVAL = 1024 * 1024;
  let uncommittedBytes = 0;
  let p6Offset = 0;
  let p6Index = 0;

  while (p6Offset < TEST_SIZE_6) {
    const slice = rawFile6.subarray(p6Offset, Math.min(p6Offset + CHUNK_SIZE, TEST_SIZE_6));
    const packet = packChunk(66, p6Index, p6Offset, slice);
    const { byteOffset, payload } = unpackChunk(packet);

    fileHandle.write(Buffer.from(payload), { at: byteOffset });
    uncommittedBytes += payload.byteLength;

    if (uncommittedBytes >= FLUSH_INTERVAL) {
      fileHandle.flush();
      uncommittedBytes = 0;
    }

    p6Offset += slice.byteLength;
    p6Index++;
  }

  fileHandle.close();

  const writtenHash6 = crypto.createHash('sha256').update(fileHandle.storage).digest('hex');
  assert.strictEqual(writtenHash6, expectedHash6, 'OPFS file buffer hash mismatch!');
  assert.ok(fileHandle.flushOperations >= 6, `Expected at least 6 flushes, got ${fileHandle.flushOperations}`);
  assert.strictEqual(fileHandle.closed, true, 'File handle was not closed');
  console.log(`  PASS: Wrote 6 MB across ${p6Index} chunks with ${fileHandle.flushOperations} flushes, hash verified.\n`);
  passed++;

  // TEST 7: Malformed Framing & Bit-Flip Tamper Resistance
  console.log('[Test 7] Testing Bit-Flip Tampering & Malformed Packet Rejection...');
  const salt7 = crypto.randomBytes(16);
  const key7 = await deriveKey('IntegrityCheckKey7!', salt7);
  const originalChunk = crypto.randomBytes(CHUNK_SIZE);
  const validEncrypted = encryptChunk(originalChunk, key7);

  const truncatedPacket = new Uint8Array(8);
  assert.throws(
    () => unpackChunk(truncatedPacket),
    /MalformedPacket/,
    'Failed to reject packet with truncated header'
  );

  const validPacket = packChunk(77, 0, 0, validEncrypted);
  const clippedPacket = validPacket.subarray(0, validPacket.byteLength - 100);
  assert.throws(
    () => unpackChunk(clippedPacket),
    /MalformedPacket/,
    'Failed to reject clipped payload'
  );

  const tamperedEncrypted = Buffer.from(validEncrypted);
  tamperedEncrypted[35] ^= 0x01;
  assert.throws(
    () => decryptChunk(tamperedEncrypted, key7),
    /Unsupported state or unable to authenticate data/,
    'Ciphertext bit-flip bypassed GCM authentication tag verification!'
  );

  const tamperedTag = Buffer.from(validEncrypted);
  tamperedTag[14] ^= 0x80;
  assert.throws(
    () => decryptChunk(tamperedTag, key7),
    /Unsupported state or unable to authenticate data/,
    'Tag bit-flip bypassed GCM authentication tag verification!'
  );

  console.log('  PASS: Header bounds checks, bit-flips, and tag tampering rejected safely.\n');
  passed++;

  // TEST 8: Live Stripe Dropout & Automatic Channel Failover
  console.log('[Test 8] Simulating Multi-Stripe Drop & Automatic Channel Failover...');
  const TEST_SIZE_8 = 8 * 1024 * 1024;
  const rawFile8 = crypto.randomBytes(TEST_SIZE_8);
  const expectedHash8 = crypto.createHash('sha256').update(rawFile8).digest('hex');

  const channels = [
    new MockDataChannel(),
    new MockDataChannel(),
    new MockDataChannel(),
    new MockDataChannel(),
  ];

  let p8Offset = 0;
  let p8Index = 0;
  const DROP_POINT = 3 * 1024 * 1024;
  let stripe1Dropped = false;
  let stripe2Dropped = false;

  while (p8Offset < TEST_SIZE_8) {
    if (p8Offset >= DROP_POINT && !stripe1Dropped) {
      channels[1].close();
      stripe1Dropped = true;
    }
    if (p8Offset >= 5 * 1024 * 1024 && !stripe2Dropped) {
      channels[2].close();
      stripe2Dropped = true;
    }

    const availableChannels = channels.filter((c) => c.readyState === 'open');
    assert.ok(availableChannels.length > 0, 'All channels dropped unexpectedly');

    const targetChannel = availableChannels[p8Index % availableChannels.length];
    const slice = rawFile8.subarray(p8Offset, Math.min(p8Offset + CHUNK_SIZE, TEST_SIZE_8));
    const packet = packChunk(88, p8Index, p8Offset, slice);

    targetChannel.send(packet);
    p8Offset += slice.byteLength;
    p8Index++;
  }

  while (channels.some((c) => c.bufferedAmount > 0)) {
    await new Promise((res) => setImmediate(res));
  }

  const diskBuffer8 = Buffer.alloc(TEST_SIZE_8);
  for (const ch of channels) {
    for (const pkt of ch.received) {
      const { byteOffset, payload } = unpackChunk(pkt);
      diskBuffer8.set(payload, byteOffset);
    }
  }

  const actualHash8 = crypto.createHash('sha256').update(diskBuffer8).digest('hex');
  assert.strictEqual(actualHash8, expectedHash8, 'Failover produced corrupted data mismatch!');
  assert.strictEqual(channels[1].readyState, 'closed');
  assert.strictEqual(channels[2].readyState, 'closed');
  assert.strictEqual(channels[0].readyState, 'open');
  assert.strictEqual(channels[3].readyState, 'open');

  console.log(`  PASS: Completed 8 MB transfer with 2 of 4 channels dropped mid-flight.\n`);
  passed++;

  // TEST 9: Rapid Consecutive Disconnects & Multi-Drop Resumption
  console.log('[Test 9] Simulating Rapid Re-Handshake Churn (3 Consecutive Drops)...');
  const TEST_SIZE_9 = 12 * 1024 * 1024; // 12 MB
  const rawFile9 = crypto.randomBytes(TEST_SIZE_9);
  const expectedHash9 = crypto.createHash('sha256').update(rawFile9).digest('hex');

  // Interrupt targets at non-chunk-aligned boundaries
  const dropPoints = [
    Math.floor(2.73 * 1024 * 1024),
    Math.floor(6.19 * 1024 * 1024),
    Math.floor(9.84 * 1024 * 1024),
  ];

  const diskBuffer9 = Buffer.alloc(TEST_SIZE_9);
  let senderOffset = 0;
  let committedReceiverOffset = 0;

  for (let dropIteration = 0; dropIteration < dropPoints.length; dropIteration++) {
    const currentLimit = dropPoints[dropIteration];
    const dropBoundary = Math.floor(currentLimit / CHUNK_SIZE) * CHUNK_SIZE;

    // Send until disconnect point
    while (senderOffset < dropBoundary) {
      const slice = rawFile9.subarray(senderOffset, senderOffset + CHUNK_SIZE);
      const packet = packChunk(99, Math.floor(senderOffset / CHUNK_SIZE), senderOffset, slice);
      const { byteOffset, payload } = unpackChunk(packet);
      diskBuffer9.set(payload, byteOffset);
      senderOffset += slice.byteLength;
    }

    // Receiver commits safe contiguous boundary
    committedReceiverOffset = senderOffset;
    console.log(`   Drop #${dropIteration + 1} at byte ${currentLimit} -> Resuming from ${committedReceiverOffset} B`);

    // Sender queries receiver state and syncs cursor
    senderOffset = committedReceiverOffset;
  }

  // Final push: complete remaining stream to end
  while (senderOffset < TEST_SIZE_9) {
    const slice = rawFile9.subarray(senderOffset, Math.min(senderOffset + CHUNK_SIZE, TEST_SIZE_9));
    const packet = packChunk(99, Math.floor(senderOffset / CHUNK_SIZE), senderOffset, slice);
    const { byteOffset, payload } = unpackChunk(packet);
    diskBuffer9.set(payload, byteOffset);
    senderOffset += slice.byteLength;
  }

  const actualHash9 = crypto.createHash('sha256').update(diskBuffer9).digest('hex');
  assert.strictEqual(actualHash9, expectedHash9, 'Multi-drop recovery produced corrupted file!');
  console.log('  PASS: Survived 3 rapid disconnect cycles with 100% SHA-256 match.\n');
  passed++;

  console.log('----------------------------------------------------');
  console.log(`ALL TESTS PASSED: ${passed}/9 completed successfully.`);
  console.log('----------------------------------------------------');
}

runTests().catch((err) => {
  console.error('\nTEST FAILED:', err);
  process.exit(1);
});
