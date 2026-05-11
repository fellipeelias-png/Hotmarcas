// ============================================================================
// HotMarcas — main.js
// Comportamentos compartilhados entre / (home) e /lp/*. Defensivo: cada
// bloco só roda se os elementos esperados existirem no DOM.
// ============================================================================

// ── LP audience tracking (GA4) ─────────────────────────────────────────────
var LP_SLUG = (document.body && document.body.dataset && document.body.dataset.lp) || 'home';
if (typeof gtag === 'function') {
  try {
    gtag('set', 'user_properties', { lp_audience: LP_SLUG });
    gtag('event', 'lp_view', { lp_audience: LP_SLUG });
  } catch(e){}
}

// ── UTM capture (sessionStorage, reaproveitado no checkout) ─────────────────
(function(){
  try{
    var qs = new URLSearchParams(window.location.search);
    var picked = {};
    ['utm_source','utm_medium','utm_campaign','utm_content','utm_term'].forEach(function(k){
      var v = qs.get(k); if(v) picked[k] = v;
    });
    if (Object.keys(picked).length){
      sessionStorage.setItem('hm_utms', JSON.stringify(picked));
    }
  }catch(e){}
})();
function getStoredUtms(){
  try{ return JSON.parse(sessionStorage.getItem('hm_utms')||'{}'); }catch(e){ return {}; }
}

// ── Drawer / hamburger ──────────────────────────────────────────────────────
var ham = document.getElementById('ham');
var drawer = document.getElementById('drawer');
if (ham && drawer){
  ham.addEventListener('click', function(){
    ham.classList.toggle('open');
    drawer.classList.toggle('open');
    document.body.style.overflow = drawer.classList.contains('open') ? 'hidden' : '';
  });
}
function closeDrawer(){
  if (ham) ham.classList.remove('open');
  if (drawer) drawer.classList.remove('open');
  document.body.style.overflow = '';
}

// ── Stripe checkout (envia tier + audience + UTMs) ─────────────────────────
async function iniciarCheckout(tier, btn){
  var origText = btn.textContent;
  btn.disabled = true; btn.textContent = 'Aguarde…';
  if (typeof gtag === 'function') {
    try { gtag('event','lp_checkout_start',{lp_audience:LP_SLUG, tier:tier}); } catch(e){}
  }
  try{
    var r = await fetch('/api/create-checkout', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ tier: tier, audience: LP_SLUG, utms: getStoredUtms() })
    });
    if (!r.ok) throw new Error('server error');
    var data = await r.json();
    window.location.href = data.url;
  } catch(e){
    btn.disabled = false; btn.textContent = origText;
    alert('Erro ao iniciar o pagamento. Tente novamente ou fale pelo WhatsApp.');
  }
}

// ── Reveal-on-scroll ────────────────────────────────────────────────────────
var revObs = new IntersectionObserver(function(entries){
  entries.forEach(function(e){ if (e.isIntersecting) e.target.classList.add('on'); });
}, { threshold: 0.10 });
document.querySelectorAll('.rv,.rvl,.rvr').forEach(function(el){ revObs.observe(el); });

// ── Accordion (criadores etc.) ──────────────────────────────────────────────
document.querySelectorAll('.acc-hd').forEach(function(hd){
  hd.addEventListener('click', function(){
    var item = hd.closest('.acc-item');
    var isOpen = item.classList.contains('open');
    document.querySelectorAll('.cr-acc .acc-item.open').forEach(function(i){ i.classList.remove('open'); });
    if (!isOpen) item.classList.add('open');
    hd.setAttribute('aria-expanded', (!isOpen).toString());
  });
});

// ── Contador "+3.000 marcas" ────────────────────────────────────────────────
var cntEl = document.getElementById('cnt-marcas');
if (cntEl){
  var cntObs = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if (!e.isIntersecting) return;
      var n=0; var T=3000;
      var t=setInterval(function(){
        n=Math.min(n+60,T);
        cntEl.textContent='+'+n.toLocaleString('pt-BR');
        if (n>=T) clearInterval(t);
      },18);
      cntObs.unobserve(cntEl);
    });
  }, { threshold: 0.5 });
  cntObs.observe(cntEl);
}

