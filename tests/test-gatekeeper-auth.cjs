const { io } = require('socket.io-client');
const assert = require('assert');

async function testGatekeeperAndSecurity() {
  console.log('\n======================================================');
  console.log(' DropLink2 Room Password Gatekeeper & Security Test');
  console.log('======================================================\n');

  const SERVER_URL = 'http://localhost:3001';
  const PROTECTED_ROOM = 'test-protected-room-' + Date.now();
  const PASSWORD = 'SuperSecurePassword456!';
  const WRONG_PASSWORD = 'IncorrectPassword123';

  console.log(`[Step 1] Connecting Host (Peer 1) and creating protected room #${PROTECTED_ROOM}...`);
  const host = io(SERVER_URL, { transports: ['polling', 'websocket'] });
  await new Promise((resolve) => host.on('connect', resolve));

  const hostJoinedPromise = new Promise((resolve) => {
    host.on('room-joined', resolve);
  });

  host.emit('join-room', { roomId: PROTECTED_ROOM, password: PASSWORD });
  const hostJoined = await hostJoinedPromise;
  assert.strictEqual(hostJoined.roomId, PROTECTED_ROOM);
  assert.strictEqual(hostJoined.isProtected, true);
  console.log(`[Step 1 OK] Host created protected room with password hash.`);

  console.log(`[Step 2] Testing Receiver without password (Unauthenticated Access)...`);
  const receiverNoPass = io(SERVER_URL, { transports: ['polling', 'websocket'] });
  await new Promise((resolve) => receiverNoPass.on('connect', resolve));

  const authRequiredPromise = new Promise((resolve) => {
    receiverNoPass.on('room-auth-required', resolve);
  });

  receiverNoPass.emit('join-room', { roomId: PROTECTED_ROOM });
  const authReq = await authRequiredPromise;
  assert.strictEqual(authReq.roomId, PROTECTED_ROOM);
  console.log(`[Step 2 OK] Blocked unauthenticated join: Received 'room-auth-required'.`);
  receiverNoPass.disconnect();

  console.log(`[Step 3] Testing Receiver with WRONG password...`);
  const receiverWrongPass = io(SERVER_URL, { transports: ['polling', 'websocket'] });
  await new Promise((resolve) => receiverWrongPass.on('connect', resolve));

  const authFailedPromise = new Promise((resolve) => {
    receiverWrongPass.on('room-auth-failed', resolve);
  });

  receiverWrongPass.emit('join-room', { roomId: PROTECTED_ROOM, password: WRONG_PASSWORD });
  const authFailed = await authFailedPromise;
  assert.strictEqual(authFailed.roomId, PROTECTED_ROOM);
  console.log(`[Step 3 OK] Blocked invalid credentials: Received 'room-auth-failed'.`);
  receiverWrongPass.disconnect();

  console.log(`[Step 4] Testing Receiver with CORRECT password...`);
  const receiverGood = io(SERVER_URL, { transports: ['polling', 'websocket'] });
  await new Promise((resolve) => receiverGood.on('connect', resolve));

  const hostSawPeerPromise = new Promise((resolve) => {
    host.on('peer-joined', resolve);
  });

  const receiverJoinedPromise = new Promise((resolve) => {
    receiverGood.on('room-joined', resolve);
  });

  receiverGood.emit('join-room', { roomId: PROTECTED_ROOM, password: PASSWORD });
  const receiverJoined = await receiverJoinedPromise;
  const hostSawPeer = await hostSawPeerPromise;

  assert.strictEqual(receiverJoined.roomId, PROTECTED_ROOM);
  assert.strictEqual(receiverJoined.isProtected, true);
  assert.strictEqual(hostSawPeer.peerId, receiverGood.id);
  console.log(`[Step 4 OK] Authenticated successfully! Both peers joined #${PROTECTED_ROOM}.`);

  console.log(`[Step 5] Testing Signaling Relay between Authenticated Peers...`);
  const signalPromise = new Promise((resolve) => {
    receiverGood.on('signal', resolve);
  });

  host.emit('signal', { targetPeerId: receiverGood.id, signal: { type: 'e2ee-handshake', keyCheck: true } });
  const signalData = await signalPromise;
  assert.strictEqual(signalData.senderPeerId, host.id);
  assert.strictEqual(signalData.signal.type, 'e2ee-handshake');
  console.log(`[Step 5 OK] Signaling relayed between authenticated peers.`);

  console.log(`[Step 6] Testing Open Room (Zero Password)...`);
  const OPEN_ROOM = 'test-open-room-' + Date.now();
  const openPeer1 = io(SERVER_URL, { transports: ['polling', 'websocket'] });
  await new Promise((resolve) => openPeer1.on('connect', resolve));
  const openPeer1JoinedPromise = new Promise((resolve) => openPeer1.on('room-joined', resolve));
  openPeer1.emit('join-room', OPEN_ROOM);
  const openJoined = await openPeer1JoinedPromise;
  assert.strictEqual(openJoined.isProtected, false);
  console.log(`[Step 6 OK] Open room #${OPEN_ROOM} permits direct entry without password.`);

  host.disconnect();
  receiverGood.disconnect();
  openPeer1.disconnect();

  console.log('\n[ALL PASS] Room Password Gatekeeper & Access Control verified 100%!\n');
}

testGatekeeperAndSecurity().catch((err) => {
  console.error('\n[FAIL] Test error:', err);
  process.exit(1);
});
