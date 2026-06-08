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

/**
 * Bid submission is more involved (fill amount/period/proposal, then submit).
 * The full multi-field flow is implemented in the bidding task; this builder
 * currently fills the proposal textarea + submits, mirroring the reply flow.
 */
export function buildSubmitBidScript(platformId: string, proposalBody: string): string {
	// For now bids reuse the reply-style composer fill + submit. The bidding task
	// extends this with amount/period fields per platform.
	return buildSendReplyScript(platformId, proposalBody);
}
