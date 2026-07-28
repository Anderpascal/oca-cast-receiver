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
  /// Marcador esperando lo mismo. El móvil manda la estampa con la posición
  /// final PISÁNDOLE LOS TALONES al recorrido, así que reescribir nombres,
  /// clasificación y barras justo entonces metía un pico de maqueta en mitad
  /// del salto. Además es más honesto: la casilla nueva se canta cuando la
  /// ficha ha aterrizado, no antes.
  let pendingScore = false;
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
      flushDeferred();
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
  function htmlEl(tag, cls, parent) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (parent) parent.append(node);
    return node;
  }
  /// Escribir en el DOM invalida maqueta aunque el valor sea el mismo. El
  /// marcador reescribía los mismos nombres en cada estampa del móvil.
  function setText(node, value) {
    if (node && node.textContent !== value) node.textContent = value;
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
    // Las dos planchas comparten caja: si una se desencuadra, las fichas dejan
    // de caer sobre su casilla. Se comprueba que la capa exista porque un
    // aparato con el HTML viejo cacheado y el JS nuevo no la tiene, y por un
    // atributo no se puede quedar el tablero entero sin pintar.
    const box = `0 0 ${geo.cols * U} ${geo.rows * U}`;
    $('board').setAttribute('viewBox', box);
    const fx = $('board-fx');
    if (fx) fx.setAttribute('viewBox', box);
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
    const c = centerAt(positionOf(current));
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
    const c = centerAt(position);
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

  /// Centro de una casilla del tablero en curso. Es una LECTURA de una tabla
  /// ya resuelta en `board_art`: antes cada llamada reconstruía la espiral
  /// entera, y el salto de la ficha la pedía dos veces por cuadro.
  const centerAt = (n) => ART.centerFor(state.board.goal, n);

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

  /// Las caras se REESCRIBEN, no se vuelven a crear. Rehacer los nodos nueve
  /// veces por tirada reiniciaba en seco la animación de volteo del CSS -que
  /// es justo lo que hacía que los dados se vieran a tirones- y obligaba a
  /// recalcular la maqueta en cada cambio de cara.
  const faceNodes = new WeakMap();
  function paintFaces(container, values) {
    let nodes = faceNodes.get(container);
    if (!nodes || nodes.length !== values.length) {
      nodes = values.map(() => htmlEl('div', 'die'));
      container.replaceChildren(...nodes);
      faceNodes.set(container, nodes);
    }
    for (let i = 0; i < values.length; i++) nodes[i].textContent = String(values[i]);
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
  /// marca el recorrido sin dejar el tablero sucio. Un recorrido largo puede
  /// pedir treinta huellas; se queda con las últimas para no acumular nodos
  /// animándose a la vez sobre la capa de las fichas.
  const TRAIL_MAX = 12;
  function dropTrail(position, ink) {
    if (reduced()) return;
    const layer = $('board-trail');
    const c = centerAt(position);
    el('circle', {cx: c.x, cy: c.y, r: U * 0.1, fill: ink, opacity: 0.85, class: 'trail-dot'}, layer);
    const dots = layer.children;
    if (dots && dots.length > TRAIL_MAX && typeof layer.removeChild === 'function') {
      layer.removeChild(dots[0]);
    }
  }

  /// Deja el recorrido resuelto ANTES de empezar a animar: coordenadas de
  /// salida, desplazamiento y ventana de tiempo de cada tramo. Así un cuadro
  /// del salto es una interpolación y una escritura de `transform`, y no
  /// reconstruir el tablero y recorrer la lista de tramos desde el principio.
  function hopTimeline(goal, segments) {
    const plan = [];
    let acc = 0;
    for (const s of segments) {
      const a = ART.centerFor(goal, s.from);
      const b = ART.centerFor(goal, s.to);
      plan.push({
        from: s.from, x: a.x, y: a.y, dx: b.x - a.x, dy: b.y - a.y,
        start: acc, ms: s.ms, lift: s.jump ? U * 0.9 : U * 0.46,
      });
      acc += s.ms;
    }
    return {plan, total: acc};
  }

  function playHop(payload) {
    const playerId = state?.turn?.currentPlayerId;
    const node = tokenNodes.get(playerId);
    const segments = ART.hopPlanFor(payload.from, payload.path, payload.to);
    const fx = $('board-fx');
    const finish = () => {
      hopActive = null;
      hopHold = null;
      if (fx && fx.classList) fx.classList.remove('hopping');
      $('board-trail').replaceChildren();
      if (state) renderTokens();
    };
    if (!node || !segments.length || reduced()) { finish(); return; }

    const player = state.players.find(p => p.publicId === playerId);
    const ink = colors[player ? player.inkIndex : 0] || colors[0];
    hopActive = playerId;
    if (fx && fx.classList) fx.classList.add('hopping');
    const {plan, total} = hopTimeline(state.board.goal, segments);
    const started = Date.now();
    // El tramo solo avanza; el tiempo no retrocede y buscar desde el principio
    // en cada cuadro no aportaba nada.
    let index = 0, printed = -1;
    const frame = () => {
      const t = Date.now() - started;
      if (t >= total) { finish(); return; }
      while (index < plan.length - 1 && t >= plan[index].start + plan[index].ms) index++;
      const seg = plan[index];
      if (index !== printed) { printed = index; dropTrail(seg.from, ink); }
      const u = Math.min(1, Math.max(0, (t - seg.start) / seg.ms));
      const lift = Math.sin(Math.PI * u);
      setTokenAt(
        node,
        seg.x + seg.dx * u,
        seg.y + seg.dy * u - lift * seg.lift,
        1 + lift * 0.13,
      );
      raf(frame);
    };
    raf(frame);
  }

  // --- marcador y hojas ---------------------------------------------------

  /// Filas de la clasificación, creadas UNA vez y reescritas después. Antes
  /// cada estampa del móvil rehacía la lista entera con `innerHTML`: volver a
  /// parsear y maquetar la lista en mitad del salto de la ficha es un pico de
  /// trabajo justo en el peor momento posible.
  const rankRows = [];
  let effectsSignature = null;

  function rankRow() {
    const li = htmlEl('li');
    const pos = htmlEl('span', '', li);
    const copy = htmlEl('span', 'rank-copy', li);
    const name = htmlEl('strong', '', copy);
    const tags = htmlEl('small', '', copy);
    const bar = htmlEl('span', 'rank-bar', copy);
    const fill = htmlEl('i', '', bar);
    const dot = htmlEl('span', 'dot', li);
    return {li, pos, name, tags, fill, dot};
  }

  function renderRanking(ranking, goal) {
    const list = $('ranking');
    if (rankRows.length !== ranking.length) {
      rankRows.length = 0;
      for (let i = 0; i < ranking.length; i++) rankRows.push(rankRow());
      list.replaceChildren(...rankRows.map(r => r.li));
    }
    ranking.forEach((p, i) => {
      const row = rankRows[i];
      const ink = colors[p.inkIndex] || colors[0];
      const statuses = (p.statuses || []).map(s => statusLabels[s]).filter(Boolean).join(' · ');
      setText(row.pos, String(i + 1));
      setText(row.name, p.displayName || `Jugador ${p.symbol}`);
      setText(row.tags, statuses);
      row.tags.hidden = !statuses;
      row.fill.style.width = `${Math.round((Math.min(p.position, goal) / goal) * 100)}%`;
      row.fill.style.background = ink;
      setText(row.dot, p.symbol);
      row.dot.style.background = ink;
      row.li.classList.toggle('is-current', p.publicId === state.turn.currentPlayerId);
    });
  }

  function renderScore() {
    const current = state.players.find(p => p.publicId === state.turn.currentPlayerId) || state.players[0];
    if (current) {
      const mark = $('player-mark');
      setText(mark, current.symbol);
      mark.style.background = colors[current.inkIndex];
      setText($('player-name'), (current.displayName || `JUGADOR ${current.symbol}`).toUpperCase());
      const key = `${current.publicId}|${state.turn.round}`;
      if (key !== shownTurn) {
        shownTurn = key;
        mark.classList.toggle('handoff', !reduced());
        setTimeout(() => mark.classList.remove('handoff'), 400);
      }
      const at = positionOf(current);
      const left = Math.max(0, state.board.goal - at);
      setText($('square'), `CASILLA ${at}`);
      setText($('togo'), left === 0
        ? 'HA LLEGADO AL JARDÍN'
        : `FALTAN ${left} PARA EL JARDÍN`);
    }
    setText($('round'), `RONDA ${state.turn.round}`);

    renderRanking(
      [...state.players].sort((a, b) => b.position - a.position),
      state.board.goal || 63,
    );

    // Las leyes de la mesa cambian una vez cada muchas estampas: se reescriben
    // solo cuando cambian de verdad.
    const effects = (state.effects || []).slice(0, 4);
    const signature = effects.join('|');
    if (signature !== effectsSignature) {
      effectsSignature = signature;
      $('effects').innerHTML = effects.map(e => `<span>${escapeHtml(e)}</span>`).join('');
    }
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
    // Con resumen manda el CUADRO DE HONOR; la lista pelada se queda como
    // respaldo para un móvil viejo que todavía no lo mande.
    const summary = victory ? state.summary : null;
    renderSummary(summary);
    const finalRanking = $('ceremony-ranking');
    finalRanking.hidden = !victory || !!summary;
    finalRanking.innerHTML = (victory && !summary)
      ? ranking.slice(0, 8).map((p, i) => `<li><span>${i + 1}</span><strong>${escapeHtml(p.displayName || `Jugador ${p.symbol}`)}</strong><span>${p.position}</span></li>`).join('')
      : '';
  }

  /// PALOTES DE BAR. Cuatro trazos y el quinto cruzado en diagonal sobre los
  /// cuatro, como los cuenta un camarero y como los pinta el móvil
  /// (`_TallyGroupPainter`). Se dibujan, no se escriben: un "5" no cuenta lo
  /// mismo de un vistazo desde el sofá que cinco palos.
  function tallyGroup(count, ink) {
    const svg = el('svg', {
      viewBox: '0 0 30 26', 'aria-hidden': 'true',
      fill: 'none', stroke: ink, 'stroke-width': 3, 'stroke-linecap': 'round',
    });
    const strokes = Math.min(count, 4);
    for (let i = 0; i < strokes; i++) {
      const x = 4 + i * 6.5;
      el('path', {d: `M${x},3 L${x},23`}, svg);
    }
    if (count >= 5) el('path', {d: 'M1,21 L29,5'}, svg);
    return svg;
  }

  function summaryRowName(row) {
    return (row.displayName || `JUGADOR ${row.symbol}`).toUpperCase();
  }

  /// Duración en el formato del ticket: `12 MIN` o `1 H 04`.
  function prettyDuration(ms) {
    const total = Math.max(0, Math.round((ms || 0) / 60000));
    if (total < 60) return `${total} MIN`;
    const h = Math.floor(total / 60);
    return `${h} H ${String(total % 60).padStart(2, '0')}`;
  }

  function renderSummary(summary) {
    const box = $('summary');
    if (!box) return;
    box.hidden = !summary;
    // La hoja de campeón cambia de reparto cuando trae resumen: sin esto el
    // titular a tamaño de ceremonia deja el cuadro de honor fuera de un 720p.
    const copy = typeof document.querySelector === 'function'
      ? document.querySelector('.ceremony-copy')
      : null;
    if (copy && copy.classList) copy.classList.toggle('has-summary', !!summary);
    if (!summary) return;

    // El sitio en alto manda: con la mesa llena se recorta la lista de
    // palotes, nunca el podio ni la crónica.
    const MAX_TALLIES = 6;

    const rows = Array.isArray(summary.rows) ? summary.rows : [];
    setText($('summary-rounds'), `${summary.rounds} ${summary.rounds === 1 ? 'RONDA' : 'RONDAS'}`);
    setText($('summary-time'), prettyDuration(summary.durationMs));
    setText($('summary-drinks'), `${summary.totalDrinks} EN LA CUENTA`);

    // El podio: campeón en el centro y a mayor altura, como en el móvil.
    const podium = $('summary-podium');
    podium.replaceChildren();
    const top = rows.slice(0, 3);
    const order = top.length === 3 ? [1, 0, 2] : top.map((_, i) => i);
    for (const index of order) {
      const row = top[index];
      if (!row) continue;
      const ink = colors[row.inkIndex] || colors[0];
      const li = htmlEl('li', '', podium);
      const dot = htmlEl('span', 'dot', li);
      dot.textContent = row.symbol;
      dot.style.background = ink;
      dot.style.color = row.inkIndex === 2 ? 'var(--ink)' : '#fff';
      htmlEl('span', 'who', li).textContent = summaryRowName(row);
      htmlEl('span', 'sq', li).textContent = `CASILLA ${row.position}`;
      const step = htmlEl('span', 'step', li);
      step.textContent = String(index + 1);
      step.style.borderColor = ink;
      step.style.color = ink;
    }

    // Los palotes, uno por jugador, en su tinta.
    const tallies = $('summary-tallies');
    tallies.replaceChildren();
    for (const row of rows.slice(0, MAX_TALLIES)) {
      const ink = colors[row.inkIndex] || colors[0];
      const line = htmlEl('div', 'tally', tallies);
      const who = htmlEl('span', 'who', line);
      const name = htmlEl('span', 'name', who);
      name.textContent = summaryRowName(row);
      name.style.color = ink;
      const marks = htmlEl('span', 'marks', line);
      const total = Math.max(0, row.drinks || 0);
      if (total === 0) {
        htmlEl('span', 'none', marks).textContent = '—';
      } else {
        // Un grupo por cada cinco tragos, el último incompleto.
        for (let g = 0; g * 5 < total && g < 24; g++) {
          marks.append(tallyGroup(Math.min(5, total - g * 5), ink));
        }
      }
      const totalNode = htmlEl('span', 'total', line);
      totalNode.textContent = String(total);
      totalNode.style.color = ink;
      // Lo que no son tragos se resume en una línea corta bajo el nombre.
      const extras = [];
      if (row.given) extras.push(`${row.given} REPARTIDOS`);
      if (row.challengesDone) extras.push(`${row.challengesDone} RETOS`);
      if (row.challengesQuit) extras.push(`${row.challengesQuit} RAJADAS`);
      if (row.deaths) extras.push(`${row.deaths} MUERTES`);
      if (row.wells) extras.push(`${row.wells} POZO`);
      if (row.jails) extras.push(`${row.jails} CÁRCEL`);
      if (extras.length) {
        htmlEl('span', 'extra', who).textContent = extras.join(' · ');
      }
    }

    const chronicle = $('summary-chronicle');
    chronicle.replaceChildren();
    for (const line of (summary.chronicle || []).slice(0, 4)) {
      htmlEl('li', '', chronicle).textContent = line;
    }
  }

  /// Todo lo que se aparcó mientras algo se movía, de una vez y con la escena
  /// ya parada.
  function flushDeferred() {
    if (pendingScore) {
      pendingScore = false;
      if (state) renderScore();
    }
    if (pendingOverlays) renderOverlays();
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
    setText($('edition'), state.board.title.toUpperCase());
    renderBoard();
    renderTokens();
    // El sello de la esquina se rellena con lo que diga el estado mientras no
    // haya una tirada en curso: al reconectar a media partida la mesa ve la
    // última tirada sin esperar a la siguiente.
    if (!busy() && !lastRoll.length && (state.turn.dice || []).length) {
      lastRoll = state.turn.dice.slice(0, 4);
      paintRollSlot(false);
    }
    // El marcador, la carta y la banda esperan a que la ficha aterrice:
    // primero el dado, después el recorrido, y solo entonces lo que ha pasado.
    if (busy()) { pendingScore = true; pendingOverlays = true; return; }
    renderScore();
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
      // Estampar y AGUANTAR. El sello tarda `DICE_STAMP_MS` en caer, y a partir
      // de ahí el resultado se queda quieto para que la mesa lo lea desde el
      // sofá antes de que encoja hacia la esquina.
      schedule(() => settleDice(dice), ART.DICE_STAMP_MS + ART.DICE_HOLD_MS);
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
    const demo={protocolVersion:1,board:{publicId:'clasica',title:'Oca Clásica',visualTheme:'clasica',goal:63,geometryVersion:1,specialSquares:{'5':'oca','6':'puente','12':'puente','13':'oca','19':'posada','20':'oca','26':'dados','27':'oca','31':'pozo','35':'oca','42':'laberinto','43':'oca','51':'oca','53':'dados','56':'carcel','58':'muerte','63':'jardin'}},players:[{publicId:'j1',displayName:'Lola',inkIndex:0,symbol:'1',position:23,statuses:['pozo']},{publicId:'j2',displayName:'Dani',inkIndex:3,symbol:'2',position:18,statuses:[]},{publicId:'j3',displayName:'Rita',inkIndex:1,symbol:'3',position:18,statuses:[]}],turn:{currentPlayerId:'j1',round:4,dice:[5,3]},phase:'idle',effects:['REGLA DE LA NOCHE'],privacyCover:false,accessibility:{reducedMotion:false}};
    state=demo;render();
    if(demoMode==='card'){state.publicCard={title:'CONFESIÓN DE BARRA',body:'Cuenta tu peor excusa para llegar tarde o cumple el castigo.',suit:'ESPADAS',nonAlcohol:false};render()}
    if(demoMode==='ceremony'){state.publicCeremony={type:'oca',title:'DE OCA A OCA',body:'Y BEBE PORQUE TE TOCA'};render()}
    if(demoMode==='castigo'){state.publicCeremony={type:'pozo',title:'AL POZO',body:'LOLA'};render()}
    if(demoMode==='privacy'){state.privacyCover=true;render()}
    if(demoMode==='private'){state.secretDecision=true;render()}
    if(demoMode==='victory'){state.players[0].position=63;state.publicCeremony={type:'victoria',title:'CAMPEÓN DE LA OCA',body:'LOLA'};render()}
    // EL CUADRO DE HONOR con datos de una partida de verdad: podio, palotes y
    // crónica. Es la vista que hay que revisar a 1280×720 y a 4K.
    if(demoMode==='stats'){
      state.players[0].position=63;
      state.publicCeremony={type:'victoria',title:'CAMPEÓN DE LA OCA',body:'LOLA'};
      state.summary={
        winnerId:'j1',winnerName:'Lola',rounds:11,durationMs:23*60000,
        totalDrinks:41,totalGiven:18,
        rows:[
          {publicId:'j1',displayName:'Lola',inkIndex:0,symbol:'1',position:63,drinks:12,given:11,deaths:1,wells:1,jails:0,challengesDone:4,challengesQuit:1},
          {publicId:'j3',displayName:'Rita',inkIndex:1,symbol:'3',position:47,drinks:17,given:4,deaths:0,wells:2,jails:1,challengesDone:2,challengesQuit:3},
          {publicId:'j2',displayName:'Dani',inkIndex:3,symbol:'2',position:38,drinks:8,given:3,deaths:2,wells:0,jails:0,challengesDone:5,challengesQuit:0},
          {publicId:'j4',displayName:'Bea',inkIndex:5,symbol:'4',position:21,drinks:4,given:0,deaths:0,wells:1,jails:2,challengesDone:1,challengesQuit:2},
        ],
        chronicle:[
          'LOLA CONQUISTÓ LA CASILLA 63 EN 11 RONDAS.',
          'LOLA FUE LA MANO MÁS GENEROSA: 11 REPARTIDOS.',
          'RITA SE LLEVÓ LA CUENTA MÁS LARGA: 17.',
          'EL POZO ATRAPÓ A LA MESA 4 VECES.',
        ],
      };
      render();
    }
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
