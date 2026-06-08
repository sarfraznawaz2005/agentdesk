// ---------------------------------------------------------------------------
// Auto-Earn — WRITE-path script builders (human-paced typing + send)
//
// The send must originate as GENUINE user input inside the real session — never
// a direct API call (a non-browser API call is a documented ban signal, and
// bypassing the UI looks automated). So we build a small script that runs in the
// embedded page: it focuses the composer, types the body character-by-character
// with jitter and reading pauses, dispatches real input events, then clicks Send.
// The frontend runs this via wv.executeJavascript and awaits an 'fl-send-result'
// host-message.
// ---------------------------------------------------------------------------

import { getPlatform } from "./platforms";

export interface WriteResult {
	type: "fl-send-result";
	ok: boolean;
	error: string;
}

// Per-character + pause timing — the human-pacing model. Tunable in one place.
const PER_CHAR_MIN_MS = 25;
const PER_CHAR_SPAN_MS = 60;
const LONG_PAUSE_EVERY = 23; // chars
const LONG_PAUSE_MS = 300;

/**
 * Build the script that types `body` into the platform's reply composer with
 * human pacing and clicks Send. Reports back via __electrobunSendToHost.
 */
export function buildSendReplyScript(platformId: string, body: string): string {
	const desc = getPlatform(platformId);
	const INPUTS = JSON.stringify(desc.composer.inputSelectors);
	const SENDS = JSON.stringify(desc.composer.sendSelectors);
	const BODY = JSON.stringify(body);
	return `(function(){
  var INPUTS = ${INPUTS}, SENDS = ${SENDS}, BODY = ${BODY};
  var PER_MIN = ${PER_CHAR_MIN_MS}, PER_SPAN = ${PER_CHAR_SPAN_MS}, LONG_EVERY = ${LONG_PAUSE_EVERY}, LONG_MS = ${LONG_PAUSE_MS};
  function report(ok, err){ try { if (window.__electrobunSendToHost) window.__electrobunSendToHost({type:'fl-send-result', ok:!!ok, error: err||''}); } catch(e){} }
  function find(sels){ for (var i=0;i<sels.length;i++){ try { var el=document.querySelector(sels[i]); if (el) return el; } catch(e){} } return null; }
  function jit(base, span){ return base + Math.floor((Date.now() % (span+1))); }
  var input = find(INPUTS);
  if (!input){ report(false,'composer not found'); return; }
  try { input.focus(); } catch(e){}
  var isCE = input.getAttribute && input.getAttribute('contenteditable') === 'true';
  if (isCE) { input.textContent=''; } else { input.value=''; }
  var i = 0;
  function tick(){
    if (i < BODY.length){
      var ch = BODY[i++];
      if (isCE) { input.textContent += ch; } else { input.value += ch; }
      try { input.dispatchEvent(new Event('input', {bubbles:true})); } catch(e){}
      var delay = jit(PER_MIN, PER_SPAN);
      if (i % LONG_EVERY === 0) delay += LONG_MS;
      setTimeout(tick, delay);
    } else {
      try { input.dispatchEvent(new Event('change', {bubbles:true})); } catch(e){}
      setTimeout(function(){
        var btn = find(SENDS);
        if (!btn){ report(false,'send button not found'); return; }
        try { btn.click(); } catch(e){ report(false,'click failed: '+e); return; }
        report(true,'');
      }, jit(400, 500));
    }
  }
  setTimeout(tick, jit(800, 1200)); // reading pause before typing
})();`;
}

export interface BidFillOptions {
	/** The proposal text (typed into the "Describe your proposal" textarea). */
	proposal: string;
	/** Bid amount to fill, or null to leave blank for the user to set. */
	amount: number | null;
	/** Delivery period in days. */
	days: number;
	/** When true (full-auto + known amount) the script clicks Place Bid itself.
	 *  When false it fills everything and stops, reporting `fl-bid-prefilled`. */
	autoPlace: boolean;
}

