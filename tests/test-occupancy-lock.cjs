const { io } = require('socket.io-client');
const assert = require('assert');

const SERVER_URL = 'http://localhost:3001';
const TEST_ROOM = `test-occ-lock-${Date.now()}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createClient(name) {
  return io(SERVER_URL, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false
  });
}

async function runTests() {
  console.log('\n======================================================');
  console.log(' DropLink2 Occupancy, Auto-Handshake & Lock Test');
  console.log('======================================================\n');

  const clients = [];

  try {
    // ----------------------------------------------------
    // TEST 1: Participant Occupancy (1/5 to 5/5) & Cap
    // ----------------------------------------------------
    console.log('[Step 1] Connecting Host (Peer 1) to room...');
    const host = createClient('Host');
    clients.push(host);

    const hostJoinPromise = new Promise((resolve, reject) => {
      host.on('room-joined', (data) => resolve(data));
      host.on('error', reject);
    });

    host.emit('join-room', { roomId: TEST_ROOM, peerName: 'Host-Device' });
    const hostJoinData = await hostJoinPromise;

    assert.strictEqual(hostJoinData.occupancy, 1, 'Host should receive occupancy = 1');
    assert.strictEqual(hostJoinData.maxPeers, 5, 'Max peers should be 5');
    console.log(`[Step 1 OK] Host joined with occupancy = 1/5.`);

    // Peer 2 joins
    console.log('[Step 2] Connecting Peer 2...');
    const peer2 = createClient('Peer2');
    clients.push(peer2);

    let hostOccupancyUpdate = null;
    host.on('room-occupancy-update', (data) => {
      hostOccupancyUpdate = data.occupancy;
    });

    const peer2JoinPromise = new Promise((resolve) => {
      peer2.on('room-joined', resolve);
    });

    peer2.emit('join-room', { roomId: TEST_ROOM, peerName: 'Peer-2-Laptop' });
    const peer2JoinData = await peer2JoinPromise;

    await sleep(200);
    assert.strictEqual(peer2JoinData.occupancy, 2, 'Peer 2 should receive occupancy = 2');
    assert.strictEqual(hostOccupancyUpdate, 2, 'Host should receive live occupancy update = 2');
    console.log(`[Step 2 OK] Peer 2 joined; both peers see 2/5 in Room.`);

    // Connect Peers 3, 4, 5 to fill room to 5/5
    console.log('[Step 3] Adding Peers 3, 4, and 5 to reach capacity...');
    const peer3 = createClient('Peer3');
    const peer4 = createClient('Peer4');
    const peer5 = createClient('Peer5');
    clients.push(peer3, peer4, peer5);

    let currentOccupancy = 2;
    host.on('room-occupancy-update', (data) => {
      currentOccupancy = data.occupancy;
    });

    peer3.emit('join-room', { roomId: TEST_ROOM, peerName: 'Peer-3-Phone' });
    await sleep(150);
    peer4.emit('join-room', { roomId: TEST_ROOM, peerName: 'Peer-4-Tablet' });
    await sleep(150);
    peer5.emit('join-room', { roomId: TEST_ROOM, peerName: 'Peer-5-Workstation' });
    await sleep(200);

    assert.strictEqual(currentOccupancy, 5, 'Room should be at full 5/5 capacity');
    console.log(`[Step 3 OK] Room reached 5/5 capacity.`);

    // Attempt to add 6th peer (Should be rejected with room-full)
    console.log('[Step 4] Testing 6th peer rejection (Capped at 5)...');
    const peer6 = createClient('Peer6');
    clients.push(peer6);

    const roomFullPromise = new Promise((resolve) => {
      peer6.on('room-full', resolve);
    });

    peer6.emit('join-room', { roomId: TEST_ROOM, peerName: 'Peer-6-Intruder' });
    const fullInfo = await roomFullPromise;

    assert.ok(fullInfo, 'Peer 6 should receive room-full event');
    assert.strictEqual(fullInfo.maxPeers, 5);
    console.log(`[Step 4 OK] 6th peer rejected with 'room-full' message: "${fullInfo.message}"`);

    // Peer 5 leaves: real-time decrement
    console.log('[Step 5] Testing real-time occupancy decrement on leave...');
    let leftOccupancy = null;
    host.on('peer-left', (data) => {
      leftOccupancy = data.occupancy;
    });

    peer5.emit('leave-room');
    peer5.disconnect();
    await sleep(200);

    assert.strictEqual(leftOccupancy, 4, 'Occupancy should decrement to 4 when peer leaves');
    console.log(`[Step 5 OK] Peer left and occupancy decremented in real-time to 4/5.`);

    // ----------------------------------------------------
    // TEST 2: Automatic WebRTC Post-Auth Handshake Signaling
    // ----------------------------------------------------
    console.log('\n[Step 6] Testing automatic WebRTC signal relay between Host and Peer 2...');
    let signalReceived = false;

    peer2.on('signal', (data) => {
      if (data.senderPeerId === host.id && data.signal.type === 'test-offer') {
        signalReceived = true;
      }
    });

    host.emit('signal', {
      targetPeerId: peer2.id,
      signal: { type: 'test-offer', sdp: 'v=0...' }
    });

    await sleep(200);
    assert.strictEqual(signalReceived, true, 'Peer 2 should receive relayed WebRTC signal from Host');
    console.log(`[Step 6 OK] WebRTC signaling relayed cleanly between peers.`);

    // ----------------------------------------------------
    // TEST 3: Mutual Exclusion Transfer Lock
    // ----------------------------------------------------
    console.log('\n[Step 7] Testing Mutual Exclusion Lock Acquisition...');

    let hostSawLock = null;
    let peer2SawLock = null;

    host.on('transfer-lock-acquired', (data) => {
      hostSawLock = data;
    });
    peer2.on('transfer-lock-acquired', (data) => {
      peer2SawLock = data;
    });

    // Peer 2 acquires lock
    const acquireRes = await new Promise((resolve) => {
      peer2.emit('acquire-transfer-lock', resolve);
    });

    assert.strictEqual(acquireRes.success, true, 'Peer 2 should successfully acquire transfer lock');
    await sleep(150);

    assert.ok(hostSawLock, 'Host should receive transfer-lock-acquired event');
    assert.strictEqual(hostSawLock.senderId, peer2.id);
    assert.strictEqual(peer2SawLock.senderId, peer2.id);
    console.log(`[Step 7 OK] Peer 2 acquired lock. All peers notified (${hostSawLock.senderName}).`);

    // Host attempts to acquire lock while held by Peer 2 (Must be rejected)
    console.log('[Step 8] Testing Lock Contention (Host attempting to broadcast while locked)...');
    const hostAcquireRes = await new Promise((resolve) => {
      host.emit('acquire-transfer-lock', resolve);
    });

    assert.strictEqual(hostAcquireRes.success, false, 'Host must be rejected while lock is held');
    console.log(`[Step 8 OK] Blocked simultaneous broadcast: "${hostAcquireRes.error}".`);

    // Peer 2 releases lock
    console.log('[Step 9] Releasing Transfer Lock...');
    let releasedNotification = false;
    host.on('transfer-lock-released', () => {
      releasedNotification = true;
    });

    const releaseRes = await new Promise((resolve) => {
      peer2.emit('release-transfer-lock', resolve);
    });

    assert.strictEqual(releaseRes.success, true, 'Peer 2 should successfully release transfer lock');
    await sleep(150);
    assert.strictEqual(releasedNotification, true, 'All peers should receive transfer-lock-released');
    console.log(`[Step 9 OK] Transfer lock released and room unlocked for all participants.`);

    // Safety fallback: Sender acquires lock and abruptly disconnects
    console.log('[Step 10] Testing Safety Fallback: Sender abruptly disconnects mid-transfer...');
    const peer3AcquireRes = await new Promise((resolve) => {
      peer3.emit('acquire-transfer-lock', resolve);
    });
    assert.strictEqual(peer3AcquireRes.success, true);

    let fallbackReleaseReason = null;
    host.on('transfer-lock-released', (data) => {
      fallbackReleaseReason = data.reason;
    });

    // Peer 3 disconnects without releasing
    peer3.disconnect();
    await sleep(250);

    assert.strictEqual(fallbackReleaseReason, 'sender-disconnected', 'Server must auto-release lock on sender disconnect');
    console.log(`[Step 10 OK] Safety fallback verified: lock auto-released with reason: ${fallbackReleaseReason}.`);

    console.log('\n======================================================');
    console.log(' [ALL PASS] Occupancy, WebRTC & Transfer Lock Verified!');
    console.log('======================================================\n');
  } finally {
    clients.forEach((c) => {
      try {
        c.disconnect();
      } catch {}
    });
  }
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n[TEST FAILED]:', err);
    process.exit(1);
  });
