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
// Inter-key delays use Math.random (a Date.now()-derived sequence is deterministic
// — successive delays form a recurrence that keystroke-dynamics detection can spot)
// and the longer "thinking" pause lands at a RANDOM char interval, never a fixed one.
const PER_CHAR_MIN_MS = 25;
const PER_CHAR_SPAN_MS = 60;
const LONG_PAUSE_MIN_CHARS = 14;
const LONG_PAUSE_SPAN_CHARS = 18;
const LONG_PAUSE_MIN_MS = 200;
const LONG_PAUSE_SPAN_MS = 500;
// How long to wait, after clicking Send, for evidence the platform accepted it.
const VERIFY_TIMEOUT_MS = 8000;
// How long to wait for the (Angular SPA) bid form to render after navigation
// before giving up. The form frequently appears a little after the page itself,
// so we poll rather than assume it is present on first injection.
const BID_FORM_WAIT_MS = 30000;
const BID_FORM_POLL_MS = 400;

/**
 * Build the script that types `body` into the platform's reply composer with
 * human pacing and clicks Send. Reports back via __electrobunSendToHost.
 *
 * The result is VERIFIED, not assumed: a successful send clears the composer, so
 * after clicking we poll until the composer no longer holds our text (or it was
 * re-rendered away by the SPA). Only then is ok=true reported — a click that the
 * platform silently rejected reports ok=false instead of being recorded as sent.
 */
