const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

function lanUrls() {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) urls.push(`http://${a.address}:${PORT}`);
    }
  }
  return urls;
}

const app = express();
app.get('/lan', (req, res) => res.json({ urls: lanUrls() }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules/three/build')));
app.use('/vendor/three-addons', express.static(path.join(__dirname, 'node_modules/three/examples/jsm')));
const server = http.createServer(app);
// A player whose connection drops briefly keeps their critter, id and place in the round.
const AWAY_GRACE_MS = 30000;
const AWAY_GRACE_LOBBY_MS = 8000;
const io = new Server(server, {
  connectionStateRecovery: { maxDisconnectionDuration: AWAY_GRACE_MS, skipMiddlewares: true },
  // Snapshots are repetitive JSON: compressing them cuts phone data use several times over.
  perMessageDeflate: { threshold: 512 },
});

// ---- Tunables (world units: metres, seconds) ----
const TICK_RATE = 60;
const SEND_RATE = 30;
const BODY_R = 0.85;
const MOVE_SPEED = 6.5;
const CARRY_SPEED = 4.2;
const GROUND_ACCEL = 9;
const AIR_ACCEL = 2.5;
const GROUND_FRICTION = 5;
const GRAVITY = 24;
const JUMP_VEL = 8.5;
const PUNCH_RANGE = 2.1;
const PUNCH_COOLDOWN = 0.42;
const PUNCH_KNOCK = 6.5;
const PUNCH_DIZZY = 30;
const DIZZY_DECAY = 9;
const KO_TIME = 5;
const GRAB_RANGE = 2.0;
const MAX_HOLD = 3.5;
const THROW_SPEED = 13;
const ISLAND_START = 28;
const ISLAND_MIN = 6;
const THROW_VY = 7;
const THROW_OFF = 1.35;
// Thrown players are the only thing the fence lets through.
const THROWN_TIME = 1.6;
const SHRINK_DELAY = 300;
const SHRINK_DURATION = 120;
const SHRINK_WARN = 15;
const SPAWN_R = 13;
const PICKUP_RANGE = 1.9;
const MAX_GROUND_ITEMS = 20;
const OBSTACLE_COUNT = 32;
// The whole edge is fenced except where the river spills off it.
const GUARD_INSET = 0.25;
const FENCE_GAP_MARGIN = 1.2;
// Thrown players that drop past the fence close enough can grab the rail and climb back in.
const HANG_REACH = 1.5;
const HANG_REACH_GRAB = 3.2;
const HANG_MAX_Y = 2.4;
const HANG_OUT = 0.3;
const HANG_Y = -0.9;
const HANG_CLIMB = 2.6;
const HANG_MASH = 0.12;
// Kicks: quick startup, modest shove; bombs on the ground get booted along it.
const KICK_STARTUP = 0.1;
const KICK_COOLDOWN = 0.7;
const KICK_RANGE = 2.2;
const KICK_KNOCK = 7;
const KICK_DIZZY = 15;
const KICK_BOMB_RANGE = 1.9;
const KICK_BOMB_SPEED = 17;
const SKID_FRICTION = 1.2;
// Aimed releases stay buffered briefly so a throw isn't lost to a cooldown.
const FIRE_BUFFER = 0.35;
const AIM_TURN = 22;
// River: a current along its centreline that carries players off the island's edge.
const RIVER_HALF = 1.7;
const RIVER_FLOW = 6;
const RIVER_WADE = 0.6;
const BRIDGE_HALF_LEN = 1.15;
// Bombs drop from the sky unannounced, land with a lit fuse and can be picked up and thrown.
// Sticky bombs only light when picked up, and cling to whoever they're thrown at.
const BOMB_FUSE = 5;
const BOMB_RADIUS = 3.2;
// Bombs only shove and daze: heavy dizziness near the centre, never a launch.
const BOMB_KNOCK = 3.5;
const BOMB_DIZZY_MIN = 60;
const BOMB_STUN = 0.7;
const BOMB_TOSS_SPEED = 12;
const BOMB_TOSS_VY = 6;
const WEAPON_TOSS_SPEED = 15;
const WEAPON_TOSS_VY = 3.5;
const MAX_BOMBS = 12;
const STICKY_CHANCE = 0.3;
const TEAM_SIZES = [0, 2, 3, 4];
const FALL_OUT_Y = -14;
const LOADING_TIME = 1;
const COUNTDOWN = 3;
const ROUND_OVER_TIME = 5;
const MAX_PLAYERS = 8;
const ROOM_CODE = 'ghouse';
const INV_TIME = 10;

// Admin-only settings for the player named "ghouse". Kept outside the room so they survive
// the room being dropped when everyone leaves. Never sent in 'room' or 'state'.
const ADMIN_NAME = 'ghouse';
const ADMIN_PIN = process.env.GHOUSE_PIN || '';
const PIN_MAX_FAILS = 5;
const PIN_LOCK_MS = 60000;
const pinFails = new Map(); // ip -> { n, until }
const savedSecret = { blessed: 0, includeMe: true, invBtn: false, invCd: 30, invUses: 2 };
const isAdmin = (p) => !!p && !p.isBot && p.name.trim().toLowerCase() === ADMIN_NAME;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const pinMatches = (pin) => crypto.timingSafeEqual(sha(pin), sha(ADMIN_PIN));

// Melee weapons wind up, then hit a shape: a forward cone, a wide sweep (pan) or a spin (hammer).
// carry = speed multiplier while held. dizzy defaults to 100 (instant knockout).
// The bat is the fast one: it only dazes, and hitting someone already dazed wakes them back up.
// windup values must match WEAPON_INFO in public/weapons.js.
const WEAPONS = {
  bat: { range: 3.0, cone: 0.2, knock: 7, dizzy: 45, wakes: true, windup: 0.1, cd: 0.36, uses: 12, carry: 0.88, weight: 3 },
  chicken: { range: 2.9, cone: 0.2, knock: 7, windup: 0.2, cd: 0.6, uses: 8, carry: 0.82, weight: 2 },
  pan: { range: 3.5, cone: -0.08, sweep: true, knock: 8, windup: 0.3, cd: 0.85, uses: 7, carry: 0.74, weight: 3 },
  lollipop: { range: 3.7, cone: 0.35, knock: 10, windup: 0.38, cd: 1.0, uses: 6, carry: 0.66, weight: 2 },
  hammer: { spin: 0.65, turns: 2, radius: 3.4, knock: 11, windup: 0.45, cd: 1.7, uses: 4, carry: 0.55, spinSlow: 0.3, weight: 2 },
  blaster: { ranged: true, cd: 1.3, uses: 3, speed: 22, knock: 7, dizzy: 100, life: 1.0, carry: 0.9, weight: 1 },
  bomb: { bomb: true, cd: 0.3, uses: 1, carry: 0.9, weight: 0 },
  sticky: { bomb: true, sticky: true, cd: 0.3, uses: 1, carry: 0.9, weight: 0 },
};
const WEAPON_BAG = Object.entries(WEAPONS).flatMap(([k, w]) => Array(w.weight).fill(k));
const WAKE_GRACE = 1.2;
const START_ITEMS = 12;
const OBSTACLE_KINDS = [
  { t: 'tree', r: 0.55 },
  { t: 'rock', r: 0.9 },
  { t: 'bush', r: 0.7 },
];

const ANIMALS = ['corgi', 'cat', 'panda', 'bunny', 'raccoon', 'sheep', 'hamster', 'bulldog', 'pig', 'skunk'];
const BOT_NAMES = ['Biscuit', 'Noodle', 'Pickles', 'Mochi', 'Waffles', 'Bean', 'Toffee', 'Pudding'];

const rooms = new Map();

// There is only ever one room; it is created on first join and dropped when the last human leaves.
function getRoom() {
  return rooms.get(ROOM_CODE) || createRoom();
}

function createRoom() {
  const room = {
    code: ROOM_CODE,
    hostId: null,
    players: new Map(),
    phase: 'lobby', // lobby | loading | countdown | playing | roundover
    phaseTime: 0,
    roundTime: 0,
    roundPlayers: 0,
    islandR: ISLAND_START,
    winnerId: null,
    events: [],
    botCounter: 0,
    obstacles: [],
    items: [],
    shots: [],
    nextItemId: 1,
    itemT: 0,
    river: null,
    gaps: [],
    shrinkWarned: false,
    bombT: 0,
    teamSize: 0,
    winnerTeam: -1,
    secret: savedSecret,
  };
  rooms.set(room.code, room);
  return room;
}

const MANIFEST_PATH = path.join(__dirname, 'public/models/characters.json');

// Re-read on demand so new .glb characters work without restarting the server.
function modelIds() {
  try {
    const { characters = [] } = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    return characters.map((c) => c.id).filter(Boolean);
  } catch {
    return [];
  }
}

function allCharacters() {
  return [...ANIMALS, ...modelIds()];
}

// Each character can only be played by one person per room.
const animalTaken = (room, a, exceptId) => [...room.players.values()].some((p) => p.id !== exceptId && p.animal === a);

function pickAnimal(room, a, id) {
  const all = allCharacters();
  if (all.includes(a) && !animalTaken(room, a, id)) return a;
  const free = all.filter((c) => !animalTaken(room, c, id));
  const pool = free.length ? free : all;
  return pool[Math.floor(Math.random() * pool.length)];
}

function addPlayer(room, id, name, animal, isBot = false) {
  const p = {
    id,
    name: String(name || 'Buddy').slice(0, 14),
    animal: pickAnimal(room, isBot ? null : animal, id),
    isBot,
    score: 0,
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    face: 0,
    grounded: true,
    state: 'out', // alive | out
    falling: false,
    stunT: 0,
    koT: 0,
    dizzy: 0,
    punchCd: 0,
    punchT: 0,
    punchArm: 0,
    grabCd: 0,
    holding: null,
    heldBy: null,
    holdT: 0,
    weapon: null,
    prevGrab: false,
    grabLock: false,
    swingWind: 0,
    spinT: 0,
    spinHits: null,
    sweepSide: 1,
    heaveT: 0,
    wakeT: 0,
    thrownT: 0,
    hang: false,
    hangA: 0,
    climbT: 0,
    hangUsed: false,
    kickCd: 0,
    kickWind: 0,
    kickT: 0,
    aim: false,
    fireQ: 0,
    fireA: 0,
    late: room.phase !== 'lobby',
    team: -1,
    input: { x: 0, z: 0, grab: false, punch: false, jump: false, kick: false, fire: false, aim: false, ax: 0, az: 1 },
    botT: 0,
    // Private: only ever sent to this player's own socket.
    invT: 0,
    invCdT: 0,
    invUsed: 0,
    blessed: false,
    adm: false,
    pvKey: '{}',
  };
  room.players.set(id, p);
  if (!room.hostId && !isBot) room.hostId = id;
  return p;
}

function roomInfo(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    winnerId: room.winnerId,
    winnerTeam: room.winnerTeam,
    teamSize: room.teamSize,
    obstacles: room.obstacles,
    river: room.river && { pts: room.river.pts, half: RIVER_HALF, bridges: room.river.bridges },
    guardInset: GUARD_INSET,
    // Movement constants for client-side prediction of the local player.
    move: {
      accel: GROUND_ACCEL, airAccel: AIR_ACCEL, jump: JUMP_VEL, gravity: GRAVITY, punchCd: PUNCH_COOLDOWN, kickCd: KICK_COOLDOWN, aimTurn: AIM_TURN,
      body: BODY_R, flow: RIVER_FLOW, bridge: BRIDGE_HALF_LEN,
    },
    // Launch profiles so the client's aim preview matches the real arcs.
    arcs: {
      g: GRAVITY,
      player: { s: THROW_SPEED, vy: THROW_VY, y: 1.25, off: THROW_OFF, carry: 0.5 },
      bomb: { s: BOMB_TOSS_SPEED, vy: BOMB_TOSS_VY, y: 1.1, off: 0.9, carry: 0.5 },
      weapon: { s: WEAPON_TOSS_SPEED, vy: WEAPON_TOSS_VY, y: 1.1, off: 0.9, carry: 0.5 },
      blaster: { line: WEAPONS.blaster.speed * WEAPONS.blaster.life, y: 1.15 },
      kick: { line: KICK_RANGE + 1.6, y: 0.15 },
    },
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, animal: p.animal, score: p.score, isBot: p.isBot, team: p.team,
    })),
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room', roomInfo(room));
}

