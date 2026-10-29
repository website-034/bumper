const fs = require('fs');
const os = require('os');
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
const io = new Server(server);

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
const SHRINK_DELAY = 20;
const SHRINK_DURATION = 120;
const SPAWN_R = 13;
const PICKUP_RANGE = 1.9;
const MAX_GROUND_ITEMS = 20;
const OBSTACLE_COUNT = 32;
// Small floating rock islands just past the edge; they drop once the gap is too wide to jump.
const PLATFORM_COUNT = 4;
const PLATFORM_R = 2.4;
const PLATFORM_MAX_GAP = 5.5;
// Fenced stretches of the edge that stop players from being knocked off there.
const GUARD_COUNT = 4;
const GUARD_INSET = 0.5;
// River: a current along its centreline that carries players off the island's edge.
const RIVER_HALF = 1.7;
const RIVER_FLOW = 6;
const RIVER_WADE = 0.6;
const BRIDGE_HALF_LEN = 1.15;
// Bombs drop from the sky unannounced, land with a lit fuse and can be picked up and thrown.
// Sticky bombs only light when picked up, and cling to whoever they're thrown at.
const BOMB_FUSE = 5;
const BOMB_RADIUS = 3.2;
const BOMB_KNOCK = 14;
const MAX_BOMBS = 12;
const STICKY_CHANCE = 0.3;
const TEAM_SIZES = [0, 2, 3, 4];
const FALL_OUT_Y = -14;
const COUNTDOWN = 3;
const ROUND_OVER_TIME = 5;
const MAX_PLAYERS = 8;

