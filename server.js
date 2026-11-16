'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const { scoreHit } = require('./scoring');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: false },
  maxHttpBufferSize: 10_000,
});

const PORT = Number(process.env.PORT) || 3000;
const STARTING_SCORE = 301;
const MAX_PLAYERS = 3;
const ROOM_TTL = 3 * 60 * 60 * 1000;
const rooms = new Map();
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

function randomCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(name) {
  const value = typeof name === 'string' ? name.replace(/[\x00-\x1F\x7F<>]/g, '').trim().slice(0, 18) : '';
  return value || 'Player';
}

function cleanToken(token) {
  return typeof token === 'string' && /^[a-zA-Z0-9_-]{12,96}$/.test(token) ? token : null;
}

function publicState(room) {
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    players: room.players.map(p => ({
      id: p.id, name: p.name, score: p.score, connected: p.connected,
    })),
    turnIndex: room.turnIndex,
    turnNumber: room.turnNumber,
    dartsThrown: room.dartsThrown,
    turnEnding: room.turnEnding,
    turnDarts: room.turnDarts,
    winnerId: room.winnerId,
    lastThrow: room.lastThrow,
    startingScore: STARTING_SCORE,
  };
}

function publish(room) {
  room.lastActive = Date.now();
  io.to(room.code).emit('room:state', publicState(room));
}

function error(ack, message) {
  if (typeof ack === 'function') ack({ ok: false, error: message });
}

function associate(socket, room, player) {
  if (socket.data.roomCode && socket.data.roomCode !== room.code) {
    socket.leave(socket.data.roomCode);
  }
  if (player.socketId && player.socketId !== socket.id) {
    const oldSocket = io.sockets.sockets.get(player.socketId);
    if (oldSocket) {
      oldSocket.leave(room.code);
      oldSocket.data.roomCode = null;
    }
  }
  player.socketId = socket.id;
  player.connected = true;
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  socket.join(room.code);
}

function getPlayerRoom(socket, code) {
  const room = rooms.get(String(code || '').trim().toUpperCase());
  if (!room || socket.data.roomCode !== room.code) return {};
  const player = room.players.find(p => p.id === socket.data.playerId && p.socketId === socket.id);
  return { room, player };
}

function resetGame(room) {
  room.phase = 'playing';
  room.turnIndex = 0;
  room.turnNumber = 1;
  room.turnEnding = false;
  room.dartsThrown = 0;
  room.turnStartScore = STARTING_SCORE;
  room.turnDarts = [];
  room.lastThrow = null;
  room.winnerId = null;
  for (const player of room.players) {
    player.score = STARTING_SCORE;
    player.lastShotAt = 0;
  }
}

function gaussian() {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}


