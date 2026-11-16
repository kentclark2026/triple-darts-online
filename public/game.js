import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js';

const socket = window.io();
const $ = (id) => document.getElementById(id);
const COLORS = ['#c6f46e', '#74ddce', '#ffb981'];
const NUMBERS = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
const START_SCORE = 301;
const storageKey = 'triple-darts-player-v1';
const roomKey = 'triple-darts-room-v1';
const remembered = readJSON(storageKey) || {};
const fallbackToken = Array.from({ length: 6 }, () => Math.random().toString(36).slice(2)).join('').slice(0, 32);
const playerToken = remembered.token || (window.crypto?.randomUUID?.().replaceAll('-', '') || fallbackToken);
let myId = null;
let roomCode = null;
let roomState = null;
let toastTimer = null;
let resultTimer = null;
let sceneReady = false;
let renderer, scene, camera, raycaster, boardPlane, stageObserver;
let shotModels = new Map();
let flightAnimations = [];
let shownTurn = null;
let aimed = { x: 0, y: 0.60 };
let chargeActive = false;
let chargeStart = 0;
let currentPower = 0.78;
let chargeRAF = 0;
let pendingThrow = false;
let overlayDismissed = false;

function readJSON(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }
function saveJSON(key, data) { try { localStorage.setItem(key, JSON.stringify(data)); } catch { /* private browsing */ } }
function removeStored(key) { try { localStorage.removeItem(key); } catch { /* private browsing */ } }
function escapeHtml(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function text(id, value) { $(id).textContent = value; }
function show(id, visible) { $(id).classList.toggle('hide', !visible); }
function buttonBusy(id, busy) { $(id).disabled = busy; }
function playerColor(index) { return COLORS[index % COLORS.length]; }
function shortName(name) { return String(name).trim().slice(0, 1).toUpperCase() || 'P'; }
function hostPlayer() { return roomState?.players.find(p => p.id === roomState.hostId); }
function myPlayer() { return roomState?.players.find(p => p.id === myId); }
function isHost() { return Boolean(roomState && roomState.hostId === myId); }
function activePlayer() { return roomState?.players[roomState.turnIndex]; }
function isMyTurn() { return roomState?.phase === 'playing' && activePlayer()?.id === myId && !roomState.turnEnding && socket.connected; }
function inviteUrl() { return `${location.origin}${location.pathname}?room=${encodeURIComponent(roomCode)}`; }

function toast(message, type = 'normal') {
  const element = $('toast');
  element.textContent = message;
  element.className = `toast show${type === 'error' ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 3200);
}

function updateUserStorage() {
  saveJSON(storageKey, { token: playerToken, name: $('player-name').value.trim() });
}

async function emitAck(eventName, data) {
  return new Promise(resolve => {
    const timeout = setTimeout(() => resolve({ ok: false, error: 'Connection timed out. Try again.' }), 10000);
    socket.emit(eventName, data, (result) => { clearTimeout(timeout); resolve(result || { ok: false, error: 'No response from server.' }); });
  });
}

async function createRoom() {
  if (!socket.connected) return toast('Connecting to the game server. Try again in a moment.', 'error');
  updateUserStorage();
  buttonBusy('create-room', true);
  const response = await emitAck('room:create', { name: $('player-name').value, token: playerToken });
  buttonBusy('create-room', false);
  if (!response.ok) return toast(response.error, 'error');
  enterRoom(response);
  toast('Room created! Invite two friends 🎯');
}

async function joinRoom(codeArg) {
  if (!socket.connected) return toast('Connecting to the game server. Try again in a moment.', 'error');
  const code = (codeArg || $('join-code').value).trim().toUpperCase();
  if (code.length !== 5) return toast('Enter the 5-character room code.', 'error');
  updateUserStorage();
  buttonBusy('join-room', true);
  const response = await emitAck('room:join', { code, name: $('player-name').value, token: playerToken });
  buttonBusy('join-room', false);
  if (!response.ok) return toast(response.error, 'error');
  enterRoom(response);
  toast('You joined the game room!');
}

function enterRoom({ code, playerId }) {
  roomCode = code;
  myId = playerId;
  overlayDismissed = false;
  saveJSON(roomKey, { code, playerId });
  history.replaceState(null, '', `?room=${encodeURIComponent(code)}`);
  show('welcome-screen', false);
  show('room-screen', true);
  show('top-exit', true);
  text('room-code-pill', code);
  text('lobby-code', code);
  ensureScene();
  requestAnimationFrame(resizeScene);
}

function updateRoom(data) {
  const previousPhase = roomState?.phase;
  roomState = data;
  if (previousPhase === 'finished' && data.phase === 'playing') {
    overlayDismissed = false;
    show('winner-overlay', false);
  }
  if (!roomCode) {
    const stored = readJSON(roomKey);
    if (stored?.code === data.code) enterRoom({ code: data.code, playerId: stored.playerId });
    else return;
  }
  const isLobby = data.phase === 'lobby';
  const isGame = data.phase !== 'lobby';
  show('lobby-details', isLobby);
  show('score-details', isGame);
  show('game-controls', isGame);
  show('lobby-footer', isLobby);
  show('stage-message', isLobby || (isGame && !isMyTurn()));
  text('room-code-pill', data.code);
  text('lobby-code', data.code);
  text('player-count', `${data.players.length} / 3`);
  if (isLobby) {
    renderLobby();
    text('turn-pill', 'PRACTICE YOUR AIM');
    text('stage-message', 'Invite your friends to begin!');
    text('side-status', 'Waiting for players');
    text('side-description', `${data.players.length} of 3 joined. Share the invite link and start when everyone arrives.`);
  } else {
    renderScoreboard();
    renderControls();
    if (data.phase === 'finished') {
      text('turn-pill', 'GAME COMPLETE');
      text('side-status', 'We have a winner!');
      text('side-description', `${data.players.find(p => p.id === data.winnerId)?.name || 'A player'} reached exactly zero.`);
      if (!overlayDismissed) renderWinner();
    } else {
      const active = activePlayer();
      text('turn-pill', isMyTurn() ? '✦ YOUR TURN' : data.turnEnding ? 'NEXT THROWER…' : `${active?.name || 'Player'}'S TURN`);
      text('side-status', isMyTurn() ? 'You’re up next!' : data.turnEnding ? 'Changing turns…' : `It's ${active?.name || 'a player'}'s turn`);
      text('side-description', isMyTurn() ? 'Aim at the board. Hold and release the throw button to launch your dart.' : 'Watch the board live as your friend takes a shot.');
      text('stage-message', data.turnEnding ? 'Passing the darts…' : `Waiting for ${active?.name || 'player'}…`);
    }
  }
  if (data.lastThrow) {
    const shotPlayer = data.players.find(p => p.id === data.lastThrow.playerId);
    text('last-shot', `${shotPlayer?.name || 'Player'}: ${data.lastThrow.bust ? 'BUST!' : data.lastThrow.label} (${data.lastThrow.points} pts)`);
  } else text('last-shot', 'No darts thrown yet');
  syncModels(data);
  updateAimIndicator();
}