// ── Smooth anchors ──────────────────────────────────────────────────────────
document.querySelectorAll('a[href^="#"]').forEach(function(a){
  a.addEventListener('click', function(e){
    var t = document.querySelector(a.getAttribute('href'));
    if (t){ e.preventDefault(); closeDrawer(); t.scrollIntoView({behavior:'smooth', block:'start'}); }
  });
});

// ── Validation helpers (telefone, e-mail) ──────────────────────────────────
var VALID_DDDS=[11,12,13,14,15,16,17,18,19,21,22,24,27,28,31,32,33,34,35,37,38,41,42,43,44,45,46,47,48,49,51,53,54,55,61,62,63,64,65,66,67,68,69,71,73,74,75,77,79,81,82,83,84,85,86,87,88,89,91,92,93,94,95,96,97,98,99];
function maskPhone(raw){var d=raw.replace(/\D/g,'').slice(0,11);if(!d.length)return'';if(d.length<=2)return'('+d;if(d.length<=6)return'('+d.slice(0,2)+') '+d.slice(2);if(d.length<=10)return'('+d.slice(0,2)+') '+d.slice(2,6)+'-'+d.slice(6);return'('+d.slice(0,2)+') '+d.slice(2,7)+'-'+d.slice(7);}
function validatePhone(masked){var d=masked.replace(/\D/g,'');if(d.length<10)return'Número muito curto';var ddd=parseInt(d.slice(0,2));if(!VALID_DDDS.includes(ddd))return'DDD '+ddd+' inválido';if(d.length===11&&d[2]!=='9')return'Celular deve começar com 9';return null;}
function validateEmail(email){return/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)?null:'E-mail inválido';}
function showErr(id,msg){var el=document.getElementById('err-'+id);if(!el)return;el.textContent='⚠ '+msg;el.classList.add('show');var inp=document.getElementById('f-'+id);if(inp){inp.classList.add('invalid');inp.classList.remove('valid');}}
function clearErr(id){var el=document.getElementById('err-'+id);if(el)el.classList.remove('show');var inp=document.getElementById('f-'+id);if(inp)inp.classList.remove('invalid');}
function showOk(id){var el=document.getElementById('ok-'+id);if(el)el.classList.add('show');var inp=document.getElementById('f-'+id);if(inp){inp.classList.add('valid');inp.classList.remove('invalid');}}
function clearOk(id){var el=document.getElementById('ok-'+id);if(el)el.classList.remove('show');}

var waInput = document.getElementById('f-whats');
if (waInput){
  waInput.addEventListener('input', function(){
    this.value = maskPhone(this.value);
    var d = this.value.replace(/\D/g,'');
    clearErr('whats'); clearOk('whats');
    if (d.length>=10){ var err=validatePhone(this.value); if (err) showErr('whats',err); else showOk('whats'); }
  });
  waInput.addEventListener('blur', function(){
    if (this.value){ var err=validatePhone(this.value); if (err) showErr('whats',err); else showOk('whats'); }
  });
}
var emailInput = document.getElementById('f-email');
if (emailInput){
  emailInput.addEventListener('blur', function(){
    if (this.value){ var err=validateEmail(this.value); if (err) showErr('email',err); else clearErr('email'); }
  });
  emailInput.addEventListener('input', function(){
    var errEl = document.getElementById('err-email');
    if (errEl && errEl.classList.contains('show')){
      var err=validateEmail(this.value); if (!err) clearErr('email');
    }
  });
}
function onAreaChange(){
  var sel=document.getElementById('f-area'); var hint=document.getElementById('hint-area');
  if (!sel || !hint) return;
  clearErr('area');
  if (sel.value){
    var parts=sel.value.split('|'); var ncl=parts[1];
    if (ncl && ncl.trim()){ hint.textContent='Classe NCL correspondente: '+ncl; hint.classList.add('show'); }
    else if (parts[0].includes('Outro')){ hint.textContent='Você poderá especificar no WhatsApp.'; hint.classList.add('show'); }
    else hint.classList.remove('show');
  } else hint.classList.remove('show');
}