function setPhase(room, phase) {
  room.phase = phase;
  room.phaseTime = 0;
  if (phase === 'lobby') {
    room.items = [];
    room.shots = [];
    for (const p of room.players.values()) { p.weapon = null; p.invT = 0; p.blessed = false; }
  }
  if (phase === 'playing') {
    for (const p of room.players.values()) {
      if (p.blessed && isActive(p)) grantInv(room, p);
      p.blessed = false;
    }
  }
  broadcastRoom(room);
}

// An S-curved river crossing the island near its centre, flowing from one edge to the other.
function makeRiver() {
  const ang = Math.random() * Math.PI * 2;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const off = (Math.random() - 0.5) * 5;
  const amp = 2 + Math.random() * 2.5;
  const freq = (Math.PI * 2) / (ISLAND_START * (1.4 + Math.random() * 0.6));
  const phase = Math.random() * Math.PI * 2;
  const L = ISLAND_START + 3;
  const pts = [];
  for (let i = 0; i <= 48; i++) {
    const u = -L + (2 * L * i) / 48;
    const v = off + amp * Math.sin(u * freq + phase);
    pts.push([r2(u * ca - v * sa), r2(u * sa + v * ca)]);
  }
  const segs = [];
  let s = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, z0] = pts[i], [x1, z1] = pts[i + 1];
    const len = Math.hypot(x1 - x0, z1 - z0);
    segs.push({ x0, z0, dx: (x1 - x0) / len, dz: (z1 - z0) / len, len, s });
    s += len;
  }
  const river = { pts, segs, bridges: [] };
  // Bridges where the river passes closest to two points on either side of the centre.
  for (const target of [-12, 0, 12]) {
    let best = null;
    for (const sg of segs) {
      const mx = sg.x0 + sg.dx * sg.len * 0.5, mz = sg.z0 + sg.dz * sg.len * 0.5;
      const u = mx * ca + mz * sa;
      if (!best || Math.abs(u - target) < Math.abs(best.u - target)) best = { u, x: mx, z: mz, a: Math.atan2(sg.dx, sg.dz) };
    }
    river.bridges.push({ x: r2(best.x), z: r2(best.z), a: r2(best.a) });
  }
  return river;
}

function riverAt(room, x, z) {
  const rv = room.river;
  if (!rv) return null;
  let best = null, bestD = Infinity, side = 0;
  for (const sg of rv.segs) {
    const px = x - sg.x0, pz = z - sg.z0;
    const t = Math.max(0, Math.min(sg.len, px * sg.dx + pz * sg.dz));
    const ox = px - sg.dx * t, oz = pz - sg.dz * t;
    const d = Math.hypot(ox, oz);
    if (d < bestD) { bestD = d; best = sg; side = -ox * sg.dz + oz * sg.dx; }
  }
  if (bestD > RIVER_HALF) return null;
  for (const b of rv.bridges) {
    const bx = x - b.x, bz = z - b.z;
    const along = bx * Math.sin(b.a) + bz * Math.cos(b.a);
    if (Math.abs(along) < BRIDGE_HALF_LEN) return null;
  }
  return { tx: best.dx, tz: best.dz, d: bestD, side };
}

function riverDist(room, x, z) {
  if (!room.river) return Infinity;
  let bestD = Infinity;
  for (const sg of room.river.segs) {
    const px = x - sg.x0, pz = z - sg.z0;
    const t = Math.max(0, Math.min(sg.len, px * sg.dx + pz * sg.dz));
    bestD = Math.min(bestD, Math.hypot(px - sg.dx * t, pz - sg.dz * t));
  }
  return bestD;
}

function makeObstacles(room) {
  const obs = [];
  for (let tries = 0; obs.length < OBSTACLE_COUNT && tries < 600; tries++) {
    const kind = OBSTACLE_KINDS[Math.floor(Math.random() * OBSTACLE_KINDS.length)];
    const a = Math.random() * Math.PI * 2;
    const d = 2.5 + Math.random() * (ISLAND_START - 4);
    if (Math.abs(d - SPAWN_R) < 1.6) continue;
    const x = Math.sin(a) * d, z = Math.cos(a) * d;
    if (riverDist(room, x, z) < RIVER_HALF + kind.r + 0.8) continue;
    if (obs.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + kind.r + 2.6)) continue;
    obs.push({ x: r2(x), z: r2(z), r: kind.r, t: kind.t, v: Math.floor(Math.random() * 4) });
  }
  return obs;
}

const sameTeam = (a, b) => a.team >= 0 && a.team === b.team;

function assignTeams(room) {
  const list = [...room.players.values()];
  if (!room.teamSize || list.length < 2) {
    for (const p of list) p.team = -1;
    return;
  }
  const nTeams = Math.max(2, Math.ceil(list.length / room.teamSize));
  list.sort(() => Math.random() - 0.5).forEach((p, i) => { p.team = i % nTeams; });
}

const isBomb = (it) => !!WEAPONS[it.type].bomb;

function dropBombs(room) {
  const alive = [...room.players.values()].filter((p) => isActive(p) && !p.falling);
  const live = room.items.filter(isBomb).length;
  let idleSticky = room.items.filter((it) => it.type === 'sticky' && it.fuse == null).length;
  const n = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n && live + i < MAX_BOMBS; i++) {
    let x, z;
    if (alive.length && Math.random() < 0.6) {
      const p = alive[Math.floor(Math.random() * alive.length)];
      x = p.x + (Math.random() - 0.5) * 9;
      z = p.z + (Math.random() - 0.5) * 9;
    } else {
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * room.islandR;
      x = Math.sin(a) * d; z = Math.cos(a) * d;
    }
    const r = Math.hypot(x, z);
    if (r > room.islandR - 1) { x *= (room.islandR - 1) / r; z *= (room.islandR - 1) / r; }
    const sticky = idleSticky < 4 && Math.random() < STICKY_CHANCE;
    if (sticky) idleSticky++;
    room.items.push({
      id: room.nextItemId++, type: sticky ? 'sticky' : 'bomb', uses: 1, holder: null,
      x, y: 24 + i * 4, z, vx: 0, vy: 0, vz: 0, grounded: false, thrownBy: null,
      rot: r2(Math.random() * Math.PI * 2), fuse: null, stuckTo: null,
    });
  }
  room.events.push({ t: 'bombWarn' });
}

function stepBombSpawns(room, dt) {
  room.bombT -= dt;
  if (room.bombT <= 0) {
    room.bombT = 3 + Math.random() * 4;
    dropBombs(room);
  }
}

function explode(room, it) {
  const holder = it.holder && room.players.get(it.holder);
  if (holder && holder.weapon === it.id) holder.weapon = null;
  room.items = room.items.filter((x) => x !== it);
  const bx = it.x, bz = it.z, by = it.y + (it.holder ? 1.1 : 0.4);
  room.events.push({ t: 'boom', x: r2(bx), y: r2(by), z: r2(bz), w: it.type });
  for (const o of room.players.values()) {
    if (!isActive(o) || o.falling || Math.abs(o.y + 0.8 - by) > 3) continue;
    const dx = o.x - bx, dz = o.z - bz;
    const d = Math.hypot(dx, dz);
    if (d > BOMB_RADIUS) continue;
    if (o.invT > 0) { deflect(room, null, o, o.x, o.y + 1, o.z, it.type); continue; }
    if (o.heldBy) {
      const h = room.players.get(o.heldBy);
      if (h) release(room, h, false);
    }
    const a = d > 0.1 ? Math.atan2(dx, dz) : Math.random() * Math.PI * 2;
    const near = 1 - d / BOMB_RADIUS;
    hitPlayer(room, null, o, Math.sin(a), Math.cos(a), BOMB_KNOCK * (0.6 + near * 0.4), BOMB_DIZZY_MIN + (100 - BOMB_DIZZY_MIN) * near, o.x, o.y + 1, o.z, it.type);
    o.stunT = Math.max(o.stunT, BOMB_STUN);
  }
  for (const other of room.items) {
    if (other.holder || other.stuckTo) continue;
    const dx = other.x - bx, dz = other.z - bz, d = Math.hypot(dx, dz);
    if (d > BOMB_RADIUS) continue;
    const a = d > 0.1 ? Math.atan2(dx, dz) : Math.random() * Math.PI * 2;
    other.vx = Math.sin(a) * 7; other.vz = Math.cos(a) * 7; other.vy = 8; other.grounded = false;
  }
}

// ---- Edge fence (open only where the river flows off) ----
const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

// Gaps where the river leaves an island of radius R. The river curves, so its exit moves
// as the island shrinks; the gap is widened when the river crosses the edge at a slant.
function riverGaps(room, R) {
  const gaps = [];
  if (!room.river) return gaps;
  for (const sg of room.river.segs) {
    const ex = sg.x0 + sg.dx * sg.len, ez = sg.z0 + sg.dz * sg.len;
    if (Math.hypot(sg.x0, sg.z0) >= R || Math.hypot(ex, ez) < R) continue;
    let lo = 0, hi = sg.len;
    for (let k = 0; k < 14; k++) {
      const m = (lo + hi) / 2;
      if (Math.hypot(sg.x0 + sg.dx * m, sg.z0 + sg.dz * m) < R) lo = m; else hi = m;
    }
    const x = sg.x0 + sg.dx * lo, z = sg.z0 + sg.dz * lo;
    const cross = Math.max(0.35, (sg.dx * x + sg.dz * z) / R);
    gaps.push({ c: Math.atan2(x, z), h: Math.min(1.2, (RIVER_HALF + FENCE_GAP_MARGIN) / cross / R) });
  }
  return gaps;
}

