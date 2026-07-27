'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const protocol = require('./protocol.js');
const boardArt = require('./board_art.js');
const receiverSource = fs.readFileSync(
  require.resolve('./receiver.js'),
  'utf8',
);

class FakeClassList {
  constructor() {
    this.values = new Set();
  }
  add(value) {
    this.values.add(value);
  }
  remove(value) {
    this.values.delete(value);
  }
  toggle(value, force) {
    if (force) this.values.add(value);
    else this.values.delete(value);
  }
}

class FakeElement {
  constructor() {
    this.hidden = false;
    this.textContent = '';
    this.innerHTML = '';
    this.style = {};
    this.className = '';
    this.classList = new FakeClassList();
    this.children = [];
    this.offsetWidth = 100;
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = [...children];
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  querySelector() {
    return new FakeElement();
  }
}

function renderDemo(mode) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  const document = {
    body: new FakeElement(),
    getElementById: element,
    createElement: () => new FakeElement(),
    createElementNS: () => new FakeElement(),
  };
  const context = {
    OcaCastProtocol: protocol,
    OcaBoardArt: boardArt,
    URLSearchParams,
    clearTimeout,
    console,
    document,
    location: { search: `?demo=${mode}` },
    setTimeout,
    window: {},
  };
  vm.runInNewContext(receiverSource, context, { filename: 'receiver.js' });
  return { element };
}

function bootCastReceiver(extraContext = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  const callbacks = new Map();
  const sent = [];
  let customMessage;
  const eventTypes = {
    SENDER_CONNECTED: 'sender_connected',
    SENDER_DISCONNECTED: 'sender_disconnected',
  };
  const receiverContext = {
    addCustomMessageListener(namespace, callback) {
      assert.equal(namespace, 'urn:x-cast:com.juegaoca.presentation');
      customMessage = callback;
    },
    addEventListener(type, callback) {
      callbacks.set(type, callback);
    },
    sendCustomMessage(namespace, senderId, payload) {
      sent.push({ namespace, senderId, payload });
    },
    start(options) {
      assert.equal(options.disableIdleTimeout, true);
    },
  };
  const cast = {
    framework: {
      CastReceiverContext: { getInstance: () => receiverContext },
      system: { EventType: eventTypes },
    },
  };
  vm.runInNewContext(
    receiverSource,
    {
      OcaCastProtocol: protocol,
      OcaBoardArt: boardArt,
      TextEncoder,
      URLSearchParams,
      cast,
      clearTimeout,
      console,
      document: {
        body: new FakeElement(),
        getElementById: element,
        createElement: () => new FakeElement(),
        createElementNS: () => new FakeElement(),
      },
      location: { search: '' },
      setTimeout,
      window: { cast },
      ...extraContext,
    },
    { filename: 'receiver.js' },
  );
  return {
    element,
    sent,
    connect: (senderId) =>
      callbacks.get(eventTypes.SENDER_CONNECTED)({ senderId }),
    disconnect: (senderId) =>
      callbacks.get(eventTypes.SENDER_DISCONNECTED)({ senderId }),
    message: (senderId, data) => customMessage({ senderId, data }),
  };
}

function publicSnapshot() {
  return {
    protocolVersion: 1,
    board: {
      publicId: 'clasica',
      title: 'Oca Clásica',
      visualTheme: 'clasica',
      goal: 63,
      geometryVersion: 1,
      specialSquares: {},
    },
    players: [
      {
        publicId: 'j1',
        displayName: 'Lola',
        inkIndex: 0,
        symbol: '1',
        position: 12,
        statuses: [],
      },
    ],
    turn: { currentPlayerId: 'j1', round: 2, dice: [5] },
    phase: 'idle',
    effects: [],
    privacyCover: false,
    secretDecision: false,
    accessibility: { reducedMotion: false },
  };
}

function castCue(sequence, type, payload = {}, overrides = {}) {
  return {
    protocolVersion: 1,
    sessionId: 'mesa-a',
    sequence,
    eventId: `evento-${sequence}-${type}`,
    sentAt: '2026-07-20T10:00:00.000Z',
    type,
    payload,
    ...overrides,
  };
}