// Melee weapons hit everyone in a cone in front; the blaster fires foam balls.
// Heavy melee weapons are dragged (carry = speed multiplier), wind up before striking,
// and knock anyone they hit straight into the dizzy state.
const WEAPONS = {
  bat: { range: 3.3, cone: 0.15, knock: 9, windup: 0.38, cd: 0.95, uses: 6, carry: 0.68, weight: 3 },
  pan: { range: 3.0, cone: 0.15, knock: 8, windup: 0.3, cd: 0.8, uses: 7, carry: 0.75, weight: 3 },
  hammer: { range: 3.4, cone: 0.1, knock: 12, windup: 0.55, cd: 1.2, uses: 4, carry: 0.55, weight: 2 },
  lollipop: { range: 3.3, cone: 0.15, knock: 9, windup: 0.4, cd: 0.95, uses: 6, carry: 0.68, weight: 2 },
  chicken: { range: 2.9, cone: 0.2, knock: 7, windup: 0.26, cd: 0.7, uses: 8, carry: 0.82, weight: 2 },
  blaster: { ranged: true, cd: 0.55, uses: 6, speed: 20, knock: 9, dizzy: 35, life: 1.0, carry: 0.9, weight: 1 },
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

const ANIMALS = ['corgi', 'bear', 'cat', 'bunny', 'duck', 'frog', 'pig', 'penguin', 'fox'];
const BOT_NAMES = ['Biscuit', 'Noodle', 'Pickles', 'Mochi', 'Waffles', 'Bean', 'Toffee', 'Pudding'];

const rooms = new Map();

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const room = {
    code: makeCode(),
    hostId: null,
    players: new Map(),
    phase: 'lobby', // lobby | countdown | playing | roundover
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
    platforms: [],
    guards: [],
    bombT: 0,
    teamSize: 0,
    winnerTeam: -1,
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

function validAnimal(a) {
  const all = allCharacters();
  return all.includes(a) ? a : all[Math.floor(Math.random() * all.length)];
}

function addPlayer(room, id, name, animal, isBot = false) {
  const p = {
    id,
    name: String(name || 'Buddy').slice(0, 14),
    animal: validAnimal(animal),
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
    heaveT: 0,
    wakeT: 0,
    team: -1,
    input: { x: 0, z: 0, grab: false, punch: false, jump: false },
    botT: 0,
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
    platforms: room.platforms,
    guards: room.guards,
    guardInset: GUARD_INSET,
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
    for (const p of room.players.values()) p.weapon = null;
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
    if (o.heldBy) {
      const h = room.players.get(o.heldBy);
      if (h) release(room, h, false);
    }
    const a = d > 0.1 ? Math.atan2(dx, dz) : Math.random() * Math.PI * 2;
    hitPlayer(room, null, o, Math.sin(a), Math.cos(a), BOMB_KNOCK * (1 - (d / BOMB_RADIUS) * 0.4), 100, o.x, o.y + 1, o.z, it.type);
    o.vy = 9;
  }
  for (const other of room.items) {
    if (other.holder || other.stuckTo) continue;
    const dx = other.x - bx, dz = other.z - bz, d = Math.hypot(dx, dz);
    if (d > BOMB_RADIUS) continue;
    const a = d > 0.1 ? Math.atan2(dx, dz) : Math.random() * Math.PI * 2;
    other.vx = Math.sin(a) * 7; other.vz = Math.cos(a) * 7; other.vy = 8; other.grounded = false;
  }
}

// ---- Floating rock platforms and fenced edges ----
const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

// Angles at which the river crosses the edge (at full size and part-way through shrinking).
function riverEdgeAngles(room) {
  const out = [];
  for (const R of [ISLAND_START, ISLAND_START * 0.6]) {
    for (const sg of room.river.segs) {
      const ex = sg.x0 + sg.dx * sg.len, ez = sg.z0 + sg.dz * sg.len;
      if ((Math.hypot(sg.x0, sg.z0) < R) !== (Math.hypot(ex, ez) < R)) out.push(Math.atan2(ex, ez));
    }
  }
  return out;
}

function makeGuards(room) {
  const avoid = riverEdgeAngles(room);
  const guards = [];
  for (let tries = 0; guards.length < GUARD_COUNT && tries < 600; tries++) {
    const c = Math.random() * Math.PI * 2;
    const h = 0.3 + Math.random() * 0.2;
    if (avoid.some((a) => angDiff(a, c) < h + 0.35)) continue;
    if (guards.some((g) => angDiff(g.c, c) < g.h + h + 0.45)) continue;
    guards.push({ c: r2(c), h: r2(h) });
  }
  return guards;
}

const inGuard = (room, a) => room.guards.some((g) => angDiff(a, g.c) < g.h);

function makePlatforms(room) {
  const avoid = riverEdgeAngles(room);
  const plats = [];
  for (let tries = 0; plats.length < PLATFORM_COUNT && tries < 600; tries++) {
    const a = Math.random() * Math.PI * 2;
    if (avoid.some((x) => angDiff(x, a) < 0.35)) continue;
    if (room.guards.some((g) => angDiff(g.c, a) < g.h + 0.15)) continue;
    if (plats.some((p) => angDiff(p.a, a) < 0.6)) continue;
    const gap = 1.4 + Math.random() * 0.8;
    const d = ISLAND_START + gap + PLATFORM_R;
    plats.push({ a: r2(a), x: r2(Math.sin(a) * d), z: r2(Math.cos(a) * d), r: PLATFORM_R, d: r2(d) });
  }
  return plats;
}

const platformActive = (room, pl) => pl.d - pl.r - room.islandR < PLATFORM_MAX_GAP;

function platformAt(room, x, z) {
  return room.platforms.find((pl) => platformActive(room, pl) && Math.hypot(x - pl.x, z - pl.z) <= pl.r) || null;
}

const onGround = (room, x, z) => Math.hypot(x, z) <= room.islandR || !!platformAt(room, x, z);

// Fences push back anything trying to leave through a guarded stretch of the edge.
function guardPush(room, o, bounce) {
  const d = Math.hypot(o.x, o.z);
  const lim = room.islandR - GUARD_INSET - 0.6;
  if (d <= lim || d > room.islandR + 0.4 || !inGuard(room, Math.atan2(o.x, o.z))) return;
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
  p.swingWind = p.heaveT = p.wakeT = 0;
}

function startRound(room) {
  const list = [...room.players.values()];
  room.islandR = ISLAND_START;
  room.roundTime = 0;
  room.winnerId = null;
  room.winnerTeam = -1;
  room.roundPlayers = list.length;
  room.river = makeRiver();
  room.guards = makeGuards(room);
  room.platforms = makePlatforms(room);
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
  });
  setPhase(room, 'countdown');
}

const isActive = (p) => p.state === 'alive';
const canAct = (p) => isActive(p) && !p.falling && p.koT <= 0 && p.stunT <= 0 && !p.heldBy;

function release(room, holder, thrown) {
  const t = room.players.get(holder.holding);
  holder.holding = null;
  holder.grabCd = 0.5;
  if (!t) return;
  t.heldBy = null;
  t.holdT = 0;
  if (thrown) {
    t.vx = Math.sin(holder.face) * THROW_SPEED + holder.vx * 0.5;
    t.vz = Math.cos(holder.face) * THROW_SPEED + holder.vz * 0.5;
    t.vy = 7;
    t.stunT = 0.9;
    t.grounded = false;
    room.events.push({ t: 'throw', id: holder.id, target: t.id });
  } else {
    t.vy = 2;
    t.grounded = false;
    t.stunT = Math.max(t.stunT, 0.2);
  }
}