const fenced = (room, a) => !room.gaps.some((g) => angDiff(a, g.c) < g.h);
const fenceR = (room) => room.islandR - GUARD_INSET;

const onGround = (room, x, z) => Math.hypot(x, z) <= room.islandR;

// The fence pushes back anything trying to leave through a fenced stretch of the edge.
function guardPush(room, o, bounce) {
  const d = Math.hypot(o.x, o.z);
  const lim = fenceR(room) - 0.6;
  if (d <= lim || d > room.islandR + 0.4 || !fenced(room, Math.atan2(o.x, o.z))) return;
  const nx = o.x / d, nz = o.z / d;
  o.x = nx * lim; o.z = nz * lim;
  const vn = o.vx * nx + o.vz * nz;
  if (vn > 0) { o.vx -= vn * nx * bounce; o.vz -= vn * nz * bounce; }
}

const obstacleActive = (room, o) => Math.hypot(o.x, o.z) < room.islandR - 0.3;

function resetBody(p) {
  p.vx = p.vy = p.vz = 0;
  p.y = 0;
  p.grounded = true;
  p.falling = false;
  p.stunT = p.koT = p.dizzy = 0;
  p.punchCd = p.punchT = p.grabCd = 0;
  p.holding = p.heldBy = null;
  p.holdT = 0;
  p.weapon = null;
  p.grabLock = false;
  p.swingWind = p.spinT = p.heaveT = p.wakeT = 0;
  p.thrownT = p.climbT = p.kickCd = p.kickWind = p.kickT = p.fireQ = 0;
  p.hang = p.hangUsed = p.aim = false;
}

function startRound(room) {
  const list = [...room.players.values()];
  room.islandR = ISLAND_START;
  room.roundTime = 0;
  room.winnerId = null;
  room.winnerTeam = -1;
  room.roundPlayers = list.length;
  room.river = makeRiver();
  room.gaps = riverGaps(room, room.islandR);
  room.shrinkWarned = false;
  room.obstacles = makeObstacles(room);
  room.items = [];
  room.shots = [];
  room.bombT = 6 + Math.random() * 3;
  room.itemT = 2;
  for (let i = 0; i < START_ITEMS; i++) spawnItem(room, true);
  assignTeams(room);
  // Teammates start next to each other.
  list.sort((a, b) => a.team - b.team);
  list.forEach((p, i) => {
    let a = (i / list.length) * Math.PI * 2;
    for (let k = 0; k < 12 && riverDist(room, Math.sin(a) * SPAWN_R, Math.cos(a) * SPAWN_R) < RIVER_HALF + 1.2; k++) a += 0.12;
    p.x = Math.sin(a) * SPAWN_R;
    p.z = Math.cos(a) * SPAWN_R;
    p.face = a + Math.PI;
    resetBody(p);
    p.state = 'alive';
    p.late = false;
    p.invT = p.invCdT = p.invUsed = 0;
  });
  drawBlessed(room, list);
  setPhase(room, 'loading');
}

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Blessed players get the special loading screen and invincibility once play begins.
// Each human is told privately; nobody else learns who was picked.
function drawBlessed(room, list) {
  const sec = room.secret;
  const pool = list.filter((p) => sec.includeMe || !isAdmin(p));
  const picks = new Set(shuffled(pool).slice(0, Math.min(sec.blessed, pool.length)));
  for (const p of list) {
    p.blessed = picks.has(p);
    if (p.blessed && !p.isBot) io.to(p.id).emit('pvLoad', { video: true });
  }
}

function grantInv(room, p) {
  p.invT = INV_TIME;
  p.koT = p.stunT = p.dizzy = p.thrownT = 0;
  if (p.heldBy) {
    const h = room.players.get(p.heldBy);
    if (h) release(room, h, false);
    p.stunT = 0;
  }
  for (const it of room.items) {
    if (it.stuckTo === p.id) { it.stuckTo = null; it.grounded = false; it.vy = 3; }
  }
  if (p.hang) rescue(room, p);
}

// Put an invincible player who ended up over the edge back at the nearest safe spot on the island.
function rescue(room, p) {
  const a0 = Math.atan2(p.x, p.z);
  const r0 = Math.min(Math.hypot(p.x, p.z), fenceR(room) - 1.5);
  const safe = (x, z) => riverDist(room, x, z) > RIVER_HALF + 1
    && !room.obstacles.some((o) => obstacleActive(room, o) && Math.hypot(o.x - x, o.z - z) < o.r + BODY_R + 0.3);
  let best = null, bestD = Infinity, fallback = { x: 0, z: 0 }, fallbackRv = -1;
  for (let r = Math.max(0, r0); r >= 0; r -= 1.5) {
    for (let k = -12; k <= 12; k++) {
      const a = a0 + k * 0.08;
      const x = Math.sin(a) * r, z = Math.cos(a) * r;
      const rvd = riverDist(room, x, z);
      if (rvd > fallbackRv) { fallbackRv = rvd; fallback = { x, z }; }
      if (!safe(x, z)) continue;
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < bestD) { bestD = d; best = { x, z }; }
    }
  }
  const spot = best || fallback;
  p.x = spot.x; p.z = spot.z; p.y = 0;
  p.vx = p.vy = p.vz = 0;
  p.grounded = true;
  p.falling = p.hang = false;
  p.thrownT = p.climbT = p.stunT = 0;
}

function useInvButton(room, p) {
  const sec = room.secret;
  if (!sec.invBtn || room.phase !== 'playing' || !isActive(p) || p.invCdT > 0 || p.invUsed >= sec.invUses) return;
  p.invUsed += 1;
  p.invCdT = sec.invCd;
  grantInv(room, p);
}

// An invincible target: the hit lands as a harmless bounce for everyone to see.
function deflect(room, attackerId, o, hx, hy, hz, w = '') {
  room.events.push({ t: 'hit', x: r2(hx), y: r2(hy), z: r2(hz), big: false, a: attackerId, b: o.id, w, df: 1 });
}

const isActive = (p) => p.state === 'alive';
const canAct = (p) => isActive(p) && !p.falling && !p.hang && p.koT <= 0 && p.stunT <= 0 && !p.heldBy;

// A grab-and-throw is the only launch the fence lets through (thrownT).
function release(room, holder, thrown) {
  const t = room.players.get(holder.holding);
  holder.holding = null;
  holder.grabCd = 0.5;
  if (!t) return;
  t.heldBy = null;
  t.holdT = 0;
  if (thrown) {
    // Launch from in front of the thrower, even if the aim snapped round since they were carried.
    t.x = holder.x + Math.sin(holder.face) * THROW_OFF;
    t.z = holder.z + Math.cos(holder.face) * THROW_OFF;
    t.vx = Math.sin(holder.face) * THROW_SPEED + holder.vx * 0.5;
    t.vz = Math.cos(holder.face) * THROW_SPEED + holder.vz * 0.5;
    t.vy = THROW_VY;
    t.stunT = 0.9;
    t.grounded = false;
    t.thrownT = THROWN_TIME;
    t.hangUsed = false;
    room.events.push({ t: 'throw', id: holder.id, target: t.id });
  } else {
    t.vy = 2;
    t.grounded = false;
    t.stunT = Math.max(t.stunT, 0.2);
  }
}

const weaponItem = (room, p) => (p.weapon ? room.items.find((it) => it.id === p.weapon) : null);

// Shared by punches, kicks, weapon swings, foam balls, thrown weapons and bombs.
// Knockback never carries anyone over the fence; only hanging players get knocked off it.
function hitPlayer(room, attackerId, o, fx, fz, knockBase, dizzyAdd, hx, hy, hz, w = '') {
  if (o.invT > 0) return deflect(room, attackerId, o, hx, hy, hz, w);
  if (o.hang) {
    letGo(room, o, fx, fz);
    room.events.push({ t: 'hit', x: r2(hx), y: r2(hy), z: r2(hz), big: true, a: attackerId, b: o.id, w });
    return;
  }
  const knock = knockBase * (1 + o.dizzy / 120) * (o.koT > 0 ? 1.4 : 1);
  o.vx += fx * knock;
  o.vz += fz * knock;
  o.vy = Math.max(o.vy, 3 + knockBase * 0.12);
  o.grounded = false;
  o.stunT = Math.max(o.stunT, 0.35);
  o.swingWind = o.spinT = o.kickWind = 0;
  if (Math.hypot(o.x, o.z) < fenceR(room)) o.thrownT = 0;
  if (o.holding) release(room, o, false);

  let ko = false;
  if (WEAPONS[w]?.wakes && (o.dizzy > 0 || o.koT > 0)) {
    // Spamming the bat wakes a dazed target up: grab them instead.
    o.dizzy = 0;
    o.koT = 0;
    o.wakeT = WAKE_GRACE;
    room.events.push({ t: 'wake', id: o.id });
  } else if (o.koT <= 0) {
    // Just-woken players get a moment of grace so they can't be stun-locked.
    o.dizzy += dizzyAdd >= 100 && o.wakeT > 0 ? 50 : dizzyAdd;
    if (o.dizzy >= 100) {
      o.dizzy = 0;
      o.koT = KO_TIME;
      ko = true;
      dropWeapon(room, o, false);
      room.events.push({ t: 'ko', id: o.id });
    }
  }
  room.events.push({ t: 'hit', x: r2(hx), y: r2(hy), z: r2(hz), big: ko || knockBase > 12, a: attackerId, b: o.id, w });
}

// Forward cone hit. sweep (+1/-1) is the side a sideways swing starts from: targets get
// shoved across, toward the other side, instead of straight ahead.
function meleeHits(room, p, range, cone, knock, dizzy, w = '', sweep = 0) {
  const fx = Math.sin(p.face), fz = Math.cos(p.face);
  let kx = fx, kz = fz;
  if (sweep) {
    kx = fx * 0.45 - sweep * Math.cos(p.face);
    kz = fz * 0.45 + sweep * Math.sin(p.face);
    const kl = Math.hypot(kx, kz);
    kx /= kl; kz /= kl;
  }
  for (const o of room.players.values()) {
    if (o === p || !isActive(o) || o.falling || o.heldBy) continue;
    const dx = o.x - p.x, dz = o.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist > range || Math.abs(o.y - p.y) > 1.4) continue;
    if (dist > 0.01 && (dx * fx + dz * fz) / dist < cone) continue;
    const hx = sweep ? (p.x + o.x) / 2 : p.x + fx * 1.1, hz = sweep ? (p.z + o.z) / 2 : p.z + fz * 1.1;
    hitPlayer(room, p.id, o, kx, kz, knock, dizzy, hx, p.y + 1.1, hz, w);
  }
}

