'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const protocol = require('./protocol.js');
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
  };
  const context = {
    OcaCastProtocol: protocol,
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

function bootCastReceiver() {
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
      TextEncoder,
      URLSearchParams,
      cast,
      clearTimeout,
      console,
      document: {
        body: new FakeElement(),
        getElementById: element,
        createElement: () => new FakeElement(),
      },
      location: { search: '' },
      setTimeout,
      window: { cast },
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
  assert.equal(element('board').children.length, 63);
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
  assert.equal(element('board').children.length, 63);
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
  assert.equal(cast.element('board').children.length, 63);
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