test('HTML tiene IDs únicos, scripts ordenados y ninguna ruta de emparejamiento', () => {
  const html = fs.readFileSync(require.resolve('./index.html'), 'utf8');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(html.indexOf('protocol.js') < html.indexOf('receiver.js'));
  assert.doesNotMatch(html, /\bQR\b|código corto|emparejamiento/i);
  assert.equal(fs.existsSync(require.resolve('./assets/Archivo-Variable.ttf')), true);
  assert.equal(
    fs.existsSync(require.resolve('./assets/AlfaSlabOne-Regular.ttf')),
    true,
  );
});

test('demo tablero construye 63 casillas y oculta conexión', () => {
  const { element } = renderDemo('board');
  assert.equal(element('board-cells').children.length, 63);
  assert.equal(element('connection').hidden, true);
  assert.equal(element('player-name').textContent, 'LOLA');
});

test('demos de carta y privacidad activan su takeover', () => {
  const card = renderDemo('card');
  assert.equal(card.element('card').hidden, false);
  assert.equal(card.element('card-title').textContent, 'CONFESIÓN DE BARRA');

  const privacy = renderDemo('privacy');
  assert.equal(privacy.element('privacy').hidden, false);
});

test('decisión secreta conserva tablero y muestra aviso lateral', () => {
  const { element } = renderDemo('private');
  assert.equal(element('board-cells').children.length, 63);
  assert.equal(element('private-note').hidden, false);
  assert.equal(element('privacy').hidden, true);
});

test('victoria muestra póster persistente y clasificación', () => {
  const { element } = renderDemo('victory');
  assert.equal(element('ceremony').hidden, false);
  assert.equal(element('ceremony-title').textContent, 'CAMPEÓN DE LA OCA');
  assert.equal(element('ceremony-body').textContent, 'LOLA');
  assert.equal(element('ceremony-ranking').hidden, false);
  assert.match(element('ceremony-ranking').innerHTML, /Lola/);
  assert.match(element('ceremony-ranking').innerHTML, />63</);
});
test('CAF asigna un solo sender y libera la autoridad al desconectar', () => {
  const cast = bootCastReceiver();
  cast.connect('movil-a');
  assert.equal(cast.sent.at(-1).payload.type, 'ready');
  assert.equal(cast.sent.at(-1).payload.capabilities.protocolVersion, 1);

  cast.connect('movil-b');
  assert.equal(cast.sent.at(-1).senderId, 'movil-b');
  assert.equal(cast.sent.at(-1).payload.type, 'busy');

  cast.disconnect('movil-a');
  cast.connect('movil-b');
  assert.equal(cast.sent.at(-1).payload.type, 'ready');
});

test('CAF aplica snapshot válido, renderiza y confirma secuencia', () => {
  const cast = bootCastReceiver();
  cast.connect('movil-a');
  cast.message(
    'movil-a',
    castCue(1, 'snapshot', { state: publicSnapshot() }),
  );
  assert.equal(cast.element('board-cells').children.length, 63);
  assert.equal(cast.element('connection').hidden, true);
  assert.equal(cast.sent.at(-1).payload.type, 'ack');
  assert.equal(cast.sent.at(-1).payload.sequence, 1);
});