// Hammer spin: everyone in the radius, each at most once per spin, knocked straight outward.
function spinHits(room, p, w) {
  for (const o of room.players.values()) {
    if (o === p || !isActive(o) || o.falling || o.heldBy || p.spinHits.has(o.id)) continue;
    const dx = o.x - p.x, dz = o.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist > w.radius || Math.abs(o.y - p.y) > 1.4) continue;
    p.spinHits.add(o.id);
    const a = dist > 0.01 ? Math.atan2(dx, dz) : p.face;
    hitPlayer(room, p.id, o, Math.sin(a), Math.cos(a), w.knock, w.dizzy ?? 100, (p.x + o.x) / 2, p.y + 1.1, (p.z + o.z) / 2, 'hammer');
  }
}

// Snap facing toward the best target roughly in front, so attacks are easy to land on phones.
// Enemies are preferred; teammates are only auto-aimed at when no enemy is close.
// Aiming players pick their own direction, so there is no assist.
function aimAssist(room, p, range, minDot) {
  if (p.aim || p.fireQ > 0) return;
  const fx = Math.sin(p.face), fz = Math.cos(p.face);
  let best = null, bestScore = Infinity;
  for (const o of room.players.values()) {
    if (o === p || !isActive(o) || o.falling || o.heldBy) continue;
    const dx = o.x - p.x, dz = o.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d > range || d < 0.01) continue;
    const dot = (dx * fx + dz * fz) / d;
    if (dot < minDot) continue;
    const score = d * (2 - dot) + (sameTeam(p, o) ? 100 : 0);
    if (score < bestScore) { bestScore = score; best = o; }
  }
  if (best) p.face = Math.atan2(best.x - p.x, best.z - p.z);
}

function doPunch(room, p) {
  aimAssist(room, p, PUNCH_RANGE + 0.4, 0.3);
  p.punchCd = PUNCH_COOLDOWN;
  p.punchT = 0.25;
  p.punchArm = 1 - p.punchArm;
  room.events.push({ t: 'swing', id: p.id });
  meleeHits(room, p, PUNCH_RANGE, 0.45, PUNCH_KNOCK, PUNCH_DIZZY);
}

function weaponAttack(room, p) {
  const it = weaponItem(room, p);
  if (!it) { p.weapon = null; return doPunch(room, p); }
  const w = WEAPONS[it.type];
  p.punchCd = w.cd;
  if (w.bomb) {
    aimAssist(room, p, 12, 0.6);
    dropWeapon(room, p, true);
    p.punchT = 0.25;
    p.punchArm = 1 - p.punchArm;
  } else if (w.ranged) {
    aimAssist(room, p, 14, 0.7);
    p.punchT = 0.3;
    p.punchArm = 1 - p.punchArm;
    const fx = Math.sin(p.face), fz = Math.cos(p.face);
    room.shots.push({
      id: room.nextItemId++, owner: p.id, life: w.life,
      x: p.x + fx * 1.1, y: p.y + 1.15, z: p.z + fz * 1.1,
      vx: fx * w.speed, vz: fz * w.speed,
    });
    room.events.push({ t: 'shoot', id: p.id });
    useUp(room, p, it);
  } else {
    if (!w.spin) aimAssist(room, p, w.range + 1, w.sweep ? -0.2 : 0.1);
    if (w.sweep) {
      // The pan sweeps from the side it's held on, then switches sides for the next swing.
      p.sweepSide = p.punchArm ? 1 : -1;
      p.punchArm = 1 - p.punchArm;
    }
    p.swingWind = w.windup;
    room.events.push({ t: 'windup', id: p.id, w: it.type });
  }
}

function weaponStrike(room, p) {
  const it = weaponItem(room, p);
  if (!it) return;
  const w = WEAPONS[it.type];
  if (w.spin) {
    p.spinT = w.spin;
    p.spinHits = new Set();
    room.events.push({ t: 'spin', id: p.id, w: it.type });
    spinHits(room, p, w);
    return;
  }
  if (!w.sweep) {
    aimAssist(room, p, w.range + 0.6, 0.1);
    p.punchArm = 1 - p.punchArm;
  }
  p.punchT = 0.35;
  room.events.push({ t: 'swing', id: p.id, w: it.type, sd: w.sweep ? p.sweepSide : 0 });
  meleeHits(room, p, w.range, w.cone, w.knock, w.dizzy ?? 100, it.type, w.sweep ? p.sweepSide : 0);
  useUp(room, p, it);
}

function stepSpin(room, p, dt) {
  const it = weaponItem(room, p);
  if (!canAct(p) || !it) { p.spinT = 0; return; }
  p.spinT -= dt;
  spinHits(room, p, WEAPONS[it.type]);
  if (p.spinT <= 0) {
    p.spinT = 0;
    useUp(room, p, it);
  }
}

// ---- Kicks ----
function startKick(room, p) {
  if (!p.aim) {
    // Prefer an enemy in front; otherwise line up on a bomb lying close by.
    const before = p.face;
    aimAssist(room, p, KICK_RANGE + 0.4, 0.3);
    if (p.face === before) {
      const b = kickableBomb(room, p, -0.2);
      if (b) p.face = Math.atan2(b.x - p.x, b.z - p.z);
    }
  }
  p.kickCd = KICK_COOLDOWN;
  p.kickWind = KICK_STARTUP;
  p.kickT = 0.35;
  room.events.push({ t: 'kick', id: p.id });
}

function kickableBomb(room, p, minDot) {
  const fx = Math.sin(p.face), fz = Math.cos(p.face);
  let best = null, bestD = KICK_BOMB_RANGE;
  for (const it of room.items) {
    if (!isBomb(it) || it.holder || it.stuckTo || it.y > 0.8 || it.y < -0.3) continue;
    const dx = it.x - p.x, dz = it.z - p.z, d = Math.hypot(dx, dz);
    if (d > bestD || (d > 0.3 && (dx * fx + dz * fz) / d < minDot)) continue;
    bestD = d; best = it;
  }
  return best;
}

function kickStrike(room, p) {
  const fx = Math.sin(p.face), fz = Math.cos(p.face);
  const b = kickableBomb(room, p, 0.2);
  if (b) {
    // Booted along the ground; kicking an unlit bomb lights it.
    b.grounded = true;
    b.skid = true;
    b.kicked = true;
    b.y = 0;
    b.vx = fx * KICK_BOMB_SPEED + p.vx * 0.3;
    b.vz = fz * KICK_BOMB_SPEED + p.vz * 0.3;
    b.vy = 0;
    b.rot = r2(p.face);
    b.thrownBy = p.id;
    if (b.fuse == null) b.fuse = BOMB_FUSE;
    room.events.push({ t: 'kickBomb', id: p.id, x: r2(b.x), z: r2(b.z) });
  }
  meleeHits(room, p, KICK_RANGE, 0.4, KICK_KNOCK, KICK_DIZZY, 'kick');
}

// ---- Hanging on the fence ----
// Thrown players dropping just past the fence catch the rail (holding GRAB reaches further).
// Knocked-out players are out cold and can't, so a knockout and a throw finishes someone.
function tryHang(room, p, reaching) {
  if (p.thrownT <= 0 || p.thrownT > THROWN_TIME - 0.12 || p.hangUsed || p.grounded || p.koT > 0) return;
  const d = Math.hypot(p.x, p.z);
  const out = d - fenceR(room);
  if (out < 0.3 || out > (reaching ? HANG_REACH_GRAB : HANG_REACH) || p.y > HANG_MAX_Y || p.y < -0.6) return;
  const a = Math.atan2(p.x, p.z);
  if (!fenced(room, a)) return;
  p.hang = true;
  p.hangUsed = true;
  p.hangA = a;
  p.climbT = 0;
  p.stunT = 0;
  if (p.holding) release(room, p, false);
  dropWeapon(room, p, false);
  placeHanging(room, p);
  room.events.push({ t: 'hang', id: p.id });
}

function placeHanging(room, p) {
  const r = room.islandR + HANG_OUT;
  p.x = Math.sin(p.hangA) * r;
  p.z = Math.cos(p.hangA) * r;
  p.y = HANG_Y + (p.climbT / HANG_CLIMB) * 0.5;
  p.vx = p.vy = p.vz = 0;
  p.face = p.hangA + Math.PI;
  p.grounded = false;
}

function stepHang(room, p, dt, mash) {
  if (!fenced(room, p.hangA)) return letGo(room, p, 0, 0);
  p.climbT += dt + (mash ? HANG_MASH : 0);
  if (p.climbT < HANG_CLIMB) return placeHanging(room, p);
  // Over the top and back inside.
  const r = fenceR(room) - 0.9;
  p.hang = false;
  p.climbT = 0;
  p.thrownT = 0;
  p.x = Math.sin(p.hangA) * r;
  p.z = Math.cos(p.hangA) * r;
  p.y = 0.3;
  p.vx = -Math.sin(p.hangA) * 2;
  p.vz = -Math.cos(p.hangA) * 2;
  p.vy = 5;
  p.wakeT = WAKE_GRACE;
  room.events.push({ t: 'climb', id: p.id });
}

// Knocked off the rail: gone for good (no second grab, and the fence won't catch them).
function letGo(room, p, fx, fz) {
  p.hang = false;
  p.climbT = 0;
  p.hangUsed = true;
  p.thrownT = THROWN_TIME;
  p.vx = Math.sin(p.hangA) * 3 + fx * 3;
  p.vz = Math.cos(p.hangA) * 3 + fz * 3;
  p.vy = -1;
  p.y = Math.min(p.y, -0.7);
  p.grounded = false;
  room.events.push({ t: 'letgo', id: p.id });
}

// ---- THROW button: release in the aimed direction ----
function aimedRelease(room, p) {
  if (p.holding) { release(room, p, true); return true; }
  const it = weaponItem(room, p);
  if (!it || p.heaveT > 0) return !it;
  const w = WEAPONS[it.type];
  if (w.ranged) {
    if (p.punchCd > 0) return false;
    weaponAttack(room, p);
  } else {
    // Bombs are lobbed, melee weapons flung.
    dropWeapon(room, p, true);
    p.punchCd = Math.max(p.punchCd, 0.3);
    p.punchT = 0.25;
    p.punchArm = 1 - p.punchArm;
  }
  return true;
}

function useUp(room, p, it) {
  const fx = Math.sin(p.face), fz = Math.cos(p.face);
  it.uses -= 1;
  if (it.uses <= 0) {
    room.items = room.items.filter((x) => x !== it);
    p.weapon = null;
    room.events.push({ t: 'break', id: p.id, w: it.type, x: r2(p.x + fx), y: r2(p.y + 1.2), z: r2(p.z + fz) });
  }
}

