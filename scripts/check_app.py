#!/usr/bin/env python3
"""Drive the real app in headless Chrome and report console errors.

scripts/smoke.html covers the DOM-free modules; this walks the actual UI —
switching readings, expanding aliyot, opening a pasuk, stepping through the
stages — and fails on any uncaught exception or console error along the way.

    .venv/bin/python scripts/check_app.py [base-url]
"""
import json
import subprocess
import sys
import time
import urllib.request

import websocket

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT = 9223
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8123"

# `guided=0` pins the walkthrough to the expert workshop. Without it a fresh
# browser profile is a first-time visitor, and the app quite rightly opens the
# guided onboarding wizard over the top of everything these steps poke at. The
# guided surface has its own steps at the end of the run.
APP_URL = f"{BASE}/index.html?guided=0"

# Helpers injected into the page before the app boots, so every probe starts from
# the same place regardless of what a previous run left in localStorage.
PRELUDE = r"""
window.__t = {
  q: (s) => document.querySelector(s),
  all: (s) => [...document.querySelectorAll(s)],
  // Open the first section and leave it open, whatever it was before.
  openFirst() {
    const head = this.q('.alsec-head');
    if (!head) return null;
    if (!head.closest('.alsec').classList.contains('open')) head.click();
    if (!this.q('.alsec.open')) head.click();
    return this.q('.alsec.open');
  },
  // Open the first section and select its first pasuk.
  pickVerse() {
    this.openFirst();
    const v = this.q('.alsec.open .verse');
    if (v) v.click();
    return this.q('#practice .phead h2');
  },
  stage(i) {
    const b = this.all('#stageBar .stagebtn')[i];
    if (b) b.click();
    return !!b;
  },
  key(k) { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); },
  // Where the reader is, as the UI reports it: which word the karaoke highlight
  // sits on. The app plays through a detached Audio element, so this — the thing
  // the user actually watches — is the honest probe.
  wordAt() {
    const ws = this.all('#timelineWords .w');
    return ws.findIndex((w) => w.classList.contains('cur'));
  },
  // Poll until `cond` holds (or give up), then report. Returned as a promise so
  // the probe can await real playback rather than guessing at timings.
  settle(cond, okMsg, failMsg, ms = 4000) {
    const end = Date.now() + ms;
    return new Promise((res) => {
      const tick = () => {
        if (cond()) return res(okMsg);
        if (Date.now() > end) return res(failMsg);
        setTimeout(tick, 50);
      };
      tick();
    });
  },
  after(ms, fn) { return new Promise((res) => setTimeout(() => res(fn()), ms)); },
  // Click a control by selector rather than by id: the onboarding wizard and the
  // guided surface rebuild their buttons on every render, so there is nothing
  // stable to hold on to but the shape of the thing.
  tap(sel) {
    const b = this.q(sel);
    if (!b) return `no ${sel}`;
    if (b.disabled) return `${sel} is disabled`;
    b.click();
    return this.text(b);
  },
  text(el) { return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; },
  // The single question the wizard is asking, and the answers it offers.
  ask() { return this.text(this.q('.ob-h')); },
  answers() { return this.all('.ob-choice').map((b) => this.text(b)); },
  // Grant every stage on every pasuk of a reading, so the later stages can be
  // exercised without recording a take first. Takes effect on the next load.
  unlock(slug) {
    const d = JSON.parse(localStorage.getItem('cantillate.v1') || '{}');
    d.levels = d.levels || {};
    d.schema = 2;
    for (let i = 1; i <= 200; i++) d.levels[`${slug}:${i}`] = 9;
    localStorage.setItem('cantillate.v1', JSON.stringify(d));
  },
};
if (!sessionStorage.getItem('__checked')) {
  // Fresh slate on the first load of a run, but keep whatever a probe seeds after.
  try { localStorage.clear(); } catch (e) {}
  sessionStorage.setItem('__checked', '1');
}
"""

# Each step is (description, JS expression). The expression must return a string
# beginning with "OK"; anything else (including a throw) fails the step. Making
# every probe state its own verdict keeps a merely-truthy result from passing.
STEPS = [
    ("the reading menu is grouped by sefer, in chumash order",
     "(()=>{const g=__t.all('#parashah optgroup').map(o=>o.label);"
     " const books=['Bereshit','Shemot','Vayikra','Bamidbar','Devarim'];"
     " const seen=g.filter(l=>books.some(b=>l.startsWith(b)));"
     " const pos=seen.map(l=>books.findIndex(b=>l.startsWith(b)));"
     " const ordered=pos.every((n,i)=>i===0||n>pos[i-1]);"
     " return seen.length>=2 && ordered && g.length>seen.length"
     "   ? 'OK '+g.join(' | ') : 'out of order or ungrouped: '+g.join(' | ');})()"),
    ("each sefer lists its parashiyot in order",
     "(()=>{const d=__t.all('#parashah optgroup').find(o=>o.label.startsWith('Devarim'));"
     " if(!d) return 'no Devarim group';"
     " const first=[...d.children].map(o=>o.textContent.split('(')[0].trim());"
     " return /^Devarim/.test(first[0]) && /Va.etchanan/.test(first[2]||first[1])"
     "   ? 'OK '+first.slice(0,4).join(', ')+' \\u2026' : first.slice(0,4).join(', ');})()"),
    ("aliyot render as collapsible sections, all closed",
     "(()=>{const n=__t.all('.alsec').length, open=__t.all('.alsec.open').length;"
     " return n===7&&open===0 ? 'OK 7 sections, none expanded' : `${n} sections, ${open} open`;})()"),
    ("expanding a section reveals its pesukim",
     "(()=>{__t.openFirst(); const v=__t.all('.alsec.open .verse').length;"
     " return v>0 ? `OK ${v} pesukim` : 'no pesukim revealed';})()"),
    ("collapsing hides them again",
     "(()=>{__t.q('.alsec.open .alsec-head').click();"
     " const v=__t.all('.alsec .verse').length;"
     " return v===0 ? 'OK collapsed' : `${v} pesukim still shown`;})()"),
    ("the open section is remembered across a re-render",
     "(()=>{__t.openFirst(); const key=__t.q('.alsec.open').dataset.key;"
     " __t.q('#tgEnglish').click(); __t.q('#tgEnglish').click();"
     " const now=__t.q('.alsec.open'); return now&&now.dataset.key===key ? 'OK '+key : 'lost the open section';})()"),
    ("the STA\"M is drawn in the Shlomo hand by default",
     "(()=>{if(!__t.q('.hebrew.scroll')) __t.q('#tgFont').click();"
     " const el=__t.q('.hebrew.scroll'); if(!el) return 'no STA\\u201cM text on screen';"
     " const fam=getComputedStyle(el).fontFamily;"
     " return /ShlomoStam/.test(fam) ? 'OK '+fam : fam;})()"),
    ("switching to the Ashkenaz hand changes the script and is remembered",
     "(()=>{const pick=(h)=>__t.all('#stamHandSeg .sh').find(b=>b.dataset.sh===h).click();"
     " pick('ashkenaz');"
     " const fam=getComputedStyle(__t.q('.hebrew.scroll')).fontFamily;"
     " const saved=localStorage.getItem('cantillate.stamHand');"
     # Leave the toolbar exactly as we found it for the steps that follow.
     " pick('shlomo'); __t.q('#tgFont').click();"
     " return /StamAshkenaz/.test(fam)&&!/Shlomo/.test(fam)&&saved==='ashkenaz'"
     "   ? 'OK '+fam : `${fam} / saved=${saved}`;})()"),
    ("the tracking slider opens up the space between STA\"M letters",
     "(()=>{if(!__t.q('.hebrew.scroll')) __t.q('#tgFont').click();"
     " const el=__t.q('.hebrew.scroll'), s=__t.q('#stamTrack');"
     " const px=()=>parseFloat(getComputedStyle(el).letterSpacing)||0;"
     " const set=(v)=>{s.value=v; s.dispatchEvent(new Event('input'));};"
     " const before=px(); set('0.1'); const wide=px();"
     " const saved=parseFloat(localStorage.getItem('cantillate.stamTrack'));"
     " set('0.05'); __t.q('#tgFont').click();"
     " return wide>before&&saved===0.1 ? `OK ${before}px -> ${wide}px`"
     "   : `${before}px -> ${wide}px, saved=${saved}`;})()"),
    ("the workshop can place a pointed full-reading scroll beside the STA\"M",
     "(()=>{const mode=__t.q('[data-scroll-text=\"dual\"]'), pane=__t.q('#paneToggleScroll');"
     " if(!mode||!pane) return 'full-reading controls missing';"
     " mode.click(); if(!document.body.classList.contains('scroll-view')) pane.click();"
     " return __t.settle(()=>!!__t.q('#scrollStamTrack .sw')&&!!__t.q('#scrollPointedTrack .sw'),"
     "   null,null,12000).then(()=>{"
     "     const a=__t.q('#scrollStamTrack .sw'), b=__t.q('#scrollPointedTrack .sw');"
     "     const same=a.dataset.verse===b.dataset.verse&&a.dataset.widx===b.dataset.widx;"
     "     const pointed=/[\\u0591-\\u05c7]/.test(b.textContent), bare=!/[\\u0591-\\u05c7]/.test(a.textContent);"
     "     __t.q('[data-scroll-text=\"stam\"]').click();"
     "     if(document.body.classList.contains('scroll-view')) pane.click();"
     "     return same&&pointed&&bare ? `OK both map verse ${a.dataset.verse}, word ${a.dataset.widx}`"
     "       : `same=${same} pointed=${pointed} bare=${bare}`;"
     "   });})()"),
    ("clicking a pasuk keeps the dual columns instead of rebuilding them",
     "(()=>{const mode=__t.q('[data-scroll-text=\"dual\"]'), pane=__t.q('#paneToggleScroll');"
     " if(!mode||!pane) return 'full-reading controls missing';"
     " mode.click(); if(!document.body.classList.contains('scroll-view')) pane.click();"
     " return __t.settle(()=>!!__t.q('#scrollStamTrack .sw')&&!!__t.q('#scrollPointedTrack .sw'),"
     "   null,null,12000).then(()=>{"
     "     const box=__t.q('#scrollVerses');"
     "     const first=__t.q('#scrollStamTrack .sw');"
     "     const key=box.dataset.layoutKey;"
     "     const v=__t.all('#scrollStamTrack .sw[data-verse]').map(w=>w.dataset.verse)"
     "       .find(n=>n && n!==first.dataset.verse) || first.dataset.verse;"
     "     const target=__t.q(`#scrollStamTrack .sw[data-verse=\"${v}\"]`);"
     "     if(target) target.click();"
     "     const kept=first.isConnected && box.dataset.layoutKey===key;"
     "     const sel=__t.all(`#scrollStamTrack .sw.sel[data-verse=\"${v}\"]`).length;"
     "     const pointedSel=__t.all(`#scrollPointedTrack .sw.sel[data-verse=\"${v}\"]`).length;"
     "     __t.q('[data-scroll-text=\"stam\"]').click();"
     "     if(document.body.classList.contains('scroll-view')) pane.click();"
     "     return kept&&sel>0&&pointedSel>0"
     "       ? `OK same nodes, ${sel}+${pointedSel} selected on verse ${v}`"
     "       : `kept=${kept} sel=${sel} pointedSel=${pointedSel} key=${box.dataset.layoutKey}`;"
     "   });})()"),
    ("chain chips are offered inside an aliyah",
     "(()=>{__t.openFirst(); const c=__t.all('.alsec.open .chain').length;"
     " return c>0 ? `OK ${c} chain(s)` : 'no chains offered';})()"),
    ("changing the chain size re-cuts the runs",
     "(()=>{__t.openFirst(); const before=__t.all('.alsec.open .chain').map(b=>b.dataset.start+'-'+b.dataset.end).join();"
     " const sizes=__t.all('.chain-sizes .cs'); sizes[sizes.length-1].click(); __t.openFirst();"
     " const after=__t.all('.alsec.open .chain').map(b=>b.dataset.start+'-'+b.dataset.end).join();"
     " return `OK ${before||'(none)'} -> ${after||'(none)'}`;})()"),
    ("selecting a pasuk opens the practice pane",
     "(()=>{const h=__t.pickVerse(); return h ? 'OK '+h.textContent.trim() : 'no practice pane';})()"),
    ("the stage bar lists all nine stages",
     "(()=>{const n=__t.all('#stageBar .stagebtn').length;"
     " return n===9 ? 'OK 9 stages' : `${n} stages`;})()"),
    ("the transliteration sits under every word, on the column and the coach line alike",
     "(()=>{const b=__t.q('#tgTranslit'); if(!b) return 'no transliteration toggle';"
     " if(!b.classList.contains('on')) b.click();"
     " const col=__t.all('#verses .verse.active .w').length, colTl=__t.all('#verses .verse.active .wtl').length;"
     " const coach=__t.all('#timelineWords .w').length, coachTl=__t.all('#timelineWords .wtl').length;"
     " const sample=__t.text(__t.q('#verses .verse.active .wtl'));"
     " return col===colTl && coach===coachTl && col>0 && /^[a-zA-Z'-]+$/.test(sample)"
     "   ? `OK ${col} words in the column, ${coach} on the coach line, e.g. \u201c${sample}\u201d`"
     "   : `column ${colTl}/${col}, coach ${coachTl}/${coach}, sample=${sample}`;})()"),
    # It is a stronger crutch than the vowels, which the column shows on the
    # reader's say-so whatever the practice pane is doing. This one the stage
    # overrules the reader on, or the bare-text stages could be read off the
    # column beside them.
    ("and the stages that strip the text take it away too, reader or no reader",
     "(()=>{const b=__t.q('#tgTranslit'); __t.stage(6);"
     " const bare=__t.all('.wtl').length, greyed=b.disabled;"
     " __t.stage(0); const back=__t.all('.wtl').length;"
     " if(b.classList.contains('on')) b.click();"
     " return bare===0 && greyed && back>0"
     "   ? `OK gone and greyed at stage 7, ${back} back at stage 1`"
     "   : `stage 7 left ${bare} lines (greyed=${greyed}), stage 1 restored ${back}`;})()"),
    ("the transport exposes pause and word-step, disabled while idle",
     "(()=>{const ids=['btnPause','btnStepBack','btnStepFwd'];"
     " const missing=ids.filter(i=>!document.getElementById(i));"
     " if (missing.length) return 'missing '+missing.join();"
     " const live=ids.filter(i=>!document.getElementById(i).disabled);"
     " return live.length ? 'enabled while idle: '+live.join() : 'OK present and disabled';})()"),
    ("the transport keys are inert when nothing is running",
     "(()=>{__t.key(' '); __t.key(','); __t.key('.');"
     " return document.body.classList.contains('transport-paused') ? 'paused with nothing playing' : 'OK no-op';})()"),
    ("an unreached stage still shows its locked page",
     "(()=>{__t.stage(3); return __t.q('.locked-page') ? 'OK stage 4 is gated until stage 3 is passed'"
     " : 'a locked stage rendered as if unlocked';})()"),
    ("every stage renders",
     "(()=>{for(let i=0;i<9;i++) if(!__t.stage(i)) return 'stage '+(i+1)+' missing';"
     " __t.stage(0); return 'OK walked all nine';})()"),
    # The rung below reading a run off the bare scroll: the same pesukim with the
    # vowels and the accents in front of you, so the joins are the only hard part.
    # Guided mode's fifth round asks for every run this way first, and each surface
    # keeps its own best — so the chip has to follow the text on screen rather than
    # look as though a run's score had vanished.
    ("a run can be chanted from the pointed text, and keeps its own best there",
     "(()=>{__t.q('#alBack')&&__t.q('#alBack').click();"
     " return Promise.all([import('/js/store.js'), import('/js/app.js')]).then(([st])=>{"
     "   __t.openFirst(); const chip=__t.q('.alsec.open .chain');"
     "   if(!chip) return 'no chain to open';"
     "   const [s,e]=[chip.dataset.start,chip.dataset.end].map(Number);"
     "   const slug=__t.q('#parashah').value;"
     "   st.recordChainScore(slug, s, e, 84, 'pointed');"
     "   __t.q('[data-scroll-text=\"pointed\"]').click(); __t.openFirst();"
     "   const badge=__t.text(__t.q(`.chain[data-start=\"${s}\"] .chain-score`));"
     "   __t.q(`.alsec.open .chain[data-start=\"${s}\"]`).click();"
     "   const desc=__t.text(__t.q('.aliyah-view .leveldesc'));"
     "   const pointed=!!__t.q('#aliyahPointed'), bare=!!__t.q('#aliyahScroll');"
     "   __t.q('#alBack').click(); __t.q('[data-scroll-text=\"stam\"]').click(); __t.openFirst();"
     "   const after=__t.q(`.chain[data-start=\"${s}\"] .chain-score`);"
     "   return pointed && !bare && badge==='84' && !after && /pointed text/.test(desc)"
     "     ? `OK pesukim ${s}-${e} read pointed, 84 with the vowels and nothing yet from the scroll`"
     "     : `pointed=${pointed} bare=${bare} badge=${badge} after=${__t.text(after)} desc=${desc.slice(0,70)}`;"
     " });})()"),
    ("a verse chain opens the multi-verse reader",
     "(()=>{__t.q('#alBack')&&__t.q('#alBack').click(); __t.openFirst();"
     " const chip=__t.q('.alsec.open .chain'); if(!chip) return 'no chain to open';"
     " chip.click(); const h=__t.q('.aliyah-view .phead h2');"
     " return h&&/Pesukim/.test(h.textContent) ? 'OK '+h.textContent.trim() : 'reader did not open';})()"),
    ("leaving the chain returns to the verse list",
     "(()=>{const b=__t.q('#alBack'); if(!b) return 'no back button'; b.click();"
     " return __t.all('.alsec').length===7 ? 'OK back to 7 sections' : 'lost the sections';})()"),
]