test('CAF repara huecos y rechaza versión, tamaño o sender incorrectos', () => {
  const cast = bootCastReceiver();
  cast.connect('movil-a');
  cast.message(
    'movil-a',
    castCue(1, 'snapshot', { state: publicSnapshot() }),
  );
  cast.message('movil-a', castCue(3, 'dice_result', { dice: [4] }));
  assert.equal(cast.sent.at(-1).payload.type, 'snapshot_request');

  cast.message(
    'movil-a',
    castCue(2, 'snapshot', { state: publicSnapshot() }, { protocolVersion: 2 }),
  );
  assert.equal(cast.sent.at(-1).payload.type, 'incompatible');

  cast.message('movil-a', castCue(2, 'snapshot', { state: null }));
  assert.equal(cast.sent.at(-1).payload.type, 'snapshot_request');

  cast.message('movil-a', 'x'.repeat(64 * 1024));
  assert.equal(cast.sent.at(-1).payload.type, 'snapshot_request');

  cast.message('movil-b', castCue(1, 'dice_started'));
  assert.equal(cast.sent.at(-1).senderId, 'movil-b');
  assert.equal(cast.sent.at(-1).payload.type, 'busy');
});
test('la espiral del tablero coincide casilla a casilla con la del móvil', () => {
  const geo = boardArt.geometryFor(63);
  assert.equal(geo.cols, 8);
  assert.equal(geo.rows, 8);
  assert.equal(geo.cells.length, 63);
  const at = (n) => geo.cells[n - 1];
  // Arranca abajo a la izquierda y recorre la fila inferior hacia la derecha.
  assert.deepEqual([at(1).col, at(1).row], [0, 7]);
  assert.deepEqual([at(8).col, at(8).row], [7, 7]);
  // Sube por la derecha y vuelve por arriba hacia la izquierda.
  assert.deepEqual([at(15).col, at(15).row], [7, 0]);
  assert.deepEqual([at(22).col, at(22).row], [0, 0]);
  // Y baja por la izquierda para cerrar el primer circuito.
  assert.deepEqual([at(28).col, at(28).row], [0, 6]);
  // La meta no es una casilla más: es el bloque reservado del medallón.
  assert.deepEqual(
    [at(63).col, at(63).row, at(63).colSpan],
    [3, 3, 2],
  );
  // Ninguna casilla comparte hueco con otra.
  const seen = new Set(geo.cells.map((c) => `${c.col},${c.row}`));
  assert.equal(seen.size, geo.cells.length);
});

test('la partida rápida usa retícula 6x6 y meta de bloque 2x2', () => {
  const geo = boardArt.geometryFor(30);
  assert.equal(geo.cols, 6);
  assert.equal(geo.cells.length, 30);
  const meta = geo.cells[29];
  assert.deepEqual([meta.col, meta.row, meta.colSpan, meta.rowSpan], [2, 2, 2, 2]);
});

test('el plan del salto reproduce los tiempos del móvil', () => {
  // Camino corto: paso visible de 260 ms por casilla.
  const corto = boardArt.hopPlanFor(3, [4, 5, 6], 6);
  assert.equal(corto.length, 3);
  assert.ok(corto.every((s) => s.ms === 260 && !s.jump));
  assert.equal(boardArt.hopDuration(corto), 780);

  // Camino largo realista (12 es el máximo con dos dados): se comprime para
  // no pasarse del techo de ceremonia.
  const largo = boardArt.hopPlanFor(1, Array.from({length: 12}, (_, i) => i + 2), 13);
  assert.equal(largo.length, 12);
  assert.ok(largo.every((s) => s.ms < 260));
  assert.ok(boardArt.hopDuration(largo) <= 2200);

  // El suelo de 120 ms manda sobre el techo: antes de acelerar hasta que no
  // se vea nada, se prefiere pasarse de largo. Mismo criterio que el móvil.
  const absurdo = boardArt.hopPlanFor(1, Array.from({length: 30}, (_, i) => i + 2), 31);
  assert.ok(absurdo.every((s) => s.ms === 120));

  // El salto largo del motor (pisar una oca) va en su propio tramo.
  const conSalto = boardArt.hopPlanFor(3, [4, 5], 9);
  assert.equal(conSalto.length, 3);
  assert.equal(conSalto[2].jump, true);
  assert.equal(conSalto[2].ms, 560);
  assert.deepEqual([conSalto[2].from, conSalto[2].to], [5, 9]);

  // Sin recorrido no se inventa animación.
  assert.deepEqual(boardArt.hopPlanFor(7, [], 7), []);
});