function renderLobby() {
  const players = roomState.players;
  let html = '';
  for (let i = 0; i < 3; i++) {
    const p = players[i];
    html += p ? `<div class="lobby-player"><div class="avatar" style="background:${playerColor(i)}">${escapeHtml(shortName(p.name))}</div><div><strong>${escapeHtml(p.name)}${p.id === myId ? ' (You)' : ''}</strong><small>${p.id === roomState.hostId ? 'Room host' : p.connected ? 'Ready to play' : 'Disconnected'}${p.connected ? ' ✓' : ''}</small></div></div>`
      : `<div class="lobby-player empty"><div class="avatar" style="background:#506763">+</div><div><strong>Open seat</strong><small>Waiting for a friend…</small></div></div>`;
  }
  $('lobby-players').innerHTML = html;
  const canStart = isHost() && players.length === 3 && players.every(p => p.connected);
  $('start-game').disabled = !canStart;
  text('start-game', canStart ? 'START THE MATCH →' : isHost() ? 'WAITING FOR PLAYERS…' : 'HOST WILL START THE MATCH');
  text('host-message', isHost() ? 'You are the host. Start when all 3 are here.' : `Waiting for ${hostPlayer()?.name || 'the host'} to start.`);
}

function renderScoreboard() {
  const state = roomState;
  const active = activePlayer();
  $('score-players').innerHTML = state.players.map((p, i) => {
    const turn = state.phase === 'playing' && p.id === active?.id;
    return `<div class="score-player ${turn ? 'active' : ''} ${p.id === myId ? 'you' : ''}"><div class="score-player-top"><div class="avatar" style="background:${playerColor(i)}">${escapeHtml(shortName(p.name))}</div><div class="player-info"><strong>${escapeHtml(p.name)}</strong><small>${!p.connected ? 'Offline' : p.id === myId ? 'You' : p.id === state.hostId ? 'Host' : 'Player'}</small></div></div><div class="score-value">${p.score}</div>${turn ? '<div class="active-flag">● THROWING NOW</div>' : ''}</div>`;
  }).join('');
  text('round-label', `TURN ${String(state.turnNumber).padStart(2, '0')}   •   ${state.dartsThrown} / 3 DARTS`);
  const skip = state.phase === 'playing' && isHost() && !active?.connected && !state.turnEnding;
  show('skip-container', skip);
}