function spawnItem(room, onGround = false) {
  for (let tries = 0; tries < 30; tries++) {
    const a = Math.random() * Math.PI * 2;
    const d = Math.sqrt(Math.random()) * Math.max(1, room.islandR - 2);
    const x = Math.sin(a) * d, z = Math.cos(a) * d;
    if (room.obstacles.some((o) => obstacleActive(room, o) && Math.hypot(o.x - x, o.z - z) < o.r + 1.2)) continue;
    if (riverDist(room, x, z) < RIVER_HALF + 0.8) continue;
    if (room.items.some((it) => !it.holder && Math.hypot(it.x - x, it.z - z) < 2)) continue;
    if (onGround && Math.abs(d - SPAWN_R) < 1.5) continue;
    const type = WEAPON_BAG[Math.floor(Math.random() * WEAPON_BAG.length)];
    room.items.push({
      id: room.nextItemId++, type, uses: WEAPONS[type].uses, holder: null,
      x, y: onGround ? 0 : 10, z, vx: 0, vy: 0, vz: 0, grounded: onGround, thrownBy: null,
      rot: r2(Math.random() * Math.PI * 2),
    });
    return;
  }
}

function tryPickup(room, p) {
  let best = null, bestD = PICKUP_RANGE;
  for (const it of room.items) {
    if (it.holder || it.stuckTo || it.y > 1.4 || it.y < -0.5) continue;
    const d = Math.hypot(it.x - p.x, it.z - p.z);
    if (d < bestD) { bestD = d; best = it; }
  }
  if (!best) return false;
  best.holder = p.id;
  best.thrownBy = null;
  p.weapon = best.id;
  const light = isBomb(best);
  if (best.type === 'sticky' && best.fuse == null) best.fuse = BOMB_FUSE;
  p.punchCd = Math.max(p.punchCd, light ? 0.2 : 0.45);
  p.heaveT = light ? 0.15 : 0.45;
  room.events.push({ t: 'pickup', id: p.id, w: best.type });
  return true;
}

function dropWeapon(room, p, toss) {
  const it = weaponItem(room, p);
  p.weapon = null;
  p.swingWind = 0;
  if (!it) return;
  const fx = Math.sin(p.face), fz = Math.cos(p.face);
  it.rot = r2(p.face + Math.PI / 2);
  it.holder = null;
  it.grounded = false;
  it.x = p.x + fx * 0.9;
  it.z = p.z + fz * 0.9;
  it.y = p.y + 1.1;
  // Bombs are lobbed in an arc; weapons are flung flat and fast.
  const speed = isBomb(it) ? BOMB_TOSS_SPEED : WEAPON_TOSS_SPEED;
  it.vx = p.vx * 0.5 + (toss ? fx * speed : 0);
  it.vz = p.vz * 0.5 + (toss ? fz * speed : 0);
  it.vy = toss ? (isBomb(it) ? BOMB_TOSS_VY : WEAPON_TOSS_VY) : 2;
  it.skid = it.kicked = false;
  it.thrownBy = toss ? p.id : null;
  if (toss) room.events.push({ t: 'toss', id: p.id });
}

function stepItems(room, dt) {
  const blasts = [];
  for (const it of room.items) {
    if (it.fuse != null) {
      it.fuse -= dt;
      if (it.fuse <= 0) { blasts.push(it); continue; }
    }
    if (it.stuckTo) {
      const v = room.players.get(it.stuckTo);
      if (v && isActive(v)) { it.x = v.x; it.y = v.y + 1.3; it.z = v.z; continue; }
      it.stuckTo = null;
      it.grounded = false;
    }
    if (it.holder) {
      const h = room.players.get(it.holder);
      if (!h || h.weapon !== it.id) it.holder = null;
      else { it.x = h.x; it.y = h.y; it.z = h.z; continue; }
    }
    if (!it.grounded) {
      it.vy -= GRAVITY * dt;
      it.x += it.vx * dt;
      it.y += it.vy * dt;
      it.z += it.vz * dt;
    } else if (it.skid) {
      // Kicked bombs skid along the ground until friction stops them.
      it.x += it.vx * dt;
      it.z += it.vz * dt;
      const f = Math.exp(-SKID_FRICTION * dt);
      it.vx *= f; it.vz *= f;
      if (Math.hypot(it.vx, it.vz) < 1.5) { it.skid = false; it.thrownBy = null; }
    } else {
      const rv = riverAt(room, it.x, it.z);
      if (rv) { it.x += rv.tx * RIVER_FLOW * 0.45 * dt; it.z += rv.tz * RIVER_FLOW * 0.45 * dt; }
    }
    const onIsland = onGround(room, it.x, it.z);
    if (onIsland && it.y <= 0 && it.y > -0.5) {
      if (!it.grounded) room.events.push({ t: 'itemLand', x: r2(it.x), z: r2(it.z), w: it.type });
      it.y = 0;
      it.vy = 0;
      if (!it.skid) { it.vx = it.vz = 0; it.thrownBy = null; }
      it.grounded = true;
      if (it.type === 'bomb' && it.fuse == null) it.fuse = BOMB_FUSE;
    } else if (!onIsland) {
      it.grounded = false;
      it.skid = false;
    }
    if (it.y < 1) guardPush(room, it, 1.3);
    for (const o of room.obstacles) {
      if (!obstacleActive(room, o) || it.y > 2) continue;
      const dx = it.x - o.x, dz = it.z - o.z, d = Math.hypot(dx, dz) || 1;
      if (d < o.r + 0.3) {
        it.x = o.x + (dx / d) * (o.r + 0.3);
        it.z = o.z + (dz / d) * (o.r + 0.3);
        it.vx *= -0.3; it.vz *= -0.3;
      }
    }
    // A thrown weapon bonks the first player it reaches.
    if (it.thrownBy && Math.hypot(it.vx, it.vz) > 6) {
      for (const o of room.players.values()) {
        if (o.id === it.thrownBy || !isActive(o) || o.falling || o.heldBy) continue;
        if (Math.abs(o.y + 0.9 - it.y) > 1.3 || Math.hypot(o.x - it.x, o.z - it.z) > BODY_R + 0.4) continue;
        const sp = Math.hypot(it.vx, it.vz);
        if (o.invT > 0) {
          deflect(room, it.thrownBy, o, it.x, it.y, it.z, it.type);
          it.vx *= -0.25; it.vz *= -0.25; it.vy = 3;
          it.grounded = false;
        } else if (it.type === 'sticky') {
          hitPlayer(room, it.thrownBy, o, it.vx / sp, it.vz / sp, 3, 15, it.x, it.y, it.z, 'sticky');
          it.stuckTo = o.id;
          it.vx = it.vy = it.vz = 0;
          room.events.push({ t: 'stick', id: o.id, x: r2(it.x), y: r2(it.y), z: r2(it.z) });
        } else {
          const bomb = it.type === 'bomb';
          hitPlayer(room, it.thrownBy, o, it.vx / sp, it.vz / sp, bomb ? 5 : 9, bomb ? 25 : it.type === 'blaster' ? 40 : WEAPONS[it.type].dizzy ?? 100, it.x, it.y, it.z, it.type);
          // A kicked lit bomb goes off right on whoever it runs into.
          if (bomb && it.kicked && it.fuse != null) it.fuse = Math.min(it.fuse, 0.12);
          it.vx *= -0.25; it.vz *= -0.25; it.vy = 3;
          it.grounded = false;
        }
        it.skid = it.kicked = false;
        it.thrownBy = null;
        break;
      }
    }
  }
  for (const it of blasts) explode(room, it);
  room.items = room.items.filter((it) => it.holder || it.stuckTo || it.y > FALL_OUT_Y);

  for (const s of room.shots) {
    s.life -= dt;
    s.x += s.vx * dt;
    s.z += s.vz * dt;
    if (room.obstacles.some((o) => obstacleActive(room, o) && Math.hypot(o.x - s.x, o.z - s.z) < o.r + 0.2)) {
      s.life = 0;
      room.events.push({ t: 'pop', x: r2(s.x), y: r2(s.y), z: r2(s.z) });
      continue;
    }
    for (const o of room.players.values()) {
      if (o.id === s.owner || !isActive(o) || o.falling || o.heldBy) continue;
      if (Math.abs(o.y + 1 - s.y) > 1.3 || Math.hypot(o.x - s.x, o.z - s.z) > BODY_R + 0.35) continue;
      const sp = Math.hypot(s.vx, s.vz);
      const w = WEAPONS.blaster;
      hitPlayer(room, s.owner, o, s.vx / sp, s.vz / sp, w.knock, w.dizzy, s.x, s.y, s.z, 'blaster');
      s.life = 0;
      break;
    }
  }
  room.shots = room.shots.filter((s) => s.life > 0);

  if (room.phase === 'playing') {
    room.itemT -= dt;
    const ground = room.items.filter((it) => !it.holder && !isBomb(it)).length;
    if (room.itemT <= 0) {
      room.itemT = 1.5 + Math.random() * 2;
      if (ground < MAX_GROUND_ITEMS) spawnItem(room);
    }
  }
}

function tryGrab(room, p) {
  const fx = Math.sin(p.face), fz = Math.cos(p.face);
  let best = null, bestD = Infinity;
  for (const o of room.players.values()) {
    if (o === p || !isActive(o) || o.falling || o.heldBy || o.holding === p.id || o.invT > 0) continue;
    const dx = o.x - p.x, dz = o.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist > GRAB_RANGE || Math.abs(o.y - p.y) > 1.5) continue;
    if (dist > 0.01 && (dx * fx + dz * fz) / dist < 0.3) continue;
    if (dist < bestD) { bestD = dist; best = o; }
  }
  if (!best) return;
  if (best.holding) release(room, best, false);
  dropWeapon(room, best, false);
  p.holding = best.id;
  best.heldBy = p.id;
  best.holdT = 0;
  room.events.push({ t: 'grab', id: p.id, target: best.id });
}

// Bots aim straight at whatever they want to hit.
function botAim(inp, dx, dz) {
  const l = Math.hypot(dx, dz) || 1;
  inp.aim = true;
  inp.ax = dx / l;
  inp.az = dz / l;
}

function enemiesNear(room, bot, r) {
  return [...room.players.values()].filter((o) => o !== bot && isActive(o) && !o.falling && !o.heldBy && !sameTeam(bot, o)
    && Math.hypot(o.x - bot.x, o.z - bot.z) < r);
}