// ── Multi-step form ────────────────────────────────────────────────────────
function fcGoTo(step){
  [1,2,3].forEach(function(s){
    var panel=document.getElementById('fc-step-'+s); var dot=document.getElementById('fc-dot-'+s);
    if (!panel||!dot) return;
    panel.classList.toggle('fc-active', s===step);
    dot.classList.remove('active','done');
    if (s<step) dot.classList.add('done'); else if (s===step) dot.classList.add('active');
  });
  var labels={1:'Verificação gratuita — Passo 1 de 3',2:'Seus dados — Passo 2 de 3',3:'Objetivo — Passo 3 de 3'};
  var lbl=document.getElementById('fc-step-label'); if (lbl) lbl.textContent=labels[step]||'';
}
function fcNext(fromStep){
  if (fromStep===1){
    var ok=true;
    var marca=document.getElementById('f-marca').value.trim();
    if (!marca){showErr('marca','Informe o nome da marca');ok=false;} else clearErr('marca');
    var areaVal=document.getElementById('f-area').value;
    if (!areaVal){showErr('area','Selecione sua área');ok=false;} else clearErr('area');
    if (!ok){var fe=document.querySelector('.fc-err.show'); if (fe) fe.scrollIntoView({behavior:'smooth',block:'center'}); return;}
    fcGoTo(2);
    var fc=document.getElementById('form'); if (fc) fc.scrollIntoView({behavior:'smooth',block:'start'});
  } else if (fromStep===2){
    var ok2=true;
    var nome=document.getElementById('f-nome').value.trim();
    if (!nome){showErr('nome','Informe seu nome');ok2=false;} else clearErr('nome');
    var whats=document.getElementById('f-whats').value.trim();
    var wErr=validatePhone(whats);
    if (!whats){showErr('whats','Informe seu WhatsApp');ok2=false;}
    else if (wErr){showErr('whats',wErr);ok2=false;}
    else {clearErr('whats'); showOk('whats');}
    var email=document.getElementById('f-email').value.trim();
    var eErr=validateEmail(email);
    if (!email){showErr('email','Informe seu e-mail');ok2=false;}
    else if (eErr){showErr('email',eErr);ok2=false;}
    else clearErr('email');
    if (!ok2){var fe2=document.querySelector('.fc-err.show'); if (fe2) fe2.scrollIntoView({behavior:'smooth',block:'center'}); return;}
    fcGoTo(3);
    var fc2=document.getElementById('form'); if (fc2) fc2.scrollIntoView({behavior:'smooth',block:'start'});
  }
}
function fcBack(fromStep){ fcGoTo(fromStep-1); var fc=document.getElementById('form'); if (fc) fc.scrollIntoView({behavior:'smooth',block:'start'}); }
function enviarWA(){
  var valid=true;
  var objetivo=document.getElementById('f-objetivo').value;
  if (!objetivo){showErr('objetivo','Selecione seu objetivo');valid=false;} else clearErr('objetivo');
  if (!valid) return;
  var nome=document.getElementById('f-nome').value.trim();
  var whats=document.getElementById('f-whats').value.trim();
  var email=document.getElementById('f-email').value.trim();
  var marca=document.getElementById('f-marca').value.trim();
  var areaVal=document.getElementById('f-area').value;
  var areaParts=areaVal.split('|');
  var areaNome=areaParts[0];
  var nclVal=areaParts[1];
  var nclInfo=nclVal&&nclVal.trim()?' (NCL: '+nclVal+')':'';
  var msg=['Olá! Quero uma pesquisa de viabilidade de marca.','','*Nome:* '+nome,'*WhatsApp:* '+whats,'*E-mail:* '+email,'*Nome da marca:* '+marca,'*Área de atividade:* '+areaNome+nclInfo,'*Objetivo:* '+objetivo,'','*Origem:* '+LP_SLUG].join('\n');
  if (typeof gtag === 'function') { try { gtag('event','lp_form_submit',{lp_audience:LP_SLUG}); } catch(e){} }
  window.open('https://wa.me/5548984283696?text='+encodeURIComponent(msg),'_blank');
  document.getElementById('fc-main').style.display='none';
  document.getElementById('fc-success').style.display='block';
}
function resetForm(){
  ['nome','whats','email','marca'].forEach(function(id){var el=document.getElementById('f-'+id); if (el) el.value=''; clearErr(id); clearOk(id);});
  var a=document.getElementById('f-area'); if (a) a.value='';
  var o=document.getElementById('f-objetivo'); if (o) o.value='';
  var h=document.getElementById('hint-area'); if (h) h.classList.remove('show');
  var m=document.getElementById('fc-main'); if (m) m.style.display='block';
  var s=document.getElementById('fc-success'); if (s) s.style.display='none';
  fcGoTo(1);
}