function renderControls() {
  const playing = roomState.phase === 'playing';
  const canThrow = isMyTurn() && !pendingThrow;
  $('throw-btn').disabled = !canThrow;
  $('board-stage').style.cursor = canThrow ? 'crosshair' : 'default';
  show('aim-dot', playing && canThrow);
  if (canThrow) {
    text('control-headline', `${3 - roomState.dartsThrown} DART${3 - roomState.dartsThrown !== 1 ? 'S' : ''} LEFT — YOUR TURN`);
    text('control-help', 'Tap or drag on the board to aim. Hold to charge.');
  } else {
    text('control-headline', playing && roomState.turnEnding ? 'NICE THROW — CHANGING TURNS' : 'WAITING FOR YOUR TURN');
    text('control-help', 'Watch your friends throw in real time.');
  }
}

function renderWinner() {
  const winner = roomState.players.find(p => p.id === roomState.winnerId);
  if (!winner) return;
  text('winner-name', winner.id === myId ? 'YOU WON! 🏆' : `${winner.name.toUpperCase()} WINS!`);
  text('winner-description', winner.id === myId ? 'You hit exactly zero. Champion of the group chat!' : `${winner.name} takes the crown. Ready for a rematch?`);
  show('rematch-btn', isHost());
  show('winner-overlay', true);
}

async function copyLink() {
  const url = inviteUrl();
  try { await navigator.clipboard.writeText(url); toast('Invite link copied! Send it to 2 friends.'); }
  catch { window.prompt('Copy this invite link:', url); }
}

async function shareLink() {
  if (navigator.share) {
    try { await navigator.share({ title: 'Play Triple Darts with me!', text: 'Join my 3D darts game 🎯', url: inviteUrl() }); }
    catch (error) { if (error.name !== 'AbortError') copyLink(); }
  } else copyLink();
}

async function leaveRoom() {
  if (!roomCode) return;
  await emitAck('room:leave', { code: roomCode });
  roomCode = null; myId = null; roomState = null; shownTurn = null;
  removeStored(roomKey);
  history.replaceState(null, '', location.pathname);
  show('welcome-screen', true); show('room-screen', false);
  show('top-exit', false); show('winner-overlay', false);
  clearDarts();
  toast('You left the room.');
}