test('la ficha recorre el camino y un snapshot a media animación no la corta', () => {
  // Reloj y cuadros bajo control: la animación se ejecuta paso a paso en vez
  // de depender del reloj real.
  const clock = { t: 0 };
  const frames = [];
  const cast = bootCastReceiver({
    Date: { now: () => clock.t },
    requestAnimationFrame: (cb) => frames.push(cb),
  });
  const tick = (ms) => {
    clock.t = ms;
    frames.splice(0, frames.length).forEach((cb) => cb());
  };
  const tokenTransform = () => {
    const layer = cast.element('board-tokens');
    return layer.children.length ? layer.children[0].transform : null;
  };

  cast.connect('movil-a');
  cast.message('movil-a', castCue(1, 'snapshot', { state: publicSnapshot() }));
  const salida = tokenTransform();
  assert.ok(salida, 'debe haber una ficha en el tablero');

  // El móvil manda el recorrido 12 -> 15 y, pisándole los talones, el
  // snapshot con la posición ya final. Ese snapshot NO debe teletransportar
  // la ficha: si lo hiciera, la mesa no vería el recorrido.
  cast.message('movil-a', castCue(2, 'piece_path', { from: 12, to: 15, path: [13, 14, 15] }));
  const enVuelo = publicSnapshot();
  enVuelo.players[0].position = 15;
  cast.message('movil-a', castCue(3, 'snapshot', { state: enVuelo }));

  const vistas = new Set();
  for (let t = 0; t < 780; t += 60) {
    tick(t);
    const current = tokenTransform();
    if (current) vistas.add(current);
  }
  assert.ok(vistas.size >= 6, `la ficha debe recorrer posiciones intermedias, vio ${vistas.size}`);
  assert.ok(!vistas.has(salida) || vistas.size > 1, 'la ficha no puede quedarse quieta');

  // Al terminar aterriza en la casilla 15, la que dice el estado.
  tick(780);
  const geo = boardArt.geometryFor(63);
  const destino = boardArt.centerOf(geo.cells[14]);
  const final = tokenTransform();
  assert.match(final, /^translate\(/);
  const [x, y] = final.match(/translate\(([-\d.]+),([-\d.]+)\)/).slice(1).map(Number);
  assert.equal(Math.round(x), Math.round(destino.x));
  assert.equal(Math.round(y), Math.round(destino.y));
});

/// Reloj y cuadros bajo control para poder recorrer un turno entero paso a
/// paso: los cues de un turno llegan del móvil en el MISMO instante y lo que
/// se prueba aquí es justamente que la tele los reparte en el tiempo.
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const frames = [];
  return {
    now: () => now,
    setTimeout: (cb, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + (ms || 0), cb });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (cb) => frames.push(cb),
    advance(ms) {
      const target = now + ms;
      for (let guard = 0; guard < 10000; guard++) {
        let next = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (next === null || timer.at < timers.get(next).at)) {
            next = id;
          }
        }
        const step = next === null ? target : timers.get(next).at;
        // Los cuadros de animación corren aunque no venza ningún temporizador.
        while (now < step) {
          now = Math.min(step, now + 16);
          frames.splice(0, frames.length).forEach((cb) => cb());
        }
        if (next === null) break;
        const timer = timers.get(next);
        timers.delete(next);
        timer.cb();
      }
      now = target;
      frames.splice(0, frames.length).forEach((cb) => cb());
    },
  };
}