io.on('connection', (socket) => {
  socket.on('room:create', (payload = {}, ack) => {
    const token = cleanToken(payload.token);
    if (!token) return error(ack, 'Please refresh the page and try again.');
    const code = randomCode();
    const player = {
      id: crypto.randomUUID(),
      token,
      socketId: socket.id,
      name: cleanName(payload.name),
      score: STARTING_SCORE,
      connected: true,
      lastShotAt: 0,
    };
    const room = {
      code, phase: 'lobby', hostId: player.id, players: [player],
      turnIndex: 0, turnNumber: 1, dartsThrown: 0, turnEnding: false,
      turnStartScore: STARTING_SCORE, turnDarts: [], lastThrow: null,
      winnerId: null, lastActive: Date.now(),
    };
    rooms.set(code, room);
    associate(socket, room, player);
    if (typeof ack === 'function') ack({ ok: true, code, playerId: player.id });
    publish(room);
  });

  socket.on('room:join', (payload = {}, ack) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const token = cleanToken(payload.token);
    const room = rooms.get(code);
    if (!room) return error(ack, 'Room not found. Check the invite code.');
    if (!token) return error(ack, 'Please refresh the page and try again.');
    let player = room.players.find(p => p.token === token);
    if (!player) {
      if (room.phase !== 'lobby') return error(ack, 'This match has already started.');
      if (room.players.length >= MAX_PLAYERS) return error(ack, 'This room is full (3 players).');
      player = {
        id: crypto.randomUUID(), token, socketId: null,
        name: cleanName(payload.name), score: STARTING_SCORE,
        connected: false, lastShotAt: 0,
      };
      room.players.push(player);
    }
    associate(socket, room, player);
    if (typeof ack === 'function') ack({ ok: true, code, playerId: player.id });
    publish(room);
  });

  socket.on('room:start', (payload = {}, ack) => {
    const { room, player } = getPlayerRoom(socket, payload.code);
    if (!room || !player) return error(ack, 'You are not in this room.');
    if (room.hostId !== player.id) return error(ack, 'Only the host can start the game.');
    if (room.phase !== 'lobby') return error(ack, 'Match already started.');
    if (room.players.length !== MAX_PLAYERS || room.players.some(p => !p.connected)) {
      return error(ack, 'All 3 players must be online to begin.');
    }
    resetGame(room);
    if (typeof ack === 'function') ack({ ok: true });
    publish(room);
  });

  socket.on('game:throw', (payload = {}, ack) => {
    const { room, player } = getPlayerRoom(socket, payload.code);
    if (!room || !player) return error(ack, 'You are not in this room.');
    if (room.phase !== 'playing') return error(ack, 'The game has not started.');
    if (room.turnEnding) return error(ack, 'The next turn is starting.');
    if (room.players[room.turnIndex]?.id !== player.id) return error(ack, 'Wait for your turn.');
    if (!Number.isFinite(payload.x) || !Number.isFinite(payload.y) || !Number.isFinite(payload.power)) {
      return error(ack, 'Invalid throw. Try again.');
    }
    if (Date.now() - player.lastShotAt < 350) return error(ack, 'Give the dart a moment.');
    player.lastShotAt = Date.now();
    const x = Math.max(-1.3, Math.min(1.3, payload.x));
    const y = Math.max(-1.3, Math.min(1.3, payload.y));
    const power = Math.max(0, Math.min(1, payload.power));
    const spread = 0.030 + Math.abs(power - 0.78) * 0.18;
    const landingX = Math.max(-1.35, Math.min(1.35, x + gaussian() * spread));
    const landingY = Math.max(-1.35, Math.min(1.35, y + gaussian() * spread));
    const hit = scoreHit(landingX, landingY);
    const previousScore = player.score;
    let bust = false;
    let win = false;
    if (hit.points > player.score) {
      bust = true;
      player.score = room.turnStartScore;
    } else {
      player.score -= hit.points;
      if (player.score === 0) win = true;
    }
    room.dartsThrown += 1;
    const shot = {
      id: crypto.randomUUID(), playerId: player.id,
      x: Math.round(landingX * 10000) / 10000,
      y: Math.round(landingY * 10000) / 10000,
      points: hit.points, label: hit.label, ring: hit.ring,
      previousScore, remainingScore: player.score,
      bust, win, dartNumber: room.dartsThrown,
      turnNumber: room.turnNumber,
    };
    room.turnDarts.push(shot);
    room.lastThrow = shot;
    if (typeof ack === 'function') ack({ ok: true, shotId: shot.id });
    io.to(room.code).emit('game:shot', shot);
    if (win) {
      room.phase = 'finished';
      room.winnerId = player.id;
      room.turnEnding = true;
    } else if (bust || room.dartsThrown >= 3) {
      room.turnEnding = true;
      const thisTurn = room.turnNumber;
      setTimeout(() => {
        if (rooms.get(room.code) !== room || room.phase !== 'playing' || room.turnNumber !== thisTurn) return;
        room.turnIndex = (room.turnIndex + 1) % room.players.length;
        room.turnNumber++;
        room.dartsThrown = 0;
        room.turnDarts = [];
        room.turnStartScore = room.players[room.turnIndex].score;
        room.turnEnding = false;
        publish(room);
      }, 1650);
    }
    publish(room);
  });

  socket.on('game:skip', (payload = {}, ack) => {
    const { room, player } = getPlayerRoom(socket, payload.code);
    if (!room || !player) return error(ack, 'You are not in this room.');
    if (room.phase !== 'playing' || room.turnEnding) return error(ack, 'Cannot skip now.');
    if (room.hostId !== player.id) return error(ack, 'Only the host can skip a turn.');
    if (room.players[room.turnIndex].connected) return error(ack, 'You can only skip a disconnected player.');
    room.turnIndex = (room.turnIndex + 1) % room.players.length;
    room.turnNumber++;
    room.dartsThrown = 0;
    room.turnDarts = [];
    room.turnStartScore = room.players[room.turnIndex].score;
    room.lastThrow = null;
    if (typeof ack === 'function') ack({ ok: true });
    publish(room);
  });

  socket.on('game:rematch', (payload = {}, ack) => {
    const { room, player } = getPlayerRoom(socket, payload.code);
    if (!room || !player) return error(ack, 'You are not in this room.');
    if (room.hostId !== player.id) return error(ack, 'Only the host can start a rematch.');
    if (room.phase !== 'finished') return error(ack, 'Finish the match first.');
    if (room.players.some(p => !p.connected)) return error(ack, 'All 3 players must reconnect first.');
    resetGame(room);
    if (typeof ack === 'function') ack({ ok: true });
    publish(room);
  });

  socket.on('room:leave', (payload = {}, ack) => {
    const { room, player } = getPlayerRoom(socket, payload.code);
    if (!room || !player) return error(ack, 'You are not in this room.');
    socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.playerId = null;
    player.connected = false;
    player.socketId = null;
    if (room.phase === 'lobby') room.players = room.players.filter(p => p.id !== player.id);
    if (room.players.length === 0) rooms.delete(room.code);
    else {
      if (room.hostId === player.id) room.hostId = room.players[0].id;
      publish(room);
    }
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.data.playerId && p.socketId === socket.id);
    if (!player) return;
    player.connected = false;
    player.socketId = null;
    // Keep identities in a lobby so brief connection drops do not kick someone out.
    if (room.hostId === player.id) {
      const successor = room.players.find(p => p.connected);
      if (successor) room.hostId = successor.id;
    }
    publish(room);
  });
});

const cleanup = setInterval(() => {
  for (const [code, room] of rooms) {
    if (Date.now() - room.lastActive > ROOM_TTL) rooms.delete(code);
  }
}, 10 * 60 * 1000);
cleanup.unref?.();

if (require.main === module) {
  httpServer.listen(PORT, '0.0.0.0', () => console.log(`Triple Darts running on http://localhost:${PORT}`));
}

module.exports = { httpServer, io };