const weaponItem = (room, p) => (p.weapon ? room.items.find((it) => it.id === p.weapon) : null);

// Shared by punches, weapon swings, foam balls and thrown weapons.
function hitPlayer(room, attackerId, o, fx, fz, knockBase, dizzyAdd, hx, hy, hz, w = '') {
  const knock = knockBase * (1 + o.dizzy / 120) * (o.koT > 0 ? 1.4 : 1);
  o.vx += fx * knock;
  o.vz += fz * knock;
  o.vy = Math.max(o.vy, 3 + knockBase * 0.12);
  o.grounded = false;
  o.stunT = Math.max(o.stunT, 0.35);
  o.swingWind = 0;
  if (o.holding) release(room, o, false);

  let ko = false;
  if (o.koT <= 0) {
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

function meleeHits(room, p, range, cone, knock, dizzy, w = '') {
  const fx = Math.sin(p.face), fz = Math.cos(p.face);
  for (const o of room.players.values()) {
    if (o === p || !isActive(o) || o.falling || o.heldBy) continue;
    const dx = o.x - p.x, dz = o.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist > range || Math.abs(o.y - p.y) > 1.4) continue;
    if (dist > 0.01 && (dx * fx + dz * fz) / dist < cone) continue;
    hitPlayer(room, p.id, o, fx, fz, knock, dizzy, p.x + fx * 1.1, p.y + 1.1, p.z + fz * 1.1, w);
  }
}

// Snap facing toward the best target roughly in front, so attacks are easy to land on phones.
// Enemies are preferred; teammates are only auto-aimed at when no enemy is close.
function aimAssist(room, p, range, minDot) {
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
    aimAssist(room, p, w.range + 1, 0.1);
    p.swingWind = w.windup;
    room.events.push({ t: 'windup', id: p.id, w: it.type });
  }
}

