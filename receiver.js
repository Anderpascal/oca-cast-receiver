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
  const TONE = {bien:'var(--green)', mal:'var(--red)', neutro:'var(--pink)'};

  let state = null;
  const guard = new OcaCastProtocol.CueGuard();
  const authority = new OcaCastProtocol.SenderAuthority();
  let context = null;
  const $ = id => document.getElementById(id);
  const tokenNodes = new Map();

  /// Firma del tablero impreso. Repintar 63 casillas en cada snapshot es caro
  /// en un Chromecast de los baratos y no cambia nada: solo se reimprime la
  /// plancha cuando cambia el tablero de verdad.
  let boardSignature = '';
  /// Ficha que está andando AHORA (no se la puede repintar debajo).
  let hopActive = null;
  /// Salto ya anunciado pero todavía en cola: la ficha se queda en su casilla
  /// de origen aunque el snapshot traiga ya la de destino.
  let hopHold = null;
  /// Carta y banda esperando a que la escena en curso termine.
  let pendingOverlays = false;
  let lastRoll = [];
  let shownTurn = '';

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

  // --- la escena ----------------------------------------------------------
  //
  // El móvil manda los hechos de un turno en el MISMO instante: el resultado
  // del dado, el recorrido de la ficha, la ceremonia y el snapshot ya con la
  // posición final llegan pisándose. Pintarlos según llegan es lo que hacía
  // que la mesa no viera nunca andar a la ficha. Aquí se reparten en el tiempo
  // y en el orden dramático del móvil: DADO → SALTO → lo que haya pasado.

  const steps = [];
  let running = false;
  const reduced = () => !!(state && state.accessibility && state.accessibility.reducedMotion);
  const busy = () => running || steps.length > 0;

  function schedule(action, holdMs) {
    steps.push({action, holdMs});
    if (!running) pump();
  }
  function pump() {
    const step = steps.shift();
    if (!step) {
      running = false;
      if (pendingOverlays) renderOverlays();
      return;
    }
    running = true;
    step.action();
    const ms = reduced() ? 0 : step.holdMs;
    if (ms <= 0) { pump(); return; }
    setTimeout(pump, ms);
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
  function div(cls, value, parent) {
    const node = document.createElement('div');
    node.className = cls;
    if (value !== undefined) node.textContent = value;
    if (parent) parent.append(node);
    return node;
  }
  /// `style.setProperty` no existe en todos los entornos donde se prueba esto;
  /// nunca debe tumbar un pintado por un color.
  function setVar(node, name, value) {
    if (node && node.style && typeof node.style.setProperty === 'function') {
      node.style.setProperty(name, value);
    }
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
    const signature = `${board.goal}|${board.visualTheme}|${JSON.stringify(board.specialSquares)}`;
    if (signature === boardSignature) return;
    boardSignature = signature;

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

  /// Anillo sobre la casilla de quien juega: desde el sofá se localiza sin
  /// buscar la ficha entre las de los demás.
  function renderMarks() {
    const layer = $('board-marks');
    layer.replaceChildren();
    const current = state.players.find(p => p.publicId === state.turn.currentPlayerId);
    if (!current) return;
    const c = ART.centerOf(cellByNumber(positionOf(current)));
    el('circle', {
      cx: c.x, cy: c.y, r: U * 0.44, class: 'mark-ring',
      fill: 'none', stroke: colors[current.inkIndex] || colors[0], 'stroke-width': 6,
    }, layer);
  }

  /// Las fichas viven en su propia capa para poder moverse entre casillas sin
  /// repintar el póster de debajo.
  const positionOf = (player) =>
    hopHold && hopHold.id === player.publicId ? hopHold.position : player.position;

  function renderTokens() {
    // Repintar durante un salto lo cortaría en seco: el snapshot con la
    // posición final llega pisándole los talones al `piece_path`.
    if (hopActive) return;
    const layer = $('board-tokens');
    layer.replaceChildren();
    tokenNodes.clear();

    const byCell = new Map();
    for (const p of state.players) {
      const cell = positionOf(p);
      const list = byCell.get(cell) || [];
      list.push(p);
      byCell.set(cell, list);
    }
    for (const [cell, list] of byCell) {
      const {scale} = crowdLayout(list.length);
      list.forEach((p, i) => {
        const g = el('g', {class: 'token' + (p.publicId === state.turn.currentPlayerId ? ' current' : '')}, layer);
        buildToken(g, p, scale);
        const at = restingSpot(cell, i, list.length);
        setTokenAt(g, at.x, at.y, 1);
        tokenNodes.set(p.publicId, g);
      });
    }
    renderMarks();
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

  // --- los dados ----------------------------------------------------------
  //
  // Ruedan grandes SOBRE el tablero, con un velo oscuro debajo para que el
  // numeral se lea, y al asentar encogen hasta el sello de la esquina. Nunca
  // hay una hoja a pantalla completa: lo siguiente que la mesa quiere ver es
  // la ficha andando.

  let diceTimer = null;
  const faceRoll = () => 1 + Math.floor(Math.random() * 6);
  const sum = (values) => values.reduce((a, b) => a + b, 0);

  function paintFaces(container, values) {
    container.replaceChildren();
    for (const value of values) div('die', String(value), container);
  }
  function stopRolling() {
    if (diceTimer !== null) { clearTimeout(diceTimer); diceTimer = null; }
  }

  function startRolling() {
    stopRolling();
    const stage = $('dice-stage');
    $('dice-scrim').hidden = false;
    stage.hidden = false;
    stage.classList.remove('settled');
    stage.classList.remove('stowing');
    stage.classList.add('rolling');
    $('dice-total').textContent = '';
    paintFaces($('dice-faces'), [faceRoll(), faceRoll()]);
    if (reduced()) return;
    // Intervalos CRECIENTES: el dado de madera pierde impulso, como en el
    // móvil. Los tiempos vienen de board_art para no separarse de Dart.
    const beats = ART.diceBeats();
    let i = 1;
    const next = () => {
      paintFaces($('dice-faces'), [faceRoll(), faceRoll()]);
      i++;
      if (i >= beats.length) { diceTimer = null; return; }
      diceTimer = setTimeout(next, beats[i] - beats[i - 1]);
    };
    diceTimer = setTimeout(next, beats[0]);
  }

  function settleDice(dice) {
    stopRolling();
    const values = (dice && dice.length ? dice : lastRoll).slice(0, 4);
    if (!values.length) return;
    lastRoll = values;
    const stage = $('dice-stage');
    $('dice-scrim').hidden = false;
    stage.hidden = false;
    stage.classList.remove('rolling');
    stage.classList.remove('stowing');
    stage.classList.add('settled');
    paintFaces($('dice-faces'), values);
    $('dice-total').textContent = String(sum(values));
  }

  /// Los dados se van encogiendo HACIA la esquina y el sello aparece allí: el
  /// resultado no se pierde, se guarda. Es el mismo gesto que en el móvil.
  function stowDice() {
    const stage = $('dice-stage');
    $('dice-scrim').hidden = true;
    // El encogido dura lo que dice board_art, no lo que diga la hoja de estilo:
    // el móvil cuenta con ese tramo para volver a habilitar TIRAR.
    setVar(stage, '--stow', `${ART.DICE_STOW_MS}ms`);
    stage.classList.add('stowing');
    paintRollSlot(true);
    setTimeout(() => {
      stage.hidden = true;
      stage.classList.remove('stowing');
      stage.classList.remove('settled');
    }, reduced() ? 0 : ART.DICE_STOW_MS);
  }

  function paintRollSlot(animate) {
    const slot = $('roll-slot');
    if (!lastRoll.length) { slot.hidden = true; return; }
    const current = state && state.players.find(p => p.publicId === state.turn.currentPlayerId);
    // Tinta de quien tiró: el sello se lee de un vistazo sin buscar el nombre.
    setVar(slot, '--tone', colors[current ? current.inkIndex : 0] || colors[0]);
    paintFaces($('roll-faces'), lastRoll);
    $('roll-total').textContent = String(sum(lastRoll));
    slot.hidden = false;
    slot.classList.toggle('arriving', !!animate && !reduced());
    if (animate) setTimeout(() => slot.classList.remove('arriving'), 420);
  }

  // --- el salto de la ficha ------------------------------------------------

  const raf = (cb) => (typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(cb)
    : setTimeout(cb, 16));

  /// Huella de tinta por donde ha pasado la ficha. Se desvanece sola con CSS:
  /// marca el recorrido sin dejar el tablero sucio.
  function dropTrail(position, ink) {
    if (reduced()) return;
    const c = ART.centerOf(cellByNumber(position));
    el('circle', {cx: c.x, cy: c.y, r: U * 0.1, fill: ink, opacity: 0.85, class: 'trail-dot'}, $('board-trail'));
  }

  function playHop(payload) {
    const playerId = state?.turn?.currentPlayerId;
    const node = tokenNodes.get(playerId);
    const segments = ART.hopPlanFor(payload.from, payload.path, payload.to);
    const finish = () => {
      hopActive = null;
      hopHold = null;
      $('board-trail').replaceChildren();
      if (state) renderTokens();
    };
    if (!node || !segments.length || reduced()) { finish(); return; }

    const player = state.players.find(p => p.publicId === playerId);
    const ink = colors[player ? player.inkIndex : 0] || colors[0];
    hopActive = playerId;
    const total = ART.hopDuration(segments);
    const started = Date.now();
    let printed = -1;
    const frame = () => {
      const t = Date.now() - started;
      if (t >= total) { finish(); return; }
      let acc = 0, seg = segments[0], index = 0;
      for (let i = 0; i < segments.length; i++) {
        if (t < acc + segments[i].ms) { seg = segments[i]; index = i; break; }
        acc += segments[i].ms;
      }
      if (index !== printed) { printed = index; dropTrail(seg.from, ink); }
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

  // --- marcador y hojas ---------------------------------------------------

  function renderScore() {
    const current = state.players.find(p => p.publicId === state.turn.currentPlayerId) || state.players[0];
    if (current) {
      const mark = $('player-mark');
      mark.textContent = current.symbol;
      mark.style.background = colors[current.inkIndex];
      $('player-name').textContent = (current.displayName || `JUGADOR ${current.symbol}`).toUpperCase();
      const key = `${current.publicId}|${state.turn.round}`;
      if (key !== shownTurn) {
        shownTurn = key;
        mark.classList.toggle('handoff', !reduced());
        setTimeout(() => mark.classList.remove('handoff'), 400);
      }
      const at = positionOf(current);
      const left = Math.max(0, state.board.goal - at);
      $('square').textContent = `CASILLA ${at}`;
      $('togo').textContent = left === 0
        ? 'HA LLEGADO AL JARDÍN'
        : `FALTAN ${left} PARA EL JARDÍN`;
    }
    $('round').textContent = `RONDA ${state.turn.round}`;

    const goal = state.board.goal || 63;
    const ranking = [...state.players].sort((a, b) => b.position - a.position);
    $('ranking').innerHTML = ranking.map((p, i) => {
      const statuses = (p.statuses || []).map(s => statusLabels[s]).filter(Boolean).join(' · ');
      const ink = colors[p.inkIndex] || colors[0];
      const pct = Math.round((Math.min(p.position, goal) / goal) * 100);
      const mine = p.publicId === state.turn.currentPlayerId ? ' class="is-current"' : '';
      return `<li${mine}><span>${i + 1}</span><span class="rank-copy"><strong>${escapeHtml(p.displayName || `Jugador ${p.symbol}`)}</strong>${statuses ? `<small>${statuses}</small>` : ''}<span class="rank-bar"><i style="width:${pct}%;background:${ink}"></i></span></span><span class="dot" style="background:${ink}">${p.symbol}</span></li>`;
    }).join('');
    $('effects').innerHTML = (state.effects || []).slice(0, 4).map(e => `<span>${escapeHtml(e)}</span>`).join('');
  }

  /// EL RETO. Es lo único, junto al final de la partida, que se come la
  /// pantalla entera: lo tiene que leer toda la mesa a la vez y mientras está
  /// puesto no hay nada que animar en el tablero.
  function renderCard() {
    const card = state.publicCard;
    $('card').hidden = !card;
    if (!card) return;
    $('card-suit').textContent = (card.suit || '').toUpperCase();
    $('card-sober').hidden = !card.nonAlcohol;
    $('card-title').textContent = card.title;
    $('card-body').textContent = card.body;
    const who = state.players.find(p => p.publicId === (card.playerId || state.turn.currentPlayerId));
    $('card-who').hidden = !who;
    if (who) {
      const mark = $('card-who-mark');
      mark.textContent = who.symbol;
      mark.style.background = colors[who.inkIndex] || colors[0];
      mark.style.color = who.inkIndex === 2 ? 'var(--ink)' : '#fff';
      $('card-who-name').textContent = (who.displayName || `JUGADOR ${who.symbol}`).toUpperCase();
    }
  }

  /// Todo lo demás -oca, puente, pozo, cárcel, brindis, reglas- entra en una
  /// BANDA apoyada en el borde de abajo del póster. Antes era una hoja a
  /// pantalla completa y tapaba justo lo que la mesa quería mirar.
  function renderCeremony() {
    const ceremony = state.publicCeremony;
    const victory = ceremony && ceremony.type === 'victoria';
    const banded = !!ceremony && !victory;
    $('banner').hidden = !banded;
    $('ceremony').hidden = !victory;
    // El tablero se encoge lo que ocupa la banda en vez de quedar tapado por
    // ella: el SVG se reajusta solo y no se pierde ni una casilla.
    $('poster').classList.toggle('banded', banded);

    if (banded) {
      const look = ART.ceremonyLook(ceremony.type);
      const tone = TONE[look.tone] || TONE.neutro;
      setVar($('banner'), '--tone', tone);
      $('banner-type').textContent = look.kicker;
      $('banner-title').textContent = ceremony.title;
      $('banner-body').textContent = ceremony.body || '';
      const glyph = $('banner-glyph');
      glyph.replaceChildren();
      drawPictogram(glyph, look.pict, 50, 50, 96, 'var(--ink)');
    }

    const ranking = [...state.players].sort((a, b) => b.position - a.position);
    if (victory) {
      $('ceremony-type').textContent = 'EL JARDÍN';
      $('ceremony-title').textContent = ceremony.title;
      $('ceremony-body').textContent = ceremony.body || '';
    }
    const finalRanking = $('ceremony-ranking');
    finalRanking.hidden = !victory;
    finalRanking.innerHTML = victory
      ? ranking.slice(0, 8).map((p, i) => `<li><span>${i + 1}</span><strong>${escapeHtml(p.displayName || `Jugador ${p.symbol}`)}</strong><span>${p.position}</span></li>`).join('')
      : '';
  }

  function renderOverlays() {
    pendingOverlays = false;
    if (!state) return;
    renderCard();
    renderCeremony();
    $('private-note').hidden = !state.secretDecision || state.privacyCover;
    $('privacy').hidden = !state.privacyCover;
  }

  function render() {
    if (!state) return;
    $('connection').hidden = true;
    document.body.classList.toggle('reduced', reduced());
    $('edition').textContent = state.board.title.toUpperCase();
    renderBoard();
    renderTokens();
    renderScore();
    // El sello de la esquina se rellena con lo que diga el estado mientras no
    // haya una tirada en curso: al reconectar a media partida la mesa ve la
    // última tirada sin esperar a la siguiente.
    if (!busy() && !lastRoll.length && (state.turn.dice || []).length) {
      lastRoll = state.turn.dice.slice(0, 4);
      paintRollSlot(false);
    }
    // La carta y la banda esperan a que la ficha aterrice: primero el dado,
    // después el recorrido, y solo entonces lo que ha pasado.
    if (busy()) { pendingOverlays = true; return; }
    renderOverlays();
  }

  function animateCue(type, payload) {
    if (type === 'dice_started') {
      lastRoll = [];
      $('roll-slot').hidden = true;
      schedule(startRolling, ART.DICE_ROLL_MS);
      return;
    }
    if (type === 'dice_result') {
      const dice = Array.isArray(payload.dice) ? payload.dice : [];
      schedule(() => settleDice(dice), ART.DICE_STAMP_MS);
      schedule(stowDice, ART.DICE_STOW_MS);
      return;
    }
    if (type === 'piece_path') {
      // La ficha se ancla YA en su casilla de origen: el snapshot con la
      // posición final viene detrás y no puede teletransportarla.
      const playerId = state?.turn?.currentPlayerId;
      if (playerId && typeof payload.from === 'number') {
        hopHold = {id: playerId, position: payload.from};
        if (state && !hopActive) renderTokens();
      }
      const segments = ART.hopPlanFor(payload.from, payload.path, payload.to);
      schedule(() => playHop(payload), ART.hopDuration(segments));
      return;
    }
    if (type === 'ceremony_closed') {
      $('banner').hidden = true;
      return;
    }
    if (type === 'privacy_cover_changed') {
      $('privacy').hidden = !payload.covered;
      if (payload.covered) $('private-note').hidden = true;
      return;
    }
  }
  function escapeHtml(value){return String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}

  // --- arranque -----------------------------------------------------------

  const demoMode = new URLSearchParams(location.search).get('demo');
  if (!demoMode && window.cast?.framework) {
    context=cast.framework.CastReceiverContext.getInstance();
    context.addCustomMessageListener(NS,onMessage);
    context.addEventListener(cast.framework.system.EventType.SENDER_CONNECTED,e=>{if(authority.claim(e.senderId))send(e.senderId,'ready',{capabilities:{protocolVersion:PROTOCOL,maxMessageBytes:MAX_MESSAGE_BYTES}});else send(e.senderId,'busy')});
    context.addEventListener(cast.framework.system.EventType.SENDER_DISCONNECTED,e=>{authority.release(e.senderId);if(!authority.senderId){$('connection').hidden=false;$('connection').querySelector('h2').textContent='RECONECTANDO'}});
    context.start({disableIdleTimeout:true});
  } else {
    const demo={protocolVersion:1,board:{publicId:'clasica',title:'Oca Clásica',visualTheme:'clasica',goal:63,geometryVersion:1,specialSquares:{'5':'oca','6':'puente','9':'oca','12':'puente','14':'oca','18':'oca','19':'posada','23':'oca','26':'dados','27':'oca','31':'pozo','32':'oca','36':'oca','41':'oca','42':'laberinto','45':'oca','50':'oca','53':'dados','54':'oca','56':'carcel','58':'muerte','59':'oca','63':'jardin'}},players:[{publicId:'j1',displayName:'Lola',inkIndex:0,symbol:'1',position:23,statuses:['pozo']},{publicId:'j2',displayName:'Dani',inkIndex:3,symbol:'2',position:18,statuses:[]},{publicId:'j3',displayName:'Rita',inkIndex:1,symbol:'3',position:18,statuses:[]}],turn:{currentPlayerId:'j1',round:4,dice:[5,3]},phase:'idle',effects:['REGLA DE LA NOCHE'],privacyCover:false,accessibility:{reducedMotion:false}};
    state=demo;render();
    if(demoMode==='card'){state.publicCard={title:'CONFESIÓN DE BARRA',body:'Cuenta tu peor excusa para llegar tarde o cumple el castigo.',suit:'ESPADAS',nonAlcohol:false};render()}
    if(demoMode==='ceremony'){state.publicCeremony={type:'oca',title:'DE OCA A OCA',body:'Y BEBE PORQUE TE TOCA'};render()}
    if(demoMode==='castigo'){state.publicCeremony={type:'pozo',title:'AL POZO',body:'LOLA'};render()}
    if(demoMode==='privacy'){state.privacyCover=true;render()}
    if(demoMode==='private'){state.secretDecision=true;render()}
    if(demoMode==='victory'){state.players[0].position=63;state.publicCeremony={type:'victoria',title:'CAMPEÓN DE LA OCA',body:'LOLA'};render()}
    if(demoMode==='dice'){
      // Turno completo en bucle: tirada, recorrido y banda, tal cual llega de
      // un móvil de verdad.
      const turno=()=>{
        const p=state.players[0];
        const from=p.position;
        const dado=[faceRoll(),faceRoll()];
        const path=[];
        for(let i=1;i<=dado[0]+dado[1];i++)path.push(((from+i-1)%62)+1);
        animateCue('dice_started',{});
        animateCue('dice_result',{dice:dado,total:dado[0]+dado[1]});
        animateCue('piece_path',{from,to:path[path.length-1],path});
        p.position=path[path.length-1];
        state.turn.dice=dado;
        state.publicCeremony={type:'oca',title:'DE OCA A OCA',body:'Y BEBE PORQUE TE TOCA'};
        render();
      };
      turno();
      if(typeof setInterval==='function')setInterval(turno,6000);
    }
    if(demoMode==='hop'){setInterval(()=>{const p=state.players[0];const from=p.position;const path=[];for(let i=1;i<=4;i++)path.push(((from+i-1)%62)+1);p.position=path[path.length-1];render();animateCue('piece_path',{from,to:p.position,path})},3200)}
  }
})();