// ── Search widget ──────────────────────────────────────────────────────────
var genericTerms=['empresa','brasil','store','shop','digital','online','tech','solutions','group','service','serviços','comercio','comercial','nacional','internacional','global','universal','geral','central','prime','plus','pro','max','top','super','mega','ultra','brazil','click','web','net','info','br','ltda','eireli','mei'];
var famousMarks=['nike','adidas','apple','google','amazon','microsoft','samsung','sony','netflix','uber','ifood','magalu','natura','boticario','havaianas','hering','reserva','arezzo','vivo','claro','tim','bradesco','itau','nubank','inter','xp','ambev','brahma','skol','coca','pepsi','mcdonalds','burger','starbucks','disney','facebook','instagram','tiktok','youtube','whatsapp','spotify','mercadolivre','shopee','shein'];
var _lastBrandAnalysis={name:'',result:'',score:0,area:''};
var _searchDebounce=null;

function analyzeBrand(v){
  var lo=v.toLowerCase().replace(/[àáâãä]/g,'a').replace(/[èéêë]/g,'e').replace(/[ìíîï]/g,'i').replace(/[òóôõö]/g,'o').replace(/[ùúûü]/g,'u').replace(/[ç]/g,'c');
  var words=lo.split(/\s+/);
  var score=100; var issues=[]; var outcome='ok';
  if (/^\d+$/.test(v)) return{score:5,outcome:'bad',msg:'Só números — o INPI não registra marcas exclusivamente numéricas.',detail:'Entre em contato para avaliar alternativas com nosso especialista.'};
  if (v.length<3) return{score:10,outcome:'bad',msg:'Nome muito curto — o INPI exige distintividade mínima.',detail:'Nomes com menos de 3 caracteres raramente são aceitos sem estudo específico.'};
  var hasFamous=famousMarks.some(function(m){return lo.includes(m)||m.includes(lo.replace(/\s/g,''));});
  if (hasFamous){score-=60; issues.push('semelhante a marca famosa registrada');}
  if (/^[A-Z]{2,3}$/.test(v)){score-=30; issues.push('sigla pura — alta concorrência na base do INPI');}
  if (v.length>40){score-=20; issues.push('nome muito longo ('+v.length+' caracteres)');}
  if (/[!@#$%^&*()\[\]{}|\\<>\/]/.test(v)){score-=20; issues.push('contém caracteres especiais questionáveis');}
  var allGeneric=words.every(function(w){return genericTerms.includes(w);});
  if (allGeneric){score-=50; issues.push('composto apenas por termos genéricos');}
  else { var hasGeneric=words.some(function(w){return genericTerms.includes(w);}); if (hasGeneric){score-=20; issues.push('contém termos de uso comum');} }
  var areaSel=document.getElementById('search-area');
  var areaVal=areaSel?areaSel.value:'';
  if (areaVal){
    var sectorGenerics={'41':['escola','curso','aula','ensino','treino','training','academy','edu'],'44':['clinica','saude','medico','farma','care','health','wellness'],'35':['marketing','agencia','solucoes','consultoria','business'],'42':['tech','software','digital','app','sistemas','data'],'36':['investimento','financas','bank','capital','credito']};
    var ncl=(areaVal.split('|')[1]||'').split(',');
    ncl.forEach(function(cl){var sg=sectorGenerics[cl.trim()]; if (sg && words.some(function(w){return sg.includes(w);})){score-=15; issues.push('termo genérico no setor selecionado');}});
  }
  score=Math.max(5,Math.min(100,score));
  if (score>=75) outcome='ok'; else if (score>=45) outcome='warn'; else outcome='bad';
  var detail=''; if (issues.length) detail='Pontos de atenção: '+issues.join('; ')+'.';
  var msg='';
  if (outcome==='ok') msg='<strong>"'+v+'"</strong> tem boa distintividade. Próximo passo: verificar anterioridade na base oficial do INPI.';
  else if (outcome==='warn') msg='<strong>"'+v+'"</strong> tem distintividade moderada — é registrável, mas exige estratégia específica na especificação.';
  else msg='<strong>"'+v+'"</strong> pode ter dificuldades no INPI. Recomendamos consulta antes do protocolo.';
  if (areaVal){var parts=areaVal.split('|'); var ncl2=parts[1]; if (ncl2) detail+=(detail?' ':'')+' Classe NCL sugerida: <strong>'+ncl2+'</strong>.';}
  return {score:score, outcome:outcome, msg:msg, detail:detail};
}

var _loadingMsgs=['Verificando comprimento e estrutura…','Checando termos genéricos…','Analisando distintividade…','Consultando critérios INPI…'];
function buscarMarca(){
  var inp=document.getElementById('search-input'); if (!inp) return;
  var v=inp.value.trim();
  var r=document.getElementById('sres');
  var loading=document.getElementById('sres-loading');
  var loadingTxt=document.getElementById('sres-loading-txt');
  var gate=document.getElementById('sgate');
  var brandSpan=document.getElementById('sgate-brand-name');
  if (gate) gate.classList.remove('sg-visible');
  var thanks=document.getElementById('sgate-thanks'); if (thanks) thanks.classList.remove('show');
  var gateErr=document.getElementById('sgate-err'); if (gateErr) gateErr.classList.remove('show');
  var sgw=document.getElementById('sgate-whats'); if (sgw){sgw.value=''; sgw.disabled=false;}
  var sgn=document.getElementById('sgate-name'); if (sgn){sgn.value=''; sgn.disabled=false;}
  var btn2=document.querySelector('#sgate .sgate-row button'); if (btn2) btn2.disabled=false;
  if (!v){ if (r) r.className='sres'; if (loading) loading.classList.remove('on'); return; }
  if (r) r.className='sres';
  if (loading) loading.classList.add('on');
  var msgIdx=0;
  var msgInterval=setInterval(function(){msgIdx=(msgIdx+1)%_loadingMsgs.length; if (loadingTxt) loadingTxt.textContent=_loadingMsgs[msgIdx];},400);
  if (typeof gtag === 'function') { try { gtag('event','lp_search',{lp_audience:LP_SLUG, brand_name:v}); } catch(e){} }
  setTimeout(function(){
    clearInterval(msgInterval);
    if (loading) loading.classList.remove('on');
    var res=analyzeBrand(v);
    _lastBrandAnalysis.name=v; _lastBrandAnalysis.result=res.outcome; _lastBrandAnalysis.score=res.score;
    var areaSelEl=document.getElementById('search-area'); _lastBrandAnalysis.area=areaSelEl?areaSelEl.value:'';
    var barColor=res.score>=75?'#16a34a':res.score>=45?'#d97706':'#dc2626';
    if (r){
      r.className='sres '+(res.outcome==='ok'?'ok':res.outcome==='warn'?'warn':'bad')+' on';
      r.innerHTML=res.msg
        +'<div class="sres-score"><div class="sres-bar-wrap"><div class="sres-bar" style="width:'+res.score+'%;background:'+barColor+'"></div></div><span class="sres-score-num" style="color:'+barColor+'">'+res.score+'/100</span></div>'
        +(res.detail?'<div class="sres-detail">'+res.detail+'</div>':'');
    }
    if ((res.outcome==='ok'||res.outcome==='warn') && gate){
      if (brandSpan) brandSpan.textContent='"'+v+'"';
      gate.classList.add('sg-visible');
      if (gateErr) gateErr.classList.remove('show');
      if (sgw && !sgw._masked){sgw._masked=true; sgw.addEventListener('input',function(){this.value=maskPhone(this.value);});}
    }
  },1600);
}
var _searchInputEl=document.getElementById('search-input');
if (_searchInputEl){
  _searchInputEl.addEventListener('input', function(){
    clearTimeout(_searchDebounce);
    var v=this.value.trim();
    if (v.length<2){var rEl=document.getElementById('sres'); if (rEl) rEl.className='sres'; var ld=document.getElementById('sres-loading'); if (ld) ld.classList.remove('on'); var gt=document.getElementById('sgate'); if (gt) gt.classList.remove('sg-visible'); return;}
    _searchDebounce=setTimeout(buscarMarca,700);
  });
  _searchInputEl.addEventListener('keydown', function(e){ if (e.key==='Enter'){ clearTimeout(_searchDebounce); buscarMarca(); } });
}
function sgateSubmit(){
  var whatsEl=document.getElementById('sgate-whats');
  var nameEl=document.getElementById('sgate-name');
  var errEl=document.getElementById('sgate-err');
  var thanksEl=document.getElementById('sgate-thanks');
  if (!whatsEl) return;
  var whats=whatsEl.value.trim();
  var wErr=validatePhone(whats);
  if (!whats||wErr){if (errEl){errEl.textContent='⚠ '+(wErr||'Informe seu WhatsApp'); errEl.classList.add('show');} return;}
  if (errEl) errEl.classList.remove('show');
  var brandName=_lastBrandAnalysis.name;
  var score=_lastBrandAnalysis.score;
  var areaInfo=_lastBrandAnalysis.area?(' | Ramo: '+_lastBrandAnalysis.area.split('|')[0]):'';
  var nameInfo=nameEl&&nameEl.value.trim()?nameEl.value.trim():'';
  var intro=nameInfo?'Olá, sou '+nameInfo+'! ':'Olá! ';
  var msg=intro+'Analisei a marca "'+brandName+'" (score '+score+'/100'+areaInfo+', origem: '+LP_SLUG+') e quero fazer a busca de anterioridade no INPI. Pode me ajudar?';
  if (typeof gtag === 'function') { try { gtag('event','lp_sgate_submit',{lp_audience:LP_SLUG, score:score}); } catch(e){} }
  window.open('https://wa.me/5548984283696?text='+encodeURIComponent(msg),'_blank');
  if (whatsEl) whatsEl.disabled=true;
  if (nameEl) nameEl.disabled=true;
  var btn=document.querySelector('#sgate .sgate-row button'); if (btn) btn.disabled=true;
  if (thanksEl) thanksEl.classList.add('show');
}

// ── Logo wall marquee ──────────────────────────────────────────────────────
(function(){
  var track=document.getElementById('lw-track'); if (!track) return;
  var brands=['Müsy','Pangea','Café On TV','Soletra+','Helpers Education','QStarts','IACES Brasil','Capeia Azul','Mináguas','Bless Music','Musy Records','Agathos Editora','AGT Produtora','Grupo Agathos','Auset','BizuCash','Capoeira D\'Tomé','Djiele','Liquida Itaperuna','Agathos Play','Beer Beard Club','Art\'s Empire','Angion Clínica','Futura Supermercados'];
  for (var i=brands.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1)); var tmp=brands[i]; brands[i]=brands[j]; brands[j]=tmp;}
  var html=''; var set=brands.concat(brands);
  set.forEach(function(b){ html+='<span class="lw-item">'+b+'</span><span class="lw-dot">·</span>'; });
  track.innerHTML=html;
})();