test('un turno entero: dados sobre el tablero, ficha andando y banda al final', () => {
  const clock = fakeClock();
  const cast = bootCastReceiver({
    Date: { now: clock.now },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    requestAnimationFrame: clock.requestAnimationFrame,
  });
  const tokenAt = () => {
    const layer = cast.element('board-tokens');
    return layer.children.length ? layer.children[0].transform : null;
  };
  const geo = boardArt.geometryFor(63);
  const centerOf = (n) => boardArt.centerOf(geo.cells[n - 1]);
  const near = (transform, n) => {
    const [x, y] = transform.match(/translate\(([-\d.]+),([-\d.]+)\)/).slice(1).map(Number);
    const c = centerOf(n);
    return Math.abs(x - c.x) < 1 && Math.abs(y - c.y) < 1;
  };

  cast.connect('movil-a');
  cast.message('movil-a', castCue(1, 'snapshot', { state: publicSnapshot() }));
  assert.ok(near(tokenAt(), 12), 'la ficha empieza en la 12');

  // El móvil manda el turno completo de golpe, como hace de verdad.
  cast.message('movil-a', castCue(2, 'dice_started'));
  cast.message('movil-a', castCue(3, 'dice_result', { dice: [4, 2], total: 6 }));
  cast.message('movil-a', castCue(4, 'piece_path', { from: 12, to: 18, path: [13, 14, 15, 16, 17, 18] }));
  const conCeremonia = publicSnapshot();
  conCeremonia.players[0].position = 18;
  conCeremonia.turn.dice = [4, 2];
  conCeremonia.publicCeremony = { type: 'oca', title: 'DE OCA A OCA', body: 'Y BEBE PORQUE TE TOCA' };
  cast.message('movil-a', castCue(5, 'snapshot', { state: conCeremonia }));

  // NADA de hoja a pantalla completa por una tirada, y la ficha sigue en su
  // casilla: el snapshot con la posición final NO puede teletransportarla.
  assert.equal(cast.element('ceremony').hidden, true);
  assert.equal(cast.element('banner').hidden, true);
  assert.equal(cast.element('dice-stage').hidden, false, 'los dados ruedan sobre el tablero');
  assert.ok(near(tokenAt(), 12), 'la ficha no se adelanta a su recorrido');

  // Los dados se asientan en el valor de verdad y encogen hasta el sello.
  clock.advance(boardArt.DICE_ROLL_MS + boardArt.DICE_STAMP_MS);
  assert.deepEqual(
    cast.element('dice-faces').children.map((d) => d.textContent),
    ['4', '2'],
  );
  assert.equal(cast.element('dice-total').textContent, '6');
  clock.advance(boardArt.DICE_STOW_MS + 40);
  assert.equal(cast.element('roll-slot').hidden, false, 'el resultado se guarda en la esquina');
  assert.equal(cast.element('roll-total').textContent, '6');
  // Y solo AHORA empieza a andar la ficha, con la banda todavía sin sacar.
  assert.equal(cast.element('banner').hidden, true);

  const recorrido = new Set();
  const total = boardArt.hopDuration(boardArt.hopPlanFor(12, [13, 14, 15, 16, 17, 18], 18));
  for (let t = 0; t < total; t += 120) {
    clock.advance(120);
    recorrido.add(tokenAt());
  }
  assert.ok(recorrido.size >= 6, `la mesa tiene que ver el recorrido, vio ${recorrido.size}`);

  clock.advance(200);
  assert.ok(near(tokenAt(), 18), 'la ficha aterriza donde dice el estado');
  // La ceremonia llega DESPUÉS del salto, y en la banda: el tablero se ve.
  assert.equal(cast.element('banner').hidden, false);
  assert.equal(cast.element('banner-title').textContent, 'DE OCA A OCA');
  assert.equal(cast.element('banner-type').textContent, 'CASILLA DE LA OCA');
  assert.equal(cast.element('ceremony').hidden, true);
});

test('el reto se lee a pantalla completa y dice a quién le toca', () => {
  const cast = bootCastReceiver();
  cast.connect('movil-a');
  const conReto = publicSnapshot();
  conReto.publicCard = {
    title: 'CONFESIÓN DE BARRA',
    body: 'Cuenta tu peor excusa.',
    suit: 'espadas',
    nonAlcohol: true,
    playerId: 'j1',
  };
  cast.message('movil-a', castCue(1, 'snapshot', { state: conReto }));
  assert.equal(cast.element('card').hidden, false);
  assert.equal(cast.element('card-title').textContent, 'CONFESIÓN DE BARRA');
  assert.equal(cast.element('card-suit').textContent, 'ESPADAS');
  assert.equal(cast.element('card-sober').hidden, false);
  assert.equal(cast.element('card-who').hidden, false);
  assert.equal(cast.element('card-who-name').textContent, 'LOLA');
});

test('con movimiento reducido la ficha no anima pero llega igual', () => {
  const frames = [];
  const cast = bootCastReceiver({
    Date: { now: () => 0 },
    requestAnimationFrame: (cb) => frames.push(cb),
  });
  cast.connect('movil-a');
  const quieto = publicSnapshot();
  quieto.accessibility.reducedMotion = true;
  cast.message('movil-a', castCue(1, 'snapshot', { state: quieto }));
  cast.message('movil-a', castCue(2, 'piece_path', { from: 12, to: 15, path: [13, 14, 15] }));
  assert.equal(frames.length, 0, 'no debe programarse ningún cuadro');

  const llegada = publicSnapshot();
  llegada.accessibility.reducedMotion = true;
  llegada.players[0].position = 15;
  cast.message('movil-a', castCue(3, 'snapshot', { state: llegada }));
  const geo = boardArt.geometryFor(63);
  const destino = boardArt.centerOf(geo.cells[14]);
  const final = cast.element('board-tokens').children[0].transform;
  const [x, y] = final.match(/translate\(([-\d.]+),([-\d.]+)\)/).slice(1).map(Number);
  assert.equal(Math.round(x), Math.round(destino.x));
  assert.equal(Math.round(y), Math.round(destino.y));
});
