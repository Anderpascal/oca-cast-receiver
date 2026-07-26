(() => {
  'use strict';
  const NS = 'urn:x-cast:com.juegaoca.presentation';
  const PROTOCOL = OcaCastProtocol.PROTOCOL_VERSION;
  const MAX_MESSAGE_BYTES = 64 * 1024;
  const colors = ['#0078bf','#00a95c','#ffe800','#ff6c2f','#f15060','#914e72','#00838a','#765ba7'];
  const icons = {oca:'O',puente:'↔',posada:'P',dados:'⚄',pozo:'↓',laberinto:'⌁',carcel:'▦',muerte:'†',jardin:'★'};
  const statusLabels = {pozo:'POZO',carcel:'CÁRCEL',posada:'POSADA'};
  let state = null;
  const guard = new OcaCastProtocol.CueGuard();
  const authority = new OcaCastProtocol.SenderAuthority();
  let context = null;
  const $ = id => document.getElementById(id);

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

  function cellsFor(goal) {
    const side = goal === 30 ? 6 : 8, cells = [];
    let top=0,left=0,bottom=side-1,right=side-1;
    while(top<=bottom&&left<=right){
      for(let c=left;c<=right;c++) cells.push([top,c]); top++;
      for(let r=top;r<=bottom;r++) cells.push([r,right]); right--;
      if(top<=bottom){for(let c=right;c>=left;c--) cells.push([bottom,c]); bottom--;}
      if(left<=right){for(let r=bottom;r>=top;r--) cells.push([r,left]); left++;}
    }
    return cells.slice(0,goal).map((p,i)=>({number:i+1,row:p[0],col:p[1],side}));
  }
  function render() {
    if (!state) return;
    $('connection').hidden = true;
    document.body.classList.toggle('reduced', !!state.accessibility?.reducedMotion);
    $('edition').textContent = state.board.title.toUpperCase();
    const board = $('board'); board.replaceChildren();
    const playersByCell = new Map();
    for (const p of state.players) { const list=playersByCell.get(p.position)||[]; list.push(p); playersByCell.set(p.position,list); }
    for (const cell of cellsFor(state.board.goal)) {
      const type = state.board.specialSquares[String(cell.number)];
      const el = document.createElement('div'); el.className='cell'+(type?' special':'');
      const gap=.55, w=(100-gap*(cell.side-1))/cell.side;
      el.style.cssText=`left:${cell.col*(w+gap)}%;top:${cell.row*(w+gap)}%;width:${w}%;height:${w}%;--cell-ink:${type==='muerte'||type==='carcel'?'#f15060':type==='oca'?'#0078bf':'#ffe800'};--tilt:${((cell.number*17)%5-2)*.25}deg`;
      el.innerHTML=`<span>${cell.number}</span>${type?`<span class="pict">${icons[type]||'·'}</span>`:''}`;
      const group=document.createElement('div'); group.className='tokens';
      for(const p of playersByCell.get(cell.number)||[]){const t=document.createElement('div');t.className='token'+(p.publicId===state.turn.currentPlayerId?' current':'');t.style.background=colors[p.inkIndex]||colors[0];t.textContent=p.symbol;t.title=p.displayName||`Jugador ${p.symbol}`;group.append(t)}
      el.append(group); board.append(el);
    }
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
    const ceremony=state.publicCeremony;$('ceremony').hidden=!ceremony;if(ceremony){$('ceremony-type').textContent=ceremony.type;$('ceremony-title').textContent=ceremony.title;$('ceremony-body').textContent=ceremony.body||''}
    const finalRanking=$('ceremony-ranking');finalRanking.hidden=ceremony?.type!=='victoria';finalRanking.innerHTML=ceremony?.type==='victoria'?ranking.slice(0,8).map((p,i)=>`<li><span>${i+1}</span><strong>${escapeHtml(p.displayName||`Jugador ${p.symbol}`)}</strong><span>${p.position}</span></li>`).join(''):'';
    $('private-note').hidden=!state.secretDecision || state.privacyCover;
    $('privacy').hidden=!state.privacyCover;
  }
  function animateCue(type,payload){
    if(type==='dice_started'||type==='dice_result'){$('dice').classList.remove('roll');void $('dice').offsetWidth;$('dice').classList.add('roll');if(payload.dice)$('dice').textContent=payload.dice.join(' + ')}
    if(type==='piece_path'){$('stage').classList.add('piece-hop');setTimeout(()=>$('stage').classList.remove('piece-hop'),420)}
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
    const demo={protocolVersion:1,board:{publicId:'clasica',title:'Oca Clásica',visualTheme:'clasica',goal:63,geometryVersion:1,specialSquares:{'5':'oca','6':'puente','9':'oca','12':'puente','19':'posada','26':'dados','31':'pozo','42':'laberinto','56':'carcel','58':'muerte','63':'jardin'}},players:[{publicId:'j1',displayName:'Lola',inkIndex:0,symbol:'1',position:23,statuses:['pozo']},{publicId:'j2',displayName:'Dani',inkIndex:3,symbol:'2',position:18,statuses:[]}],turn:{currentPlayerId:'j1',round:4,dice:[5]},phase:'idle',effects:['REGLA DE LA NOCHE'],privacyCover:false,accessibility:{reducedMotion:false}};
    state=demo;render();if(demoMode==='card'){state.publicCard={title:'CONFESIÓN DE BARRA',body:'Cuenta tu peor excusa para llegar tarde o cumple el castigo.',suit:'ESPADAS',nonAlcohol:false};render()}if(demoMode==='ceremony'){state.publicCeremony={type:'OCA',title:'DE OCA A OCA',body:'Y BEBE PORQUE TE TOCA'};render()}if(demoMode==='privacy'){state.privacyCover=true;render()}if(demoMode==='private'){state.secretDecision=true;render()}if(demoMode==='victory'){state.players[0].position=63;state.publicCeremony={type:'victoria',title:'CAMPEÓN DE LA OCA',body:'LOLA'};render()}
  }
})();
