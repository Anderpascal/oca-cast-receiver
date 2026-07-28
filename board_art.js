// Planchas del tablero para la tele: geometría y pictogramas.
//
// Se separa de receiver.js porque son dos cosas distintas: aquí vive el DIBUJO
// (qué forma tiene el tablero y qué se imprime en cada casilla) y allí la
// CONVERSACIÓN con el móvil. Además así puede probarse sin simular Cast.
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OcaBoardArt = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  // Geometría SAGRADA, copiada de `SpiralGeometry` (lib/app/theme/board/
  // board_geometry.dart). No es "una espiral cualquiera": arranca en la
  // esquina INFERIOR IZQUIERDA, recorre la fila de abajo hacia la derecha,
  // sube por la derecha, vuelve por arriba hacia la izquierda y baja por la
  // izquierda, y repite un circuito más adentro. La meta no es una casilla
  // normal sino un bloque reservado donde vive el medallón.
  //
  // Tiene que coincidir CASILLA A CASILLA con el móvil: si no, la mesa ve dos
  // tableros distintos y el recorrido de la ficha no cuadra con el de la mano.
  const GRIDS = { 30: [6, 6], 63: [8, 8] };

  /// La retícula de un tablero no cambia NUNCA durante una partida, pero el
  /// salto de la ficha la pedía dos veces por cuadro y la reconstruía entera:
  /// 63 objetos nuevos a 60 cuadros por segundo son ~7.500 asignaciones por
  /// segundo tirando del recolector, y en un Chromecast eso se ve como
  /// tirones. Se construye una vez por meta y se reparte la misma.
  const geometryCache = new Map();
  function geometryFor(goal) {
    const hit = geometryCache.get(goal);
    if (hit) return hit;
    const built = buildGeometry(goal);
    geometryCache.set(goal, built);
    return built;
  }

  function buildGeometry(goal) {
    const [cols, rows] = GRIDS[goal] || [7, 9];
    const cells = [];
    let l = 0, t = 0, r = cols - 1, b = rows - 1, n = 1;
    while (l <= r && t <= b && n <= goal) {
      for (let c = l; c <= r && n <= goal; c++) cells.push(cell(n++, c, b));
      for (let row = b - 1; row >= t && n <= goal; row--) cells.push(cell(n++, r, row));
      if (t !== b) {
        for (let c = r - 1; c >= l && n <= goal; c--) cells.push(cell(n++, c, t));
      }
      if (l !== r) {
        for (let row = t + 1; row <= b - 1 && n <= goal; row++) cells.push(cell(n++, l, row));
      }
      l++; t++; r--; b--;
    }
    // El hueco del medallón: la meta ocupa bloque propio y no pisa a nadie.
    if (goal === 63) cells[62] = cell(63, 3, 3, 2, 1);
    if (goal === 30) cells[29] = cell(30, 2, 2, 2, 2);
    // Centros ya resueltos: durante el salto solo se leen, nunca se calculan.
    const centers = cells.map(centerOf);
    return {
      cols, rows, cells, centers,
      decor: goal === 30 ? [[1, 1], [1, 2], [1, 3]] : [],
    };
  }
  function cell(n, col, row, colSpan = 1, rowSpan = 1) {
    return { n, col, row, colSpan, rowSpan };
  }

  // Lado de casilla en unidades de viewBox. Todo el dibujo se expresa en esta
  // rejilla y el SVG se encarga de escalarlo al televisor que toque.
  const U = 100;

  function centerOf(c) {
    return {
      x: (c.col + c.colSpan / 2) * U,
      y: (c.row + c.rowSpan / 2) * U,
    };
  }

  /// Centro de la casilla `n` en un tablero de esa meta, sin construir nada:
  /// es lo único que necesita el salto de la ficha cuadro a cuadro.
  function centerFor(goal, n) {
    const geo = geometryFor(goal);
    const last = geo.centers.length - 1;
    const i = Math.min(Math.max(Math.round(n) - 1, 0), last);
    return geo.centers[i];
  }

  // Pictogramas en una caja 0..100 centrada en (50,50). Se describen como
  // datos -no como cadenas de SVG- para poder construirlos con createElementNS
  // sin depender de innerHTML sobre nodos SVG, que en televisores viejos no es
  // de fiar.
  // Los pictogramas llenan su caja de lado a lado: en un televisor visto desde
  // el sofá, un dibujo tímido en el centro de la casilla no se lee. Trazos
  // gruesos y masas rellenas, como una plancha de imprenta.
  const S = (d, w = 8) => ({ t: 'path', a: { d, 'stroke-width': w } });
  const PICTS = {
    // La oca: silueta RELLENA, no contorno. A tres metros una silueta se lee y
    // un contorno fino desaparece.
    oca: [
      { t: 'path', a: { d: 'M14,58 L0,44 L16,76 Z', fill: 'ink' } },
      { t: 'ellipse', a: { cx: 44, cy: 64, rx: 32, ry: 24, fill: 'ink' } },
      { t: 'path', a: { d: 'M58,52 C55,30 62,16 72,14', 'stroke-width': 15, 'stroke-linecap': 'round' } },
      { t: 'circle', a: { cx: 74, cy: 14, r: 13, fill: 'ink' } },
      { t: 'path', a: { d: 'M85,7 L100,14 L85,21 Z', fill: 'ink' } },
    ],
    puente: [
      S('M10,62 A38,30 0 0 1 90,62', 9),
      S('M4,62 L96,62', 9),
      S('M10,88 Q30,76 50,88 T90,88', 6),
    ],
    posada: [
      S('M26,30 L70,30 L64,90 L32,90 Z', 8),
      S('M70,44 A16,16 0 0 1 70,74', 8),
      S('M20,20 L76,20', 12),
    ],
    dados: [
      S('M20,20 L80,20 L80,80 L20,80 Z', 8),
      { t: 'circle', a: { cx: 36, cy: 36, r: 8, fill: 'ink' } },
      { t: 'circle', a: { cx: 50, cy: 50, r: 8, fill: 'ink' } },
      { t: 'circle', a: { cx: 64, cy: 64, r: 8, fill: 'ink' } },
    ],
    // Pozo: tejadillo a dos aguas, postes y brocal. Antes eran dos rectas al
    // vértice y se leía como un cono.
    pozo: [
      S('M10,36 L50,10 L90,36', 9),
      S('M24,36 L24,66', 8), S('M76,36 L76,66', 8),
      { t: 'ellipse', a: { cx: 50, cy: 72, rx: 32, ry: 13, 'stroke-width': 9 } },
      S('M50,36 L50,62', 5),
    ],
    laberinto: [
      S('M14,14 L86,14 L86,86 L14,86 L14,44 L64,44', 9),
      S('M34,64 L86,64', 9),
    ],
    carcel: [
      S('M14,14 L86,14', 10), S('M14,86 L86,86', 10),
      S('M32,14 L32,86', 9), S('M50,14 L50,86', 9), S('M68,14 L68,86', 9),
    ],
    muerte: [
      { t: 'ellipse', a: { cx: 50, cy: 42, rx: 32, ry: 30, 'stroke-width': 9 } },
      { t: 'circle', a: { cx: 38, cy: 40, r: 8.5, fill: 'ink' } },
      { t: 'circle', a: { cx: 62, cy: 40, r: 8.5, fill: 'ink' } },
      S('M36,72 L64,72 L64,94 L36,94 Z', 8),
      S('M45,72 L45,94', 6), S('M55,72 L55,94', 6),
    ],
    // Los que siguen no son casillas: son sellos de ceremonia para la banda de
    // la tele. Misma caja 0..100 y mismo grosor de trazo, para que la banda se
    // lea igual de lejos que el tablero.
    brindis: [
      S('M18,14 L46,14 L38,44 L26,44 Z', 8),
      S('M32,44 L32,84', 8), S('M18,86 L46,86', 9),
      S('M56,14 L84,14 L76,44 L64,44 Z', 8),
      S('M70,44 L70,84', 8), S('M56,86 L84,86', 9),
    ],
    corona: [
      S('M12,74 L20,26 L38,50 L50,18 L62,50 L80,26 L88,74 Z', 9),
      S('M14,88 L86,88', 10),
    ],
    estrella: [
      S('M50,8 L61,38 L93,38 L67,57 L77,88 L50,69 L23,88 L33,57 L7,38 L39,38 Z', 9),
    ],
    carta: [
      S('M22,10 L78,10 L78,90 L22,90 Z', 9),
      { t: 'circle', a: { cx: 50, cy: 42, r: 15, fill: 'ink' } },
      S('M50,57 L50,76', 8),
    ],
    sello: [
      { t: 'circle', a: { cx: 50, cy: 42, r: 26, 'stroke-width': 9 } },
      S('M50,68 L50,84', 9), S('M20,88 L80,88', 10),
    ],
  };

  /// Tono, sello y antetítulo de cada ceremonia: mandan el color y el dibujo
  /// de la banda de la tele. El tono se lee de lejos antes que el texto -verde
  /// algo bueno, rojo algo malo-, así que no puede depender del idioma ni del
  /// largo del título. El antetítulo dice DÓNDE pasa, para no repetir el
  /// titular ni enseñar el nombre técnico del evento.
  const CEREMONY = {
    oca: { pict: 'oca', tone: 'bien', kicker: 'CASILLA DE LA OCA' },
    puente: { pict: 'puente', tone: 'bien', kicker: 'EL PUENTE' },
    dados: { pict: 'dados', tone: 'bien', kicker: 'LOS DADOS' },
    tirada_extra: { pict: 'dados', tone: 'bien', kicker: 'OTRA VEZ' },
    libertad: { pict: 'carcel', tone: 'bien', kicker: 'LA CÁRCEL' },
    rescate: { pict: 'pozo', tone: 'bien', kicker: 'EL POZO' },
    marea: { pict: 'pozo', tone: 'bien', kicker: 'EL POZO' },
    indulto: { pict: 'muerte', tone: 'bien', kicker: 'LA MUERTE' },
    seguro: { pict: 'estrella', tone: 'bien', kicker: 'EL SEGURO' },
    comodin: { pict: 'estrella', tone: 'bien', kicker: 'COMODÍN' },
    victoria: { pict: 'corona', tone: 'bien', kicker: 'EL JARDÍN' },
    pozo: { pict: 'pozo', tone: 'mal', kicker: 'EL POZO' },
    carcel: { pict: 'carcel', tone: 'mal', kicker: 'LA CÁRCEL' },
    muerte: { pict: 'muerte', tone: 'mal', kicker: 'LA MUERTE' },
    laberinto: { pict: 'laberinto', tone: 'mal', kicker: 'EL LABERINTO' },
    rebote: { pict: 'puente', tone: 'mal', kicker: 'LA META' },
    turno_saltado: { pict: 'posada', tone: 'mal', kicker: 'TURNO EN PAUSA' },
    posada: { pict: 'posada', tone: 'neutro', kicker: 'LA POSADA' },
    brindis: { pict: 'brindis', tone: 'neutro', kicker: 'EL PUENTE' },
    reto: { pict: 'carta', tone: 'neutro', kicker: 'CASTIGO' },
    regla: { pict: 'sello', tone: 'neutro', kicker: 'LEY DE LA MESA' },
    turno: { pict: 'sello', tone: 'neutro', kicker: 'CAMBIO DE MANO' },
    sello: { pict: 'sello', tone: 'neutro', kicker: 'LA PARTIDA' },
  };
  const ceremonyLook = (type) => CEREMONY[type] || CEREMONY.sello;

  // Roles de tinta por tipo de casilla. Constantes entre ediciones: el tablero
  // se lee como señalización aunque cambie la tirada de tinta.
  const ROLE = {
    oca: 'ink1', puente: 'ink1',
    posada: 'ink2', dados: 'ink2',
    pozo: 'ink3', laberinto: 'ink3', carcel: 'ink3', muerte: 'ink3',
    jardin: 'ink2',
  };

  // Tiradas de tinta, espejo de PressTheme (lib/app/theme/inks.dart).
  const THEMES = {
    clasica: { ink1: '#0078bf', ink2: '#ffe800', ink3: '#f15060', paper: '#f4eddc' },
    noche: { ink1: '#00838a', ink2: '#ff6c2f', ink3: '#f15060', paper: '#efe7d6' },
    verbena: { ink1: '#00a95c', ink2: '#ffe800', ink3: '#ff6c2f', paper: '#f6efdd' },
  };
  const themeFor = (id) => THEMES[id] || THEMES.clasica;

  // Mismos tiempos que el móvil (`tvHopDurationMs`, lib/domain/tv/
  // tv_event_cues.dart). Si cambian allí, cambian aquí: el mando espera
  // exactamente esto para volver a habilitar TIRAR, y si los dos lados no
  // coinciden o se habilita el botón con la ficha aún andando, o la mesa se
  // queda esperando de más.
  const HOP_PER_CELL = 260, HOP_MIN_PER_CELL = 120, HOP_CEILING = 2200, HOP_JUMP = 560;

  /// Reparte el recorrido en tramos con su duración: paso corto y visible
  /// mientras el camino sea corto, comprimido después para no eternizar un
  /// rebote, y un tramo aparte para el salto largo del motor (oca, puente,
  /// dados, laberinto, muerte), que es un acontecimiento y no un paso más.
  function hopPlanFor(from, path, finalPosition) {
    const walk = (path || []).filter((n) => typeof n === 'number');
    const segments = [];
    let previous = from;
    if (walk.length) {
      const per = walk.length <= 8
        ? HOP_PER_CELL
        : Math.max(HOP_MIN_PER_CELL, Math.floor(HOP_CEILING / walk.length));
      for (const square of walk) {
        segments.push({ from: previous, to: square, ms: per, jump: false });
        previous = square;
      }
    }
    if (typeof finalPosition === 'number' && finalPosition !== previous) {
      segments.push({ from: previous, to: finalPosition, ms: HOP_JUMP, jump: true });
    }
    return segments;
  }
  const hopDuration = (segments) => segments.reduce((a, s) => a + s.ms, 0);

  // LOS DADOS DE LA TELE. Espejo de `tvDiceStageMs` (lib/domain/tv/
  // tv_event_cues.dart) y del dado del móvil (`DiceWidget`): 9 cambios de cara
  // con intervalos CRECIENTES 60→140 ms -el dado de madera pierde impulso-, el
  // sello de la cara final y el encogido hasta la esquina.
  //
  // El móvil suma este tramo antes de volver a habilitar TIRAR: si aquí se
  // alarga y allí no, la mesa podrá tirar con los dados todavía rodando.
  const DICE_CHANGES = 9;
  const DICE_FIRST_MS = 60, DICE_LAST_MS = 140;
  const DICE_STAMP_MS = 240, DICE_STOW_MS = 260;

  /// Instantes (ms desde el inicio) en los que el dado cambia de cara.
  function diceBeats() {
    const beats = [];
    let acc = 0;
    for (let i = 0; i < DICE_CHANGES; i++) {
      acc += Math.round(
        DICE_FIRST_MS + ((DICE_LAST_MS - DICE_FIRST_MS) * i) / (DICE_CHANGES - 1),
      );
      beats.push(acc);
    }
    return beats;
  }
  const DICE_ROLL_MS = diceBeats()[DICE_CHANGES - 1];
  const DICE_STAGE_MS = DICE_ROLL_MS + DICE_STAMP_MS + DICE_STOW_MS;

  return {
    geometryFor, centerOf, centerFor, PICTS, ROLE, THEMES, themeFor, U,
    hopPlanFor, hopDuration, ceremonyLook, CEREMONY,
    diceBeats, DICE_ROLL_MS, DICE_STAMP_MS, DICE_STOW_MS, DICE_STAGE_MS,
  };
});