# Re-probed after every stage has been granted, so the later stages (which are
# gated behind a scored take) can actually be exercised.
UNLOCKED_STEPS = [
    ("the sections stage offers the Divide control",
     "(()=>{__t.pickVerse(); __t.stage(3);"
     " if (__t.q('.locked-page')) return 'stage 4 still locked';"
     " const labels=__t.all('#divideSeg .dv').map(b=>b.textContent+(b.disabled?'(n/a)':''));"
     " return labels.length===4 ? 'OK '+labels.join(' ') : 'got '+labels.join(' ');})()"),
    ("a coarser division yields fewer, longer units",
     "(()=>{const units=()=>{const l=__t.q('.u-label'); return l?parseInt(l.textContent.split('/')[1],10):1;};"
     " const live=__t.all('#divideSeg .dv').filter(b=>!b.disabled);"
     " if (live.length<2) return 'this pasuk offers only one division';"
     " live[live.length-1].click(); const fine=units();"
     " __t.all('#divideSeg .dv').filter(b=>!b.disabled)[0].click(); const coarse=units();"
     " return coarse<fine ? `OK ${fine} phrases collapse into ${coarse} coarser units` : `${coarse} vs ${fine}`;})()"),
    ("an Etnachta is never left without its run-up",
     "(()=>{__t.pickVerse(); __t.stage(2);"  # the phrase stage
     " const n=__t.q('.u-label')?parseInt(__t.q('.u-label').textContent.split('/')[1],10):1;"
     " let lone=0;"
     " for(let i=0;i<n;i++){ if(__t.all('#timelineWords .w').length===1"
     "   && /Etnachta|Sof Pasuk/.test(__t.q('.mode-pill').textContent)) lone++;"
     "   const nx=__t.q('#uNext'); if(nx) nx.click(); }"
     " return lone===0 ? `OK ${n} phrases, none stranded` : `${lone} stranded`;})()"),
    ("the whole-verse stage takes the pasuk as one unit",
     "(()=>{__t.pickVerse(); __t.stage(4);"
     " if (__t.q('.locked-page')) return 'stage 5 still locked';"
     " return __t.q('.u-label') ? 'still divided: '+__t.q('.u-label').textContent : 'OK one whole pasuk';})()"),
]

# The transport under real playback. These need audio actually rolling, so each
# one waits for the chant to start before acting on it.
TRANSPORT_STEPS = [
    ("playing the chant enables the transport",
     "(()=>{__t.pickVerse(); __t.stage(4); __t.q('#btnReal').click();"
     " return __t.settle(()=>!__t.q('#btnPause').disabled, 'OK pause became available',"
     "   'transport stayed disabled while the chant played');})()"),
    ("the chant advances word by word",
     "__t.settle(()=>__t.wordAt()>1, 'OK karaoke highlight is moving', 'highlight never advanced')"),
    ("space holds the chant where it is",
     "(()=>{__t.key(' ');"
     " return __t.settle(()=>document.body.classList.contains('transport-paused')"
     "   && __t.q('#btnPause').textContent.includes('Resume'),"
     "   'OK held, button offers Resume', 'space did not hold playback');})()"),
    ("the reading stays put while held",
     "(()=>{const a=__t.wordAt();"
     " return __t.after(1500, ()=>__t.wordAt()===a ? `OK frozen on word ${a}`"
     "   : `drifted from word ${a} to ${__t.wordAt()}`);})()"),
    ("',' steps back a word and '.' steps forward again",
     "(()=>{const start=__t.wordAt(); __t.key(',');"
     " return __t.after(500, ()=>{const back=__t.wordAt();"
     "   if (back !== start-1) return `, moved word ${start} -> ${back}, expected ${start-1}`;"
     "   __t.key('.');"
     "   return __t.after(500, ()=>{const fwd=__t.wordAt();"
     "     return fwd === back+1 ? `OK word ${start} -> ${back} -> ${fwd}`"
     "       : `. moved word ${back} -> ${fwd}, expected ${back+1}`;});});})()"),
    ("stepping while held keeps it held",
     "(()=>document.body.classList.contains('transport-paused') ? 'OK still held'"
     " : 'stepping resumed playback')()"),
    ("space resumes from where it was held",
     "(()=>{const at=__t.wordAt(); __t.key(' ');"
     " return __t.settle(()=>!document.body.classList.contains('transport-paused') && __t.wordAt()>at,"
     "   'OK resumed from word '+at, 'did not resume from word '+at);})()"),
    ("stopping clears the held state",
     "(()=>{__t.key('Escape');"
     " return __t.settle(()=>!document.body.classList.contains('transport-paused')"
     "   && __t.q('#btnPause').disabled, 'OK transport reset', 'transport left armed after stop');})()"),
    # A recording made by a person has things in it that are not the reading: a
    # false start, a cough, a word to the room. Whoever labelled it cut those out
    # (scripts/label.html), and the promise the app makes is that a child never
    # hears one played back as though their teacher had chanted it.
    ("a stretch cut out of a recording is never played",
     "(async()=>{const ra=await import('/js/realaudio.js');"
     " const idx=await (await fetch('data/trope-index.json')).json();"
     " const v=idx.readings[0].verses[0];"
     " const from=v.onsets[1], to=v.onsets[2], first=v.onsets[0], last=v.onsets[3];"
     " ra.setAudioCuts(v.file, [[from, to]]);"
     " const seen=[];"
     " await new Promise((done)=>{"
     "   ra.playSegment(v.file, first, last, {onEnd: done, onError: done});"
     "   const poll=setInterval(()=>{const p=ra.verseAudioProgress(); if(p!=null) seen.push(p);}, 20);"
     "   setTimeout(()=>{clearInterval(poll); done();}, 8000);});"
     " ra.stopVerseAudio(); ra.setAudioCuts(v.file, []);"
     " const at=seen.map((p)=>first + p*(last-first));"
     " const inside=at.filter((t)=>t>from+0.05 && t<to-0.05);"
     " return inside.length===0 && at.some((t)=>t>=to)"
     "   ? `OK jumped ${(to-from).toFixed(2)}s of ${v.ref}, ${at.length} samples, none inside`"
     "   : `${inside.length} of ${at.length} samples landed in the cut`;})()"),
]

# The same transport during a take. A fumbled phrase should be re-singable: hold,
# step back, carry on — and what was sung past that point must be discarded so the
# retry replaces it rather than scoring on top of it.
RECORD_STEPS = [
    ("recording starts and the cue moves",
     "(()=>{__t.pickVerse(); __t.stage(4); __t.q('#btnSing').click();"
     " return __t.settle(()=>__t.wordAt()>1, 'OK duet under way', 'the take never started', 8000);})()"),
    ("space holds the take",
     "(()=>{__t.key(' ');"
     " return __t.settle(()=>document.body.classList.contains('transport-paused'),"
     "   'OK take held', 'space did not hold the take');})()"),
    ("the record clock stops while held",
     "(()=>{const a=__t.wordAt();"
     " return __t.after(1500, ()=>__t.wordAt()===a ? `OK clock frozen on word ${a}`"
     "   : `clock ran on from word ${a} to ${__t.wordAt()}`);})()"),
    # rewindUser's frame-dropping is unit-tested in smoke.html; here we check the
    # visible half of the contract — the cue really goes back a word mid-take.
    ("',' rewinds the take by a word",
     "(()=>{const at=__t.wordAt(); __t.key(',');"
     " return __t.after(400, ()=>__t.wordAt()===at-1 ? `OK word ${at} -> ${__t.wordAt()}`"
     "   : `, moved word ${at} -> ${__t.wordAt()}`);})()"),
    ("the take resumes and finishes",
     "(()=>{__t.key(' ');"
     " return __t.settle(()=>!document.body.classList.contains('transport-paused'),"
     "   'OK take resumed', 'take stayed held');})()"),
    ("stopping a held take still scores it",
     "(()=>{__t.key('Escape');"
     " return __t.settle(()=>/accuracy/i.test(__t.q('#result').textContent)"
     "   && __t.q('#btnPause').disabled,"
     "   'OK '+__t.q('#result').textContent.trim().slice(0,60), 'the take produced no score', 6000);})()"),
]

