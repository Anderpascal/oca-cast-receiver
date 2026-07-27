(() => {
  'use strict';
  const NS = 'urn:x-cast:com.juegaoca.presentation';
  const PROTOCOL = OcaCastProtocol.PROTOCOL_VERSION;
  const MAX_MESSAGE_BYTES = 64 * 1024;
  const ART = OcaBoardArt;
  const SVG = 'http://www.w3.org/2000/svg';
  const U = ART.U;
  const colors = ['#0078bf','#00a95c','#ffe800','#ff6c2f','#f15060','#914e72','#00838a','#765ba7'];
  const statusLabels = {pozo:'POZO',carcel:'CÁRCEL',posada:'POSADA'};
  let state = null;
  const guard = new OcaCastProtocol.CueGuard();
  const authority = new OcaCastProtocol.SenderAuthority();
  let context = null;
  const $ = id => document.getElementById(id);
  const hopping = new Set();
  const tokenNodes = new Map();

  function send(senderId, type, extra={}) {
    if (!context || !senderId) return;
    context.sendCustomMessage(NS, senderId, {type, protocolVersion:PROTOCOL, ...extra});
  }
  function onMessage(event) {
    if (!authority.claim(event.senderId)) {
      send(event.senderId, 'busy');
      return;
    }
    let msg;
    try {
      const raw = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
      if (new TextEncoder().encode(raw).length >= MAX_MESSAGE_BYTES) {
        send(event.senderId, 'snapshot_request');
        return;
      }
      msg = typeof event.data === 'string' ? JSON.parse(raw) : event.data;
    } catch (_) {
      send(event.senderId, 'snapshot_request');
      return;
    }
    if (msg?.protocolVersion !== PROTOCOL) {
      send(event.senderId, 'incompatible');
      return;
    }
    if (msg?.type === 'snapshot' && !OcaCastProtocol.isPresentationState(msg.payload?.state)) {
      send(event.senderId, 'snapshot_request');
      return;
    }
    const decision = guard.inspect(msg);
    if (decision === 'incompatible') {
      send(event.senderId, 'incompatible');
      return;
    }
    if (decision === 'malformed' || decision === 'snapshot_request') {
      send(event.senderId, 'snapshot_request');
      return;
    }
    if (decision === 'ignore') return;

    if (msg.type === 'snapshot') {
      state = msg.payload.state;
      render();
    } else {
      animateCue(msg.type, msg.payload || {});
    }
    send(event.senderId, 'ack', {sequence: guard.lastSequence});
  }

  // --- dibujo -------------------------------------------------------------

  function el(tag, attrs, parent) {
    const node = document.createElementNS(SVG, tag);
    for (const k in attrs) if (attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    if (parent) parent.append(node);
    return node;
  }
  function text(parent, value, attrs) {
    const node = el('text', attrs, parent);
    node.textContent = value;
    return node;
  }

  function squareType(n, board) {
    if (n === board.goal) return 'jardin';
    return board.specialSquares[String(n)] || null;
  }

  function drawPictogram(parent, type, cx, cy, size, ink) {
    const shapes = ART.PICTS[type];
    if (!shapes) return;
    const s = size / 100;
    const g = el('g', {
      transform: `translate(${cx - size / 2},${cy - size / 2}) scale(${s})`,
      fill: 'none', stroke: ink, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }, parent);
    for (const shape of shapes) {
      const attrs = {};
      for (const k in shape.a) attrs[k] = shape.a[k] === 'ink' ? ink : shape.a[k];
      el(shape.t, attrs, g);
    }
  }

  /// El medallón de la meta: no es una casilla, es el final del viaje. Papel
  /// como el resto del tablero y la fiesta en el sello -si se rellena entero
  /// de tinta se come el tablero desde el otro lado del salón-.
  function drawGoal(parent, cell, theme) {
    const c = ART.centerOf(cell);
    const w = cell.colSpan * U, h = cell.rowSpan * U;
    const rx = Math.min(w, h) * 0.36;
    el('rect', {
      x: c.x - w / 2 + U * 0.07, y: c.y - h / 2 + U * 0.07,
      width: w - U * 0.14, height: h - U * 0.14,
      fill: 'var(--paper)', stroke: 'var(--ink)', 'stroke-width': 8,
    }, parent);
    // Rayos del sello, a la manera de una escarapela de feria.
    for (let i = 0; i < 12; i++) {
      const a = (i * Math.PI) / 6;
      el('path', {
        d: `M${(c.x + Math.cos(a) * rx * 1.06).toFixed(1)},${(c.y + Math.sin(a) * rx * 1.06).toFixed(1)} L${(c.x + Math.cos(a) * rx * 1.42).toFixed(1)},${(c.y + Math.sin(a) * rx * 1.42).toFixed(1)}`,
        stroke: theme.ink2, 'stroke-width': 7, 'stroke-linecap': 'round',
      }, parent);
    }
    el('circle', {cx: c.x, cy: c.y, r: rx, fill: theme.ink2, stroke: 'var(--ink)', 'stroke-width': 6}, parent);
    el('circle', {cx: c.x, cy: c.y, r: rx * 0.78, fill: 'none', stroke: 'var(--ink)', 'stroke-width': 3}, parent);
    text(parent, 'META', {
      x: c.x, y: c.y + rx * 0.24, 'text-anchor': 'middle',
      class: 'goal-label', 'font-size': rx * 0.6,
    });
  }

  function renderBoard() {
    const board = state.board;
    const geo = ART.geometryFor(board.goal);
    const theme = ART.themeFor(board.visualTheme);
    const svg = $('board');
    svg.setAttribute('viewBox', `0 0 ${geo.cols * U} ${geo.rows * U}`);
    const cells = $('board-cells');
    cells.replaceChildren();

    for (const cell of geo.cells) {
      const type = squareType(cell.n, board);
      const g = el('g', {class: 'cell' + (type ? ' special' : '')}, cells);
      if (type === 'jardin') { drawGoal(g, cell, theme); continue; }

      const c = ART.centerOf(cell);
      const w = cell.colSpan * U, h = cell.rowSpan * U;
      const ink = type ? theme[ART.ROLE[type] || 'ink1'] : null;
      // Desregistro de guillotina: cada plancha cae con un grado de más o de
      // menos. Sembrado por número para que no baile entre repintados.
      const tilt = ((cell.n * 17) % 5 - 2) * 0.35;
      el('rect', {
        x: c.x - w / 2 + U * 0.07, y: c.y - h / 2 + U * 0.07,
        width: w - U * 0.14, height: h - U * 0.14,
        fill: 'var(--paper)', stroke: 'var(--ink)',
        'stroke-width': type ? 6 : 3.4,
        transform: `rotate(${tilt} ${c.x} ${c.y})`,
      }, g);

      if (type) {
        drawPictogram(g, type, c.x, c.y + U * 0.05, U * 0.76, ink);
        // El número se retira a la esquina: manda el pictograma.
        text(g, cell.n, {
          x: c.x - w / 2 + U * 0.17, y: c.y - h / 2 + U * 0.28,
          class: 'cell-corner', 'font-size': U * 0.19,
        });
      } else {
        text(g, cell.n, {
          x: c.x, y: c.y + U * 0.14, 'text-anchor': 'middle',
          class: 'cell-number', 'font-size': U * 0.4,
        });
      }
    }
  }

  /// Las fichas viven en su propia capa para poder moverse entre casillas sin
  /// repintar el póster de debajo.
  function renderTokens() {
    // Repintar durante un salto lo cortaría en seco: el snapshot con la
    // posición final llega pisándole los talones al `piece_path`.
    if (hopping.size) return;
    const layer = $('board-tokens');
    layer.replaceChildren();
    tokenNodes.clear();

    const byCell = new Map();
    for (const p of state.players) {
      const list = byCell.get(p.position) || [];
      list.push(p);
      byCell.set(p.position, list);
    }
    for (const [, list] of byCell) {
      const {scale} = crowdLayout(list.length);
      list.forEach((p, i) => {
        const g = el('g', {class: 'token' + (p.publicId === state.turn.currentPlayerId ? ' current' : '')}, layer);
        buildToken(g, p, scale);
        const at = restingSpot(p.position, i, list.length);
        setTokenAt(g, at.x, at.y, 1);
        tokenNodes.set(p.publicId, g);
      });
    }
  }

  function buildToken(g, player, scale) {
    const ink = colors[player.inkIndex] || colors[0];
    const r = U * 0.26 * scale;
    const isCurrent = player.publicId === state.turn.currentPlayerId;
    // A quien le toca se le pone una aureola rosa -la tinta de acción- en vez
    // de agrandarle la ficha: el tamaño se lo reserva el salto.
    if (isCurrent) {
      el('circle', {cx: 0, cy: 0, r: r * 1.3, fill: 'none', stroke: 'var(--pink)', 'stroke-width': 7}, g);
    }
    el('circle', {cx: r * 0.16, cy: r * 0.2, r, fill: 'var(--ink)'}, g);
    el('circle', {cx: 0, cy: 0, r, fill: ink, stroke: 'var(--ink)', 'stroke-width': 5}, g);
    text(g, player.symbol, {
      x: 0, y: r * 0.37, 'text-anchor': 'middle',
      class: 'token-mark', 'font-size': r * 1.1,
      fill: player.inkIndex === 2 ? 'var(--ink)' : '#fff',
    });
  }

  /// Varias fichas en la misma casilla se reparten en rejilla y encogen para
  /// que ninguna tape a otra ni se salga de la casilla; una sola se queda
  /// centrada y a tamaño completo.
  function crowdLayout(total) {
    if (total <= 1) return {scale: 1, cols: 1};
    if (total <= 4) return {scale: 0.62, cols: 2};
    return {scale: 0.46, cols: 3};
  }
  function restingSpot(position, index, total) {
    const c = ART.centerOf(cellByNumber(position));
    if (total <= 1) return c;
    const {cols} = crowdLayout(total);
    const rows = Math.ceil(total / cols);
    const gap = U * 0.34;
    const col = index % cols, row = Math.floor(index / cols);
    return {
      x: c.x + (col - (Math.min(cols, total) - 1) / 2) * gap,
      y: c.y + (row - (rows - 1) / 2) * gap,
    };
  }

  function cellByNumber(n) {
    const geo = ART.geometryFor(state.board.goal);
    const clamped = Math.min(Math.max(n, 1), state.board.goal);
    return geo.cells[clamped - 1];
  }

  function setTokenAt(g, x, y, squash) {
    // scale(2-squash, squash): estirar al despegar y aplastar al aterrizar,
    // igual que la ficha del móvil. El grupo se dibuja centrado en el origen,
    // así que la escala no lo descoloca.
    g.setAttribute('transform', `translate(${x.toFixed(2)},${y.toFixed(2)}) scale(${(2 - squash).toFixed(3)},${squash.toFixed(3)})`);
  }

  function render() {
    if (!state) return;
    $('connection').hidden = true;
    document.body.classList.toggle('reduced', !!state.accessibility?.reducedMotion);
    $('edition').textContent = state.board.title.toUpperCase();
    renderBoard();
    renderTokens();

    const current=state.players.find(p=>p.publicId===state.turn.currentPlayerId)||state.players[0];
    if(current){$('player-mark').textContent=current.symbol;$('player-mark').style.background=colors[current.inkIndex];$('player-name').textContent=(current.displayName||`JUGADOR ${current.symbol}`).toUpperCase()}
    $('round').textContent=`RONDA ${state.turn.round}`;
    const dice=state.turn.dice||[];$('dice').textContent=dice.length?dice.join(' + '):'·';$('dice').setAttribute('aria-label',dice.length?`Tirada ${dice.join(' y ')}`:'Sin tirada');
    const ranking=[...state.players].sort((a,b)=>b.position-a.position);
    $('ranking').innerHTML=ranking.map((p,i)=>{
      const statuses=(p.statuses||[]).map(s=>statusLabels[s]).filter(Boolean).join(' · ');
      return `<li><span>${i+1}</span><span class="rank-copy"><strong>${escapeHtml(p.displayName||`Jugador ${p.symbol}`)}</strong>${statuses?`<small>${statuses}</small>`:''}</span><span class="dot" style="background:${colors[p.inkIndex]}">${p.symbol}</span></li>`;
    }).join('');
    $('effects').innerHTML=(state.effects||[]).slice(0,4).map(e=>`<span>${escapeHtml(e)}</span>`).join('');
    const card=state.publicCard;$('card').hidden=!card;if(card){$('card-suit').textContent=card.nonAlcohol?`${card.suit} · SIN ALCOHOL`:card.suit;$('card-title').textContent=card.title;$('card-body').textContent=card.body}
    const ceremony=state.publicCeremony;$('ceremony').hidden=!ceremony;if(ceremony){$('ceremony-type').textContent=(ceremony.type||'').toUpperCase();$('ceremony-title').textContent=ceremony.title;$('ceremony-body').textContent=ceremony.body||''}
    const finalRanking=$('ceremony-ranking');finalRanking.hidden=ceremony?.type!=='victoria';finalRanking.innerHTML=ceremony?.type==='victoria'?ranking.slice(0,8).map((p,i)=>`<li><span>${i+1}</span><strong>${escapeHtml(p.displayName||`Jugador ${p.symbol}`)}</strong><span>${p.position}</span></li>`).join(''):'';
    $('private-note').hidden=!state.secretDecision || state.privacyCover;
    $('privacy').hidden=!state.privacyCover;
  }

  // --- el salto de la ficha ------------------------------------------------

  const raf = (cb) => (typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(cb)
    : setTimeout(cb, 16));

  function playHop(payload) {
    const playerId = state?.turn?.currentPlayerId;
    const node = tokenNodes.get(playerId);
    const segments = ART.hopPlanFor(payload.from, payload.path, payload.to);
    if (!node || !segments.length) return;
    if (state.accessibility?.reducedMotion) return;

    hopping.add(playerId);
    const total = ART.hopDuration(segments);
    const started = Date.now();
    const finish = () => {
      hopping.delete(playerId);
      renderTokens();
    };
    const frame = () => {
      const t = Date.now() - started;
      if (t >= total) { finish(); return; }
      let acc = 0, seg = segments[0];
      for (const s of segments) {
        if (t < acc + s.ms) { seg = s; break; }
        acc += s.ms;
      }
      const u = Math.min(1, Math.max(0, (t - acc) / seg.ms));
      const a = ART.centerOf(cellByNumber(seg.from));
      const b = ART.centerOf(cellByNumber(seg.to));
      const lift = Math.sin(Math.PI * u);
      setTokenAt(
        node,
        a.x + (b.x - a.x) * u,
        a.y + (b.y - a.y) * u - lift * (seg.jump ? U * 0.9 : U * 0.46),
        1 + lift * 0.13,
      );
      raf(frame);
    };
    raf(frame);
  }

  function animateCue(type,payload){
    if(type==='dice_started'||type==='dice_result'){$('dice').classList.remove('roll');void $('dice').offsetWidth;$('dice').classList.add('roll');if(payload.dice)$('dice').textContent=payload.dice.join(' + ')}
    if(type==='piece_path'){playHop(payload)}
    if(type==='ceremony_closed'){$('ceremony').hidden=true}
    if(type==='privacy_cover_changed'){
      $('privacy').hidden=!payload.covered;
      if(payload.covered)$('private-note').hidden=true;
    }
    if(type==='turn_started'||type==='game_finished'){const toast=$('toast');toast.textContent=type==='game_finished'?'HAY CAMPEÓN':'CAMBIO DE TURNO';toast.hidden=false;setTimeout(()=>toast.hidden=true,1200)}
  }
  function escapeHtml(value){return String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}

  const demoMode = new URLSearchParams(location.search).get('demo');
  if (!demoMode && window.cast?.framework) {
    context=cast.framework.CastReceiverContext.getInstance();
    context.addCustomMessageListener(NS,onMessage);
    context.addEventListener(cast.framework.system.EventType.SENDER_CONNECTED,e=>{if(authority.claim(e.senderId))send(e.senderId,'ready',{capabilities:{protocolVersion:PROTOCOL,maxMessageBytes:MAX_MESSAGE_BYTES}});else send(e.senderId,'busy')});
    context.addEventListener(cast.framework.system.EventType.SENDER_DISCONNECTED,e=>{authority.release(e.senderId);if(!authority.senderId){$('connection').hidden=false;$('connection').querySelector('h2').textContent='RECONECTANDO'}});
    context.start({disableIdleTimeout:true});
  } else {
    const demo={protocolVersion:1,board:{publicId:'clasica',title:'Oca Clásica',visualTheme:'clasica',goal:63,geometryVersion:1,specialSquares:{'5':'oca','6':'puente','9':'oca','12':'puente','14':'oca','18':'oca','19':'posada','23':'oca','26':'dados','27':'oca','31':'pozo','32':'oca','36':'oca','41':'oca','42':'laberinto','45':'oca','50':'oca','53':'dados','54':'oca','56':'carcel','58':'muerte','59':'oca','63':'jardin'}},players:[{publicId:'j1',displayName:'Lola',inkIndex:0,symbol:'1',position:23,statuses:['pozo']},{publicId:'j2',displayName:'Dani',inkIndex:3,symbol:'2',position:18,statuses:[]},{publicId:'j3',displayName:'Rita',inkIndex:1,symbol:'3',position:18,statuses:[]}],turn:{currentPlayerId:'j1',round:4,dice:[5]},phase:'idle',effects:['REGLA DE LA NOCHE'],privacyCover:false,accessibility:{reducedMotion:false}};
    state=demo;render();if(demoMode==='card'){state.publicCard={title:'CONFESIÓN DE BARRA',body:'Cuenta tu peor excusa para llegar tarde o cumple el castigo.',suit:'ESPADAS',nonAlcohol:false};render()}if(demoMode==='ceremony'){state.publicCeremony={type:'OCA',title:'DE OCA A OCA',body:'Y BEBE PORQUE TE TOCA'};render()}if(demoMode==='privacy'){state.privacyCover=true;render()}if(demoMode==='private'){state.secretDecision=true;render()}if(demoMode==='victory'){state.players[0].position=63;state.publicCeremony={type:'victoria',title:'CAMPEÓN DE LA OCA',body:'LOLA'};render()}
    if(demoMode==='hop'){setInterval(()=>{const p=state.players[0];const from=p.position;const path=[];for(let i=1;i<=4;i++)path.push(((from+i-1)%62)+1);p.position=path[path.length-1];render();playHop({from,to:p.position,path})},3200)}
  }
})();