export function buildSendReplyScript(platformId: string, body: string): string {
	const desc = getPlatform(platformId);
	const INPUTS = JSON.stringify(desc.composer.inputSelectors);
	const SENDS = JSON.stringify(desc.composer.sendSelectors);
	const BODY = JSON.stringify(body);
	return `(function(){
  var INPUTS = ${INPUTS}, SENDS = ${SENDS}, BODY = ${BODY};
  var PER_MIN = ${PER_CHAR_MIN_MS}, PER_SPAN = ${PER_CHAR_SPAN_MS};
  var P_MIN_CH = ${LONG_PAUSE_MIN_CHARS}, P_SPAN_CH = ${LONG_PAUSE_SPAN_CHARS}, P_MIN_MS = ${LONG_PAUSE_MIN_MS}, P_SPAN_MS = ${LONG_PAUSE_SPAN_MS};
  var VERIFY_MS = ${VERIFY_TIMEOUT_MS};
  function report(ok, err){ try { if (window.__electrobunSendToHost) window.__electrobunSendToHost({type:'fl-send-result', ok:!!ok, error: err||''}); } catch(e){} }
  function find(sels){ for (var i=0;i<sels.length;i++){ try { var el=document.querySelector(sels[i]); if (el) return el; } catch(e){} } return null; }
  function rnd(base, span){ return Math.round(base + Math.random() * span); }
  var input = find(INPUTS);
  if (!input){ report(false,'composer not found'); return; }
  try { input.focus(); } catch(e){}
  var isCE = input.getAttribute && input.getAttribute('contenteditable') === 'true';
  if (isCE) { input.textContent=''; } else { input.value=''; }
  var i = 0;
  var nextPause = rnd(P_MIN_CH, P_SPAN_CH);
  function tick(){
    if (i < BODY.length){
      var ch = BODY[i++];
      if (isCE) { input.textContent += ch; } else { input.value += ch; }
      try { input.dispatchEvent(new Event('input', {bubbles:true})); } catch(e){}
      var delay = rnd(PER_MIN, PER_SPAN);
      if (i >= nextPause){ delay += rnd(P_MIN_MS, P_SPAN_MS); nextPause = i + rnd(P_MIN_CH, P_SPAN_CH); }
      setTimeout(tick, delay);
    } else {
      try { input.dispatchEvent(new Event('change', {bubbles:true})); } catch(e){}
      setTimeout(function(){
        var btn = find(SENDS);
        if (!btn){ report(false,'send button not found'); return; }
        try { btn.click(); } catch(e){ report(false,'click failed: '+e); return; }
        verify(0);
      }, rnd(400, 500));
    }
  }
  // Send confirmation: re-find the composer each poll (the SPA may re-render it).
  // Cleared or gone => the platform took the message; still holding our text after
  // the window => the send did NOT go through.
  function verify(waited){
    var cur = find(INPUTS);
    var text = cur ? ((cur.getAttribute && cur.getAttribute('contenteditable') === 'true' ? cur.textContent : cur.value) || '') : '';
    if (!cur || text.replace(/\\s+/g,'') === ''){ report(true,''); return; }
    if (waited >= VERIFY_MS){ report(false,'send not confirmed — the message is still in the composer'); return; }
    setTimeout(function(){ verify(waited + 400); }, 400);
  }
  setTimeout(tick, rnd(800, 1200)); // reading pause before typing
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
 * so the script polls for the form (up to 30s) before filling. Fields are located
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
  // Try a prioritised list of CSS selectors, returning the first visible match.
  function qFirst(sels){
    for (var i=0;i<sels.length;i++){
      try { var el = document.querySelector(sels[i]); if (el && visible(el)) return el; } catch(e){}
    }
    return null;
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
  // Stable Freelancer selectors first (Angular formcontrolname/id), then resilient
  // placeholder/label heuristics — so a DOM tweak degrades instead of breaking.
  function findProposal(){
    return qFirst([
      'textarea[formcontrolname="descriptionTextArea"]',
      'textarea[formcontrolname="description"]',
      '#descriptionTextArea',
      'textarea[name="description"]',
      'textarea[placeholder*="candidate" i]',
      'textarea[placeholder*="proposal" i]'
    ]) || (Array.prototype.slice.call(document.querySelectorAll('textarea')).filter(visible)[0] || null);
  }
  function findAmount(){
    return qFirst([
      'input[formcontrolname="amount"]',
      '#bidAmountInput',
      'input[id*="amount" i]',
      'input[name*="amount" i]'
    ]) || findInputByLabel(/bid amount/i);
  }
  function findDays(){
    return qFirst([
      'input[formcontrolname="period"]',
      '#periodInput',
      'input[id*="period" i]',
      'input[name*="period" i]',
      'input[name*="day" i]'
    ]) || findInputByLabel(/deliver/i);
  }
  function findPlaceBidBtn(){
    var btns = Array.prototype.slice.call(document.querySelectorAll('button, [role=button]')).filter(visible);
    for (var i=0;i<btns.length;i++){ if(/place\\s*bid|submit\\s*bid|bid\\s*now/i.test(btns[i].textContent||'')) return btns[i]; }
    return null;
  }
  function rnd(base, span){ return Math.round(base + Math.random() * span); }
  function typeHuman(el, text, done){
    var i=0, nextPause = rnd(14, 18);
    (function tick(){
      if (i<text.length){
        setNative(el, el.value + text[i++]);
        var d = rnd(25, 60);
        if (i >= nextPause){ d += rnd(200, 500); nextPause = i + rnd(14, 18); }
        setTimeout(tick, d);
      } else { el.dispatchEvent(new Event('change',{bubbles:true})); done(); }
    })();
  }
  var FORM_WAIT_MS = ${BID_FORM_WAIT_MS}, FORM_POLL_MS = ${BID_FORM_POLL_MS};
  var waited = 0;
  (function waitForm(){
    var proposal = findProposal();
    if (!proposal){
      if (waited >= FORM_WAIT_MS){ host('fl-bid-prefilled', false, 'bid form did not appear within ${Math.round(BID_FORM_WAIT_MS / 1000)}s'); return; }
      waited += FORM_POLL_MS; setTimeout(waitForm, FORM_POLL_MS); return;
    }
    try {
      if (AMOUNT !== null){ var amt = findAmount(); if (amt) setNative(amt, AMOUNT); }
      var days = findDays(); if (days) setNative(days, DAYS);
      proposal.focus(); setNative(proposal, '');
      setTimeout(function(){
        typeHuman(proposal, PROPOSAL, function(){
          var amountMissing = (AMOUNT === null);
          if (AUTO && !amountMissing){
            setTimeout(function(){
              var btn = findPlaceBidBtn();
              if (!btn){ host('fl-send-result', false, 'Place Bid button not found'); return; }
              try { btn.click(); } catch(e){ host('fl-send-result', false, 'click failed: '+e); return; }
              // Verify: on success the bid form is replaced (textarea gone). If the
              // form is still showing our proposal after the window, it didn't go.
              (function verify(waited){
                var ta = findProposal();
                if (!ta){ host('fl-send-result', true, ''); return; }
                if (waited >= 8000){ host('fl-send-result', false, 'bid not confirmed — the form is still open'); return; }
                setTimeout(function(){ verify(waited + 400); }, 400);
              })(0);
            }, rnd(600, 400));
          } else {
            host('fl-bid-prefilled', true, amountMissing ? 'amount' : '');
          }
        });
      }, 600);
    } catch(e){ host(AUTO ? 'fl-send-result' : 'fl-bid-prefilled', false, 'fill failed: '+e); }
  })();
})();`;
}