function weaponStrike(room, p) {
  const it = weaponItem(room, p);
  if (!it) return;
  const w = WEAPONS[it.type];
  aimAssist(room, p, w.range + 0.6, 0.1);
  p.punchT = 0.35;
  p.punchArm = 1 - p.punchArm;
  room.events.push({ t: 'swing', id: p.id, w: it.type });
  meleeHits(room, p, w.range, w.cone, w.knock, 100, it.type);
  useUp(room, p, it);
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
  const speed = isBomb(it) ? 12 : 15;
  it.vx = p.vx * 0.5 + (toss ? fx * speed : 0);
  it.vz = p.vz * 0.5 + (toss ? fz * speed : 0);
  it.vy = toss ? (isBomb(it) ? 6 : 3.5) : 2;
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
    } else {
      const rv = riverAt(room, it.x, it.z);
      if (rv) { it.x += rv.tx * RIVER_FLOW * 0.45 * dt; it.z += rv.tz * RIVER_FLOW * 0.45 * dt; }
    }
    const onIsland = onGround(room, it.x, it.z);
    if (onIsland && it.y <= 0 && it.y > -0.5) {
      if (!it.grounded) room.events.push({ t: 'itemLand', x: r2(it.x), z: r2(it.z), w: it.type });
      it.y = 0;
      it.vx = it.vy = it.vz = 0;
      it.grounded = true;
      it.thrownBy = null;
      if (it.type === 'bomb' && it.fuse == null) it.fuse = BOMB_FUSE;
    } else if (!onIsland) {
      it.grounded = false;
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
        if (it.type === 'sticky') {
          hitPlayer(room, it.thrownBy, o, it.vx / sp, it.vz / sp, 3, 15, it.x, it.y, it.z, 'sticky');
          it.stuckTo = o.id;
          it.vx = it.vy = it.vz = 0;
          room.events.push({ t: 'stick', id: o.id, x: r2(it.x), y: r2(it.y), z: r2(it.z) });
        } else {
          const bomb = it.type === 'bomb';
          hitPlayer(room, it.thrownBy, o, it.vx / sp, it.vz / sp, bomb ? 5 : 9, bomb ? 25 : it.type === 'blaster' ? 40 : 100, it.x, it.y, it.z, it.type);
          it.vx *= -0.25; it.vz *= -0.25; it.vy = 3;
        }
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
    if (o === p || !isActive(o) || o.falling || o.heldBy || o.holding === p.id) continue;
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

function botThink(room, bot, dt) {
  bot.botT -= dt;
  if (bot.botT > 0) return;
  bot.botT = 0.18 + Math.random() * 0.15;
  const inp = bot.input;
  inp.punch = false;
  inp.jump = false;

  if (bot.heldBy) {
    inp.punch = Math.random() < 0.35;
    return;
  }

  const distC = Math.hypot(bot.x, bot.z) || 0.001;
  const R = room.islandR;

  if (bot.holding) {
    // Carry the victim to the nearest edge, then toss.
    inp.x = bot.x / distC;
    inp.z = bot.z / distC;
    inp.grab = true;
    if (distC > R - 2.4) inp.punch = true;
    return;
  }

  // Stranded on a floating rock: run at the main island and hop the gap.
  const pl = distC > R ? platformAt(room, bot.x, bot.z) : null;
  if (pl) {
    inp.x = -bot.x / distC;
    inp.z = -bot.z / distC;
    inp.grab = false;
    if (distC < pl.d - pl.r + 1) inp.jump = true;
    if (bot.weapon) inp.punch = true;
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

  let target = null, best = Infinity;
  for (const o of room.players.values()) {
    if (o === bot || !isActive(o) || o.falling || o.heldBy === bot.id || sameTeam(bot, o)) continue;
    const d = Math.hypot(o.x - bot.x, o.z - bot.z);
    if (d < best) { best = d; target = o; }
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
    if (w.bomb) {
      if ((best < 8 && facing > 0.8) || (held.fuse != null && held.fuse < 1.2)) inp.punch = true;
    } else if (w.ranged) {
      if (best < 6) { inp.x *= 0.2; inp.z *= 0.2; }
      if (best < 11 && facing > 0.9 && Math.random() < 0.4) inp.punch = true;
    } else if (best < w.range - 0.3 && facing > 0.6 && Math.random() < 0.45) {
      inp.punch = true;
    }
    return;
  }

  if (best < 1.9) {
    if ((target.koT > 0 && Math.random() < 0.5) || Math.random() < 0.05) inp.grab = true;
    else if (Math.random() < 0.3) inp.punch = true;
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
    if (p.koT <= 0) p.dizzy = Math.max(0, p.dizzy - DIZZY_DECAY * dt);

    if (p.isBot && room.phase === 'playing') botThink(room, p, dt);
    const inp = p.input;
    const grabPressed = inp.grab && !p.prevGrab;
    p.prevGrab = inp.grab;
    if (!inp.grab) p.grabLock = false;

    if (p.heldBy) {
      if (inp.punch || inp.jump) p.holdT += 0.3;
      inp.punch = inp.jump = false;
      continue;
    }

    if (p.swingWind > 0) {
      if (!canAct(p) || !p.weapon) p.swingWind = 0;
      else {
        p.swingWind -= dt;
        if (p.swingWind <= 0) { p.swingWind = 0; weaponStrike(room, p); }
      }
    }

    const rv = !p.falling && p.y < 0.4 && !p.heldBy ? riverAt(room, p.x, p.z) : null;
    p.inRiver = !!rv;
    // Movement and friction act relative to the water, so standing still means drifting.
    const flowX = rv ? rv.tx * RIVER_FLOW : 0, flowZ = rv ? rv.tz * RIVER_FLOW : 0;
    p.vx -= flowX; p.vz -= flowZ;

    if (canAct(p)) {
      let ix = inp.x, iz = inp.z;
      const il = Math.hypot(ix, iz);
      if (il > 1) { ix /= il; iz /= il; }
      if (il > 0.15) {
        const target = Math.atan2(ix, iz);
        let diff = target - p.face;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        p.face += diff * Math.min(1, dt * 14);
      }
      const held = weaponItem(room, p);
      let speed = p.holding ? CARRY_SPEED : MOVE_SPEED;
      if (held) speed *= WEAPONS[held.type].carry;
      if (p.swingWind > 0 || p.punchT > 0 && held) speed *= 0.25;
      if (p.heaveT > 0) speed *= 0.1;
      if (rv) speed *= RIVER_WADE;
      const accel = (p.grounded ? GROUND_ACCEL : AIR_ACCEL) * (rv ? 0.5 : 1);
      p.vx += (ix * speed - p.vx) * Math.min(1, accel * dt);
      p.vz += (iz * speed - p.vz) * Math.min(1, accel * dt);

      if (inp.jump && p.grounded && p.heaveT <= 0) {
        p.vy = held && !WEAPONS[held.type].ranged && !WEAPONS[held.type].bomb ? JUMP_VEL * 0.75 : JUMP_VEL;
        p.grounded = false;
        room.events.push({ t: 'jump', id: p.id });
      }
      if (inp.punch) {
        if (p.holding) release(room, p, true);
        else if (p.punchCd <= 0 && p.heaveT <= 0) (p.weapon ? weaponAttack : doPunch)(room, p);
      }
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
    if (!p.heldBy && !p.falling && p.y < 1.1) guardPush(room, p, 1.3);

    if (!p.falling && p.y < -0.6) {
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
  const solid = list.filter((p) => !p.heldBy && !p.falling);
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

  if (room.phase === 'countdown') {
    if (room.phaseTime >= COUNTDOWN) setPhase(room, 'playing');
    return;
  }

  if (room.phase === 'playing') {
    room.roundTime += dt;
    const t = Math.min(1, Math.max(0, (room.roundTime - SHRINK_DELAY) / SHRINK_DURATION));
    room.islandR = ISLAND_START + (ISLAND_MIN - ISLAND_START) * t;
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
    phase: room.phase,
    phaseTime: r2(room.phaseTime),
    countdown: COUNTDOWN,
    islandR: r2(room.islandR),
    islandMax: ISLAND_START,
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
      pa: p.punchT > 0 ? (p.punchArm ? 2 : 1) : 0,
      h: p.holding || '',
      hb: p.heldBy || '',
      dz: Math.round(p.dizzy),
      w: weaponItem(room, p)?.type || '',
      sw: p.swingWind > 0 ? 1 : p.punchT > 0 && p.weapon ? 2 : 0,
      tm: p.team,
      rv: p.inRiver ? 1 : 0,
      wf: fuseOf(weaponItem(room, p)),
    })),
    plat: room.platforms.map((pl) => (platformActive(room, pl) ? 1 : 0)),
    items: room.items.filter((it) => !it.holder).map((it) => ({
      i: it.id, t: it.type, x: r2(it.x), y: r2(it.y), z: r2(it.z), r: it.rot || 0, f: fuseOf(it), k: it.stuckTo || '',
    })),
    shots: room.shots.map((s) => ({ i: s.id, x: r2(s.x), y: r2(s.y), z: r2(s.z), vx: r2(s.vx), vz: r2(s.vz) })),
    events: room.events.splice(0),
  };
}

let sendAccum = 0;
let last = process.hrtime.bigint();
setInterval(() => {
  const now = process.hrtime.bigint();
  const dt = Math.min(0.05, Number(now - last) / 1e9);
  last = now;
  sendAccum += dt;
  const send = sendAccum >= 1 / SEND_RATE;
  if (send) sendAccum = 0;
  for (const room of rooms.values()) {
    tickRoom(room, dt);
    if (send) io.to(room.code).emit('state', snapshot(room));
  }
}, 1000 / TICK_RATE);

io.on('connection', (socket) => {
  let room = null;

  function join(r, name, animal) {
    if (r.players.size >= MAX_PLAYERS) return socket.emit('errorMsg', 'Room is full');
    room = r;
    socket.join(r.code);
    addPlayer(r, socket.id, name, animal);
    socket.emit('joined', { code: r.code, id: socket.id });
    broadcastRoom(r);
  }

  socket.on('create', ({ name, animal } = {}) => {
    if (room) return;
    join(createRoom(), name, animal);
  });

  socket.on('join', ({ code, name, animal } = {}) => {
    if (room) return;
    const r = rooms.get(String(code || '').toUpperCase().trim());
    if (!r) return socket.emit('errorMsg', 'Room not found');
    join(r, name, animal);
  });

  socket.on('setAnimal', (animal) => {
    if (!room || room.phase !== 'lobby') return;
    const p = room.players.get(socket.id);
    if (p && allCharacters().includes(animal)) { p.animal = animal; broadcastRoom(room); }
  });

  socket.on('input', (inp) => {
    if (!room || typeof inp !== 'object' || !inp) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.input.x = Math.max(-1, Math.min(1, Number(inp.x) || 0));
    p.input.z = Math.max(-1, Math.min(1, Number(inp.z) || 0));
    p.input.grab = !!inp.grab;
    if (room.phase === 'playing') {
      if (inp.punch) p.input.punch = true;
      if (inp.jump) p.input.jump = true;
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

  socket.on('disconnect', () => {
    if (!room) return;
    const me = room.players.get(socket.id);
    if (me) {
      dropWeapon(room, me, false);
      if (me.holding) release(room, me, false);
      if (me.heldBy) {
        const h = room.players.get(me.heldBy);
        if (h) h.holding = null;
      }
    }
    room.players.delete(socket.id);
    const humans = [...room.players.values()].filter((p) => !p.isBot);
    if (humans.length === 0) {
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === socket.id) room.hostId = humans[0].id;
    broadcastRoom(room);
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