function bindUI() {
  $('player-name').value = remembered.name || '';
  $('join-code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  const incomingCode = new URLSearchParams(location.search).get('room');
  if (incomingCode && /^[A-Z0-9]{5}$/i.test(incomingCode)) {
    $('join-code').value = incomingCode.toUpperCase();
    show('invite-notice', true);
  }
  $('create-room').addEventListener('click', createRoom);
  $('join-room').addEventListener('click', () => joinRoom());
  $('player-name').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); incomingCode ? joinRoom() : createRoom(); } });
  $('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); joinRoom(); } });
  $('copy-link').addEventListener('click', copyLink);
  $('share-link').addEventListener('click', shareLink);
  $('top-exit').addEventListener('click', leaveRoom);
  $('start-game').addEventListener('click', async () => {
    const r = await emitAck('room:start', { code: roomCode });
    if (!r.ok) toast(r.error, 'error');
  });
  $('rematch-btn').addEventListener('click', async () => {
    const r = await emitAck('game:rematch', { code: roomCode });
    if (!r.ok) toast(r.error, 'error');
    else { overlayDismissed = false; show('winner-overlay', false); }
  });
  $('winner-close').addEventListener('click', () => { overlayDismissed = true; show('winner-overlay', false); });
  $('skip-turn').addEventListener('click', async () => {
    const r = await emitAck('game:skip', { code: roomCode });
    if (!r.ok) toast(r.error, 'error');
  });
  $('board-stage').addEventListener('pointerdown', e => {
    if (!isMyTurn()) return;
    if (e.target.closest('button')) return;
    $('board-stage').setPointerCapture(e.pointerId);
    setAimFromPointer(e);
  });
  $('board-stage').addEventListener('pointermove', e => {
    if (e.buttons && isMyTurn()) setAimFromPointer(e);
  });
  const throwButton = $('throw-btn');
  throwButton.addEventListener('pointerdown', e => {
    if (!isMyTurn()) return;
    e.preventDefault();
    throwButton.setPointerCapture(e.pointerId);
    beginCharge();
  });
  throwButton.addEventListener('pointerup', e => {
    if (!chargeActive) return;
    e.preventDefault();
    endCharge(true);
  });
  throwButton.addEventListener('pointercancel', () => endCharge(false));
  window.addEventListener('keydown', e => {
    if (e.code !== 'Space' || e.repeat || ['INPUT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement?.tagName)) return;
    if (!isMyTurn()) return;
    e.preventDefault(); beginCharge();
  });
  window.addEventListener('keyup', e => { if (e.code === 'Space' && chargeActive) { e.preventDefault(); endCharge(true); } });
}

function beginCharge() {
  if (chargeActive || !isMyTurn() || pendingThrow) return;
  chargeActive = true;
  chargeStart = performance.now();
  currentPower = 0.78;
  $('throw-btn').classList.add('charging');
  updatePowerUI();
  chargeRAF = requestAnimationFrame(chargeLoop);
}
function chargeLoop(t) {
  if (!chargeActive) return;
  const hold = t - chargeStart;
  if (hold > 140) {
    const phase = ((hold - 140) % 2000) / 2000;
    const triangle = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
    currentPower = 0.36 + 0.64 * triangle;
  }
  updatePowerUI();
  chargeRAF = requestAnimationFrame(chargeLoop);
}
function updatePowerUI() {
  const value = Math.round(currentPower * 100);
  $('power-fill').style.width = `${value}%`;
  text('power-number', `${value}%`);
}
function endCharge(doThrow) {
  if (!chargeActive) return;
  chargeActive = false;
  cancelAnimationFrame(chargeRAF);
  $('throw-btn').classList.remove('charging');
  if (doThrow) fireDart();
}
async function fireDart() {
  if (!isMyTurn() || pendingThrow) return;
  pendingThrow = true;
  $('throw-btn').disabled = true;
  const r = await emitAck('game:throw', { code: roomCode, x: aimed.x, y: aimed.y, power: currentPower });
  pendingThrow = false;
  if (!r.ok) toast(r.error, 'error');
  if (roomState) renderControls();
}

function ensureScene() {
  if (sceneReady) return;
  sceneReady = true;
  const holder = $('board-canvas');
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(0, 0, 8.1);
  camera.lookAt(0, 0, 0);
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.4;
  holder.appendChild(renderer.domElement);
  scene.add(new THREE.AmbientLight(0xf1ffed, 1.7));
  const key = new THREE.PointLight(0xe4ffa8, 75); key.position.set(2.5, 3.6, 5.6); scene.add(key);
  const rim = new THREE.PointLight(0x80ced0, 35); rim.position.set(-3, -2, 4); scene.add(rim);
  raycaster = new THREE.Raycaster();
  boardPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -0.3);
  makeBoard();
  stageObserver = new ResizeObserver(resizeScene);
  stageObserver.observe($('board-stage'));
  window.addEventListener('resize', resizeScene);
  requestAnimationFrame(renderFrame);
}

function boardMaterial(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0.04, side: THREE.DoubleSide, ...opts });
}
function circle(radius, color, z, segments = 96, materialProps = {}) {
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(radius, segments), boardMaterial(color, materialProps));
  mesh.position.z = z; scene.add(mesh); return mesh;
}
function ring(inner, outer, color, z, props = {}) {
  const mesh = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 120), boardMaterial(color, props));
  mesh.position.z = z; scene.add(mesh); return mesh;
}
function wedge(innerR, outerR, center, halfWidth, color, z) {
  const shape = new THREE.Shape();
  const steps = 10;
  const a0 = center - halfWidth, a1 = center + halfWidth;
  shape.moveTo(innerR * Math.sin(a0), innerR * Math.cos(a0));
  shape.lineTo(outerR * Math.sin(a0), outerR * Math.cos(a0));
  for (let i = 1; i <= steps; i++) {
    const a = a0 + (a1 - a0) * i / steps;
    shape.lineTo(outerR * Math.sin(a), outerR * Math.cos(a));
  }
  for (let i = steps; i >= 0; i--) {
    const a = a0 + (a1 - a0) * i / steps;
    shape.lineTo(innerR * Math.sin(a), innerR * Math.cos(a));
  }
  shape.closePath();
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), boardMaterial(color));
  mesh.position.z = z; scene.add(mesh);
}
function wireCircle(r, z) {
  const vertices = [];
  for (let k = 0; k <= 120; k++) { const a = k / 120 * Math.PI * 2; vertices.push(Math.cos(a) * r, Math.sin(a) * r, z); }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0xbac7b4, transparent: true, opacity: 0.78 }));
  scene.add(line);
}
function textSprite(number) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fbefc7'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 5;
  ctx.font = 'bold 66px Arial'; ctx.fillText(String(number), 64, 67);
  const texture = new THREE.CanvasTexture(c); texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const s = new THREE.Sprite(material); s.scale.set(0.36, 0.36, 1); return s;
}