/**
 * Build the script that fills Freelancer's "Place a bid on this project" form —
 * Bid Amount, delivery Days, and the proposal textarea — with human-paced typing
 * for the proposal. The bid form is an Angular SPA that renders after navigation,
 * so the script polls for the form (up to ~15s) before filling. Fields are located
 * by label proximity + placeholder (resilient to class/id churn), and values are
 * set through the native value setter so Angular's ngModel registers the change.
 *
 * - autoPlace === true  → clicks "Place Bid" and reports `fl-send-result`.
 * - autoPlace === false → fills + stops, reports `fl-bid-prefilled` (the host then
 *   notifies the user it's their turn to click Place Bid). If the amount is unknown
 *   the script always stops, with error='amount'.
 */
export function buildSubmitBidScript(_platformId: string, opts: BidFillOptions): string {
	const PROPOSAL = JSON.stringify(opts.proposal);
	const AMOUNT = opts.amount == null ? "null" : JSON.stringify(String(opts.amount));
	const DAYS = JSON.stringify(String(opts.days));
	const AUTO = opts.autoPlace ? "true" : "false";
	return `(function(){
  var PROPOSAL=${PROPOSAL}, AMOUNT=${AMOUNT}, DAYS=${DAYS}, AUTO=${AUTO};
  function host(type, ok, err){ try{ if(window.__electrobunSendToHost) window.__electrobunSendToHost({type:type, ok:!!ok, error:err||''}); }catch(e){} }
  function visible(el){ return el && el.offsetParent !== null && !el.disabled && !el.readOnly; }
  function setNative(el, val){
    try{
      var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto,'value').set;
      setter.call(el, val);
    }catch(e){ el.value = val; }
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
  }
  function findProposal(){
    var t = document.querySelector('textarea[placeholder*="candidate" i], textarea[placeholder*="proposal" i]');
    if (t && visible(t)) return t;
    var tas = Array.prototype.slice.call(document.querySelectorAll('textarea')).filter(visible);
    return tas[0] || null;
  }
  // Find a number/text input whose surrounding section text matches \`re\`.
  function findInputByLabel(re){
    var inputs = Array.prototype.slice.call(document.querySelectorAll('input')).filter(visible);
    for (var i=0;i<inputs.length;i++){
      var el = inputs[i], scope = el.parentElement, hops = 0;
      while (scope && hops < 5){
        if (re.test(scope.textContent||'')) return el;
        scope = scope.parentElement; hops++;
      }
    }
    return null;
  }
  function findPlaceBidBtn(){
    var btns = Array.prototype.slice.call(document.querySelectorAll('button, [role=button]')).filter(visible);
    for (var i=0;i<btns.length;i++){ if(/place\\s*bid|submit\\s*bid|bid\\s*now/i.test(btns[i].textContent||'')) return btns[i]; }
    return null;
  }
  function typeHuman(el, text, done){
    var i=0;
    (function tick(){
      if (i<text.length){
        setNative(el, el.value + text[i++]);
        var d = 25 + (Date.now()%60); if (i%23===0) d+=300;
        setTimeout(tick, d);
      } else { el.dispatchEvent(new Event('change',{bubbles:true})); done(); }
    })();
  }
  var waited = 0;
  (function waitForm(){
    var proposal = findProposal();
    if (!proposal){
      if (waited >= 15000){ host('fl-bid-prefilled', false, 'bid form not found'); return; }
      waited += 400; setTimeout(waitForm, 400); return;
    }
    try {
      if (AMOUNT !== null){ var amt = findInputByLabel(/bid amount/i); if (amt) setNative(amt, AMOUNT); }
      var days = findInputByLabel(/deliver/i); if (days) setNative(days, DAYS);
      proposal.focus(); setNative(proposal, '');
      setTimeout(function(){
        typeHuman(proposal, PROPOSAL, function(){
          var amountMissing = (AMOUNT === null);
          if (AUTO && !amountMissing){
            setTimeout(function(){
              var btn = findPlaceBidBtn();
              if (!btn){ host('fl-send-result', false, 'Place Bid button not found'); return; }
              try { btn.click(); host('fl-send-result', true, ''); }
              catch(e){ host('fl-send-result', false, 'click failed: '+e); }
            }, 700);
          } else {
            host('fl-bid-prefilled', true, amountMissing ? 'amount' : '');
          }
        });
      }, 600);
    } catch(e){ host(AUTO ? 'fl-send-result' : 'fl-bid-prefilled', false, 'fill failed: '+e); }
  })();
})();`;
}
