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
        ("the drill set loads as lessons, not aliyot",
         "(()=>{const n=__t.all('.alsec').length, chains=__t.all('.chain').length;"
         " return n>=2&&chains===0 ? `OK ${n} lessons, no aliyah machinery` : `${n} lessons, ${chains} chains`;})()"),
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


def main():
    c = Chrome()
    failures = []
    try:
        if not c.goto(f"{BASE}/index.html"):
            print("FAIL app never rendered its verse list")
            return 1
        print(f"--- {BASE}/index.html ---")
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