function makeBoard() {
  const backing = new THREE.Mesh(new THREE.CylinderGeometry(2.48, 2.48, 0.32, 120), boardMaterial('#101a1c', { roughness: 0.54, metalness: 0.36 }));
  backing.rotation.x = Math.PI / 2;
  backing.position.z = -0.04;
  scene.add(backing);
  ring(2.38, 2.46, '#283b3e', 0.134);
  ring(2.05, 2.36, '#142123', 0.16);
  ring(2.01, 2.045, '#819888', 0.18);
  circle(2.0, '#e1dabc', 0.184);
  for (let i = 0; i < 20; i++) {
    const angle = i * Math.PI / 10;
    const half = Math.PI / 20;
    const pale = i % 2 === 0;
    wedge(.187, 1.162, angle, half, pale ? '#dfdac7' : '#232b2d', .195);
    wedge(1.162, 1.258, angle, half, pale ? '#b52b30' : '#328046', .199);
    wedge(1.258, 1.906, angle, half, pale ? '#dfdac7' : '#232b2d', .195);
    wedge(1.906, 2, angle, half, pale ? '#b52b30' : '#328046', .202);
    const sprite = textSprite(NUMBERS[i]);
    sprite.position.set(2.236 * Math.sin(angle), 2.236 * Math.cos(angle), .29);
    scene.add(sprite);
    const edgeAngle = angle - half;
    const points = [new THREE.Vector3(.185 * Math.sin(edgeAngle), .185 * Math.cos(edgeAngle), .235), new THREE.Vector3(2.005 * Math.sin(edgeAngle), 2.005 * Math.cos(edgeAngle), .235)];
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0xaec3bb, transparent: true, opacity: .80 })));
  }
  for (const r of [.187, 1.162, 1.258, 1.906, 2]) wireCircle(r, .239);
  circle(.187, '#24823c', .24);
  circle(.0748, '#b42d31', .244);
  ring(.078, .09, '#9cc6a6', .248);
  ring(2.47, 2.50, '#536968', .13, { metalness: .65, roughness: .35 });
  // Four tiny screws and numbers around the edge add depth to the board.
  const screwMaterial = boardMaterial('#aab5b3', { metalness: .9, roughness: .3 });
  for (let a = 0; a < 4; a++) {
    const theta = (a + .5) * Math.PI / 2;
    const screw = new THREE.Mesh(new THREE.SphereGeometry(.027, 10, 10), screwMaterial);
    screw.position.set(2.41 * Math.cos(theta), 2.41 * Math.sin(theta), .2); scene.add(screw);
  }
}