# After the walk above, switch readings and re-probe.
READING_STEPS = [
    ("trope-drills", [
        ("the drill set loads as three lessons of a pair each, not aliyot",
         "(()=>{const n=__t.all('.alsec').length, chains=__t.all('.chain').length;"
         " __t.openFirst(); const v=__t.all('.alsec.open .verse').length;"
         " return n===3&&v===2&&chains===0 ? `OK ${n} lessons, ${v} pesukim each, no aliyah machinery`"
         "   : `${n} lessons, ${v} pesukim, ${chains} chains`;})()"),
        ("each drill is a long verse the Divide control can cut up",
         "(()=>{__t.pickVerse(); __t.stage(3);"
         " if (__t.q('.locked-page')) return 'sections stage locked';"
         " const live=__t.all('#divideSeg .dv').filter(b=>!b.disabled).length;"
         " const units=__t.q('.u-label') ? __t.q('.u-label').textContent.trim() : 'undivided';"
         " return live>=3 ? `OK ${live} divisions available, showing ${units}` : `only ${live} divisions`;})()"),
        ("portion controls are hidden for a drill set",
         "(()=>document.getElementById('portion').hidden ? 'OK hidden' : 'still shown')()"),
        ("a drill line opens with a synthesized coach line",
         "(()=>{__t.pickVerse(); __t.stage(4);"
         " if (__t.q('.locked-page')) return 'whole-line stage locked';"
         " const w=__t.all('#timelineWords .w').length;"
         " return w>1 ? `OK ${w} words on the coach timeline` : `${w} word(s) — no coach built`;})()"),
        ("no whole-verse chant button where the drill has no recording of its own",
         "(()=>document.getElementById('btnReal') ? 'offered a chant that does not exist'"
         " : 'OK absent, the spliced recitation takes its place')()"),
        ("the drill still records and scores",
         "(()=>['btnRec','btnSing','btnPause','btnStepBack'].every(i=>document.getElementById(i))"
         " ? 'OK full transport' : 'transport incomplete')()"),
        # The drills have no recording of their own, so the app splices one out of
        # the corpus: the same accents, sung by the cantor on different words.
        # A drill's own words were never recorded, so its coach line has to come
        # from the corpus-wide measured shapes, not trope.js's hand-drawn motifs.
        ("the drill is taught with measured shapes, not sketches",
         "(()=>{__t.pickVerse(); __t.stage(4);"
         " const w=__t.all('#timelineWords .w').length;"
         " if (w < 2) return 'no coach built';"
         " return fetch('data/trope-shapes.json').then(r=>r.json()).then(d=>{"
         "   const n=Object.keys(d.shapes||{}).length;"
         "   const timed=Object.values(d.shapes).filter(s=>s.dur).length;"
         "   return n>20 && timed>20 ? `OK ${n} accents measured, ${timed} timed` : `${n} shapes, ${timed} timed`;});})()"),
        ("a real recitation can be spliced for the drill",
         "(()=>{const b=document.getElementById('btnRecite');"
         " if (!b) return 'no recite button';"
         " b.click();"
         " return __t.settle(()=>/Real chant/.test(__t.q('#result').textContent),"
         "  'OK spliced', 'never found a recitation', 20000);})()"),
        ("every word of it comes from the recorded chant",
         "(()=>{const t=__t.q('#result').textContent;"
         " const m=t.match(/(\\d+) of (\\d+) words/);"
         " if (!m) return 'no splice summary: '+t.slice(0,80);"
         " return m[1]===m[2] && !/synthesized/.test(t) ? `OK ${m[0]}` : t.slice(0,140);})()"),
        # A splice only proves itself when playback crosses a seam into the next
        # source verse, so poll until that happens rather than for a fixed window.
        # The complaint that started this: the drill's words stayed on screen over
        # bars spaced by nominal durations while a different verse played, so the
        # accents looked wrong even though they were right.
        ("the splice shows the words it is actually singing",
         "(()=>{const shown=__t.all('#timelineWords .w').map(e=>e.textContent.trim());"
         " const drill=/\\u05e9\\u05dc|\\u05d3\\u05d1\\u05e8/;"   # shalom / davar roots
         " const stillDrill=shown.filter(w=>drill.test(w)).length;"
         " return shown.length>2 && stillDrill<shown.length/2"
         "   ? `OK showing ${shown.slice(0,3).join(' ')} \\u2026` : `still showing the drill: ${shown.slice(0,3).join(' ')}`;})()"),
        ("the cue follows the spliced chant across its seams",
         "(()=>{const seen=new Set(); let maxWord=-1;"
         " const grab=()=>{const m=__t.q('#result').textContent.match(/Real chant \\u00b7 ([^\\u2014]+)/);"
         "   if(m) seen.add(m[1].trim()); maxWord=Math.max(maxWord,__t.wordAt());};"
         " return new Promise(res=>{const t0=Date.now();"
         "   const iv=setInterval(()=>{ grab();"
         "     if (seen.size>1 && maxWord>1 || Date.now()-t0>40000) { clearInterval(iv); __t.key('Escape');"
         "       res(seen.size>1 && maxWord>1 ? `OK crossed ${seen.size} source verses, reached word ${maxWord}`"
         "         : `${seen.size} source(s), furthest word ${maxWord}`); } }, 150);});})()"),
    ]),
    ("haftarah-devarim", [
        ("a haftarah loads as one reading, read straight through",
         "(()=>{const secs=__t.all('.alsec').length;"
         " const label=__t.q('.alsec-label') ? __t.q('.alsec-label').firstChild.textContent.trim() : '';"
         " return secs===1&&/Haftarah/.test(label) ? `OK one section: ${label}`"
         "   : `${secs} sections, first is \"${label}\"`;})()"),
        ("portion controls are hidden for a haftarah (no annual/triennial choice)",
         "(()=>{const ids=['portion','cycToday','btnEditAliyot'].filter(i=>!document.getElementById(i).hidden);"
         " return ids.length ? 'still shown: '+ids.join() : 'OK hidden';})()"),
        ("the header names the parashah it belongs to and its rite",
         "(()=>{const h=__t.q('.aliyot-head'); if(!h) return 'no header';"
         " const t=h.textContent.replace(/\\s+/g,' ').trim();"
         " return /Isaiah 1:1-27/.test(t)&&/Ashkenazi/.test(t) ? 'OK '+t : t;})()"),
        ("it is taught in the haftarah melody, not the Torah one",
         "(()=>{const chip=__t.q('#guideStyle');"
         " return chip&&/Haftarah/.test(chip.textContent) ? 'OK '+chip.textContent.trim()"
         "   : 'style chip says '+(chip?chip.textContent:'(absent)');})()"),
        ("the haftarah melody really is a different tune for the same accent",
         "(()=>Promise.all([fetch('data/trope-shapes.json').then(r=>r.json()),"
         "   fetch('data/haftarah-shapes.json').then(r=>r.json())]).then(([t,h])=>{"
         "   const keys=Object.keys(h.shapes).filter(k=>t.shapes[k]);"
         "   const differ=keys.filter(k=>JSON.stringify(t.shapes[k].steps)!==JSON.stringify(h.shapes[k].steps));"
         "   return differ.length>keys.length/2 ? `OK ${differ.length}/${keys.length} accents sung differently`"
         "     : `only ${differ.length}/${keys.length} differ`;}))()"),
        ("the whole haftarah can be chanted in one go",
         "(()=>{__t.openFirst(); const card=__t.q('.aliyah.haftarah');"
         " if(!card) return 'no whole-haftarah card';"
         " const go=card.querySelector('.al-go'); if(!go) return 'card is locked: '+card.textContent.trim().slice(0,60);"
         " go.click(); const h=__t.q('.aliyah-view .phead h2');"
         " return h&&/Haftarah/.test(h.textContent) ? 'OK '+h.textContent.replace(/\\s+/g,' ').trim()"
         "   : 'reader did not open';})()"),
        ("leaving it returns to the pesukim",
         "(()=>{const b=__t.q('#alBack'); if(!b) return 'no back button'; b.click();"
         " return __t.all('.alsec').length===1 ? 'OK back to the haftarah' : 'lost the section';})()"),
    ]),
    ("shema", [
        ("the excerpt shows only its own passage",
         "(()=>{const titles=__t.all('.alsec-label').map(e=>e.firstChild.textContent.trim());"
         " __t.all('.alsec-head').forEach(h=>h.click());"
         " const rows=__t.all('.verse').length;"
         " return rows===6 ? `OK 6 pesukim in: ${titles.join(' / ')}` : `${rows} pesukim: ${titles.join('/')}`;})()"),
        ("an excerpt keeps its parent's recording",
         "(()=>{__t.pickVerse();"
         " return document.getElementById('btnReal') ? 'OK real chant available' : 'lost the recording';})()"),
        ("excerpt progress is filed under the parent parashah",
         "(()=>{__t.pickVerse();"
         " const t=__t.q('#practice .phead h2').textContent;"
         " return /6:4/.test(t) ? 'OK '+t.trim() : t.trim();})()"),
    ]),
]


# Any passage, any book. This one isn't in the manifest — the reading is assembled
# at runtime from data/tanakh/ — so the probe drives the picker the way a reader
# would, then checks the passage behaves like every other reading.
CUSTOM_STEPS = [
    ("the picker offers every book of the Tanakh, by section",
     "(()=>{__t.q('#btnAnyPassage').click();"
     " return __t.settle(()=>__t.all('#crBook option').length>30, null, null, 10000).then(()=>{"
     "   const groups=__t.all('#crBook optgroup').map(o=>o.label);"
     "   const books=__t.all('#crBook option').length;"
     "   return books>=39&&groups.length===3 ? `OK ${books} books in ${groups.join(' | ')}`"
     "     : `${books} books, groups: ${groups.join('|')}`;});})()"),
    ("picking a Torah book offers its parashiyot",
     "(()=>{const sel=__t.q('#crBook'); sel.value='genesis'; sel.dispatchEvent(new Event('change'));"
     " const label=__t.q('#crScopeLabel').textContent;"
     " const first=__t.q('#crScope').options[0].textContent;"
     " const n=__t.all('#crScope option').length;"
     " return label==='Parashah'&&n===12&&/Bereshit/.test(first) ? `OK 12 parashiyot, from ${first}`"
     "   : `${label}: ${n} options, first ${first}`;})()"),
    ("picking a parashah proposes the whole of it",
     "(()=>{const s=__t.q('#crScope'); s.value='1'; s.dispatchEvent(new Event('change'));"
     " const t=__t.q('#crPreview').textContent.replace(/\\s+/g,' ').trim();"
     " return /Genesis 6:9-11:32/.test(t) ? 'OK '+t : t;})()"),
    ("outside the Torah the scope is the chapter",
     "(()=>{const sel=__t.q('#crBook'); sel.value='jonah'; sel.dispatchEvent(new Event('change'));"
     " const label=__t.q('#crScopeLabel').textContent, n=__t.all('#crScope option').length;"
     " return label==='Chapter'&&n===4 ? 'OK 4 chapters' : `${label}: ${n} options`;})()"),
    ("narrowing to a pasuk range restates the reference in both languages",
     "(()=>{const set=(id,v)=>{const e=__t.q('#'+id); e.value=String(v); e.dispatchEvent(new Event('change'));};"
     " set('crFromC',1); set('crFromV',1); set('crToC',1); set('crToV',10);"
     " const t=__t.q('#crPreview').textContent.replace(/\\s+/g,' ').trim();"
     " return /Jonah 1:1-10/.test(t)&&/\\u05d9\\u05d5\\u05e0\\u05d4/.test(t) ? 'OK '+t : t;})()"),
    ("opening it puts the passage in the reading menu and on screen",
     "(()=>{__t.q('#crOpen').click();"
     " return __t.settle(()=>/^custom:/.test(__t.q('#parashah').value)"
     "   && __t.q('#customModal').hidden && __t.all('.alsec').length>0, null, null, 15000).then(()=>{"
     "   const v=__t.q('#parashah').value, title=__t.q('#textTitle').textContent.trim();"
     "   return v==='custom:jonah:1.1-1.10'&&/Jonah 1:1-10/.test(title)"
     "     ? `OK ${v} \\u2014 ${title}` : `menu=${v} title=${title}`;});})()"),
    ("its pesukim are the ones asked for",
     "(()=>{__t.all('.alsec-head').forEach(h=>{if(!h.closest('.alsec').classList.contains('open')) h.click();});"
     " const rows=__t.all('.verse .vnum').map(e=>e.textContent.trim());"
     " return rows.length===10&&/1:1$/.test(rows[0])&&/1:10$/.test(rows[9])"
     "   ? `OK 10 pesukim, ${rows[0]} \\u2026 ${rows[9]}` : `${rows.length} pesukim: ${rows.join(' ')}`;})()"),
    ("a picked passage is chanted in the haftarah melody",
     "(()=>{const chip=__t.q('#guideStyle');"
     " return chip&&/Haftarah/.test(chip.textContent) ? 'OK '+chip.textContent.trim()"
     "   : 'style chip says '+(chip?chip.textContent:'(absent)');})()"),
    ("no recorded chant is offered for words nobody recorded",
     "(()=>{__t.pickVerse();"
     " return document.getElementById('btnReal') ? 'offered a chant that does not exist'"
     "   : 'OK absent \\u2014 the synthesized guide takes its place';})()"),
    ("a whole pasuk of it still gets a coach line, from the measured shapes",
     "(()=>{__t.unlock('tanakh:jonah:1.1'); __t.pickVerse(); __t.stage(4);"
     " if (__t.q('.locked-page')) return 'whole-verse stage locked';"
     " const w=__t.all('#timelineWords .w').length;"
     " return w>4 ? `OK ${w} words on the coach timeline` : `${w} word(s) — no coach built`;})()"),
    ("the English column fills in on demand",
     "(()=>{const t=__t.q('#tgEnglish'); if(t.classList.contains('on')) t.click();"
     " t.click();"
     " return __t.settle(()=>__t.all('.ventext').length>0, null, null, 10000).then(()=>{"
     "   const n=__t.all('.ventext').length; const first=n?__t.q('.ventext').textContent.trim():'';"
     "   t.click();"
     "   return n>0 ? `OK ${n} verses translated: \"${first.slice(0,40)}\u2026\"` : 'no translation arrived';});})()"),
    ("the whole passage can be chanted in one go",
     "(()=>{__t.q('#tgVowels').click(); __t.q('#tgVowels').click();"
     " __t.openFirst(); const card=__t.q('.aliyah.passage');"
     " if(!card) return 'no whole-passage card';"
     " const go=card.querySelector('.al-go'); if(!go) return 'card is locked: '+card.textContent.trim().slice(0,60);"
     " go.click(); const h=__t.q('.aliyah-view .phead h2');"
     " return h&&/Whole passage/.test(h.textContent) ? 'OK '+h.textContent.replace(/\\s+/g,' ').trim()"
     "   : 'reader did not open';})()"),
    ("its progress is filed under the book and where the passage starts",
     "(()=>{const k=Object.keys(JSON.parse(localStorage.getItem('cantillate.v1')||'{}').levels||{});"
     " const mine=k.filter(x=>x.startsWith('tanakh:jonah:1.1:'));"
     " return mine.length ? `OK ${mine.length} keys under tanakh:jonah:1.1` : 'nothing filed under the book';})()"),
    ("the passage is remembered, so it survives a reload",
     "(()=>{const raw=JSON.parse(localStorage.getItem('cantillate.customRanges')||'[]');"
     " return raw.length&&raw[0].book==='jonah' ? `OK ${raw.length} remembered` : 'not remembered: '+JSON.stringify(raw);})()"),
]

