'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CueGuard, SenderAuthority, isPresentationState } = require('./protocol.js');

function cue(sequence, eventId, overrides = {}) {
  return {
    protocolVersion: 1,
    sessionId: 'mesa-a',
    sequence,
    eventId,
    type: 'dice_result',
    payload: {},
    ...overrides,
  };
}

test('aplica mensajes ordenados e ignora replay', () => {
  const guard = new CueGuard();
  assert.equal(guard.inspect(cue(1, 'a')), 'apply');
  assert.equal(guard.inspect(cue(1, 'a')), 'ignore');
  assert.equal(guard.inspect(cue(2, 'b')), 'apply');
});

test('solicita snapshot ante un salto y acepta el snapshot reparador', () => {
  const guard = new CueGuard();
  assert.equal(guard.inspect(cue(3, 'c')), 'apply');
  assert.equal(guard.inspect(cue(5, 'e')), 'snapshot_request');
  assert.equal(
    guard.inspect(cue(5, 'snapshot', { type: 'snapshot' })),
    'apply',
  );
});

test('una sesión nueva reinicia secuencia sin heredar replays', () => {
  const guard = new CueGuard();
  assert.equal(guard.inspect(cue(8, 'old')), 'apply');
  assert.equal(
    guard.inspect(cue(1, 'new', { sessionId: 'mesa-b' })),
    'apply',
  );
  assert.equal(guard.sessionId, 'mesa-b');
  assert.equal(guard.lastSequence, 1);
});

test('rechaza versión incompatible y mensajes incompletos', () => {
  const guard = new CueGuard();
  assert.equal(
    guard.inspect(cue(1, 'a', { protocolVersion: 2 })),
    'incompatible',
  );
  assert.equal(guard.inspect({ protocolVersion: 1 }), 'malformed');
  assert.equal(guard.inspect(cue(1, 'x', { type: 'unknown' })), 'malformed');
  assert.equal(guard.inspect(cue(1, 'x', { payload: [] })), 'malformed');
});

test('valida el snapshot público completo antes de renderizar', () => {
  const snapshot = {
    protocolVersion: 1,
    board: {
      publicId: 'clasica',
      title: 'Oca Clásica',
      goal: 63,
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
    effects: [],
    privacyCover: false,
    accessibility: { reducedMotion: false },
  };
  assert.equal(isPresentationState(snapshot), true);
  assert.equal(isPresentationState({ ...snapshot, players: [] }), false);
  assert.equal(
    isPresentationState({
      ...snapshot,
      players: [{ ...snapshot.players[0], position: 999 }],
    }),
    false,
  );
  assert.equal(
    isPresentationState({ ...snapshot, accessibility: null }),
    false,
  );
});

test('solo el primer sender conserva autoridad hasta desconectarse', () => {
  const authority = new SenderAuthority();
  assert.equal(authority.claim('movil-a'), true);
  assert.equal(authority.claim('movil-b'), false);
  authority.release('movil-b');
  assert.equal(authority.claim('movil-b'), false);
  authority.release('movil-a');
  assert.equal(authority.claim('movil-b'), true);
});