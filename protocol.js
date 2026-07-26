(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OcaCastProtocol = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const PROTOCOL_VERSION = 1;
  const MAX_SEEN_EVENTS = 256;
  const MESSAGE_TYPES = new Set([
    'turn_started',
    'dice_started',
    'dice_result',
    'piece_path',
    'card_opened',
    'ceremony_opened',
    'ceremony_closed',
    'privacy_cover_changed',
    'game_finished',
    'snapshot',
  ]);

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function isPresentationState(candidate) {
    if (!isPlainObject(candidate) || candidate.protocolVersion !== PROTOCOL_VERSION) {
      return false;
    }
    const board = candidate.board;
    if (
      !isPlainObject(board) ||
      typeof board.publicId !== 'string' ||
      typeof board.title !== 'string' ||
      !Number.isSafeInteger(board.goal) ||
      board.goal < 1 ||
      board.goal > 100 ||
      !isPlainObject(board.specialSquares)
    ) {
      return false;
    }
    if (
      !Array.isArray(candidate.players) ||
      candidate.players.length < 1 ||
      candidate.players.length > 12 ||
      !candidate.players.every(
        (player) =>
          isPlainObject(player) &&
          typeof player.publicId === 'string' &&
          player.publicId.length > 0 &&
          typeof player.symbol === 'string' &&
          Number.isSafeInteger(player.inkIndex) &&
          Number.isSafeInteger(player.position) &&
          player.position >= 0 &&
          player.position <= board.goal &&
          (player.displayName == null || typeof player.displayName === 'string') &&
          Array.isArray(player.statuses) &&
          player.statuses.every((status) => typeof status === 'string'),
      )
    ) {
      return false;
    }
    const turn = candidate.turn;
    return (
      isPlainObject(turn) &&
      typeof turn.currentPlayerId === 'string' &&
      Number.isSafeInteger(turn.round) &&
      turn.round >= 0 &&
      Array.isArray(turn.dice) &&
      turn.dice.every(
        (die) => Number.isSafeInteger(die) && die >= 1 && die <= 6,
      ) &&
      Array.isArray(candidate.effects) &&
      candidate.effects.every((effect) => typeof effect === 'string') &&
      typeof candidate.privacyCover === 'boolean' &&
      isPlainObject(candidate.accessibility) &&
      typeof candidate.accessibility.reducedMotion === 'boolean'
    );
  }

  class SenderAuthority {
    constructor() {
      this.senderId = '';
    }

    claim(senderId) {
      if (typeof senderId !== 'string' || !senderId) return false;
      if (!this.senderId) this.senderId = senderId;
      return this.senderId === senderId;
    }

    release(senderId) {
      if (senderId === this.senderId) this.senderId = '';
    }
  }

  class CueGuard {
    constructor() {
      this.reset();
    }

    reset(sessionId = '') {
      this.sessionId = sessionId;
      this.lastSequence = 0;
      this.seen = new Set();
    }

    inspect(message) {
      if (!message || typeof message !== 'object') return 'malformed';
      if (message.protocolVersion !== PROTOCOL_VERSION) return 'incompatible';
      if (
        typeof message.sessionId !== 'string' ||
        !message.sessionId ||
        !Number.isSafeInteger(message.sequence) ||
        message.sequence < 1 ||
        typeof message.eventId !== 'string' ||
        !message.eventId ||
        typeof message.type !== 'string' ||
        !MESSAGE_TYPES.has(message.type) ||
        !isPlainObject(message.payload)
      ) {
        return 'malformed';
      }

      if (message.sessionId !== this.sessionId) this.reset(message.sessionId);
      if (
        this.seen.has(message.eventId) ||
        message.sequence <= this.lastSequence
      ) {
        return 'ignore';
      }
      if (
        this.lastSequence !== 0 &&
        message.sequence !== this.lastSequence + 1 &&
        message.type !== 'snapshot'
      ) {
        return 'snapshot_request';
      }

      this.lastSequence = message.sequence;
      this.seen.add(message.eventId);
      if (this.seen.size > MAX_SEEN_EVENTS) {
        this.seen.delete(this.seen.values().next().value);
      }
      return 'apply';
    }
  }

  return { CueGuard, PROTOCOL_VERSION, SenderAuthority, isPresentationState };
});