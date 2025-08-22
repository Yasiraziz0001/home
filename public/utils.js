export function fmtTs(ts){ try { return new Date(ts).toLocaleString(); }
catch { return String(ts); } }
export function qs(sel){ return document.querySelector(sel); }
export function qsa(sel){ return
Array.from(document.querySelectorAll(sel)); }
export function el(tag, attrs={}, ...children){ const
n=document.createElement(tag); Object.assign(n, attrs); children.forEach(c=>
n.append(c)); return n; }
export function iceServers(){
// Pull TURN from server-side env via meta tags if you want; for now read 
from window.TURN
const arr = [{ urls: ['stun:stun.l.google.com:19302'] }];
if (window.TURN && window.TURN.url) arr.push({ urls:[window.TURN.url],
username:window.TURN.username, credential:window.TURN.credential });
return arr;
}