function botThink(room, bot, dt) {
  bot.botT -= dt;
  if (bot.botT > 0) return;
  bot.botT = 0.18 + Math.random() * 0.15;
  const inp = bot.input;
  inp.punch = inp.jump = inp.kick = inp.fire = inp.aim = false;

  if (bot.heldBy) {
    inp.punch = Math.random() < 0.35;
    return;
  }
  // On the fence: mash to climb back in.
  if (bot.hang) {
    inp.jump = Math.random() < 0.7;
    return;
  }
  // Flying out after a throw: usually reach for the fence.
  if (bot.thrownT > 0 && !bot.grounded) {
    bot.botReach ??= Math.random() < 0.7;
    inp.grab = bot.botReach;
    return;
  }
  bot.botReach = undefined;

  const distC = Math.hypot(bot.x, bot.z) || 0.001;
  const R = room.islandR;

  if (bot.holding) {
    // Carry the victim to the fence (or the river gap) and throw them over.
    inp.x = bot.x / distC;
    inp.z = bot.z / distC;
    inp.grab = true;
    if (distC > fenceR(room) - 1.9) {
      botAim(inp, bot.x, bot.z);
      inp.fire = true;
    }
    return;
  }

  // Knock climbing enemies off the fence before they make it back in.
  let hanger = null;
  for (const o of room.players.values()) {
    if (o.hang && !sameTeam(bot, o) && Math.hypot(o.x - bot.x, o.z - bot.z) < 9) hanger = o;
  }
  if (hanger) {
    const dx = hanger.x - bot.x, dz = hanger.z - bot.z, d = Math.hypot(dx, dz) || 1;
    inp.x = dx / d;
    inp.z = dz / d;
    inp.grab = false;
    if (d < 2.1) {
      botAim(inp, dx, dz);
      if (bot.kickCd <= 0) inp.kick = true;
      else inp.punch = true;
    }
    return;
  }

  if (distC > R - 1.6) {
    inp.x = -bot.x / distC;
    inp.z = -bot.z / distC;
    inp.grab = false;
    if (Math.random() < 0.05) inp.jump = true;
    return;
  }

  // Swim out of the river: head for the nearest bank, slightly upstream.
  const rv = riverAt(room, bot.x, bot.z);
  if (rv) {
    let nx = -rv.tz, nz = rv.tx;
    if (rv.side < 0) { nx = -nx; nz = -nz; }
    inp.x = nx - rv.tx * 0.5;
    inp.z = nz - rv.tz * 0.5;
    inp.grab = false;
    if (Math.random() < 0.1) inp.jump = true;
    return;
  }

  let target = null, best = Infinity;
  for (const o of room.players.values()) {
    if (o === bot || !isActive(o) || o.falling || o.heldBy === bot.id || sameTeam(bot, o) || o.invT > 0) continue;
    const d = Math.hypot(o.x - bot.x, o.z - bot.z);
    if (d < best) { best = d; target = o; }
  }

  // Boot a bomb lying nearby at the target: get behind it, then kick.
  if (target && !bot.weapon && bot.kickCd <= 0) {
    for (const b of room.items) {
      if (!isBomb(b) || b.holder || b.stuckTo || !b.grounded || b.skid || (b.fuse != null && b.fuse < 1.4)) continue;
      if (Math.hypot(b.x - bot.x, b.z - bot.z) > 5) continue;
      const tx = target.x - b.x, tz = target.z - b.z, td = Math.hypot(tx, tz) || 1;
      if (td > 13) continue;
      const gx = b.x - (tx / td) * 1.2, gz = b.z - (tz / td) * 1.2;
      const gd = Math.hypot(gx - bot.x, gz - bot.z);
      inp.grab = false;
      if (gd < 0.8) {
        botAim(inp, tx, tz);
        inp.kick = true;
        inp.x = inp.z = 0;
      } else {
        inp.x = (gx - bot.x) / gd;
        inp.z = (gz - bot.z) / gd;
      }
      return;
    }
  }

  // Run from bombs about to go off (unless already holding one to throw).
  for (const b of room.items) {
    if (b.fuse == null || b.fuse > 2.2 || b.holder === bot.id || b.stuckTo === bot.id) continue;
    const dx = bot.x - b.x, dz = bot.z - b.z, d = Math.hypot(dx, dz);
    if (d < BOMB_RADIUS + 0.8 && d > 0.01) {
      inp.x = dx / (d || 1);
      inp.z = dz / (d || 1);
      inp.grab = false;
      return;
    }
  }

  if (!bot.weapon) {
    let item = null, itemD = 7;
    for (const it of room.items) {
      if (it.holder || !it.grounded) continue;
      const d = Math.hypot(it.x - bot.x, it.z - bot.z);
      if (d < itemD) { itemD = d; item = it; }
    }
    if (item && itemD < best + 2) {
      const len = itemD || 1;
      inp.x = (item.x - bot.x) / len;
      inp.z = (item.z - bot.z) / len;
      inp.grab = itemD < 1.6 ? !inp.grab : false;
      return;
    }
  }

  if (!target) { inp.x = inp.z = 0; inp.grab = false; return; }

  const dx = target.x - bot.x, dz = target.z - bot.z;
  const len = Math.hypot(dx, dz) || 1;
  const wobble = (Math.random() - 0.5) * 0.6;
  inp.x = dx / len + wobble * (dz / len);
  inp.z = dz / len - wobble * (dx / len);

  const held = weaponItem(room, bot);
  if (held) {
    const w = WEAPONS[held.type];
    inp.grab = false;
    const facing = (dx * Math.sin(bot.face) + dz * Math.cos(bot.face)) / len;
    const dazed = target.koT > 0 || (w.wakes && target.dizzy > 0);
    if (!w.bomb && dazed && best < 2.6) {
      // Hitting again would waste the knockout (or wake them, with the bat): drop it and grab.
      dropWeapon(room, bot, false);
      return;
    }
    if (w.bomb) {
      if ((best < 9 && facing > 0.6) || (held.fuse != null && held.fuse < 1.2)) { botAim(inp, dx, dz); inp.fire = true; }
    } else if (w.ranged) {
      if (best < 6) { inp.x *= 0.2; inp.z *= 0.2; }
      if (best < 12 && bot.punchCd <= 0 && Math.random() < 0.4) { botAim(inp, dx, dz); inp.fire = true; }
    } else if (w.spin) {
      const n = enemiesNear(room, bot, w.radius - 0.4).length;
      if (n >= 2 || (n === 1 && Math.random() < 0.25)) inp.punch = true;
    } else if (w.sweep) {
      // The pan covers a half-circle, so enemies beside count too.
      const fx = Math.sin(bot.face), fz = Math.cos(bot.face);
      const beside = enemiesNear(room, bot, w.range - 0.3).some((o) => {
        const ox = o.x - bot.x, oz = o.z - bot.z;
        return (ox * fx + oz * fz) / (Math.hypot(ox, oz) || 1) > -0.1;
      });
      if (beside && Math.random() < 0.5) inp.punch = true;
    } else if (!dazed && best < w.range - 0.3 && facing > 0.6 && Math.random() < 0.45) {
      inp.punch = true;
    }
    return;
  }

  if (best < 1.9) {
    // Kick enemies standing between us and the river.
    const rvNow = riverDist(room, target.x, target.z);
    const towardRiver = rvNow < RIVER_HALF + 3 && riverDist(room, target.x + (dx / len) * 2, target.z + (dz / len) * 2) < rvNow;
    if (towardRiver && bot.kickCd <= 0) { botAim(inp, dx, dz); inp.kick = true; }
    else if (((target.koT > 0 || target.dizzy > 60) && Math.random() < 0.5) || Math.random() < 0.05) inp.grab = true;
    else if (Math.random() < 0.3) inp.punch = true;
    else if (bot.kickCd <= 0 && Math.random() < 0.1) inp.kick = true;
  } else {
    inp.grab = false;
  }
  if (Math.random() < 0.02) inp.jump = true;
}