// ── FAQ tabs + entries ──────────────────────────────────────────────────────
function setupFaq(btnSelector,filterSync){
  document.querySelectorAll(btnSelector).forEach(function(btn){
    btn.addEventListener('click', function(){
      var cat=btn.dataset.cat;
      document.querySelectorAll(btnSelector).forEach(function(b){b.classList.remove('on');});
      btn.classList.add('on');
      if (filterSync) filterSync(cat);
      document.querySelectorAll('#faq-acc .fg').forEach(function(g){g.style.display=(cat==='all'||g.dataset.cat===cat)?'':'none';});
      document.querySelectorAll('.fe.on').forEach(function(e){e.classList.remove('on');});
    });
  });
}
setupFaq('#faq-cats-desktop .faq-cb', function(cat){ document.querySelectorAll('.faq-cm-btn').forEach(function(b){b.classList.toggle('on', b.dataset.cat===cat);}); });
setupFaq('.faq-cm-btn', function(cat){ document.querySelectorAll('.faq-cb').forEach(function(b){b.classList.toggle('on', b.dataset.cat===cat);}); });
document.querySelectorAll('.ft').forEach(function(ft){
  ft.addEventListener('click', function(){
    var entry=ft.closest('.fe'); var open=entry.classList.contains('on');
    document.querySelectorAll('.fe.on').forEach(function(e){e.classList.remove('on');});
    if (!open) entry.classList.add('on');
  });
});

