// Dex Arcade multiplayer: two players link up with a 4-digit code.
// One player picks HOST GAME and gets a code; the other picks JOIN GAME and types it in.
// Works in VR (a floating menu you point at with the controller) and on PC (a normal menu).
// The connection is made with PeerJS (WebRTC); its free public server is only used to find each other,
// then the two games talk directly.

const PEERJS_URL = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
let peerLib = null;
export function loadPeerJS() {
  if (peerLib) return peerLib;
  peerLib = new Promise((resolve, reject) => {
    if (window.Peer) { resolve(window.Peer); return; }
    const s = document.createElement('script');
    s.src = PEERJS_URL;
    s.onload = () => resolve(window.Peer);
    s.onerror = () => { peerLib = null; reject(new Error('Could not load the multiplayer library')); };
    document.head.appendChild(s);
  });
  return peerLib;
}

const W = 1024, H = 640;   // menu canvas size (pixels)

export function createMultiplayer(opts) {
  const { THREE, renderer, gameId, title, color = '#ffd23d',
    soloLabel = 'PLAY SOLO', onSolo, onHostStart, onStart, onMessage, onConnected, onLeft, onArcade } = opts;

  const maxPlayers = opts.maxPlayers ?? 3;
  const mp = {
    role: null,          // 'host' | 'guest' | null
    connected: false,    // true once at least one other player is linked up
    code: '',
    status: '',
    page: 'main',        // main | host | join | joined
    typed: '',
    peer: null,
    slot: 0,             // your player number: the host is 0, guests are 1, 2...
    players: [0],        // the player numbers in this game (including you)
    guests: new Map(),   // host only: player number -> connection
    conn: null,          // guest only: the connection to the host
    started: false,
  };

  // ---------- Networking ----------
  // Everyone connects to the host. The host passes each guest's messages on to the other guests,
  // and every message carries "_f": the player number it came from.
  const peerId = (code) => `dexarcade-${gameId}-${code}`;
  function setStatus(text) { mp.status = text; redraw(); }
  const safeSend = (c, msg) => { try { c.send(msg); } catch (e) {} };
  function hostStatus() {
    const n = mp.players.length;
    setStatus(n < 2 ? 'Waiting for friends to join...' : `${n} of ${maxPlayers} players here! Press START${n < maxPlayers ? ' or wait for more' : ''}.`);
  }
  function refreshPlayers() { mp.players = [0, ...[...mp.guests.keys()].sort()]; }
  function broadcast(msg, except = null) { for (const c of mp.guests.values()) if (c !== except) safeSend(c, msg); }

  async function host() {
    leave(true);
    mp.role = 'host'; mp.page = 'host'; mp.slot = 0; mp.players = [0]; mp.started = false;
    mp.code = String(1000 + Math.floor(Math.random() * 9000));
    setStatus('Starting...');
    let Peer;
    try { Peer = await loadPeerJS(); } catch (e) { setStatus('No internet? Could not start.'); return; }
    if (mp.role !== 'host') return;
    const peer = new Peer(peerId(mp.code));
    mp.peer = peer;
    peer.on('open', () => hostStatus());
    peer.on('connection', (c) => {
      c.on('open', () => {
        if (mp.started || mp.guests.size >= maxPlayers - 1) { safeSend(c, { t: '__full' }); setTimeout(() => c.close(), 500); return; }
        let slot = 1; while (mp.guests.has(slot)) slot++;
        c.slot = slot;
        mp.guests.set(slot, c);
        refreshPlayers();
        safeSend(c, { t: '__hello', slot, players: mp.players });
        broadcast({ t: '__players', players: mp.players }, c);
        mp.connected = true;
        hostStatus(); buzz();
        onConnected?.('host', slot);
      });
      c.on('data', (msg) => {
        if (!msg || mp.guests.get(c.slot) !== c) return;
        if (msg.t === '__bye') { guestGone(c); return; }
        msg._f = c.slot;
        broadcast(msg, c);           // pass it on to the other guests
        onMessage?.(msg, c.slot);
      });
      c.on('close', () => guestGone(c));
      c.on('error', () => guestGone(c));
    });
    peer.on('error', (e) => {
      if (e.type === 'unavailable-id') { host(); return; }   // code already taken: pick another
      setStatus('Network problem (' + e.type + ')');
    });
  }
  function guestGone(c) {
    if (mp.guests.get(c.slot) !== c) return;
    mp.guests.delete(c.slot);
    refreshPlayers();
    broadcast({ t: '__players', players: mp.players });
    broadcast({ t: '__left', slot: c.slot });
    mp.connected = mp.guests.size > 0;
    if (mp.page === 'host') hostStatus();
    onLeft?.(c.slot);
  }
  async function join(code) {
    leave(true);
    mp.role = 'guest'; mp.page = 'joined'; mp.code = code;
    setStatus('Connecting to ' + code + '...');
    let Peer;
    try { Peer = await loadPeerJS(); } catch (e) { setStatus('No internet? Could not connect.'); return; }
    if (mp.role !== 'guest') return;
    const peer = new Peer();
    mp.peer = peer;
    peer.on('open', () => {
      const c = peer.connect(peerId(code), { serialization: 'json', reliable: true });   // reliable: no lost messages
      mp.conn = c;
      c.on('data', (msg) => {
        if (!msg) return;
        if (msg.t === '__hello') {
          mp.slot = msg.slot; mp.players = msg.players; mp.connected = true;
          setStatus(`You're player ${msg.slot + 1}! Waiting for the host to start...`);
          buzz();
          onConnected?.('guest', msg.slot);
          return;
        }
        if (msg.t === '__players') { mp.players = msg.players; if (mp.page === 'joined') setStatus(`${mp.players.length} players here. Waiting for the host to start...`); return; }
        if (msg.t === '__full') { setStatus('That game is full or already playing.'); leave(true); mp.page = 'joined'; redraw(); return; }
        if (msg.t === '__start') { close(); onStart?.(msg.data); return; }
        if (msg.t === '__left') { onLeft?.(msg.slot); return; }
        if (msg.t === '__bye') { hostGone(); return; }
        onMessage?.(msg, msg._f ?? 0);
      });
      c.on('close', hostGone);
      c.on('error', hostGone);
    });
    peer.on('error', (e) => {
      setStatus(e.type === 'peer-unavailable' ? 'No game with code ' + code + '. Check the code!' : 'Network problem (' + e.type + ')');
    });
  }
  function hostGone() {
    if (!mp.conn) return;
    mp.conn = null;
    const was = mp.connected, others = mp.players.filter(s => s !== mp.slot);
    mp.connected = false;
    setStatus('Lost connection to the host.');
    if (was) for (const s of others) onLeft?.(s);   // when the host goes, everyone goes
    mp.players = [mp.slot];
  }
  function send(msg) {
    if (!mp.connected) return;
    if (mp.role === 'host') { msg._f = 0; broadcast(msg); }
    else if (mp.conn) safeSend(mp.conn, msg);
  }
  function startForBoth(data) {   // host only: tell everyone to start, and start here too
    mp.started = true;
    broadcast({ t: '__start', data });
    close();
    onStart?.(data);
  }
  function leave(quiet) {
    const others = mp.players.filter(s => s !== mp.slot);
    if (mp.role === 'host') { broadcast({ t: '__bye' }); for (const c of mp.guests.values()) { try { c.close(); } catch (e) {} } }
    if (mp.conn) { safeSend(mp.conn, { t: '__bye' }); try { mp.conn.close(); } catch (e) {} }
    if (mp.peer) { try { mp.peer.destroy(); } catch (e) {} }
    const was = mp.connected;
    mp.conn = null; mp.peer = null; mp.connected = false; mp.role = null; mp.code = '';
    mp.guests = new Map(); mp.players = [0]; mp.slot = 0; mp.started = false;
    if (was && !quiet) for (const s of others) onLeft?.(s);
  }
  addEventListener('beforeunload', () => leave(true));

  // ---------- Menu buttons (shared by the VR panel and the PC menu) ----------
  function buttons() {
    const b = (x, y, w, h, label, action, enabled = true) => ({ x, y, w, h, label, action, enabled });
    if (mp.page === 'main') return [
      b(262, 190, 500, 90, soloLabel, () => { close(); onSolo?.(); }),
      b(262, 300, 500, 90, 'HOST GAME', () => host()),
      b(262, 410, 500, 90, 'JOIN GAME', () => { mp.page = 'join'; mp.typed = ''; redraw(); }),
      ...(onArcade ? [b(362, 530, 300, 70, 'ARCADE', () => onArcade())] : []),
    ];
    if (mp.page === 'host') return [
      b(262, 420, 500, 90, 'START', () => onHostStart ? onHostStart() : startForBoth({}), mp.connected),
      b(362, 530, 300, 70, 'CANCEL', () => { leave(); mp.page = 'main'; redraw(); }),
    ];
    if (mp.page === 'join') {
      const keys = [];
      const labels = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'DEL', '0', 'GO'];
      labels.forEach((l, i) => {
        const col = i % 3, row = Math.floor(i / 3);
        keys.push(b(332 + col * 125, 200 + row * 82, 110, 70, l, () => {
          if (l === 'DEL') mp.typed = mp.typed.slice(0, -1);
          else if (l === 'GO') { if (mp.typed.length === 4) join(mp.typed); }
          else if (mp.typed.length < 4) mp.typed += l;
          redraw();
        }, l !== 'GO' || mp.typed.length === 4));
      });
      keys.push(b(362, 545, 300, 66, 'CANCEL', () => { mp.page = 'main'; redraw(); }));
      return keys;
    }
    if (mp.page === 'joined') return [
      b(362, 530, 300, 70, 'CANCEL', () => { leave(); mp.page = 'main'; redraw(); }),
    ];
    return [];
  }

  // ---------- VR panel ----------
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace;
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.0), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, fog: false }));
  panel.renderOrder = 1002;
  panel.visible = false;
  let hover = null;
  function redraw() {
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(10,12,30,0.94)'; g.fillRect(0, 0, W, H);
    g.strokeStyle = color; g.lineWidth = 8; g.strokeRect(4, 4, W - 8, H - 8);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = color; g.font = '48px "Press Start 2P", monospace';
    g.fillText(title, W / 2, 70);
    g.font = '22px "Press Start 2P", monospace'; g.fillStyle = '#ffffff';
    if (mp.page === 'main') g.fillText('PLAY ALONE OR WITH A FRIEND', W / 2, 135);
    if (mp.page === 'host') {
      g.fillText('TELL YOUR FRIEND THIS CODE:', W / 2, 140);
      g.fillStyle = color; g.font = '96px "Press Start 2P", monospace'; g.fillText(mp.code || '....', W / 2, 250);
      g.fillStyle = '#ffffff'; g.font = '20px "Press Start 2P", monospace'; g.fillText(mp.status, W / 2, 365);
    }
    if (mp.page === 'join') {
      g.fillText('TYPE YOUR FRIEND\'S CODE:', W / 2, 125);
      g.fillStyle = color; g.font = '44px "Press Start 2P", monospace';
      g.fillText((mp.typed + '____').slice(0, 4).split('').join(' '), W / 2, 170);
    }
    if (mp.page === 'joined') {
      g.fillText('CODE ' + mp.code, W / 2, 160);
      g.font = '20px "Press Start 2P", monospace';
      wrap(g, mp.status, W / 2, 300, 900, 40);
    }
    for (const btn of buttons()) {
      const hot = hover && hover.label === btn.label && btn.enabled;
      g.fillStyle = !btn.enabled ? '#2a2a3a' : hot ? color : '#3a3f6a';
      g.fillRect(btn.x, btn.y, btn.w, btn.h);
      g.strokeStyle = '#000'; g.lineWidth = 4; g.strokeRect(btn.x, btn.y, btn.w, btn.h);
      g.fillStyle = !btn.enabled ? '#666' : hot ? '#000' : '#fff';
      g.font = (btn.h < 80 ? '26px' : '30px') + ' "Press Start 2P", monospace';
      g.fillText(btn.label, btn.x + btn.w / 2, btn.y + btn.h / 2 + 2);
    }
    tex.needsUpdate = true;
    drawDom();
  }
  function wrap(g, text, x, y, maxW, lineH) {
    const words = text.split(' '); let line = '', yy = y;
    for (const w of words) { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > maxW && line) { g.fillText(line, x, yy); line = w; yy += lineH; } else line = t; }
    g.fillText(line, x, yy);
  }

  // Pointing at the panel with a controller
  const ray = new THREE.Raycaster(), rot = new THREE.Matrix4();
  const lasers = new Map();
  function laserFor(c) {
    if (!lasers.has(c)) {
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }));
      l.scale.z = 3; l.visible = false; c.add(l); lasers.set(c, l);
    }
    return lasers.get(c);
  }
  function hitButton(c) {
    rot.identity().extractRotation(c.matrixWorld);
    ray.ray.origin.setFromMatrixPosition(c.matrixWorld);
    ray.ray.direction.set(0, 0, -1).applyMatrix4(rot);
    const hit = ray.intersectObject(panel, false)[0];
    if (!hit || !hit.uv) return { hit: null, btn: null };
    const px = hit.uv.x * W, py = (1 - hit.uv.y) * H;
    return { hit, btn: buttons().find(b => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) || null };
  }
  function updatePointer(controllers) {
    let newHover = null;
    for (const c of controllers) {
      const l = laserFor(c);
      l.visible = panel.visible && renderer.xr.isPresenting;
      if (!l.visible) continue;
      const { hit, btn } = hitButton(c);
      l.scale.z = hit ? hit.distance : 3;
      if (btn) newHover = btn;
    }
    if ((newHover && newHover.label) !== (hover && hover.label)) { hover = newHover; redraw(); }
  }
  function select(c) {   // returns true if the press was used by the menu
    if (!panel.visible) return false;
    const { btn } = hitButton(c);
    if (btn && btn.enabled) { click(); btn.action(); return true; }
    return !!btn;
  }
  function click() {
    try { const a = new AudioContext(), o = a.createOscillator(), g = a.createGain(); o.frequency.value = 880; g.gain.value = 0.05; o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + 0.05); setTimeout(() => a.close(), 200); } catch (e) {}
  }
  function buzz() {
    const s = renderer.xr.getSession();
    if (s) for (const src of s.inputSources) src.gamepad?.hapticActuators?.[0]?.pulse?.(0.6, 150);
  }

  // ---------- PC menu ----------
  const dom = document.createElement('div');
  dom.style.cssText = 'position:fixed;inset:0;display:none;place-items:center;background:rgba(5,8,20,.6);z-index:50;padding:16px;font-family:"Press Start 2P",monospace';
  document.body.appendChild(dom);
  function drawDom() {
    if (dom.style.display === 'none') return;
    const card = (inner) => `<div style="background:rgba(10,12,30,.95);border:4px solid ${color};padding:24px;max-width:520px;width:100%;display:flex;flex-direction:column;gap:14px;text-align:center;color:#fff;line-height:1.7">
      <div style="font-size:clamp(18px,5vw,28px);color:${color}">${title}</div>${inner}</div>`;
    const btn = (id, label, enabled = true) => `<button data-a="${id}" ${enabled ? '' : 'disabled'} style="font:inherit;font-size:12px;color:#fff;background:${enabled ? '#3a3f6a' : '#2a2a3a'};border:3px solid #000;padding:12px 16px;cursor:${enabled ? 'pointer' : 'default'}">${label}</button>`;
    let html = '';
    if (mp.page === 'main') html = card(`<div style="font-size:10px">Play alone or with a friend</div>${btn('solo', soloLabel)}${btn('host', 'HOST GAME')}${btn('join', 'JOIN GAME')}${onArcade ? btn('arcade', 'BACK TO ARCADE') : ''}`);
    if (mp.page === 'host') html = card(`<div style="font-size:10px">Tell your friend this code:</div><div style="font-size:44px;color:${color}">${mp.code || '....'}</div><div style="font-size:9px">${mp.status}</div>${btn('start', 'START', mp.connected)}${btn('cancel', 'CANCEL')}`);
    if (mp.page === 'join') html = card(`<div style="font-size:10px">Type your friend's code:</div><input id="mpCode" inputmode="numeric" maxlength="4" value="${mp.typed}" style="font:inherit;font-size:28px;text-align:center;padding:10px;letter-spacing:8px">${btn('go', 'JOIN')}${btn('cancel', 'CANCEL')}`);
    if (mp.page === 'joined') html = card(`<div style="font-size:12px">Code ${mp.code}</div><div style="font-size:9px">${mp.status}</div>${btn('cancel', 'CANCEL')}`);
    dom.innerHTML = html;
    const input = dom.querySelector('#mpCode');
    if (input) { input.focus(); input.addEventListener('input', () => { mp.typed = input.value.replace(/\D/g, '').slice(0, 4); }); input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter' && mp.typed.length === 4) join(mp.typed); }); }
  }
  dom.addEventListener('click', (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (!a) return;
    if (a === 'solo') { close(); onSolo?.(); }
    if (a === 'host') host();
    if (a === 'join') { mp.page = 'join'; mp.typed = ''; redraw(); }
    if (a === 'arcade') onArcade?.();
    if (a === 'start') onHostStart ? onHostStart() : startForBoth({});
    if (a === 'go') { const v = (dom.querySelector('#mpCode')?.value || '').replace(/\D/g, ''); if (v.length === 4) join(v); }
    if (a === 'cancel') { leave(); mp.page = 'main'; redraw(); }
  });

  // ---------- Open / close ----------
  function open(page = 'main') {
    mp.page = mp.role === 'host' ? 'host' : mp.connected ? 'joined' : page;
    if (mp.role === 'host') { mp.started = false; hostStatus(); }   // back in the lobby: friends can join again
    if (mp.connected && mp.role === 'guest') mp.status = 'Waiting for the host to start...';
    panel.visible = renderer.xr.isPresenting;
    dom.style.display = renderer.xr.isPresenting ? 'none' : 'grid';
    redraw();
  }
  function close() {
    panel.visible = false;
    dom.style.display = 'none';
    for (const l of lasers.values()) l.visible = false;
  }
  // Switching between PC and VR keeps the menu on the right screen
  renderer.xr.addEventListener('sessionstart', () => { if (isOpen()) open(mp.page); });
  renderer.xr.addEventListener('sessionend', () => { if (isOpen()) open(mp.page); });
  const isOpen = () => panel.visible || dom.style.display !== 'none';

  Object.assign(mp, { panel, open, close, isOpen, updatePointer, select, send, startForBoth, leave, host, join, maxPlayers });
  redraw();
  return mp;
}