function stepPhysics(room, dt) {
  const list = [...room.players.values()].filter(isActive);

  for (const p of list) {
    p.stunT = Math.max(0, p.stunT - dt);
    if (p.koT > 0 && p.koT - dt <= 0) p.wakeT = WAKE_GRACE;
    p.koT = Math.max(0, p.koT - dt);
    p.wakeT = Math.max(0, p.wakeT - dt);
    p.heaveT = Math.max(0, p.heaveT - dt);
    p.punchCd = Math.max(0, p.punchCd - dt);
    p.punchT = Math.max(0, p.punchT - dt);
    p.grabCd = Math.max(0, p.grabCd - dt);
    p.kickCd = Math.max(0, p.kickCd - dt);
    p.kickT = Math.max(0, p.kickT - dt);
    p.thrownT = Math.max(0, p.thrownT - dt);
    p.fireQ = Math.max(0, p.fireQ - dt);
    p.mashT = Math.max(0, (p.mashT || 0) - dt);
    p.invT = Math.max(0, p.invT - dt);
    p.invCdT = Math.max(0, p.invCdT - dt);
    if (p.koT <= 0) p.dizzy = Math.max(0, p.dizzy - DIZZY_DECAY * dt);

    if (p.isBot && room.phase === 'playing') botThink(room, p, dt);
    const inp = p.input;
    const grabPressed = inp.grab && !p.prevGrab;
    p.prevGrab = inp.grab;
    if (!inp.grab) p.grabLock = false;
    p.aim = inp.aim;
    if (inp.fire) {
      p.fireQ = FIRE_BUFFER;
      p.fireA = Math.atan2(inp.ax, inp.az);
      inp.fire = false;
    }

    if (p.heldBy) {
      if (inp.punch || inp.jump) { p.holdT += 0.3; p.mashT = 0.3; }
      inp.punch = inp.jump = inp.kick = false;
      p.fireQ = 0;
      continue;
    }
    if (p.hang) {
      stepHang(room, p, dt, inp.jump || grabPressed);
      inp.punch = inp.jump = inp.kick = false;
      p.fireQ = 0;
      continue;
    }

    if (p.swingWind > 0) {
      if (!canAct(p) || !p.weapon) p.swingWind = 0;
      else {
        p.swingWind -= dt;
        if (p.swingWind <= 0) { p.swingWind = 0; weaponStrike(room, p); }
      }
    }
    if (p.spinT > 0) stepSpin(room, p, dt);
    if (p.kickWind > 0) {
      if (!canAct(p)) p.kickWind = 0;
      else {
        p.kickWind -= dt;
        if (p.kickWind <= 0) { p.kickWind = 0; kickStrike(room, p); }
      }
    }

    const rv = !p.falling && p.y < 0.4 && !p.heldBy ? riverAt(room, p.x, p.z) : null;
    p.inRiver = !!rv;
    // Movement and friction act relative to the water, so standing still means drifting.
    const flowing = rv && p.invT <= 0;
    const flowX = flowing ? rv.tx * RIVER_FLOW : 0, flowZ = flowing ? rv.tz * RIVER_FLOW : 0;
    p.vx -= flowX; p.vz -= flowZ;

    if (canAct(p)) {
      let ix = inp.x, iz = inp.z;
      const il = Math.hypot(ix, iz);
      if (il > 1) { ix /= il; iz /= il; }
      // Aiming faces the aim while the stick keeps strafing; otherwise face the way we move.
      const aimed = p.fireQ > 0 || (p.aim && Math.hypot(inp.ax, inp.az) > 0.1);
      if (p.fireQ > 0) p.face = p.fireA;
      else if (aimed || il > 0.15) {
        const target = aimed ? Math.atan2(inp.ax, inp.az) : Math.atan2(ix, iz);
        let diff = target - p.face;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        p.face += diff * Math.min(1, dt * (aimed ? AIM_TURN : 14));
      }
      const held = weaponItem(room, p);
      let speed = p.holding ? CARRY_SPEED : MOVE_SPEED;
      if (held) speed *= WEAPONS[held.type].carry;
      if (p.swingWind > 0 || p.punchT > 0 && held) speed *= 0.25;
      if (p.spinT > 0 && held) speed *= WEAPONS[held.type].spinSlow;
      if (p.kickWind > 0 || p.kickT > 0) speed *= 0.5;
      if (p.heaveT > 0) speed *= 0.1;
      if (rv) speed *= RIVER_WADE;
      p.moveSpd = speed;
      const accel = (p.grounded ? GROUND_ACCEL : AIR_ACCEL) * (rv ? 0.5 : 1);
      p.vx += (ix * speed - p.vx) * Math.min(1, accel * dt);
      p.vz += (iz * speed - p.vz) * Math.min(1, accel * dt);

      if (inp.jump && p.grounded && p.heaveT <= 0) {
        p.vy = held && !WEAPONS[held.type].ranged && !WEAPONS[held.type].bomb ? JUMP_VEL * 0.75 : JUMP_VEL;
        p.grounded = false;
        room.events.push({ t: 'jump', id: p.id });
      }
      if (p.fireQ > 0 && aimedRelease(room, p)) p.fireQ = 0;
      if (inp.punch) {
        if (p.holding) release(room, p, true);
        else if (p.punchCd <= 0 && p.heaveT <= 0 && p.spinT <= 0) (p.weapon ? weaponAttack : doPunch)(room, p);
      }
      if (inp.kick && p.kickCd <= 0 && p.heaveT <= 0 && !p.holding && p.swingWind <= 0 && p.spinT <= 0) startKick(room, p);
      if (grabPressed && p.weapon) {
        dropWeapon(room, p, true);
        p.grabLock = true;
      } else if (grabPressed && !p.holding && tryPickup(room, p)) {
        p.grabLock = true;
      } else if (inp.grab && !p.holding && !p.weapon && !p.grabLock && p.grabCd <= 0) {
        tryGrab(room, p);
      }
      if (!inp.grab && p.holding) release(room, p, false);
    } else {
      if (p.holding) release(room, p, false);
      if (p.grounded) {
        const f = Math.exp(-GROUND_FRICTION * dt);
        p.vx *= f;
        p.vz *= f;
      }
    }
    inp.punch = false;
    inp.jump = false;
    inp.kick = false;

    p.vx += flowX; p.vz += flowZ;

    if (!p.grounded) p.vy -= GRAVITY * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;

    const onIsland = onGround(room, p.x, p.z);
    if (onIsland && !p.falling && p.y <= 0 && p.y > -0.6) {
      if (!p.grounded && p.vy < -6) room.events.push({ t: 'land', id: p.id });
      p.y = 0;
      p.vy = 0;
      p.grounded = true;
      p.thrownT = 0;
      p.hangUsed = false;
    } else {
      p.grounded = false;
    }
    if (!p.heldBy && p.y < 1.6) {
      for (const o of room.obstacles) {
        if (!obstacleActive(room, o)) continue;
        const dx = p.x - o.x, dz = p.z - o.z;
        const d = Math.hypot(dx, dz) || 1e-4;
        const minD = o.r + BODY_R * 0.8;
        if (d >= minD) continue;
        const nx = dx / d, nz = dz / d;
        p.x = o.x + nx * minD;
        p.z = o.z + nz * minD;
        const vn = p.vx * nx + p.vz * nz;
        if (vn < 0) { p.vx -= vn * nx * 1.3; p.vz -= vn * nz * 1.3; }
      }
    }
    // Whatever the height, only thrown players get past the fence.
    if (!p.heldBy && !p.falling && p.thrownT <= 0) guardPush(room, p, 1.3);
    if (!p.falling) tryHang(room, p, inp.grab);
    if (p.invT > 0 && !p.hang && (p.falling || p.y < -0.6 || Math.hypot(p.x, p.z) > room.islandR + 0.3)) rescue(room, p);

    if (!p.falling && !p.hang && p.y < -0.6) {
      p.falling = true;
      dropWeapon(room, p, false);
      if (p.holding) release(room, p, false);
      room.events.push({ t: 'fall', id: p.id });
    }
    if (p.y < FALL_OUT_Y) p.state = 'out';
  }

  // Carried players ride in front of their holder.
  for (const h of list) {
    if (!h.holding) continue;
    const t = room.players.get(h.holding);
    if (!t || !isActive(t)) { h.holding = null; continue; }
    t.holdT += dt;
    if (t.holdT > MAX_HOLD) { release(room, h, false); continue; }
    t.x = h.x + Math.sin(h.face) * 1.35;
    t.z = h.z + Math.cos(h.face) * 1.35;
    t.y = h.y + 1.25;
    t.vx = h.vx; t.vy = h.vy; t.vz = h.vz;
    t.face = h.face + Math.PI;
    t.grounded = false;
  }

  // Soft body-to-body pushing.
  const solid = list.filter((p) => !p.heldBy && !p.falling && !p.hang);
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      const a = solid[i], b = solid[j];
      if (Math.abs(a.y - b.y) > 1.6) continue;
      let dx = b.x - a.x, dz = b.z - a.z;
      let dist = Math.hypot(dx, dz);
      const minD = BODY_R * 2;
      if (dist >= minD) continue;
      if (dist < 1e-4) { dx = 1; dz = 0; dist = 1; }
      const nx = dx / dist, nz = dz / dist;
      const push = (minD - dist) / 2;
      a.x -= nx * push; a.z -= nz * push;
      b.x += nx * push; b.z += nz * push;
      const rel = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
      if (rel > 0) {
        const j2 = rel * 0.8;
        a.vx -= nx * j2; a.vz -= nz * j2;
        b.vx += nx * j2; b.vz += nz * j2;
      }
    }
  }
}

function tickRoom(room, dt) {
  room.phaseTime += dt;

  if (room.phase === 'loading') {
    if (room.phaseTime >= LOADING_TIME) setPhase(room, 'countdown');
    return;
  }

  if (room.phase === 'countdown') {
    if (room.phaseTime >= COUNTDOWN) setPhase(room, 'playing');
    return;
  }

  if (room.phase === 'playing') {
    room.roundTime += dt;
    const t = Math.min(1, Math.max(0, (room.roundTime - SHRINK_DELAY) / SHRINK_DURATION));
    room.islandR = ISLAND_START + (ISLAND_MIN - ISLAND_START) * t;
    if (t > 0) room.gaps = riverGaps(room, room.islandR);
    if (!room.shrinkWarned && room.roundTime >= SHRINK_DELAY - SHRINK_WARN) {
      room.shrinkWarned = true;
      room.events.push({ t: 'shrinkWarn' });
    }
    stepPhysics(room, dt);
    stepItems(room, dt);
    stepBombSpawns(room, dt);

    const all = [...room.players.values()];
    const standing = all.filter((p) => isActive(p) && !p.falling);
    const falling = all.filter((p) => isActive(p) && p.falling);
    const teams = new Set(all.filter((p) => p.team >= 0).map((p) => p.team));
    if (teams.size >= 2) {
      const left = new Set(standing.map((p) => p.team));
      if (falling.length === 0 && left.size <= 1) {
        if (left.size === 1) {
          const t = [...left][0];
          room.winnerTeam = t;
          for (const p of all) if (p.team === t) p.score += 1;
        }
        setPhase(room, 'roundover');
      }
      return;
    }
    const needed = room.roundPlayers <= 1 ? 0 : 1;
    if (falling.length === 0 && standing.length <= needed) {
      const winner = room.roundPlayers > 1 ? standing[0] : null;
      if (winner) { winner.score += 1; room.winnerId = winner.id; }
      setPhase(room, 'roundover');
    }
    return;
  }

  if (room.phase === 'roundover') {
    for (const p of room.players.values()) {
      p.input.x = p.input.z = 0;
      p.input.grab = false;
    }
    stepPhysics(room, dt);
    stepItems(room, dt);
    if (room.phaseTime >= ROUND_OVER_TIME) setPhase(room, 'lobby');
  }
}

const r2 = (v) => Math.round(v * 100) / 100;
const fuseOf = (it) => (it && it.fuse != null ? r2(it.fuse) : -1);
function snapshot(room) {
  return {
    t: Math.round(serverClock * 1000) / 1000,
    phase: room.phase,
    phaseTime: r2(room.phaseTime),
    countdown: COUNTDOWN,
    islandR: r2(room.islandR),
    islandMax: ISLAND_START,
    shrinkIn: r2(SHRINK_DELAY - room.roundTime),
    gaps: room.gaps.map((g) => [r2(g.c), r2(g.h)]),
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      x: r2(p.x), y: r2(p.y), z: r2(p.z),
      vx: r2(p.vx), vy: r2(p.vy), vz: r2(p.vz),
      f: r2(p.face),
      st: p.state,
      fl: p.falling ? 1 : 0,
      ko: p.koT > 0 ? 1 : 0,
      sn: p.stunT > 0 ? 1 : 0,
      g: p.grounded ? 1 : 0,
      ms: r2(p.moveSpd || 0),
      pa: p.punchT > 0 ? (p.punchArm ? 2 : 1) : 0,
      h: p.holding || '',
      hb: p.heldBy || '',
      mh: p.heldBy && p.mashT > 0 ? 1 : 0, // visual only: legs kick while mashing to escape
      dz: Math.round(p.dizzy),
      w: weaponItem(room, p)?.type || '',
      sw: p.swingWind > 0 ? 1 : p.spinT > 0 ? 3 : p.punchT > 0 && p.weapon ? 2 : 0,
      sd: p.sweepSide,
      kk: p.kickT > 0 ? 1 : 0,
      am: p.aim ? 1 : 0,
      hg: p.hang ? Math.max(0.01, r2(p.climbT / HANG_CLIMB)) : 0,
      lt: p.late ? 1 : 0,
      tm: p.team,
      rv: p.inRiver ? 1 : 0,
      wf: fuseOf(weaponItem(room, p)),
    })),
    items: room.items.filter((it) => !it.holder).map((it) => ({
      i: it.id, t: it.type, x: r2(it.x), y: r2(it.y), z: r2(it.z), r: it.rot || 0, f: fuseOf(it), k: it.stuckTo || '', s: it.skid ? 1 : 0,
    })),
    shots: room.shots.map((s) => ({ i: s.id, x: r2(s.x), y: r2(s.y), z: r2(s.z), vx: r2(s.vx), vz: r2(s.vz) })),
  };
}