// ── Modais (privacidade, termos, cookies, form) ────────────────────────────
function openModal(id){var el=document.getElementById(id); if (!el) return; el.classList.add('open'); document.body.style.overflow='hidden';}
function closeModalById(id){var el=document.getElementById(id); if (!el) return; el.classList.remove('open'); document.body.style.overflow='';}
function closeModal(e,overlay){if (e.target===overlay) closeModalById(overlay.id);}
function openFormModal(){var m=document.getElementById('form-modal'); if (m){m.classList.add('open'); document.body.style.overflow='hidden';}}
function closeFormModal(){
  var m=document.getElementById('form-modal'); if (!m) return;
  m.classList.remove('open');
  var dr=document.getElementById('drawer');
  var drawerOpen=dr&&dr.classList.contains('open');
  var modalOpen=document.querySelector('.modal-overlay.open');
  if (!drawerOpen && !modalOpen) document.body.style.overflow='';
}
var _formModalEl=document.getElementById('form-modal');
if (_formModalEl){
  _formModalEl.addEventListener('click', function(e){ if (e.target===this) closeFormModal(); });
}
document.addEventListener('keydown', function(e){
  if (e.key==='Escape'){
    document.querySelectorAll('.modal-overlay.open').forEach(function(m){m.classList.remove('open'); document.body.style.overflow='';});
    closeFormModal(); closeExitPopup();
  }
});