# Naming a passage. A reference is how a passage is found; a name is what the
# reader calls it — so a named one has to reach the Reading menu under that name,
# come back under it after a reload, and give the name up without taking the
# passage or anything practiced in it away.
NAMED_STEPS = [
    ("a passage can be given a name",
     "(()=>{__t.q('#btnAnyPassage').click();"
     " return __t.settle(()=>__t.all('#crBook option').length>30, null, null, 10000).then(()=>{"
     "   const set=(id,v)=>{const e=__t.q('#'+id); e.value=String(v); e.dispatchEvent(new Event('change'));};"
     "   set('crBook','jonah'); set('crFromC',2); set('crFromV',1); set('crToC',2); set('crToV',10);"
     "   const box=__t.q('#crName'); box.value='Yom Kippur mincha';"
     "   box.dispatchEvent(new Event('input')); __t.q('#crSave').click();"
     "   const saved=JSON.parse(localStorage.getItem('cantillate.v1')||'{}').passages;"
     "   const list=(saved&&saved.list)||[];"
     "   return list.length===1&&list[0].name==='Yom Kippur mincha'&&list[0].book==='jonah'"
     "     ? `OK saved \"${list[0].name}\"` : 'saved: '+JSON.stringify(list);});})()"),
    ("the name, not the reference, is what the reading menu shows",
     "(()=>{const g=__t.all('#parashah optgroup').find(o=>o.label==='Any passage');"
     " if(!g) return 'no Any passage group';"
     " const o=[...g.children].find(x=>x.value==='custom:jonah:2.1-2.10');"
     " return o&&o.textContent==='Yom Kippur mincha' ? `OK ${o.textContent} (${o.value})`"
     "   : 'menu says: '+[...g.children].map(x=>x.textContent).join(' | ');})()"),
    ("the reference it stands for is still there to be seen",
     "(()=>{const g=__t.all('#parashah optgroup').find(o=>o.label==='Any passage');"
     " const o=[...g.children].find(x=>x.value==='custom:jonah:2.1-2.10');"
     " return /Jonah 2:1-10/.test(o.title) ? 'OK '+o.title.split(' · ')[0] : 'title: '+o.title;})()"),
    ("a saved passage is offered by name in the picker, and Save becomes Rename",
     "(()=>{const chip=__t.q('#crSaved .cr-chip');"
     " const label=__t.q('#crSaved .label');"
     " const btn=__t.q('#crSave').textContent;"
     " return chip&&/Yom Kippur mincha/.test(chip.textContent)&&/Jonah 2:1-10/.test(chip.textContent)"
     "   && label.textContent==='Saved' && btn==='Rename'"
     "   ? `OK ${chip.textContent.replace(/\\s+/g,' ')} · button says ${btn}`"
     "   : `chip=${chip?chip.textContent:'(none)'} button=${btn}`;})()"),
    ("opening it by name puts the name on the passage itself",
     "(()=>{__t.q('#crSaved .cr-chip').click();"
     " return __t.settle(()=>__t.q('#parashah').value==='custom:jonah:2.1-2.10'"
     "   && __t.all('.alsec').length>0, null, null, 15000).then(()=>{"
     "   const title=__t.q('#textTitle').textContent.replace(/\\s+/g,' ').trim();"
     "   const head=__t.q('.aliyot-head') ? __t.q('.aliyot-head').textContent.replace(/\\s+/g,' ').trim() : '';"
     "   return /^Yom Kippur mincha/.test(title)&&/Jonah 2:1-10/.test(title)&&/^Yom Kippur mincha/.test(head)"
     "     ? `OK ${title}` : `title=${title} head=${head}`;});})()"),
    ("naming it moved nothing: progress is still filed under book and first pasuk",
     "(()=>{__t.unlock('tanakh:jonah:2.1'); __t.pickVerse(); __t.stage(4);"
     " if (__t.q('.locked-page')) return 'the stage is locked \\u2014 progress moved with the name';"
     " const w=__t.all('#timelineWords .w').length;"
     " return w>2 ? `OK still under tanakh:jonah:2.1 (${w} words on the coach timeline)`"
     "   : `${w} word(s) — no coach built`;})()"),
    ("a named passage isn't listed twice, once under each name",
     "(()=>{__t.q('#btnAnyPassage').click();"
     " return __t.settle(()=>!!__t.q('#crSaved .cr-chip'), null, null, 10000).then(()=>{"
     "   const saved=__t.all('#crSaved .cr-chip').map(b=>b.dataset.from+'-'+b.dataset.to);"
     "   const recent=__t.all('#crRecent .cr-chip').map(b=>b.dataset.from+'-'+b.dataset.to);"
     "   __t.key('Escape');"
     "   return saved.includes('2.1-2.10')&&!recent.includes('2.1-2.10')"
     "     ? `OK in Saved (${saved.join()}), not repeated in Recent (${recent.join()})`"
     "     : `saved=${saved.join()} recent=${recent.join()}`;});})()"),
]

# After the second reload: a name is deliberate work, so unlike the recents it
# must survive on its own, and giving it up must not take the passage with it.
NAMED_AFTER_RELOAD_STEPS = [
    ("the name comes back with the passage after a reload",
     "(()=>{const g=__t.all('#parashah optgroup').find(o=>o.label==='Any passage');"
     " if(!g) return 'no Any passage group';"
     " const o=[...g.children].find(x=>x.value==='custom:jonah:2.1-2.10');"
     " return o&&o.textContent==='Yom Kippur mincha' ? 'OK '+o.textContent"
     "   : 'menu says: '+[...g.children].map(x=>x.textContent).join(' | ');})()"),
    ("forgetting the name keeps the passage and its progress",
     "(()=>{__t.q('#btnAnyPassage').click();"
     " return __t.settle(()=>!!__t.q('#crSaved .cr-forget'), null, null, 10000).then(()=>{"
     "   __t.q('#crSaved .cr-forget').click();"
     "   const saved=JSON.parse(localStorage.getItem('cantillate.v1')||'{}').passages;"
     "   const levels=Object.keys(JSON.parse(localStorage.getItem('cantillate.v1')||'{}').levels||{})"
     "     .filter(k=>k.startsWith('tanakh:jonah:2.1:'));"
     "   const g=__t.all('#parashah optgroup').find(o=>o.label==='Any passage');"
     "   const o=[...g.children].find(x=>x.value==='custom:jonah:2.1-2.10');"
     "   const named=((saved&&saved.list)||[]).length;"
     "   __t.key('Escape');"
     "   return named===0&&o&&/Jonah 2:1-10/.test(o.textContent)&&levels.length"
     "     ? `OK back to \"${o.textContent}\", ${levels.length} keys of progress kept`"
     "     : `named=${named} menu=${o?o.textContent:'(gone)'} progress=${levels.length}`;});})()"),
]

# After the reload: the remembered passage must come back as a menu entry without
# the picker being touched, and open from it.
RESTORED_STEPS = [
    ("a remembered passage is back in the reading menu",
     "(()=>{const g=__t.all('#parashah optgroup').find(o=>o.label==='Any passage');"
     " if(!g) return 'no Any passage group';"
     " const opts=[...g.children].map(o=>o.value);"
     " return opts.includes('custom:jonah:1.1-1.10') ? 'OK '+opts.join(', ') : opts.join(', ');})()"),
    ("choosing it re-opens the passage with its progress",
     "(()=>{const s=__t.q('#parashah'); s.value='custom:jonah:1.1-1.10';"
     " s.dispatchEvent(new Event('change'));"
     " return __t.settle(()=>/Jonah 1:1-10/.test(__t.q('#textTitle').textContent), null, null, 15000).then(()=>{"
     "   __t.openFirst(); const card=__t.q('.aliyah.passage');"
     "   const ready=card&&card.classList.contains('ready');"
     "   return ready ? 'OK re-opened, still unlocked' : 'reopened but progress was lost';});})()"),
]