function dartModel(colorHex) {
  const group = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: '#d3e1db', metalness: .86, roughness: .24 });
  const darkMetal = new THREE.MeshStandardMaterial({ color: '#4c5a61', metalness: .75, roughness: .3 });
  const color = new THREE.MeshStandardMaterial({ color: colorHex, roughness: .39, metalness: .14, side: THREE.DoubleSide });
  const tip = new THREE.Mesh(new THREE.ConeGeometry(.035, .23, 12), metal);
  tip.rotation.x = -Math.PI / 2; tip.position.z = .23; group.add(tip);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(.056, .048, .34, 12), metal);
  barrel.rotation.x = Math.PI / 2; barrel.position.z = .48; group.add(barrel);
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(.045, .045, .13, 12), darkMetal);
  grip.rotation.x = Math.PI / 2; grip.position.z = .69; group.add(grip);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(.020, .025, .36, 10), metal);
  shaft.rotation.x = Math.PI / 2; shaft.position.z = .88; group.add(shaft);
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2;
    const ux = Math.cos(a), uy = Math.sin(a);
    const geometry = new THREE.BufferGeometry();
    const points = new Float32Array([
      0, 0, 0.95,
      ux * .19, uy * .19, 1.19,
      0, 0, 1.26,
      0, 0, .95,
      ux * .19, uy * .19, 1.19,
      ux * .19, uy * .19, 1.00,
    ]);
    geometry.setAttribute('position', new THREE.BufferAttribute(points, 3));
    geometry.computeVertexNormals();
    group.add(new THREE.Mesh(geometry, color));
  }
  group.rotation.y = -.09; group.rotation.x = .07;
  return group;
}

