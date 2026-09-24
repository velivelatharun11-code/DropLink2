const { io } = require('socket.io-client');
const assert = require('assert');

async function runDualSessionVerification() {
  console.log('\n======================================================');
  console.log(' DropLink2 Dual-Session Signaling & Mesh Runtime Test');
  console.log('======================================================\n');

  const SERVER_URL = 'http://localhost:3001';
  const ROOM_ID = 'test-mesh-session';
  const SWITCH_ROOM_ID = 'omega-99';

  console.log(`[Step 1] Connecting Peer 1 (Host) to ${SERVER_URL}...`);
  const peer1 = io(SERVER_URL, { transports: ['polling', 'websocket'] });

  await new Promise((resolve) => peer1.on('connect', resolve));
  console.log(`[Step 1 OK] Peer 1 connected with socket id: ${peer1.id}`);

  console.log(`[Step 2] Peer 1 joining room: #${ROOM_ID}...`);
  peer1.emit('join-room', ROOM_ID);

  const peer1Joined = await new Promise((resolve) => {
    peer1.on('room-joined', (data) => resolve(data));
  });
  assert.strictEqual(peer1Joined.roomId, ROOM_ID);
  assert.deepStrictEqual(peer1Joined.existingPeers, []);
  console.log(`[Step 2 OK] Peer 1 joined #${ROOM_ID}. Initial existing peers: 0`);

  console.log(`[Step 3] Connecting Peer 2 (Receiver) to ${SERVER_URL}...`);
  const peer2 = io(SERVER_URL, { transports: ['polling', 'websocket'] });
  await new Promise((resolve) => peer2.on('connect', resolve));
  console.log(`[Step 3 OK] Peer 2 connected with socket id: ${peer2.id}`);

  console.log(`[Step 4] Peer 2 joining room: #${ROOM_ID}...`);
  const peer1SawPeer2Promise = new Promise((resolve) => {
    peer1.on('peer-joined', (data) => resolve(data));
  });

  const peer2JoinedPromise = new Promise((resolve) => {
    peer2.on('room-joined', (data) => resolve(data));
  });

  peer2.emit('join-room', ROOM_ID);

  const peer2Joined = await peer2JoinedPromise;
  const peer1SawPeer2 = await peer1SawPeer2Promise;

  assert.strictEqual(peer2Joined.roomId, ROOM_ID);
  assert.ok(peer2Joined.existingPeers.includes(peer1.id), 'Peer 2 should see Peer 1 as existing peer');
  assert.strictEqual(peer1SawPeer2.peerId, peer2.id, 'Peer 1 should receive peer-joined event for Peer 2');
  console.log(`[Step 4 OK] Dual sessions meshed! Peer 1 detected Peer 2; Peer 2 saw Peer 1.`);

  console.log(`[Step 5] Testing Signaling Relay (WebRTC SDP Offer / Answer)...`);
  const signalRelayPromise = new Promise((resolve) => {
    peer2.on('signal', (data) => {
      resolve(data);
    });
  });

  const dummyOffer = { type: 'offer', sdp: 'v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' };
  peer1.emit('signal', { targetPeerId: peer2.id, signal: dummyOffer });

  const receivedSignal = await signalRelayPromise;
  assert.strictEqual(receivedSignal.senderPeerId, peer1.id);
  assert.strictEqual(receivedSignal.signal.type, 'offer');
  console.log(`[Step 5 OK] Signaling relayed from Peer 1 -> Peer 2 via server relay.`);

  console.log(`[Step 6] Testing Room Switching: Peer 1 switching to #${SWITCH_ROOM_ID}...`);
  const peer2SawLeavePromise = new Promise((resolve) => {
    peer2.on('peer-left', (data) => resolve(data));
  });

  const peer1JoinedSwitchPromise = new Promise((resolve) => {
    peer1.on('room-joined', (data) => {
      if (data.roomId === SWITCH_ROOM_ID) resolve(data);
    });
  });

  peer1.emit('join-room', SWITCH_ROOM_ID);

  const peer2SawLeave = await peer2SawLeavePromise;
  const peer1SwitchData = await peer1JoinedSwitchPromise;

  assert.strictEqual(peer2SawLeave.peerId, peer1.id, 'Peer 2 should be notified of Peer 1 leaving');
  assert.strictEqual(peer1SwitchData.roomId, SWITCH_ROOM_ID);
  console.log(`[Step 6 OK] Peer 1 switched to #${SWITCH_ROOM_ID}. Peer 2 received peer-left teardown event.`);

  peer1.disconnect();
  peer2.disconnect();
  console.log('\n[PASS] All dual-session WebRTC mesh signaling tests completed successfully!\n');
}

runDualSessionVerification().catch((err) => {
  console.error('\n[FAIL] Dual-session verification error:', err);
  process.exit(1);
});