// Per-player data that only goes to that player's own socket, and only when it changes.
function sendPrivate(room) {
  const sec = room.secret;
  for (const p of room.players.values()) {
    if (p.isBot) continue;
    const d = {};
    if (p.invT > 0) d.inv = Math.round(p.invT * 10) / 10;
    if (p.adm && isAdmin(p) && sec.invBtn && room.phase === 'playing') {
      d.ib = { cd: Math.ceil(p.invCdT), left: Math.max(0, sec.invUses - p.invUsed) };
    }
    const key = JSON.stringify(d);
    if (key === p.pvKey) continue;
    p.pvKey = key;
    io.to(p.id).emit('pv', d);
  }
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};
function applySecret(room, s) {
  if (!s || typeof s !== 'object') return;
  const sec = room.secret;
  if ('blessed' in s) sec.blessed = clampInt(s.blessed, 0, Math.max(sec.blessed, room.players.size), sec.blessed);
  if ('includeMe' in s) sec.includeMe = !!s.includeMe;
  if ('invBtn' in s) sec.invBtn = !!s.invBtn;
  if ('invCd' in s) sec.invCd = clampInt(s.invCd, 0, 120, sec.invCd);
  if ('invUses' in s) sec.invUses = clampInt(s.invUses, 1, 10, sec.invUses);
}

// One bad tick must never freeze the round: log it (rate-limited) and keep going.
const errSeen = new Map();
function logError(where, err) {
  const key = `${where}:${err && err.message}`;
  const now = Date.now();
  if (now - (errSeen.get(key) || 0) < 10000) return;
  errSeen.set(key, now);
  console.error(`[${new Date().toISOString()}] ${where}:`, err && err.stack || err);
}
process.on('uncaughtException', (err) => logError('uncaught', err));
process.on('unhandledRejection', (err) => logError('unhandled', err));

// Fixed-step simulation: game time keeps pace with real time even when a timer fires late,
// instead of slowing down (which froze the round timer on a busy server).
const STEP = 1 / TICK_RATE;
const MAX_STEPS = 6;
let stepAccum = 0;
let sendAccum = 0;
let serverClock = 0; // seconds; stamps snapshots so clients can interpolate between them
let last = process.hrtime.bigint();
let slowWarnAt = 0;
setInterval(() => {
  const now = process.hrtime.bigint();
  stepAccum += Math.min(0.25, Number(now - last) / 1e9);
  last = now;
  let steps = 0;
  while (stepAccum >= STEP && steps < MAX_STEPS) {
    stepAccum -= STEP;
    steps++;
    serverClock += STEP;
    sendAccum += STEP;
    for (const room of rooms.values()) {
      try { tickRoom(room, STEP); } catch (err) { logError('tick', err); }
    }
  }
  if (stepAccum >= STEP) stepAccum = 0; // hopelessly behind: drop the backlog rather than spiral
  if (sendAccum < 1 / SEND_RATE) return;
  sendAccum %= 1 / SEND_RATE;
  for (const room of rooms.values()) {
    try {
      // Volatile: a congested client skips a stale snapshot instead of queueing a burst of them.
      io.to(room.code).volatile.emit('state', snapshot(room));
      if (room.events.length) io.to(room.code).emit('ev', room.events.splice(0));
      sendPrivate(room);
    } catch (err) { logError('send', err); }
  }
  const took = Number(process.hrtime.bigint() - now) / 1e6;
  if (took > 25 && Date.now() - slowWarnAt > 10000) {
    slowWarnAt = Date.now();
    console.warn(`Slow server tick: ${took.toFixed(1)} ms`);
  }
}, 1000 / TICK_RATE);

function removePlayer(room, id) {
  const me = room.players.get(id);
  if (!me) return;
  clearTimeout(me.awayTimer);
  dropWeapon(room, me, false);
  if (me.holding) release(room, me, false);
  if (me.heldBy) {
    const h = room.players.get(me.heldBy);
    if (h) h.holding = null;
  }
  room.players.delete(id);
  const humans = [...room.players.values()].filter((p) => !p.isBot);
  if (humans.length === 0) {
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === id) room.hostId = (humans.find((p) => !p.away) || humans[0]).id;
  broadcastRoom(room);
}

const clearInput = (p) => Object.assign(p.input, { x: 0, z: 0, grab: false, punch: false, jump: false, kick: false, fire: false, aim: false });

io.on('connection', (socket) => {
  let room = null;

  // Back from a short drop-out: same socket id, same critter, carry on where we left off.
  if (socket.recovered) {
    const r = rooms.get(ROOM_CODE);
    const p = r && r.players.get(socket.id);
    if (p) {
      room = r;
      clearTimeout(p.awayTimer);
      p.away = false;
      socket.join(r.code);
      socket.emit('room', roomInfo(r));
    } else {
      socket.emit('rejoin');
    }
  }

  function join(r, name, animal, sid) {
    // Same browser tab coming back on a new connection: drop its stranded old critter first.
    const sess = typeof sid === 'string' ? sid.slice(0, 40) : '';
    if (sess) for (const p of [...r.players.values()]) if (p.away && p.sid === sess) removePlayer(r, p.id);
    if (!rooms.has(r.code)) r = getRoom();
    if (r.players.size >= MAX_PLAYERS) return socket.emit('errorMsg', 'Room is full');
    room = r;
    socket.join(r.code);
    addPlayer(r, socket.id, name, animal).sid = sess;
    socket.emit('joined', { code: r.code, id: socket.id });
    broadcastRoom(r);
  }

  // Create and join both land in the single room.
  socket.on('create', ({ name, animal, sid } = {}) => {
    if (room) return;
    join(getRoom(), name, animal, sid);
  });

  socket.on('join', ({ code, name, animal, sid } = {}) => {
    if (room) return;
    if (code && String(code).toLowerCase().trim() !== ROOM_CODE) return socket.emit('errorMsg', 'Room not found');
    join(getRoom(), name, animal, sid);
  });

  socket.on('rtt', (cb) => { if (typeof cb === 'function') cb(); });

  socket.on('setAnimal', (animal) => {
    if (!room || room.phase !== 'lobby') return;
    const p = room.players.get(socket.id);
    if (!p || !allCharacters().includes(animal)) return;
    if (animalTaken(room, animal, p.id)) { socket.emit('errorMsg', 'That critter is already taken'); broadcastRoom(room); return; }
    p.animal = animal;
    broadcastRoom(room);
  });

  socket.on('input', (inp) => {
    if (!room || typeof inp !== 'object' || !inp) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.input.x = Math.max(-1, Math.min(1, Number(inp.x) || 0));
    p.input.z = Math.max(-1, Math.min(1, Number(inp.z) || 0));
    p.input.grab = !!inp.grab;
    p.input.aim = !!inp.aim;
    const ax = Number(inp.ax) || 0, az = Number(inp.az) || 0, al = Math.hypot(ax, az);
    if (al > 0.01) { p.input.ax = ax / al; p.input.az = az / al; }
    if (room.phase === 'playing') {
      if (inp.punch) p.input.punch = true;
      if (inp.jump) p.input.jump = true;
      if (inp.kick) p.input.kick = true;
      if (inp.fire) p.input.fire = true;
    }
  });

  socket.on('start', () => {
    if (!room || room.hostId !== socket.id || room.phase !== 'lobby') return;
    startRound(room);
  });

  socket.on('setTeams', (size) => {
    if (!room || room.hostId !== socket.id || room.phase !== 'lobby') return;
    if (!TEAM_SIZES.includes(size)) return;
    room.teamSize = size;
    broadcastRoom(room);
  });

  // Every admin request is checked here; anything from a player not named "ghouse" is dropped silently.
  socket.on('adm', (msg) => {
    const p = room && room.players.get(socket.id);
    if (!isAdmin(p) || !msg || typeof msg !== 'object') return;
    const reply = () => socket.emit('adm', { ok: true, s: room.secret });
    if (msg.op === 'auth') {
      if (p.adm) return reply();
      if (ADMIN_PIN) {
        const ip = socket.handshake.address;
        const f = pinFails.get(ip) || { n: 0, until: 0 };
        if (Date.now() < f.until) return socket.emit('adm', { pin: true, locked: true });
        const pin = typeof msg.pin === 'string' ? msg.pin.slice(0, 64) : '';
        if (!pin) return socket.emit('adm', { pin: true });
        if (!pinMatches(pin)) {
          f.n += 1;
          if (f.n >= PIN_MAX_FAILS) { f.n = 0; f.until = Date.now() + PIN_LOCK_MS; }
          pinFails.set(ip, f);
          return socket.emit('adm', { pin: true, bad: true, locked: f.until > Date.now() });
        }
        pinFails.delete(ip);
      }
      p.adm = true;
      return reply();
    }
    if (!p.adm) return;
    if (msg.op === 'set') { applySecret(room, msg.s); reply(); }
    else if (msg.op === 'inv') useInvButton(room, p);
  });

  socket.on('addBot', () => {
    if (!room || room.hostId !== socket.id || room.phase !== 'lobby') return;
    if (room.players.size >= MAX_PLAYERS) return;
    const name = BOT_NAMES[room.botCounter++ % BOT_NAMES.length];
    addPlayer(room, `bot-${room.code}-${room.botCounter}`, name, null, true);
    broadcastRoom(room);
  });

  socket.on('removeBots', () => {
    if (!room || room.hostId !== socket.id || room.phase !== 'lobby') return;
    for (const [id, p] of room.players) if (p.isBot) room.players.delete(id);
    broadcastRoom(room);
  });

  // Keep the critter for a grace period in case the connection comes back (phones drop Wi-Fi a lot).
  socket.on('disconnect', (reason) => {
    if (!room) return;
    const r = room, me = r.players.get(socket.id);
    if (!me) return;
    if (reason === 'client namespace disconnect' || reason === 'server namespace disconnect') return removePlayer(r, socket.id);
    me.away = true;
    clearInput(me);
    clearTimeout(me.awayTimer);
    me.awayTimer = setTimeout(() => removePlayer(r, socket.id), r.phase === 'lobby' ? AWAY_GRACE_LOBBY_MS : AWAY_GRACE_MS);
    const present = [...r.players.values()].find((p) => !p.isBot && !p.away);
    if (r.hostId === socket.id && present) { r.hostId = present.id; broadcastRoom(r); }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Bumper Buddies running at http://localhost:${PORT}`);
  const urls = lanUrls();
  if (urls.length) {
    console.log('Phones on the same Wi-Fi can join at:');
    for (const u of urls) console.log(`  ${u}`);
  }
});
