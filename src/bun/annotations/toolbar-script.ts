// Returns the self-contained annotation toolbar injected into the page via the proxy HTML wrapper.
// Uses shadow DOM so styles never bleed. Features: multi-annotation queue, numbered pins,
// edit/delete per annotation, navigation interception to preserve toolbar across page changes.
// Project + conversation IDs are baked in at injection time — no user selectors.
export function getToolbarScript(port: number, projectId: string, conversationId: string): string {
	return `
(function(){
if(document.getElementById('__ad_host'))return;

var PORT=${port},PROJ='${projectId}',CONV='${conversationId}';
var BASE='http://localhost:'+PORT;
var PROXY=BASE+'/preview';

// ── Navigation interception ──────────────────────────────────────────────────
// Redirect local link clicks through the proxy so the toolbar survives navigation.
// Handles both http://localhost:* and file:// links (multi-page static sites).
document.addEventListener('click',function(e){
  var a=e.target.closest('a[href]');
  if(!a)return;
  var href=a.getAttribute('href')||'';
  if(!href||href[0]==='#'||href.startsWith('javascript:'))return;
  try{
    var abs=new URL(href,document.baseURI).href;
    var isLocal=/^https?:\\/\\/localhost(:\\d+)?/.test(abs);
    var isFile=abs.startsWith('file://');
    if(isLocal||isFile){
      e.preventDefault();
      location.href=PROXY+'?url='+encodeURIComponent(abs)+'&project='+encodeURIComponent(PROJ)+'&conv='+encodeURIComponent(CONV)+'&enableAnnotation=1';
    }
  }catch(err){}
},true);

// ── State ────────────────────────────────────────────────────────────────────
var queue=[];      // {id,sel,elText,bounds,comment,pinEl}
var nid=1;
var picking=false;
var editId=null;   // id being edited, or null for new
var collapsed=false;

// ── Shadow host ──────────────────────────────────────────────────────────────
// Anchored to <html> rather than <body> so a transformed/filtered body cannot
// turn our position:fixed into position:absolute.
// 'contain:none' and 'will-change:auto' prevent those properties on the host
// itself from creating a new stacking context that a page element could paint over.
var host=document.createElement('div');
host.id='__ad_host';
host.style.cssText='all:initial!important;position:fixed!important;bottom:24px!important;right:24px!important;'+
  'top:auto!important;left:auto!important;transform:none!important;filter:none!important;'+
  'z-index:2147483647!important;font-size:0!important;'+
  'contain:none!important;will-change:auto!important;isolation:auto!important;'+
  /* Never let a frameless/app-region window treat a drag on the toolbar as a
     window-move — the header implements its own pointer drag below. */
  '-webkit-app-region:no-drag!important;';
var sd=host.attachShadow({mode:'open'});
var _root=document.documentElement||document.body;
_root.appendChild(host);

// ── DOM guardian ─────────────────────────────────────────────────────────────
// SPAs that replace the full DOM tree can silently remove injected nodes.
// Re-append the host (and overlay) whenever they're disconnected.
var _guardInterval=setInterval(function(){
  if(!host.isConnected){
    var r=document.documentElement||document.body;
    r.appendChild(host);
  }
  if(!ov.isConnected){
    var r2=document.documentElement||document.body;
    r2.appendChild(ov);
  }
},1000);

// ── Overlay (element highlight) ──────────────────────────────────────────────
// Anchored to <html> (same as host) so a transformed body can't trap it.
var ov=document.createElement('div');
ov.style.cssText='position:fixed!important;pointer-events:none;z-index:2147483646;display:none;'+
  'outline:2px solid #6366f1;background:rgba(99,102,241,.08);border-radius:2px;'+
  'transition:top .07s,left .07s,width .07s,height .07s;'+
  'contain:none!important;will-change:auto!important;';
(document.documentElement||document.body).appendChild(ov);

function showOv(el){
  if(!el||el===document.body){ov.style.display='none';return;}
  var r=el.getBoundingClientRect();
  ov.style.display='block';
  ov.style.top=r.top+'px'; ov.style.left=r.left+'px';
  ov.style.width=r.width+'px'; ov.style.height=r.height+'px';
}

// ── CSS path ─────────────────────────────────────────────────────────────────
function cssPath(el){
  var parts=[],cur=el;
  while(cur&&cur.nodeType===1&&cur!==document.body){
    var tag=cur.tagName.toLowerCase();
    if(cur.id){parts.unshift(tag+'#'+cur.id);break;}
    var cls=Array.prototype.slice.call(cur.classList,0,2).join('.');
    var part=cls?tag+'.'+cls:tag;
    var sibs=cur.parentElement?
      Array.prototype.filter.call(cur.parentElement.children,function(c){return c.tagName===cur.tagName;}):[];
    if(sibs.length>1)part+=':nth-of-type('+(sibs.indexOf(cur)+1)+')';
    parts.unshift(part); cur=cur.parentElement;
  }
  return parts.join(' > ')||el.tagName.toLowerCase();
}

// ── Styles ───────────────────────────────────────────────────────────────────
var css=document.createElement('style');
css.textContent=[
  /* Cross-platform built-in font cascade — no web fonts.
     macOS/iOS: -apple-system + BlinkMacSystemFont resolve to SF Pro Text.
     Windows:   "Segoe UI" (NOT the Variable build, which can render with
                broken-looking glyphs at small sizes).
     Android:   Roboto.
     Linux:     "Liberation Sans" / "DejaVu Sans" / generic sans-serif. */
  ':host{all:initial;display:block;font-size:14px;-webkit-font-smoothing:antialiased;',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Liberation Sans",sans-serif;}',
  '*{box-sizing:border-box;margin:0;padding:0;}',
  /* In Chromium, button/input/textarea elements do NOT inherit font from their
     shadow-DOM host — they use the browser form-control font instead. One rule
     here fixes every button and text input in the toolbar at once. */
  'button,input,textarea,select{font:inherit;}',

  /* Monospace cascade — Cascadia Mono (Win11), Consolas (Win), Menlo (mac),
     DejaVu Sans Mono (Linux), then generic. All ship with their OS so the
     selector chip is guaranteed a clean, fixed-width fallback. */
  '.mono{font-family:"Cascadia Mono",Consolas,Menlo,"DejaVu Sans Mono","Courier New",monospace;}',

  /* Panel */
  '#panel{background:#0f172a;color:#cbd5e1;border-radius:12px;width:360px;',
    'box-shadow:0 12px 40px rgba(0,0,0,.7),0 0 0 1px rgba(255,255,255,.06);',
    'overflow:hidden;display:flex;flex-direction:column;}',
  '#panel.hidden{display:none;}',

  /* Header */
  /* cursor:move + no text selection signals the header is the drag handle;
     touch-action:none lets pointer drag work without the browser hijacking it
     for scroll/zoom gestures. */
  '#hdr{display:flex;align-items:center;gap:8px;padding:11px 13px;cursor:move;',
    'user-select:none;-webkit-user-select:none;touch-action:none;',
    'background:#0a1120;border-bottom:1px solid rgba(255,255,255,.06);}',
  /* Buttons inside the header keep a normal pointer and never start a drag. */
  '#hdr .hdr-btn{cursor:pointer;}',
  '#hdr-icon{font-size:16px;color:#6366f1;}',
  '#hdr-title{flex:1;font-size:14px;font-weight:600;color:#e2e8f0;letter-spacing:.2px;}',
  '#badge{background:#6366f1;color:#fff;border-radius:999px;font-size:13px;font-weight:700;',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;',
    'line-height:1;padding:3px 8px;min-width:22px;text-align:center;display:none;}',
  '#badge.show{display:inline-flex;align-items:center;justify-content:center;}',
  /* Min / close buttons — pure white + semi-bold so the thin ✕ / − glyphs
     have enough visual mass against the dark #0a1120 header. */
  '.hdr-btn{background:none;border:none;cursor:pointer;color:#ffffff;font-weight:600;',
    'padding:4px 7px;border-radius:5px;font-size:15px;line-height:1;',
    'transition:color .15s,background .15s;}',
  '.hdr-btn:hover{background:rgba(255,255,255,.15);}',

  /* Body */
  '#body{padding:12px 13px;display:flex;flex-direction:column;gap:10px;',
    'max-height:500px;overflow-y:auto;}',

  /* Add btn */
  '#add-btn{display:flex;align-items:center;justify-content:center;gap:6px;',
    'background:#1e293b;border:1px dashed #334155;color:#94a3b8;border-radius:8px;',
    'padding:10px 14px;cursor:pointer;font-size:14px;transition:all .15s;width:100%;}',
  '#add-btn:hover,#add-btn.active{background:#1e1b4b;border-color:#6366f1;color:#a5b4fc;}',

  /* Queue list */
  '#queue{display:flex;flex-direction:column;gap:7px;}',
  '.ann-item{background:#1e293b;border:1px solid #334155;border-radius:8px;overflow:hidden;',
    'transition:border-color .15s;}',
  '.ann-item:hover{border-color:#475569;}',
  '.ann-top{display:flex;align-items:flex-start;gap:9px;padding:9px 11px;}',
  '.ann-num{background:#6366f1;color:#fff;border-radius:999px;font-size:12px;font-weight:700;',
    'min-width:22px;height:22px;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;}',
  '.ann-info{flex:1;min-width:0;}',
  /* Bright color (indigo-300) on dark slate — high contrast for the selector path.
     Mono font + 12px size makes the CSS selector legible without truncation pain. */
  '.ann-sel{font-size:12px;color:#a5b4fc;font-family:"Cascadia Mono",Consolas,Menlo,"DejaVu Sans Mono",monospace;',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:4px;}',
  '.ann-comment{font-size:13px;color:#e2e8f0;line-height:1.5;word-break:break-word;}',
  '.ann-actions{display:flex;gap:5px;padding:0 11px 9px;justify-content:flex-end;}',
  '.act-btn{background:none;border:1px solid #334155;color:#94a3b8;border-radius:6px;',
    'font-size:12px;padding:4px 10px;cursor:pointer;transition:all .15s;}',
  '.act-btn:hover{border-color:#475569;color:#e2e8f0;}',
  '.act-btn.del:hover{border-color:#ef4444;color:#f87171;background:rgba(239,68,68,.08);}',

  /* Edit form (inline below ann list, or new) */
  '#edit-wrap{background:#1e293b;border:1px solid #6366f1;border-radius:8px;padding:11px;',
    'display:none;flex-direction:column;gap:9px;}',
  '#edit-wrap.open{display:flex;}',
  /* Same bright indigo + bigger mono font — the selector chip in the edit form
     is the one the user sees most often when adding a new annotation. */
  '#edit-sel{font-size:12px;color:#a5b4fc;font-family:"Cascadia Mono",Consolas,Menlo,"DejaVu Sans Mono",monospace;',
    'padding:6px 8px;background:#0f172a;border-radius:5px;word-break:break-all;line-height:1.5;}',
  '#edit-note{width:100%;background:#0f172a;border:1px solid #334155;color:#e2e8f0;',
    'border-radius:6px;padding:9px 11px;font-size:14px;line-height:1.5;resize:vertical;',
    'min-height:80px;outline:none;font-family:inherit;}',
  '#edit-note:focus{border-color:#6366f1;}',
  '#edit-row{display:flex;gap:7px;}',
  '#save-ann{flex:1;background:#6366f1;color:#fff;border:none;border-radius:7px;',
    'padding:9px 14px;font-size:14px;font-weight:600;cursor:pointer;transition:background .15s;}',
  '#save-ann:hover{background:#4f46e5;}',
  '#cancel-ann{background:#1e293b;border:1px solid #334155;color:#94a3b8;border-radius:7px;',
    'padding:9px 12px;font-size:14px;cursor:pointer;transition:all .15s;}',
  '#cancel-ann:hover{border-color:#475569;color:#e2e8f0;}',

  /* Footer */
  '#footer{padding:11px 13px;border-top:1px solid rgba(255,255,255,.06);',
    'display:flex;flex-direction:column;gap:8px;}',
  '#footer.hidden{display:none;}',
  '#submit-btn{background:#6366f1;color:#fff;border:none;border-radius:8px;',
    'padding:10px 14px;font-size:14px;font-weight:600;cursor:pointer;width:100%;',
    'transition:background .15s;}',
  '#submit-btn:hover:not(:disabled){background:#4f46e5;}',
  '#submit-btn:disabled{opacity:.45;cursor:not-allowed;}',
  '#status{font-size:13px;text-align:center;min-height:18px;padding-top:2px;}',

  /* Collapsed FAB */
  '#fab{display:none;align-items:center;justify-content:center;gap:6px;',
    'background:#6366f1;color:#fff;border-radius:999px;padding:11px 16px;',
    'cursor:pointer;font-size:14px;font-weight:600;',
    'box-shadow:0 4px 16px rgba(99,102,241,.5);border:none;',
    'transition:background .15s,transform .1s;}',
  '#fab:hover{background:#4f46e5;transform:translateY(-1px);}',
  '#fab.show{display:flex;}',
  '#fab-count{background:rgba(255,255,255,.25);border-radius:999px;',
    'font-size:12px;font-weight:700;padding:1px 7px;min-width:18px;text-align:center;}',
].join('');
sd.appendChild(css);

// ── Markup ───────────────────────────────────────────────────────────────────
var root=document.createElement('div');
root.innerHTML=
  '<div id="panel">'+
    '<div id="hdr">'+
      '<span id="hdr-icon">&#9998;</span>'+
      '<span id="hdr-title">AgentDesk Annotations</span>'+
      '<span id="badge"></span>'+
      '<button class="hdr-btn" id="collapse-btn" title="Minimise">&#8722;</button>'+
      '<button class="hdr-btn" id="close-btn" title="Close toolbar">&#10005;</button>'+
    '</div>'+
    '<div id="body">'+
      '<button id="add-btn">&#43;&nbsp; Add Annotation</button>'+
      '<div id="edit-wrap">'+
        '<div id="edit-sel"></div>'+
        '<textarea id="edit-note" placeholder="Describe the issue or requested change..."></textarea>'+
        '<div id="edit-row">'+
          '<button id="save-ann">Save</button>'+
          '<button id="cancel-ann">Cancel</button>'+
        '</div>'+
      '</div>'+
      '<div id="queue"></div>'+
    '</div>'+
    '<div id="footer" class="hidden">'+
      '<button id="submit-btn" disabled>Submit All</button>'+
      '<div id="status"></div>'+
    '</div>'+
  '</div>'+
  '<button id="fab"><span>&#9998;</span><span id="fab-count">0</span></button>';
sd.appendChild(root);

// ── Refs ──────────────────────────────────────────────────────────────────────
function $$(id){return sd.getElementById(id);}
var panel=$$('panel'),fab=$$('fab'),hdr=$$('hdr');
var addBtn=$$('add-btn'),collapseBtn=$$('collapse-btn'),closeBtn=$$('close-btn');
var editWrap=$$('edit-wrap'),editSel=$$('edit-sel'),editNote=$$('edit-note');
var saveAnn=$$('save-ann'),cancelAnn=$$('cancel-ann');
var queueEl=$$('queue');
var footer=$$('footer');
var submitBtn=$$('submit-btn'),statusEl=$$('status'),badge=$$('badge');
var fabCount=$$('fab-count');

// ── Pick state ────────────────────────────────────────────────────────────────
var pendingSel={},pendingEl=null;

function enterPick(){
  picking=true;
  addBtn.classList.add('active');
  addBtn.textContent='× Cancel Pick';
  document.body.style.cursor='crosshair';
}
function exitPick(){
  picking=false;
  addBtn.classList.remove('active');
  addBtn.textContent='＋  Add Annotation';
  document.body.style.cursor='';
  ov.style.display='none';
}

// ── Queue management ──────────────────────────────────────────────────────────
function addToQueue(sel,elText,bounds,comment,id){
  var ann={id:id||nid++,sel:sel,elText:elText,bounds:bounds,comment:comment,pinEl:null};
  if(id){
    var idx=queue.findIndex(function(a){return a.id===id;});
    if(idx>=0){removePinEl(queue[idx]);queue[idx]=ann;}
  } else {
    queue.push(ann);
  }
  createPin(ann);
  renderQueue();
}

function removeFromQueue(id){
  var idx=queue.findIndex(function(a){return a.id===id;});
  if(idx<0)return;
  removePinEl(queue[idx]);
  queue.splice(idx,1);
  renderQueue();
}

function removePinEl(ann){
  if(ann.pinEl&&ann.pinEl.parentNode)ann.pinEl.remove();
  ann.pinEl=null;
}

// ── Pins ──────────────────────────────────────────────────────────────────────
// position:fixed on <html> (not body) — immune to body transforms/filters.
// Coordinates come from getBoundingClientRect() which is already viewport-relative,
// so no scrollY/scrollX offset is needed.
function createPin(ann){
  var p=document.createElement('div');
  p.style.cssText='position:fixed!important;z-index:2147483645;width:20px;height:20px;border-radius:999px;'+
    'background:#6366f1;color:#fff;font-size:10px;font-weight:700;'+
    'display:flex;align-items:center;justify-content:center;cursor:pointer;'+
    'box-shadow:0 2px 8px rgba(99,102,241,.6);font-family:system-ui,sans-serif;'+
    'border:2px solid #fff;transition:transform .1s;contain:none!important;';
  p.title='Click to edit annotation';
  p.addEventListener('mouseenter',function(){p.style.transform='scale(1.15)';});
  p.addEventListener('mouseleave',function(){p.style.transform='';});
  p.addEventListener('click',function(e){e.stopPropagation();openEdit(ann.id);});
  ann.pinEl=p;
  (document.documentElement||document.body).appendChild(p);
  positionPin(ann);
}

function positionPin(ann){
  if(!ann.pinEl)return;
  var b=ann.bounds;
  // b.x / b.y are viewport-relative (from getBoundingClientRect); fixed positioning
  // uses the same coordinate space, so no scroll offset needed.
  ann.pinEl.style.top=(b.y-10)+'px';
  ann.pinEl.style.left=(b.x+b.w-10)+'px';
}

function renumberPins(){
  queue.forEach(function(ann,i){
    if(ann.pinEl)ann.pinEl.textContent=String(i+1);
  });
}

window.addEventListener('scroll',function(){queue.forEach(positionPin);},true);
window.addEventListener('resize',function(){queue.forEach(positionPin);});

// ── Render queue ──────────────────────────────────────────────────────────────
function renderQueue(){
  renumberPins();
  var count=queue.length;
  queueEl.innerHTML='';
  badge.textContent=count||'';
  badge.className=count?'show':'';
  fabCount.textContent=String(count);
  footer.className=count?'':'hidden';
  submitBtn.disabled=count===0;
  submitBtn.textContent='Submit All ('+count+')';

  queue.forEach(function(ann,i){
    var item=document.createElement('div');
    item.className='ann-item';
    var shortSel=ann.sel.length>40?ann.sel.slice(0,37)+'…':ann.sel;
    var shortCom=ann.comment.length>80?ann.comment.slice(0,77)+'…':ann.comment;
    item.innerHTML=
      '<div class="ann-top">'+
        '<div class="ann-num">'+(i+1)+'</div>'+
        '<div class="ann-info">'+
          '<div class="ann-sel" title="'+escH(ann.sel)+'">'+escH(shortSel)+'</div>'+
          '<div class="ann-comment">'+escH(shortCom)+'</div>'+
        '</div>'+
      '</div>'+
      '<div class="ann-actions">'+
        '<button class="act-btn edit-ann" data-id="'+ann.id+'">Edit</button>'+
        '<button class="act-btn del" data-id="'+ann.id+'">Delete</button>'+
      '</div>';
    queueEl.appendChild(item);
  });

  sd.querySelectorAll('.edit-ann').forEach(function(btn){
    btn.addEventListener('click',function(){openEdit(Number(btn.dataset.id));});
  });
  sd.querySelectorAll('.act-btn.del').forEach(function(btn){
    btn.addEventListener('click',function(){
      removeFromQueue(Number(btn.dataset.id));
      if(editId===Number(btn.dataset.id))closeEdit();
    });
  });
}

// ── Edit form ─────────────────────────────────────────────────────────────────
function openEdit(id){
  if(picking)exitPick();
  editId=id||null;
  var ann=id?queue.find(function(a){return a.id===id;}):null;
  editSel.textContent=ann?ann.sel:pendingSel.sel||'';
  editNote.value=ann?ann.comment:'';
  saveAnn.textContent=ann?'Update':'Add to Queue';
  editWrap.className='open';
  editNote.focus();
}
function closeEdit(){
  editId=null; pendingSel={}; pendingEl=null;
  editWrap.className=''; editNote.value='';
}

cancelAnn.addEventListener('click',closeEdit);

saveAnn.addEventListener('click',function(){
  var comment=editNote.value.trim();
  if(!comment){editNote.style.borderColor='#ef4444';setTimeout(function(){editNote.style.borderColor='';},1200);return;}
  if(editId){
    var ann=queue.find(function(a){return a.id===editId;});
    if(ann){ann.comment=comment;renderQueue();}
  } else if(pendingSel.sel){
    addToQueue(pendingSel.sel,pendingSel.elText,pendingSel.bounds,comment);
  }
  closeEdit();
});

// ── Pick events ───────────────────────────────────────────────────────────────
addBtn.addEventListener('click',function(){picking?exitPick():enterPick();});

document.addEventListener('mousemove',function(e){
  if(!picking)return;
  if(sd.contains(e.target)||e.target===host)return;
  showOv(e.target);
},true);

document.addEventListener('click',function(e){
  if(!picking)return;
  if(sd.contains(e.target)||e.target===host)return;
  e.preventDefault();e.stopPropagation();
  var el=e.target;
  var r=el.getBoundingClientRect();
  pendingSel={sel:cssPath(el),elText:(el.textContent||'').trim().slice(0,120),
    bounds:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}};
  pendingEl=el;
  exitPick();
  openEdit(null);
},true);

// ── Draggable header ──────────────────────────────────────────────────────────
// Reposition the whole host by dragging the header. The host is anchored
// bottom/right by default; on first drag we pin its current rect as top/left
// (with !important to beat the inline cssText) so it can move freely. Position
// is clamped to the viewport and persisted to localStorage so it survives the
// re-injection that happens on every page navigation (see preview-window.ts).
var POS_KEY='__ad_toolbar_pos';
function setHostPos(left,top){
  host.style.setProperty('left',left+'px','important');
  host.style.setProperty('top',top+'px','important');
  host.style.setProperty('right','auto','important');
  host.style.setProperty('bottom','auto','important');
}
function clampPos(left,top){
  var w=host.offsetWidth||360,h=host.offsetHeight||60;
  var maxL=Math.max(0,window.innerWidth-w),maxT=Math.max(0,window.innerHeight-h);
  return {left:Math.min(Math.max(0,left),maxL),top:Math.min(Math.max(0,top),maxT)};
}
function savePos(){
  try{
    var r=host.getBoundingClientRect();
    localStorage.setItem(POS_KEY,JSON.stringify({left:Math.round(r.left),top:Math.round(r.top)}));
  }catch(e){}
}
function restorePos(){
  try{
    var raw=localStorage.getItem(POS_KEY);
    if(!raw)return;
    var p=JSON.parse(raw);
    if(p&&typeof p.left==='number'&&typeof p.top==='number'){
      var c=clampPos(p.left,p.top);
      setHostPos(c.left,c.top);
    }
  }catch(e){}
}
var dragging=false,dragDX=0,dragDY=0;
hdr.addEventListener('pointerdown',function(e){
  if(e.target.closest('.hdr-btn'))return; // min/close buttons aren't drag handles
  if(e.button!==0)return;                 // primary button only
  dragging=true;
  var r=host.getBoundingClientRect();
  setHostPos(r.left,r.top);               // switch bottom/right → top/left anchoring
  dragDX=e.clientX-r.left; dragDY=e.clientY-r.top;
  try{hdr.setPointerCapture(e.pointerId);}catch(_){}
  e.preventDefault();
});
hdr.addEventListener('pointermove',function(e){
  if(!dragging)return;
  var c=clampPos(e.clientX-dragDX,e.clientY-dragDY);
  setHostPos(c.left,c.top);
});
function endDrag(e){
  if(!dragging)return;
  dragging=false;
  try{hdr.releasePointerCapture(e.pointerId);}catch(_){}
  savePos();
}
hdr.addEventListener('pointerup',endDrag);
hdr.addEventListener('pointercancel',endDrag);
// If the viewport shrinks, keep a moved toolbar fully on-screen.
window.addEventListener('resize',function(){
  try{
    if(!localStorage.getItem(POS_KEY))return;
    var r=host.getBoundingClientRect();
    var c=clampPos(r.left,r.top);
    setHostPos(c.left,c.top);
  }catch(e){}
});

// ── Collapse / close ──────────────────────────────────────────────────────────
collapseBtn.addEventListener('click',function(){
  collapsed=true;
  panel.className='hidden'; fab.className='show';
});
fab.addEventListener('click',function(){
  collapsed=false;
  panel.className=''; fab.className='';
});
closeBtn.addEventListener('click',function(){
  clearInterval(_guardInterval);
  queue.forEach(removePinEl);
  ov.remove(); host.remove();
});

// ── Submit ────────────────────────────────────────────────────────────────────
function setStatus(txt,col){statusEl.textContent=txt;statusEl.style.color=col||'#94a3b8';}

submitBtn.addEventListener('click',function(){
  if(!queue.length)return;
  submitBtn.disabled=true;
  setStatus('Sending…','#94a3b8');

  fetch(BASE+'/annotations',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      projectId:PROJ,
      conversationId:CONV||'new',
      annotations:queue.map(function(a){return{
        element:{selector:a.sel,text:a.elText,bounds:a.bounds},
        comment:a.comment
      };}),
      url:location.href,
      pageTitle:document.title
    })
  })
  .then(function(r){if(!r.ok)throw new Error('server');return r.json();})
  .then(function(){
    setStatus('Sent '+queue.length+' annotation'+(queue.length>1?'s':'')+'!','#4ade80');
    queue.forEach(removePinEl); queue=[];
    renderQueue(); closeEdit();
    setTimeout(function(){setStatus('');},4000);
  })
  .catch(function(){setStatus('Failed — is AgentDesk open?','#f87171');})
  .finally(function(){submitBtn.disabled=queue.length===0;});
});

// ── HTML escape ───────────────────────────────────────────────────────────────
function escH(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

// ── Init ──────────────────────────────────────────────────────────────────────
renderQueue();
restorePos(); // re-apply a previously dragged position (persists across navigation)
})();
`.trim();
}