class Chrome:
    def __init__(self):
        self.proc = subprocess.Popen(
            [CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--mute-audio",
             "--autoplay-policy=no-user-gesture-required",
             # A synthetic mic so the record/duet transport can be exercised.
             "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
             f"--remote-debugging-port={PORT}", "--remote-allow-origins=*",
             "--user-data-dir=/tmp/cantillate-appcheck", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        target = None
        for _ in range(80):
            try:
                pages = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
                target = next((p for p in pages if p["type"] == "page"), None)
                if target:
                    break
            except Exception:
                pass
            time.sleep(0.25)
        if not target:
            raise RuntimeError("could not reach headless Chrome")
        self.ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=30)
        self.seq = 0
        self.problems = []
        for m in ("Runtime.enable", "Log.enable", "Page.enable"):
            self.call(m)
        self.call("Page.addScriptToEvaluateOnNewDocument", source=PRELUDE)
        # The record/duet transport needs a microphone; the fake device flags
        # supply the audio, this grants the permission that gates it.
        self.call("Browser.grantPermissions", origin=BASE, permissions=["audioCapture"])

    def call(self, method, **params):
        self.seq += 1
        self.ws.send(json.dumps({"id": self.seq, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.seq:
                return msg
            self.note(msg)

    def note(self, msg):
        method = msg.get("method")
        if method == "Runtime.exceptionThrown":
            d = msg["params"]["exceptionDetails"]
            self.problems.append(f"exception: {d.get('exception', {}).get('description', d.get('text'))}")
        elif method == "Runtime.consoleAPICalled" and msg["params"]["type"] == "error":
            text = " ".join(str(a.get("value", a.get("description", "")))
                            for a in msg["params"].get("args", []))
            self.problems.append(f"console.error: {text}")
        elif method == "Log.entryAdded" and msg["params"]["entry"].get("level") == "error":
            text = msg["params"]["entry"].get("text", "")
            # A reading with no recording legitimately 404s its audio/pitch files.
            if "404" not in text and "Failed to load resource" not in text:
                self.problems.append(f"log: {text}")

    def drain(self, seconds):
        """Absorb any events the page emitted, then restore the blocking timeout
        so the next command/response exchange doesn't inherit the short one."""
        end = time.time() + seconds
        try:
            while time.time() < end:
                self.ws.settimeout(max(0.05, end - time.time()))
                try:
                    self.note(json.loads(self.ws.recv()))
                except Exception:
                    break
        finally:
            self.ws.settimeout(30)

    def eval(self, expr):
        reply = self.call("Runtime.evaluate", expression=f"(()=>{{ return ({expr}); }})()",
                          returnByValue=True, awaitPromise=True)
        res = reply.get("result", {})
        if "exceptionDetails" in res:
            d = res["exceptionDetails"]
            return None, d.get("exception", {}).get("description", d.get("text"))
        return res.get("result", {}).get("value"), None

    def _await_render(self):
        self.drain(1.0)
        for _ in range(60):
            ready, _err = self.eval("document.querySelectorAll('.alsec').length > 0")
            if ready:
                self.drain(0.4)
                return True
            time.sleep(0.25)
        return False

    def goto(self, url):
        self.call("Page.navigate", url=url)
        return self._await_render()

    def reload(self):
        self.call("Page.reload", ignoreCache=True)
        return self._await_render()

    def close(self):
        self.proc.terminate()


def run_steps(c, steps, failures):
    for desc, expr in steps:
        value, err = c.eval(expr)
        c.drain(0.15)
        if err:
            print(f"FAIL {desc}: {err.splitlines()[0]}")
            failures.append(desc)
        elif isinstance(value, str) and value.startswith("OK"):
            print(f"PASS {desc}: {value[3:]}")
        else:
            print(f"FAIL {desc}: {value}")
            failures.append(desc)


# The onboarding wizard: a reader who has been sent a link and knows one fact, the
# date. Each step is one question, and the answer to the date question is the one
# the whole plan hangs on — so it is checked against the calendar rather than just
# for "something appeared".
WIZARD_STEPS = [
    ("the wizard opens on one question at a time",
     "(()=>{const n=__t.all('#onboard .ob-h').length;"
     " return n===1 ? `OK one question: ${__t.ask()}` : `${n} headings on screen`;})()"),
    ("it offers a way past the install advice",
     "(()=>{const r=__t.tap('#obSkipInstall');"
     " return __t.ask()==='What are you learning for?' ? `OK moved on (${r})` : `stuck on ${__t.ask()}`;})()"),
    ("the occasion is asked in plain words, with no jargon",
     "(()=>{const a=__t.answers();"
     " return a.length===4 && /Bar mitzvah/.test(a[0]) && /Learning to chant/.test(a[3])"
     "   ? `OK ${a.length} answers: ${a.map(s=>s.split(' ')[0]).join(', ')}` : `answers were ${JSON.stringify(a)}`;})()"),
    ("and three sample shortcuts sit under it for a quick try",
     "(()=>{const d=__t.all('[data-demo]').map(b=>b.dataset.demo);"
     " return d.join(',')==='shema,parasha,drills'"
     "   ? `OK ${d.join(', ')}` : `demos were ${JSON.stringify(d)}`;})()"),
    ("choosing an answer IS moving on \u2014 no second tap on Next",
     "(()=>{__t.tap('[data-occ=\"barmitzvah\"]');"
     " return /Whose bar mitzvah/.test(__t.ask()) ? `OK ${__t.ask()}` : `landed on ${__t.ask()}`;})()"),
    ("whose it is decides whether a name is asked for",
     "(()=>{__t.tap('[data-role=\"family\"]');"
     " return /What shall we call/.test(__t.ask()) ? `OK ${__t.ask()}` : `landed on ${__t.ask()}`;})()"),
    ("the name is taken and carried forward",
     "(()=>{const i=__t.q('#obName'); i.value='Noa';"
     " i.dispatchEvent(new Event('input',{bubbles:true})); __t.tap('#obNext');"
     " return /When is it/.test(__t.ask()) ? 'OK on to the date' : `landed on ${__t.ask()}`;})()"),
    ("the date field is bounded by the calendar the app ships",
     "(()=>{const d=__t.q('#obDate');"
     " return d && d.min && d.max && d.min < d.max ? `OK ${d.min} to ${d.max}` : 'no bounds on the date';})()"),
    # The load-bearing step. A wrong parashah here is six months of the wrong
    # practice, so the app has to name it, in both languages, with its passages.
    ("a date names the parashah read that week, in both languages",
     "(async()=>{const cal=await import('/js/calendar.js'); await cal.load();"
     " const want=cal.all().find(r=>r.parashah==='Eikev' && r.date>cal.today());"
     " const d=__t.q('#obDate'); d.value=want.date; d.dispatchEvent(new Event('input',{bubbles:true}));"
     " return __t.settle(()=>!!__t.q('.ob-parashah'), null, null, 4000).then(()=>{"
     "   const card=__t.q('.ob-parashah'); if(!card) return 'no parashah was named';"
     "   const name=__t.text(__t.q('.ob-pname')), he=__t.text(__t.q('.ob-phe'));"
     "   return name===want.parashah && he===want.hebrew"
     "     ? `OK ${want.date} \u2192 ${name} / ${he}` : `named ${name} / ${he}, wanted ${want.parashah}`;});})()"),
    ("and the passages that go with it",
     "(()=>{const t=__t.text(__t.q('.ob-refs'));"
     " return /Deuteronomy/.test(t) && /Isaiah/.test(t) ? `OK ${t}` : `refs were ${t}`;})()"),
    ("a reader who doesn't know the date can browse every parashah instead",
     "(()=>{__t.tap('#obNoDate');"
     " const n=__t.all('.ob-prow').length;"
     " return n>=53 ? `OK ${n} parashiyot listed, each with its next Shabbat` : `only ${n} listed`;})()"),
    ("the list filters as you type",
     "(()=>{const f=__t.q('#obFilter'); f.value='shof';"
     " f.dispatchEvent(new Event('input',{bubbles:true}));"
     " const shown=__t.all('.ob-prow').filter(b=>!b.hidden);"
     " return shown.length===1 && /Shoftim/.test(__t.text(shown[0]))"
     "   ? `OK filtered to ${__t.text(shown[0])}` : `${shown.length} rows matched 'shof'`;})()"),
    ("Back returns to the date, with the date still on it",
     "(()=>{__t.tap('.ob-back');"
     " const d=__t.q('#obDate');"
     " return /When is it/.test(__t.ask()) && d && d.value"
     "   ? `OK back on the date, still ${d.value}` : `landed on ${__t.ask()}`;})()"),
    ("the cycle question says which third of the cycle that date falls in",
     "(()=>{__t.tap('#obNext');"
     " const a=__t.answers(), note=__t.text(__t.q('.ob-note'));"
     " return /How much is being read/.test(__t.ask()) && a.length===2 && /year [123]/.test(note)"
     "   ? `OK ${note}` : `asked ${__t.ask()} / ${JSON.stringify(a)} / ${note}`;})()"),
    ("a bar mitzvah defaults to the maftir and the haftarah, already chosen",
     "(()=>{__t.tap('[data-cycle=\"annual\"]'); __t.tap('#obNext');"
     " const on=__t.all('.ob-part.on').map(b=>__t.text(b.querySelector('.ob-part-name')));"
     " return on.length===2 && on.includes('Maftir') && on.includes('Haftarah')"
     "   ? `OK ${on.join(' + ')}` : `chosen: ${JSON.stringify(on)}`;})()"),
    ("and each one can be turned off and on again",
     "(()=>{__t.tap('[data-part=\"maftir\"]');"
     " const off=__t.all('.ob-part.on').length; __t.tap('[data-part=\"maftir\"]');"
     " const back=__t.all('.ob-part.on').length;"
     " return off===1 && back===2 ? 'OK toggles' : `went ${off} then ${back}`;})()"),
    # "You have the third aliyah" is how a reader is told, and a number on its own
    # gives them no way to check they picked the right one.
    ("the seven aliyot are offered with the pesukim each one covers",
     "(()=>{const refs=__t.all('.ob-alnum-ref').map(e=>__t.text(e));"
     " return refs.length===7 && new Set(refs).size===7"
     "   && refs.every(r=>/^\\d+:\\d+-\\d+:\\d+$/.test(r))"
     "   ? `OK ${refs.join(', ')}` : `ranges shown: ${JSON.stringify(refs)}`;})()"),
    # Eight months of practice lives in one browser's localStorage until someone
    # signs in, and this is the only moment where saying so costs the reader
    # nothing: the questions are answered and the first take hasn't happened. The
    # way past it matters as much as the offer — a reader who is offline, has
    # popups blocked, or is on a build with no Firebase project must not be
    # trapped on a sign-in screen, so this tolerates the screen being absent.
    ("the questions end by offering an account to save the progress to",
     "(()=>{__t.tap('#obNext');"
     " if(/will be chanting/.test(__t.text(__t.q('#obBody'))))"
     "   return 'OK no account screen \u2014 sign-in is unavailable in this build';"
     " const ask=__t.ask(), g=__t.q('#obSignIn'), onward=!!(__t.q('#obSkipAccount')||__t.q('#obNext'));"
     " return /Save Noa\u2019s progress/.test(ask) && onward"
     "   ? `OK \u201c${ask}\u201d, google=${!!g}, with a way past it`"
     "   : `asked ${ask} / google=${!!g} / onward=${onward}`;})()"),
    ("declining it leaves the plan intact and says where practice will be kept",
     "(()=>{if(!/will be chanting/.test(__t.text(__t.q('#obBody'))))"
     "   __t.tap(__t.q('#obSkipAccount') ? '#obSkipAccount' : '#obNext');"
     " const note=__t.text(__t.q('#obBody .ob-note'));"
     " return /this browser only/.test(note) || /Saving to your account/.test(note)"
     "   ? `OK ${note.slice(0, 80)}` : `said ${note.slice(0, 120) || '(nothing)'}`;})()"),
    ("the last screen says what was decided, in the learner's name",
     "(()=>{const t=__t.text(__t.q('#obBody'));"
     " return /Noa will be chanting/.test(t) && /Eikev/.test(t) && /Maftir/.test(t)"
     "   ? `OK ${t.slice(0, 90)}` : `said ${t.slice(0, 120)}`;})()"),
]

# Quick-start demos on the occasion screen: skip the wizard entirely and land in
# guided mode on a known reading. Checked on their own clean slate so they don't
# collide with the full wizard walkthrough that follows.
DEMO_STEPS = [
    ("the install screen still offers a way past",
     "(()=>{const r=__t.tap('#obSkipInstall');"
     " return __t.ask()==='What are you learning for?' ? `OK moved on (${r})` : `stuck on ${__t.ask()}`;})()"),
    ("Demo Shema skips the rest of the wizard and opens guided mode",
     "(async()=>{__t.tap('[data-demo=\"shema\"]');"
     " return __t.settle(()=>document.body.classList.contains('guided') && !!__t.q('.g-task')"
     "   && __t.q('#parashah') && __t.q('#parashah').value==='shema', null, null, 15000)"
     "   .then(()=>{"
     "     const part=__t.text(__t.q('.g-top-part'));"
     "     return document.body.classList.contains('guided') && __t.q('#parashah').value==='shema'"
     "       ? `OK guided on Shema (${part})` : `guided=${document.body.classList.contains('guided')}"
     " reading=${__t.q('#parashah')&&__t.q('#parashah').value} part=${part}`;"
     "   });})()"),
    ("the demo plan is saved so a reload stays in guided mode",
     "(()=>{const p=JSON.parse(localStorage.getItem('cantillate.v1')||'{}').plan;"
     " return p && p.demo==='shema' && p.custom && p.custom.haftarah"
     "   && p.custom.haftarah.recordedAs==='shema'"
     "   ? `OK demo plan, part labeled ${p.custom.haftarah.label}` : `stored ${JSON.stringify(p)}`;})()"),
]

# Guided mode proper: the narrowed surface the wizard hands over to.
GUIDED_STEPS = [
    ("finishing the wizard starts the reader on their own reading",
     "(()=>{__t.tap('#obFinish');"
     " return __t.settle(()=>document.body.classList.contains('guided') && !!__t.q('.g-task'),"
     "   null, null, 12000).then(()=>document.body.classList.contains('guided')"
     "     ? `OK guided mode, on ${__t.q('#parashah').value}` : 'never entered guided mode');})()"),
    ("the plan is remembered, not just acted on",
     "(()=>{const p=JSON.parse(localStorage.getItem('cantillate.v1')||'{}').plan;"
     " return p && p.slug==='eikev' && p.learner==='Noa' && p.parts.length===2"
     "   ? `OK ${p.parashah} for ${p.learner}, ${p.parts.length} parts` : `stored ${JSON.stringify(p)}`;})()"),
    ("the workshop's chrome is out of the way",
     "(()=>{const hidden=['.mobilebar','.toolbar.stagebar','footer.src','#practice .transport']"
     "   .filter(s=>{const e=__t.q(s); return !e || getComputedStyle(e).display==='none';});"
     " return hidden.length===4 ? 'OK the settings sheet, stage bar, footer and transport are hidden'"
     "   : `still showing: ${hidden.length}/4 hidden`;})()"),
    ("the top bar names the part and the round, with the five rounds as pips",
     "(()=>{const part=__t.text(__t.q('.g-top-part')), round=__t.text(__t.q('.g-top-round'));"
     " const pips=__t.all('.g-pip').length;"
     " return part==='Maftir' && /Round 1/.test(round) && pips===5"
     "   ? `OK ${part} \u00b7 ${round} \u00b7 ${pips} pips` : `${part} / ${round} / ${pips} pips`;})()"),
    ("the mission says what to do, why this piece, and where in it you are",
     "(()=>{const task=__t.text(__t.q('.g-task')), why=__t.text(__t.q('.g-why-tag'));"
     " const where=__t.text(__t.q('.g-where'));"
     " return task && why && /Deuteronomy \\d+:\\d+/.test(where) && /word 1 of/.test(where)"
     "   ? `OK ${task} \u2014 ${why} \u2014 ${where}` : `${task} / ${why} / ${where}`;})()"),
    ("and there are two buttons, not twenty",
     "(()=>{const b=__t.all('.g-act').map(x=>__t.text(x));"
     " return b.length===2 && /Listen/.test(b[0]) && /Sing/.test(b[1])"
     "   ? `OK ${b.join(' / ')}` : `bar was ${JSON.stringify(b)}`;})()"),
    ("Listen plays the word, and the bar becomes one Stop while it does",
     "(()=>{__t.tap('.g-listen');"
     " return __t.settle(()=>__t.all('.g-act').length===1 && /Stop/.test(__t.text(__t.q('.g-act'))),"
     "   'OK one Stop button while it plays', 'the bar never changed', 6000);})()"),
    ("and goes back to Listen and Sing when it finishes",
     "(()=>__t.settle(()=>__t.all('.g-act').length>=2,"
     "   'OK the bar came back', 'the bar stayed on Stop', 20000))()"),
    ("singing it records a take and scores it, with one number and one next step",
     "(()=>{__t.tap('.g-sing');"
     " return __t.settle(()=>__t.all('.g-act').some(b=>/Stop/.test(__t.text(b))), null, null, 8000)"
     "  .then(()=>__t.after(1200, ()=>__t.key('Escape')))"
     "  .then(()=>__t.settle(()=>!!__t.q('.g-score'), null, null, 9000))"
     "  .then(()=>{const s=__t.q('.g-score'), acts=__t.all('.g-result-actions button');"
     "    return s && acts.length===2"
     "      ? `OK scored ${__t.text(s)}, offering ${acts.map(b=>__t.text(b)).join(' / ')}`"
     "      : `no verdict (${s?__t.text(s):'no score'}, ${acts.length} buttons)`;});})()"),
    ("the menu shows the plan, its parts and how far each round has got",
     "(()=>{__t.tap('.g-menu-btn');"
     " const head=__t.text(__t.q('.g-menu-head'));"
     " const parts=__t.all('.g-part').length, bars=__t.all('.g-part .g-rbar').length;"
     " return /Noa/.test(head) && /Eikev/.test(head) && parts===2 && bars===parts*5"
     "   ? `OK ${parts} parts, five rounds each: ${head.slice(0,60)}` : `${parts} parts / ${bars} bars / ${head.slice(0,60)}`;})()"),
    ("and lets a reader switch to the other part they have to learn",
     "(()=>{const rows=__t.all('.g-part');"
     " const other=rows.find(r=>!r.classList.contains('on')); if(!other) return 'no other part offered';"
     " other.querySelector('.g-part-main').click();"
     " return __t.settle(()=>__t.text(__t.q('.g-top-part'))==='Haftarah', null, null, 15000)"
     "   .then(()=>{const p=__t.text(__t.q('.g-top-part'));"
     "     return p==='Haftarah' ? `OK now on the ${p}, ${__t.q('#parashah').value}`"
     "       : `still on ${p}`;});})()"),
    ("the settings include full-reading text and the core guided aids",
     "(()=>{__t.tap('.g-menu-btn'); const rows=__t.all('.g-row').map(r=>__t.text(r));"
     " return rows.length===5 && /Full-reading text/.test(rows[0]) && /aligned/.test(rows[1])"
     "   && /Text size/.test(rows[2]) && /English letters/.test(rows[3]) && /pitch/.test(rows[4])"
     "   ? `OK ${rows.join(' / ')}` : `settings were ${JSON.stringify(rows)}`;})()"),
    # Guided mode hides the workshop's settings sheet, so this is the only door to
    # the aid for the reader who most needs it — and it has to shut itself at the
    # stage the aid stops being allowed, rather than offering a dead switch.
    ("reading in English letters can be switched on here, and says when it comes off",
     "(()=>{const box=__t.q('#gTranslit'); if(!box) return 'no transliteration row in the menu';"
     " box.click(); box.dispatchEvent(new Event('change'));"
     " const on=__t.all('#timelineWords .wtl').length, words=__t.all('#timelineWords .w').length;"
     " const note=__t.all('.g-menu-note').map(n=>__t.text(n)).find(t=>/English letters/.test(t));"
     " box.click(); box.dispatchEvent(new Event('change'));"
     " const off=__t.all('#timelineWords .wtl').length;"
     " return on===words && words>0 && off===0 && /Pesukim round/.test(note||'')"
     "   ? `OK ${on}/${words} words, and it says \u201c${(note||'').slice(0, 70)}\u2026\u201d`"
     "   : `on=${on}/${words} off=${off} note=${(note||'(none)').slice(0, 90)}`;})()"),
    # A reader who said "not now" to the wizard's account screen, or who has since
    # been handed a different phone, must not have to go to the workshop to sign in:
    # guided mode owns the whole screen precisely so they never see its topbar.
    ("signing in is offered here too, for whoever put it off in the wizard",
     "(()=>{const btn=__t.q('#gSignIn'); if(!btn) return 'no sign-in offered in the menu';"
     " const heads=__t.all('.g-menu-h').map(h=>__t.text(h));"
     " const note=__t.text([...__t.all('.g-menu-note')].find(n=>/browser only/.test(n.textContent)));"
     " return heads.includes('Saving your progress') && /Sign in with Google/.test(__t.text(btn)) && note"
     "   ? `OK \u201c${__t.text(btn)}\u201d \u2014 ${note.slice(0, 60)}`"
     "   : `heads=${JSON.stringify(heads)} button=${__t.text(btn)} note=${note}`;})()"),
    ("the guided menu opens the full part in synchronized STA\"M and pointed text",
     "(()=>{const mode=__t.q('#gScrollTextMode'); if(!mode) return 'no full-reading mode setting';"
     " mode.value='dual'; mode.dispatchEvent(new Event('change',{bubbles:true}));"
     " return __t.after(100, ()=>{__t.tap('#gWholeAliyah');"
     "   return __t.settle(()=>document.body.classList.contains('aliyah-open')"
     "     && !!__t.q('#scrollStamTrack') && !!__t.q('#scrollPointedTrack')"
     "     && __t.all('#scrollStamTrack .sw.yad-start').length===1"
     "     && __t.all('#scrollPointedTrack .sw.yad-start').length===1,"
     "     null, null, 12000).then(()=>{"
     "       const a=__t.q('#scrollStamTrack .sw.yad-start');"
     "       const b=__t.q('#scrollPointedTrack .sw.yad-start');"
     "       return a&&b&&a.dataset.verse===b.dataset.verse&&a.dataset.widx===b.dataset.widx"
     "         ? `OK both start at verse ${a.dataset.verse}, word ${a.dataset.widx}`"
     "         : `start mismatch: ${a&&a.dataset.verse}:${a&&a.dataset.widx} / ${b&&b.dataset.verse}:${b&&b.dataset.widx}`;"
     "     });});})()"),
    ("the same guided-read pointer moves through both full-reading texts",
     "(()=>{__t.tap('.g-listen');"
     " return __t.settle(()=>__t.all('#scrollStamTrack .sw.yad-cur').length>0"
     "   && __t.all('#scrollPointedTrack .sw.yad-cur').length>0, null, null, 12000)"
     "   .then(()=>{const a=__t.q('#scrollStamTrack .sw.yad-cur');"
     "     const b=__t.q('#scrollPointedTrack .sw.yad-cur'); __t.key('Escape');"
     "     return a&&b&&a.dataset.verse===b.dataset.verse&&a.dataset.widx===b.dataset.widx"
     "       ? `OK pointer at verse ${a.dataset.verse}, word ${a.dataset.widx}`"
     "       : 'the two pointers did not agree';});})()"),
    ("the workshop is one tap away, and the way back is the chip in its header",
     "(()=>{__t.tap('#gExpert');"
     " return __t.settle(()=>!document.body.classList.contains('guided'), null, null, 6000)"
     "  .then(()=>{const chip=__t.q('.learn-chip'); if(!chip) return 'no way back was offered';"
     "    const label=__t.text(chip); chip.click();"
     "    return __t.settle(()=>document.body.classList.contains('guided'), null, null, 15000)"
     "      .then(()=>document.body.classList.contains('guided')"
     "        ? `OK out to the workshop and back in via \u201c${label}\u201d` : `could not get back in (chip said ${label})`);});})()"),
    ("the reading being prepared is starred in the workshop's own menu",
     "(()=>{__t.tap('#gExpert');"
     " return __t.settle(()=>!document.body.classList.contains('guided'), null, null, 6000).then(()=>{"
     "   const starred=[...document.querySelectorAll('#parashah option')]"
     "     .filter(o=>/\u2605/.test(o.textContent)).map(o=>o.value);"
     "   return starred.includes('eikev') && starred.includes('haftarah-eikev')"
     "     ? `OK starred: ${starred.join(', ')}` : `starred: ${JSON.stringify(starred)}`;});})()"),
]

# Chanting something other than the appointed haftarah. Plenty of b'nei mitzvah do
# — a shul's own custom, a special Shabbat, a passage chosen for the child — so the
# plan has to bend to the reader rather than to the calendar. The workshop's ✦ Any
# passage machinery does the work; what these steps check is that the guided reader
# can reach it in three taps, that a choice is clamped rather than refused, and that
# the substitution then behaves like the reading he is learning: it opens, it scores
# under its own pesukim, and it can be given back.
SWAP_STEPS = [
    ("the haftarah he was given can be traded for one from another book",
     "(()=>{const chip=__t.q('.learn-chip'); if(chip) chip.click();"
     " return __t.settle(()=>document.body.classList.contains('guided'), null, null, 15000).then(()=>{"
     "   __t.tap('.g-menu-btn');"
     "   const haf=__t.all('.g-part').find(r=>/Haftarah/.test(r.textContent));"
     "   if(!haf) return 'no haftarah row in the menu';"
     "   haf.querySelector('.g-part-swap').click();"
     "   return __t.settle(()=>!!__t.q('#gPickBook'), null, null, 12000).then(()=>{"
     "     const q=__t.ask(), sub=__t.text(__t.q('#guidedPick .ob-sub'));"
     "     const at=__t.q('#gPickBook').value;"
     "     return /Noa/.test(q) && /Isaiah 49:14-51:3/.test(sub) && at==='isaiah'"
     "       ? `OK \u201c${q}\u201d, open at the appointed ${at}` : `${q} / ${sub} / ${at}`;});});})()"),
    ("landing back on the appointed passage is not called a substitution",
     "(()=>{const go=__t.text(__t.q('#gPickGo'));"
     " const set=(id,v)=>{const s=__t.q(id); s.value=String(v);"
     "   s.dispatchEvent(new Event('change',{bubbles:true}));};"
     " set('#gPickToC',52);"
     " const moved=__t.text(__t.q('#gPickGo'));"
     " set('#gPickToC',51); set('#gPickToV',3);"
     " return go==='Chant this' && moved==='Chant this instead' && __t.text(__t.q('#gPickGo'))==='Chant this'"
     "   ? `OK \u201c${go}\u201d on the appointed passage, \u201c${moved}\u201d once it moves`"
     "   : `${go} then ${moved}`;})()"),
    ("it offers the whole Tanakh, and says what each choice comes to",
     "(()=>{const set=(id,v)=>{const s=__t.q(id); s.value=String(v);"
     "   s.dispatchEvent(new Event('change',{bubbles:true}));};"
     " const books=__t.all('#gPickBook option').length;"
     " set('#gPickBook','amos'); set('#gPickFromC',9); set('#gPickFromV',8);"
     " set('#gPickToC',9); set('#gPickToV',15);"
     " const info=__t.text(__t.q('#gPickInfo'));"
     " return books>30 && /Amos 9:8-15/.test(info) && /8 pesukim/.test(info)"
     "   ? `OK ${books} books \u00b7 ${info}` : `${books} books / ${info}`;})()"),
    ("dragging one end past the other takes the other end with it",
     "(()=>{const set=(id,v)=>{const s=__t.q(id); s.value=String(v);"
     "   s.dispatchEvent(new Event('change',{bubbles:true}));};"
     " set('#gPickToV',4);"
     " const back=__t.text(__t.q('#gPickInfo .ob-pname'));"
     " set('#gPickFromV',12);"
     " const fwd=__t.text(__t.q('#gPickInfo .ob-pname'));"
     " set('#gPickFromV',8); set('#gPickToV',15);"
     " return back==='Amos 9:4' && fwd==='Amos 9:12'"
     "   ? `OK end pulled back to ${back}, then start pushed on to ${fwd}`"
     "   : `back=${back} forward=${fwd}`;})()"),
    ("a passage too long to prepare is stopped, with the reason",
     "(()=>{const set=(id,v)=>{const s=__t.q(id); s.value=String(v);"
     "   s.dispatchEvent(new Event('change',{bubbles:true}));};"
     " set('#gPickBook','isaiah'); set('#gPickFromC',1); set('#gPickFromV',1);"
     " set('#gPickToC',66); set('#gPickToV',24);"
     " const warn=__t.text(__t.q('#gPickInfo .ob-warn')), off=__t.q('#gPickGo').disabled;"
     " set('#gPickBook','amos'); set('#gPickFromC',9); set('#gPickFromV',8);"
     " set('#gPickToC',9); set('#gPickToV',15);"
     " const on=!__t.q('#gPickGo').disabled;"
     " return warn && off && on ? `OK ${warn}` : `warned \u201c${warn}\u201d, disabled=${off}, re-enabled=${on}`;})()"),
    # Whose voice these words will be in is the thing a reader is most likely to be
    # surprised by, so it is said before they commit: the app has recordings for the
    # readings it was built with and nothing else, and most of Tanakh is "nothing
    # else". Getting this wrong looks like a broken recording rather than an absent one.
    ("it says whether anyone has recorded the passage",
     "(()=>{const note=__t.text(__t.q('#gPickInfo .ob-note'));"
     " const claims=!!__t.q('#gPickInfo .ob-good');"
     " return /No one has recorded these pesukim/.test(note) && !claims"
     "   ? `OK ${note.slice(0, 80)}\u2026` : `note=${note.slice(0,90)} claims-a-recording=${claims}`;})()"),
    ("choosing it opens it there and then \u2014 he is learning Amos now",
     "(()=>{__t.tap('#gPickGo');"
     " return __t.settle(()=>__t.q('#parashah').value==='custom:amos:9.8-9.15'"
     "   && !!__t.q('.g-where'), null, null, 20000).then(()=>{"
     "   const part=__t.text(__t.q('.g-top-part')), where=__t.text(__t.q('.g-where'));"
     "   const open=!!__t.q('#guidedPick') || document.body.classList.contains('g-menu-open');"
     "   return part==='Haftarah' && /Amos 9:8/.test(where) && !open"
     "     ? `OK ${part}: ${where}` : `${part} / ${where} / sheet-still-open=${open}`;});})()"),
    ("and it doesn't pretend there is a cantor on it",
     "(()=>{const bar=__t.all('.g-act').map(b=>__t.text(b));"
     " const hint=__t.text(__t.q('.g-hint'));"
     " return /Guide voice/.test(bar[0]) && /synthesized/.test(hint) && /measured/.test(hint)"
     "   ? `OK the bar offers \u201c${bar[0]}\u201d and says why: ${hint.slice(0, 70)}\u2026`"
     "   : `bar=${JSON.stringify(bar)} hint=${hint.slice(0,90)}`;})()"),
    ("the plan says what he is chanting, in place of what he was given",
     "(()=>{const p=JSON.parse(localStorage.getItem('cantillate.v1')||'{}').plan;"
     " const c=(p.custom||{}).haftarah||{};"
     " __t.tap('.g-menu-btn');"
     " const row=__t.text(__t.all('.g-part').find(r=>/Haftarah/.test(r.textContent)));"
     " return c.ref==='Amos 9:8-15' && p.haftarahRef==='Isaiah 49:14-51:3' && /Amos 9:8-15/.test(row)"
     "   ? `OK plan reads ${c.ref} (appointed: ${p.haftarahRef}); menu row: ${row}`"
     "   : `custom=${JSON.stringify(c)} row=${row}`;})()"),
    # The passage is filed under the book and the pasuk it starts at, not under the
    # parashah — so a chant of it has to be read back from there, or the reader's
    # progress would vanish into a reading he is not preparing. Written straight into
    # the store rather than sung, because the fake microphone scores nothing.
    ("what he chants is measured on the passage's own pesukim",
     "(()=>Promise.all([import('/js/store.js'), import('/js/guided.js')]).then(([st,g])=>{"
     "   st.recordAliyahScore('tanakh:amos:9.8', 'annual', 1, 'C', 88);"
     "   const readiness=g.planReadiness();"
     "   __t.tap('.g-menu-btn');"
     "   const row=__t.text(__t.all('.g-part').find(r=>/Haftarah/.test(r.textContent)));"
     "   return /whole: 88/.test(row) && readiness===44"
     "     ? `OK the menu reads \u201c${row}\u201d and the plan is ${readiness}% ready`"
     "     : `row=${row} readiness=${readiness}`;}))()"),
    ("and the workshop now stars the passage he will actually chant",
     "(()=>{__t.tap('#gExpert');"
     " return __t.settle(()=>!document.body.classList.contains('guided'), null, null, 6000).then(()=>{"
     "   const starred=[...document.querySelectorAll('#parashah option')]"
     "     .filter(o=>/\u2605/.test(o.textContent)).map(o=>o.value);"
     "   const chip=__t.q('.learn-chip'); if(chip) chip.click();"
     "   return starred.includes('custom:amos:9.8-9.15') && !starred.includes('haftarah-eikev')"
     "     ? `OK starred: ${starred.join(', ')}` : `starred: ${JSON.stringify(starred)}`;});})()"),
    ("the appointed haftarah can be taken back, and nothing practiced is lost",
     "(()=>__t.settle(()=>document.body.classList.contains('guided'), null, null, 15000).then(()=>{"
     "   __t.tap('.g-menu-btn');"
     "   const haf=__t.all('.g-part').find(r=>/Haftarah/.test(r.textContent));"
     "   haf.querySelector('.g-part-swap').click();"
     "   return __t.settle(()=>!!__t.q('#gPickReset'), null, null, 12000).then(()=>{"
     "     __t.tap('#gPickReset');"
     "     return __t.settle(()=>__t.q('#parashah').value==='haftarah-eikev', null, null, 20000).then(()=>{"
     "       const d=JSON.parse(localStorage.getItem('cantillate.v1')||'{}');"
     "       const kept=Object.keys(d.aliyot||{}).filter(k=>k.startsWith('tanakh:amos:9.8'));"
     "       const gone=!((d.plan.custom||{}).haftarah);"
     "       const where=__t.text(__t.q('.g-where'));"
     "       return gone && /Isaiah 49:14/.test(where) && kept.length"
     "         ? `OK back to ${where}, and the Amos take is still on record (${kept[0]})`"
     "         : `custom-cleared=${gone} where=${where} kept=${kept.length}`;});});}))()"),
    # A custom haftarah is very often another week's, and those the app has built are
    # recorded. Assembling the same words out of the book text would leave a recording
    # of exactly this passage sitting unused, so the substitution opens the reading.
    ("a substituted passage the app has recorded is opened as that recording",
     "(()=>{__t.tap('.g-menu-btn');"
     " const haf=__t.all('.g-part').find(r=>/Haftarah/.test(r.textContent));"
     " haf.querySelector('.g-part-swap').click();"
     " return __t.settle(()=>!!__t.q('#gPickBook'), null, null, 12000).then(()=>{"
     "   const set=(id,v)=>{const s=__t.q(id); s.value=String(v);"
     "     s.dispatchEvent(new Event('change',{bubbles:true}));};"
     "   set('#gPickBook','isaiah'); set('#gPickFromC',40); set('#gPickFromV',1);"
     "   set('#gPickToC',40); set('#gPickToV',26);"
     "   const said=__t.text(__t.q('#gPickInfo .ob-good'));"
     "   __t.tap('#gPickGo');"
     "   return __t.settle(()=>__t.q('#parashah').value==='haftarah-vaetchanan', null, null, 20000)"
     "     .then(()=>{const bar=__t.all('.g-act').map(b=>__t.text(b));"
     "       const c=JSON.parse(localStorage.getItem('cantillate.v1')).plan.custom.haftarah;"
     "       return c.recordedAs==='haftarah-vaetchanan' && /Listen/.test(bar[0])"
     "         ? `OK ${said.slice(0, 80)} \u2014 opened ${c.recordedAs}`"
     "         : `recordedAs=${c.recordedAs} bar=${JSON.stringify(bar)}`;});});})()"),
    # The passage that is nobody's haftarah. A reader given one of those used to be
    # told, correctly, that no one had recorded it — until his teacher did, and
    # scripts/align_recording.py turned that recording into a reading. Nothing here
    # knows it came from a living room: it is found by the same covers lookup as
    # PocketTorah's, so the substitution opens the teacher's voice.
    ("a passage recorded by the reader's own teacher is found the same way",
     "(()=>{__t.tap('.g-menu-btn');"
     " const haf=__t.all('.g-part').find(r=>/Haftarah/.test(r.textContent));"
     " haf.querySelector('.g-part-swap').click();"
     " return __t.settle(()=>!!__t.q('#gPickBook'), null, null, 12000).then(()=>{"
     "   const set=(id,v)=>{const s=__t.q(id); s.value=String(v);"
     "     s.dispatchEvent(new Event('change',{bubbles:true}));};"
     "   set('#gPickBook','i-samuel'); set('#gPickFromC',28); set('#gPickFromV',8);"
     "   set('#gPickToC',28); set('#gPickToV',19);"
     "   const said=__t.text(__t.q('#gPickInfo .ob-good'));"
     "   __t.tap('#gPickGo');"
     "   return __t.settle(()=>__t.q('#parashah').value==='i-samuel-28', null, null, 20000)"
     # Escape first: the step before this one may still be playing Isaiah 40.
     "     .then(()=>{__t.key('Escape');"
     "       return __t.settle(()=>/Listen|Guide voice/.test(__t.text(__t.q('.g-act'))),"
     "         null, null, 8000);})"
     "     .then(()=>{const bar=__t.all('.g-act').map(b=>__t.text(b));"
     "       const c=JSON.parse(localStorage.getItem('cantillate.v1')).plan.custom.haftarah;"
     "       return c.recordedAs==='i-samuel-28' && /Listen/.test(bar[0])"
     "         ? `OK ${said.slice(0, 90)}`"
     "         : `recordedAs=${c.recordedAs} bar=${JSON.stringify(bar)}`;});});})()"),
]


# One of the seven aliyot, rather than a maftir. A gabbai says "you have the third
# aliyah", and the reader has to be shown which pesukim those are — and taught only
# those. The parashah's whole range is the wrong answer twice over: it tells the
# reader nothing, and for the 38 parashiyot the app has no recording of it would
# hand them the entire reading to learn.
SEED_ALIYAH_STEPS = [
    ("a plan can be made for one of the seven aliyot",
     "(async()=>{const cal=await import('/js/calendar.js'), pl=await import('/js/plan.js');"
     " await cal.load();"
     " const w=cal.all().find(r=>r.parashah==='Eikev' && r.date>cal.today());"
     " pl.save(pl.fromShabbat(w,{occasion:'aliyah', role:'self', learner:'', cycle:'triennial',"
     "   parts:[1,2,3,4,5,6,7].map(n=>pl.aliyahPart(n)), enteredDate:w.date}));"
     " const p=pl.get();"
     " return p.parts.length===7 && p.aliyotRefs && p.aliyotRefs.triennial.length===7"
     "   ? `OK ${p.parashah}, year ${p.triYear} of three, all seven aliyot`"
     "   : `stored ${p.parts.length} parts, refs=${JSON.stringify(p.aliyotRefs)}`;})()"),
]

ALIYOT_STEPS = [
    ("each of the seven says which pesukim are its own",
     "(async()=>{const pl=await import('/js/plan.js');"
     " await __t.settle(()=>document.body.classList.contains('guided') && !!__t.q('.g-task'),"
     "   null, null, 20000);"
     " __t.tap('.g-menu-btn');"
     " const refs=__t.all('.g-part-ref').map(r=>__t.text(r));"
     " const p=pl.get(), whole=p.torahRef;"
     " const uniq=new Set(refs).size;"
     " return refs.length===7 && uniq===7 && !refs.includes(whole)"
     "   ? `OK ${refs[0]} \u2026 ${refs[6]} (the parashah itself is ${whole})`"
     "   : `${refs.length} rows, ${uniq} distinct, whole-parashah rows="
     "${refs.filter(r=>r===whole).length}`;})()"),
    ("and the third one opens on the third one's first pasuk",
     "(async()=>{const pl=await import('/js/plan.js');"
     " const want=pl.partRef(pl.aliyahPart(3), pl.get());"
     " const row=__t.all('.g-part').find(r=>/Aliyah 3/.test(r.textContent));"
     " if(!row) return 'no third aliyah in the menu';"
     " row.querySelector('.g-part-main').click();"
     " const first=`${want.split(' ')[0]} ${want.match(/\\d+:\\d+/)[0]}`;"
     " await __t.settle(()=>__t.text(__t.q('.g-top-part'))==='Aliyah 3'"
     "   && __t.text(__t.q('.g-where')).startsWith(first), null, null, 20000);"
     " const where=__t.text(__t.q('.g-where'));"
     " return where.startsWith(first) ? `OK ${want} \u2014 starting at ${where}`"
     "   : `wanted ${first}, got ${where}`;})()"),
    # The case that bites hardest: no recording, so the text is assembled from
    # data/tanakh/ out of the ref the plan carries. If that ref is the parashah's,
    # a reader with one aliyah is quietly given all seven.
    # Choosing an aliyah is asking to sing that aliyah, so it opens at the top of
    # it — even when the pesukim there are done, and even when the schedule would
    # rather move on. Progress is written into the store rather than sung, because
    # the fake microphone scores nothing.
    #
    # Which pesukim those are depends on the triennial year the plan's date falls
    # in, and the date is "the next Eikev from today" — so the aliyah is read out
    # of the reading's own table and the pesukim to seed are taken from it. Hard-
    # coding them held only for the year that happened to be upcoming when this was
    # written, and left the case silently unexercised for two years in every three.
    ("a part opens on its first pasuk however much of it is already done",
     "(async()=>{const st=await import('/js/store.js'), pl=await import('/js/plan.js');"
     " const g=await import('/js/guided.js');"
     " const p=pl.get(), doc=await (await fetch('data/eikev.json')).json();"
     " const a=doc.aliyot.triennial[p.triYear].find(x=>Number(x.n)===3);"
     " __t.part={first:`${doc.book.en} ${a.ref.match(/\\d+:\\d+/)[0]}`, count:a.end-a.start+1};"
     " st.recordVerseLevel('eikev', a.start, 5); st.recordVerseLevel('eikev', a.start+1, 3);"
     " await g.start(p);"
     " await __t.settle(()=>!!__t.q('.g-where') && /pasuk/.test(__t.text(__t.q('.g-where'))),"
     "   null, null, 20000);"
     " const where=__t.text(__t.q('.g-where')), why=__t.text(__t.q('.g-why-tag'));"
     " const round=__t.text(__t.q('.g-top-round'));"
     " const want=`${__t.part.first} \u00b7 pasuk 1 of ${__t.part.count}`;"
     " return where.startsWith(want) && /From the beginning/.test(why)"
     "   && /Round 1/.test(round)"
     "   ? `OK ${where} \u00b7 ${why} \u00b7 ${round}`"
     "   : `wanted ${want} \u2014 where=${where} why=${why} round=${round}`;})()"),
    # And when it does move on, it says so: being stepped over reads as the app
    # losing the reader's place unless it explains itself and offers the way back.
    ("and moving past the finished ones says which they were",
     "(async()=>{const g=await import('/js/guided.js');"
     " g.notifyScore({kind:'verse', passed:true, score:95, threshold:80,"
     "   unitCount:1, unitIndex:0});"
     " await __t.settle(()=>!!__t.q('#gNext'), null, null, 10000);"
     " __t.tap('#gNext');"
     " const want=`pasuk 3 of ${__t.part.count}`;"
     " await __t.settle(()=>__t.text(__t.q('.g-where')).includes(want), null, null, 20000);"
     " const where=__t.text(__t.q('.g-where')), note=__t.text(__t.q('.g-pickup'));"
     " const shown=!!__t.q('.g-pickup') && getComputedStyle(__t.q('.g-pickup')).display!=='none';"
     " return /Pesukim 1\u20132 are already through/.test(note) && shown && where.includes(want)"
     "   ? `OK ${where} \u2014 ${note.slice(0, 60)}\u2026`"
     "   : `wanted ${want} \u2014 where=${where} note=${note.slice(0,90)} shown=${shown}`;})()"),
    ("the menu lists every pasuk with the rounds it has cleared",
     "(()=>{__t.tap('.g-menu-btn');"
     " const chips=__t.all('.g-pasuk').map(b=>({n:__t.text(b.querySelector('.g-pasuk-ref')),"
     "   ticks:b.querySelectorAll('.g-vseg.on').length, here:b.classList.contains('on')}));"
     " const ticks=chips.map(c=>c.ticks).join(',');"
     # The two seeded pesukim have cleared two rounds and one; the rest of the
     # aliyah, however long it is, has cleared none.
     " const want=['2','1'].concat(Array(Math.max(0, __t.part.count-2)).fill('0')).join(',');"
     " return chips.length===__t.part.count && ticks===want && chips[2].here"
     "   ? `OK ${chips.map(c=>c.n+':'+c.ticks).join(' ')} \u00b7 on pasuk ${chips.findIndex(c=>c.here)+1}`"
     "   : `${chips.length} chips, ticks=${ticks}, wanted ${want},"
     " here=${chips.findIndex(c=>c.here)+1}`;})()"),
    ("and tapping the first one goes back to it, at the stage it had reached",
     "(()=>{const first=__t.all('.g-pasuk')[0]; first.click();"
     " return __t.settle(()=>__t.text(__t.q('.g-where')).includes(`pasuk 1 of ${__t.part.count}`),"
     "   null, null, 15000)"
     "  .then(()=>{const where=__t.text(__t.q('.g-where')), why=__t.text(__t.q('.g-why-tag'));"
     "    const round=__t.text(__t.q('.g-top-round'));"
     "    const open=document.body.classList.contains('g-menu-open');"
     "    return where.startsWith(__t.part.first) && /asked for this one/.test(why)"
     "      && /Round 3/.test(round) && !open"
     "      ? `OK ${where} \u00b7 ${why} \u00b7 ${round}`"
     "      : `wanted ${__t.part.first} \u2014 where=${where} why=${why}"
     " round=${round} menu-open=${open}`;});})()"),
    ("a parashah the app has no recording of is still divided into its aliyot",
     "(async()=>{const cal=await import('/js/calendar.js'), pl=await import('/js/plan.js');"
     " const g=await import('/js/guided.js');"
     " await cal.load();"
     " const w=cal.all().find(r=>r.parashah==='Vayishlach' && r.date>cal.today());"
     " pl.save(pl.fromShabbat(w,{occasion:'aliyah', role:'self', cycle:'annual',"
     "   parts:[pl.aliyahPart(3)], enteredDate:w.date}));"
     " const want=pl.partRef(pl.aliyahPart(3), pl.get());"
     " const cv=[...want.matchAll(/(\\d+):(\\d+)/g)].map(m=>`${m[1]}.${m[2]}`);"
     " const wantId=`custom:genesis:${cv[0]}-${cv[1]}`;"
     " await g.start(pl.get());"
     " await __t.settle(()=>!!__t.q('.g-where') && __t.q('#parashah').value.startsWith('custom:'),"
     "   null, null, 25000);"
     " const got=__t.q('#parashah').value, where=__t.text(__t.q('.g-where'));"
     " return got===wantId && where.startsWith(`Genesis ${want.match(/\\d+:\\d+/)[0]}`)"
     "   ? `OK ${w.parashah} aliyah 3 is ${want}, and that is what opened (${got})`"
     "   : `opened ${got}, wanted ${wantId}; where=${where}`;})()"),
]


def main():
    c = Chrome()
    failures = []
    try:
        if not c.goto(APP_URL):
            print("FAIL app never rendered its verse list")
            return 1
        print(f"--- {APP_URL} ---")
        run_steps(c, STEPS, failures)

        print("--- with every stage unlocked ---")
        # Whichever reading the app opened on, not a fixed one: it defaults to the
        # upcoming Shabbat's parashah, so a hardcoded slug silently unlocks the
        # wrong reading (and fails every later step) once the week turns over.
        opened, err = c.eval(
            "(()=>{const s=document.getElementById('parashah').value;"
            " __t.unlock(s); return s;})()")
        if err or not opened:
            print(f"FAIL could not unlock the open reading: {err}")
            return 1
        print(f"(unlocked {opened})")
        if not c.reload():
            print("FAIL app never re-rendered after unlocking")
            return 1
        run_steps(c, UNLOCKED_STEPS, failures)

        print("--- transport, against the real recorded chant ---")
        run_steps(c, TRANSPORT_STEPS, failures)

        print("--- transport, during a duet take ---")
        run_steps(c, RECORD_STEPS, failures)

        for slug, steps in READING_STEPS:
            print(f"--- reading: {slug} ---")
            # One expression: c.eval() wraps its argument in `return (...)`.
            c.eval(f"['{slug}','vaetchanan','eikev'].map(s=>__t.unlock(s)) && 'ok'")
            ok, err = c.eval(
                f"(()=>{{const s=document.getElementById('parashah'); s.value='{slug}';"
                " s.dispatchEvent(new Event('change')); return s.value;})()")
            if err:
                print(f"FAIL switching to {slug}: {err.splitlines()[0]}")
                failures.append(slug)
                continue
            for _ in range(40):
                c.drain(0.25)
                loaded, _e = c.eval(
                    f"document.querySelectorAll('.alsec').length > 0 && document.getElementById('parashah').value === '{slug}'")
                if loaded:
                    break
            run_steps(c, steps, failures)

        print("--- any passage, any book ---")
        run_steps(c, CUSTOM_STEPS, failures)

        print("--- after a reload, the remembered passage ---")
        if not c.reload():
            print("FAIL app never re-rendered after the reload")
            failures.append("reload")
        else:
            run_steps(c, RESTORED_STEPS, failures)

        print("--- a passage saved under a name ---")
        run_steps(c, NAMED_STEPS, failures)

        print("--- after a reload, the named passage ---")
        if not c.reload():
            print("FAIL app never re-rendered after the second reload")
            failures.append("reload")
        else:
            run_steps(c, NAMED_AFTER_RELOAD_STEPS, failures)

        # Guided mode last: it is the one section that changes what the app opens
        # into (a plan is saved), so running it earlier would put every step above
        # behind a wizard.
        print("--- quick-start demos ---")
        # From a clean slate: this section is about skipping the wizard entirely.
        c.eval("(()=>{localStorage.clear(); return 'ok';})()")
        if not c.goto(f"{BASE}/index.html?guided=1"):
            print("FAIL the app never rendered with the wizard open for demos")
            failures.append("demos")
        else:
            run_steps(c, DEMO_STEPS, failures)

        print("--- the onboarding wizard ---")
        # From a clean slate: this section is about a reader's FIRST run, and the
        # steps above have unlocked every stage of half the corpus — which would
        # quite correctly drop the guided reader into round 4 with nothing to learn.
        c.eval("(()=>{localStorage.clear(); return 'ok';})()")
        if not c.goto(f"{BASE}/index.html?guided=1"):
            print("FAIL the app never rendered with the wizard open")
            failures.append("wizard")
        else:
            run_steps(c, WIZARD_STEPS, failures)
            print("--- guided mode ---")
            run_steps(c, GUIDED_STEPS, failures)
            print("--- guided mode: a haftarah of his own ---")
            run_steps(c, SWAP_STEPS, failures)

            print("--- guided mode: one of the seven aliyot ---")
            run_steps(c, SEED_ALIYAH_STEPS, failures)
            # Reloaded rather than switched, because what is being checked is what a
            # reader with an aliyah plan is opened INTO.
            if not c.reload():
                print("FAIL app never re-rendered on the aliyah plan")
                failures.append("aliyot")
            else:
                run_steps(c, ALIYOT_STEPS, failures)

        c.drain(0.5)
        if c.problems:
            print("--- page problems ---")
            for p in dict.fromkeys(c.problems):
                print(f"FAIL {p}")
            failures.extend(c.problems)
    finally:
        c.close()

    print(f"\n{'FAILED: ' + str(len(failures)) if failures else 'ALL CHECKS PASSED'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