// ── Sticky urgency counter ─────────────────────────────────────────────────
(function(){
  var COUNT_KEY='hm_verify_count'; var LAST_INC_KEY='hm_last_inc'; var INC_MS=8*60*1000;
  var stored=parseInt(sessionStorage.getItem(COUNT_KEY),10);
  var count=isNaN(stored)?47:stored;
  function updateDisplay(){var el=document.getElementById('sticky-count'); if (el) el.textContent=count;}
  function maybeInc(){var last=parseInt(sessionStorage.getItem(LAST_INC_KEY),10); var now=Date.now(); if (isNaN(last)||(now-last)>=INC_MS){count++; sessionStorage.setItem(COUNT_KEY,count); sessionStorage.setItem(LAST_INC_KEY,now); updateDisplay();}}
  updateDisplay();
  setInterval(maybeInc, INC_MS);
})();

// ── Social proof toast ─────────────────────────────────────────────────────
(function(){
  var MESSAGES=['🟢 Andrea, de São Paulo, acabou de solicitar verificação','🟢 Carlos, do Rio de Janeiro, iniciou seu registro','🟢 Mariana, de Curitiba, verificou a disponibilidade da marca','🟢 Paulo, de Belo Horizonte, acabou de contratar','🟢 Fernanda, de Porto Alegre, está verificando sua marca agora','🟢 Rafael, de Brasília, acabou de proteger sua marca','🟢 Camila, de Florianópolis, solicitou a pesquisa de viabilidade','🟢 Diego, de Salvador, iniciou o registro do seu canal','🟢 Juliana, de Recife, recebeu a confirmação do pedido','🟢 Thiago, de Campinas, acabou de contratar o registro','🟢 Larissa, de Goiânia, verificou a disponibilidade agora','🟢 Bruno, de Manaus, protegeu sua marca de cursos online'];
  var idx=Math.floor(Math.random()*MESSAGES.length); var dismissed=false;
  var toast=document.createElement('div'); toast.className='sp-toast'; toast.setAttribute('role','status'); toast.setAttribute('aria-live','polite');
  var closeBtn=document.createElement('button'); closeBtn.className='sp-toast-close'; closeBtn.textContent='✕'; closeBtn.setAttribute('aria-label','Fechar');
  closeBtn.addEventListener('click', function(){dismissed=true; hide();});
  var msgSpan=document.createElement('span'); toast.appendChild(msgSpan); toast.appendChild(closeBtn);
  document.body.appendChild(toast);
  function show(){if (dismissed) return; msgSpan.textContent=MESSAGES[idx%MESSAGES.length]; idx++; toast.classList.add('sp-visible'); setTimeout(hide,6000);}
  function hide(){toast.classList.remove('sp-visible');}
  setTimeout(show,15000);
  setInterval(function(){if (!dismissed) show();},90000);
})();