function resizeScene() {
  if (!sceneReady || $('room-screen').classList.contains('hide')) return;
  const stage = $('board-stage');
  const w = stage.clientWidth, h = stage.clientHeight;
  if (w < 10 || h < 10) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.position.z = Math.max(7.6, 2.70 / (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect));
  camera.updateProjectionMatrix();
  updateAimIndicator();
}
function renderFrame(now) {
  requestAnimationFrame(renderFrame);
  if ($('room-screen').classList.contains('hide')) return;
  flightAnimations = flightAnimations.filter(anim => {
    const t = Math.min(1, (now - anim.started) / 550);
    const eased = 1 - Math.pow(1 - t, 3);
    anim.model.position.lerpVectors(anim.from, anim.to, eased);
    anim.model.rotation.x = .07 + (1 - eased) * -.42;
    anim.model.rotation.y = -.09 + (1 - eased) * .24;
    return t < 1;
  });
  renderer.render(scene, camera);
}
function setAimFromPointer(e) {
  if (!sceneReady) return;
  const rect = renderer.domElement.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const mouse = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(mouse, camera);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(boardPlane, hit)) return;
  aimed = { x: THREE.MathUtils.clamp(hit.x / 2, -1.30, 1.30), y: THREE.MathUtils.clamp(hit.y / 2, -1.30, 1.30) };
  updateAimIndicator();
}
function updateAimIndicator() {
  if (!sceneReady || !roomState || !isMyTurn()) return;
  const stage = $('board-stage');
  const p = new THREE.Vector3(aimed.x * 2, aimed.y * 2, .34).project(camera);
  $('aim-dot').style.left = `${(p.x * .5 + .5) * stage.clientWidth}px`;
  $('aim-dot').style.top = `${(-p.y * .5 + .5) * stage.clientHeight}px`;
}
function clearDarts() {
  for (const dart of shotModels.values()) scene?.remove(dart);
  shotModels.clear();
  flightAnimations = [];
}
function syncModels(state) {
  if (!sceneReady) return;
  if (shownTurn !== state.turnNumber || state.phase === 'lobby') {
    clearDarts();
    shownTurn = state.phase === 'lobby' ? null : state.turnNumber;
  }
  const visibleIds = new Set(state.turnDarts.map(d => d.id));
  for (const [id, model] of shotModels) {
    if (!visibleIds.has(id)) { scene.remove(model); shotModels.delete(id); }
  }
  for (const shot of state.turnDarts) if (!shotModels.has(shot.id)) addShot(shot, false);
}
function addShot(shot, animated = true) {
  if (!sceneReady || shotModels.has(shot.id)) return;
  const index = Math.max(0, roomState?.players.findIndex(p => p.id === shot.playerId) ?? 0);
  const dart = dartModel(playerColor(index));
  scene.add(dart);
  shotModels.set(shot.id, dart);
  const destination = new THREE.Vector3(shot.x * 2, shot.y * 2, 0);
  if (animated) {
    const from = new THREE.Vector3(destination.x + .85, destination.y - 1.3, 6.3);
    dart.position.copy(from);
    flightAnimations.push({ model: dart, from, to: destination, started: performance.now() });
  } else dart.position.copy(destination);
}
function flashShot(shot) {
  let message = shot.win ? '🎉 MATCH DART!' : shot.bust ? 'BUST — SCORE RESET!' : `${shot.label}  +${shot.points}`;
  const node = $('result-popup');
  node.textContent = message;
  node.className = `result-popup show${shot.bust ? ' bust' : shot.ring === 'bullseye' ? ' bullseye' : ''}`;
  clearTimeout(resultTimer);
  resultTimer = setTimeout(() => node.classList.remove('show'), 1450);
}

socket.on('connect', async () => {
  const stored = readJSON(roomKey);
  if (!stored?.code && !roomCode) return;
  const code = roomCode || stored.code;
  const invitedCode = new URLSearchParams(location.search).get('room')?.toUpperCase();
  if (!roomCode && invitedCode && invitedCode !== stored.code) return;
  const response = await emitAck('room:join', { code, name: $('player-name').value, token: playerToken });
  if (response.ok) enterRoom(response);
  else if (roomCode) toast('Could not rejoin: ' + response.error, 'error');
  else removeStored(roomKey);
});
socket.on('disconnect', () => { if (roomCode) toast('Connection lost. Trying to reconnect…', 'error'); });
socket.on('room:state', updateRoom);
socket.on('game:shot', shot => {
  if (roomCode && roomState && shot.playerId) {
    addShot(shot, true);
    flashShot(shot);
  }
});

bindUI();