// ── Exit-intent popup ──────────────────────────────────────────────────────
(function(){
  var SESSION_KEY='hm_exit_shown';
  if (sessionStorage.getItem(SESSION_KEY)) return;
  var popup=document.getElementById('exit-popup'); if (!popup) return;
  var triggered=false; var mobileTimer=null;
  function showPopup(){
    if (triggered) return;
    triggered=true; sessionStorage.setItem(SESSION_KEY,'1');
    setTimeout(function(){popup.classList.add('exit-open'); document.body.style.overflow='hidden'; var fi=document.getElementById('exit-nome'); if (fi) fi.focus();},1000);
  }
  document.addEventListener('mouseleave', function(e){if (e.clientY<10) showPopup();});
  function resetMobile(){clearTimeout(mobileTimer); mobileTimer=setTimeout(showPopup,30000);}
  if ('ontouchstart' in window){['touchstart','touchmove','touchend','scroll'].forEach(function(ev){document.addEventListener(ev,resetMobile,{passive:true});}); resetMobile();}
  popup.addEventListener('click', function(e){if (e.target===popup) closeExitPopup();});
  var closeBtn=document.getElementById('exit-close-btn'); if (closeBtn) closeBtn.addEventListener('click', closeExitPopup);
  var exitW=document.getElementById('exit-whats'); if (exitW) exitW.addEventListener('input', function(){this.value=maskPhone(this.value);});
})();
function closeExitPopup(){
  var popup=document.getElementById('exit-popup'); if (popup) popup.classList.remove('exit-open');
  var dr=document.getElementById('drawer'); var drawerOpen=dr&&dr.classList.contains('open');
  var modalOpen=document.querySelector('.modal-overlay.open');
  if (!drawerOpen && !modalOpen) document.body.style.overflow='';
}
function exitSubmit(){
  var nameEl=document.getElementById('exit-nome');
  var whatsEl=document.getElementById('exit-whats');
  var errName=document.getElementById('exit-err-nome');
  var errWhats=document.getElementById('exit-err-whats');
  if (!nameEl||!whatsEl) return;
  var valid=true;
  var name=nameEl.value.trim();
  if (!name){if (errName){errName.textContent='⚠ Informe seu nome'; errName.classList.add('show');} nameEl.style.borderColor='#dc2626'; valid=false;}
  else {if (errName) errName.classList.remove('show'); nameEl.style.borderColor='';}
  var whats=whatsEl.value.trim();
  var wErr=validatePhone(whats);
  if (!whats){if (errWhats){errWhats.textContent='⚠ Informe seu WhatsApp'; errWhats.classList.add('show');} whatsEl.style.borderColor='#dc2626'; valid=false;}
  else if (wErr){if (errWhats){errWhats.textContent='⚠ '+wErr; errWhats.classList.add('show');} whatsEl.style.borderColor='#dc2626'; valid=false;}
  else {if (errWhats) errWhats.classList.remove('show'); whatsEl.style.borderColor='';}
  if (!valid) return;
  var msg='🔴 [EXIT] Nome: '+name+' | WhatsApp: '+whats+' | Origem: '+LP_SLUG+' | Solicitou verificação de urgência';
  if (typeof gtag === 'function') { try { gtag('event','lp_exit_submit',{lp_audience:LP_SLUG}); } catch(e){} }
  window.open('https://wa.me/5548984283696?text='+encodeURIComponent(msg),'_blank');
  closeExitPopup();
}
