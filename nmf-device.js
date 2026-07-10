// nmf-device.js  (v16)
// ---------------------
// Modes (combinable via toggles):
//   normal:   one full-file NMF, N components -> N tracks, N filter bases
//   fast:     learn bases on ~30s mid-file excerpt, apply fixed to full file
//   centroid: learn N bases on excerpt, RANK them by spectral centroid
//             (rank 1 = brightest), keep the base at "keep rank",
//             sum all others into one, re-run full file with 2 fixed bases
//             -> 2 tracks ("chosen"/"rest") and a 2-way realtime filter.
//
// Buffers (fixed names, must match patch):
//   nmfsrc nmfresyn nmfmono nmfbases nmfbases2 nmfactive
//
// Messages: decompose | start | setcount n | setrank n | setfast 0/1 |
//           setcentroid 0/1 | setfolder path | status | reset
// Wired from patch: nmfdone, composedone, srcloaded

autowatch = 1;
inlets = 1;
outlets = 1;

post("[nmf-device] script v23 loaded OK\n");

// ---- config -----------------------------------------------------------
var SRC = "nmfsrc", RESYN = "nmfresyn", MONO = "nmfmono";
var BASES = "nmfbases", BASES2 = "nmfbases2", ACTIVE = "nmfactive";
var ACTS = "nmfacts";                          // activations (for amplitude ranking)
var TRAIN = "nmftrain";                        // concatenated slices for scattered learning
var CAP = "nmfcap";                            // real-time capture buffer
var CAP_MS = 60000;                            // max capture length (ms)
var PITCHF = "nmfpitchf", PITCHS = "nmfpitchs"; // fluid.bufpitch~ features/stats
var DESC_NAMES = [ "centroid", "flatness", "pitch", "amplitude" ];
var MAXCOMP = 8;              // rank of fluid.nmffilter~ in the patch
var EXCERPT_FRAMES = 1440000; // ~30 s @ 48 kHz
var CLIP_SCENE = 0, UNWARP = 1, TRACK_COLOR = 26, NAME_PREFIX = "component ";
var TO_ARRANGEMENT = 1, KEEP_SESSION_CLIP = 0;

// ---- state --------------------------------------------------------------
var count = 2, keepRank = 1, fastMode = false, centroidMode = false;
var filterOnly = false, runFilterOnly = false;
var descriptor = 1;   // 1=centroid 2=flatness 3=pitch(peak) 4=amplitude
var numSlices = 1;    // 1 = one contiguous excerpt; >1 = scattered slices across the file
var xbSeq = [], xbIdx = 0;
var nmfRunning = false, composeRunning = false;   // strict handshakes
var descRunning = false;                          // pitch/stats chain handshake
var capturing = false, capStartMs = 0;
var capArrTime = 0, capInsertAt = -1;              // placement snapshot at listen-ON
var runSrc = SRC;                                  // which buffer this run analyzes
var userFolder = "", runFolder = "", runPaths = [], runNames = [], stampStr = "";
var idx = 0, bidx = 0, mkIdx = 0, mkSeq = [];
var phase = "comp", nmfPhase = "single";
var runCount = 2, runBasesBuf = BASES;
var insertAt = -1, busy = false, arrTime = 0, srcClipProps = null;
var waitingForFolder = "", waitingForSrc = false;

function log(s) { post("[nmf-device] " + s + "\n"); }

function status() {
    log("count=" + count + " keepRank=" + keepRank + " desc=" + DESC_NAMES[descriptor - 1] +
        " slices=" + numSlices + " fast=" + fastMode + " centroid=" + centroidMode +
        " filterOnly=" + filterOnly + " busy=" + busy +
        " nmfPhase=" + nmfPhase + " phase=" + phase);
}
function reset() {
    busy = false; waitingForFolder = ""; waitingForSrc = false;
    phase = "comp"; nmfPhase = "single";
    nmfRunning = false; composeRunning = false; descRunning = false;
    log("state reset.");
}

// ---- setters ----------------------------------------------------------------
function setcount(n)    { n = Math.floor(n); if (n >= 1) count = n; log("components = " + count); }
function setrank(n)     { n = Math.floor(n); if (n >= 1) keepRank = n; log("keep rank = " + keepRank + " (1 = brightest)"); }
function setfast(n)     { fastMode = (n != 0); log("2-stage fast mode " + (fastMode ? "ON" : "OFF")); }
function setcentroid(n) { centroidMode = (n != 0); log("centroid mode " + (centroidMode ? "ON (keep one rank vs rest)" : "OFF")); }
function setfilteronly(n) {
    filterOnly = (n != 0);
    log("filter-only mode " + (filterOnly ? "ON (no tracks/files, just feed the filter)" : "OFF"));
}
function setdescriptor(n) {
    n = Math.floor(n);
    if (n >= 1 && n <= 4) descriptor = n;
    log("ranking descriptor = " + DESC_NAMES[descriptor - 1] +
        " (rank 1 = highest " + DESC_NAMES[descriptor - 1] + ")");
}
function setslices(n) {
    n = Math.floor(n);
    if (n >= 1 && n <= 32) numSlices = n;
    log("learning slices = " + numSlices +
        (numSlices === 1 ? " (one contiguous excerpt)" : " (scattered across the file)"));
}

// ---- real-time capture: record the track's audio, analyze on stop -----------------
function capture(n) {
    if (n != 0) {
        if (busy) { log("cannot capture while processing."); return; }
        if (capturing) return;
        capturing = true;
        capStartMs = Date.now();
        capArrTime = playheadTime();
        var t = new LiveAPI("live_set view selected_track");
        var sel = (t && t.id != 0) ? trackIndexFromPath(t.unquotedpath) : -1;
        capInsertAt = (sel >= 0) ? sel + 1 : -1;
        outlet(0, "cap", "size", CAP_MS);      // fresh full-length buffer
        outlet(0, "rec", 1);
        log("listening... (max " + (CAP_MS / 1000) + " s, toggle off to analyze; " +
            "results will be placed at beat " + capArrTime.toFixed(2) + ")");
    } else {
        if (!capturing) return;
        capturing = false;
        outlet(0, "rec", 0);
        var ms = Math.min(Date.now() - capStartMs, CAP_MS);
        if (ms < 500) { log("capture too short (" + ms + " ms) - ignored."); return; }
        outlet(0, "cap", "crop", 0, ms);
        log("captured " + (ms / 1000).toFixed(1) + " s - analyzing...");
        var t = new Task(startCapture, this);  // let the crop settle
        t.schedule(100);
    }
}

function setfolder() {
    userFolder = toNative(arrayfromargs(arguments).join(" ")).replace(/[\/]+$/, "");
    log("output folder (sticky): " + userFolder);
    var w = waitingForFolder; waitingForFolder = "";
    if (w === "start") start();
    else if (w === "decompose") decompose();
    else if (w === "capture") startCapture();
}

// ---- path / misc helpers -----------------------------------------------------
function toNative(p) {
    p = String(p).replace(/\\/g, "/");
    var m = p.match(/^([^\/:]+):(\/.*)$/);
    if (m) return (m[1].length === 1) ? p : m[2];
    return p;
}
function dirOf(p) { p = toNative(p); var c = p.lastIndexOf("/"); return c > 0 ? p.substring(0, c) : ""; }
function trackIndexFromPath(path) { var m = String(path).match(/\btracks (\d+)\b/); return m ? parseInt(m[1]) : -1; }
function num(x) { if (x instanceof Array) x = x[0]; return Number(x); }
function bufFrames(name) { try { return (new Buffer(name)).framecount(); } catch (e) { return -1; } }

function resolveFolder(fallbackFile) {
    if (userFolder) return userFolder;
    try {
        var fp = String(new LiveAPI("live_set").get("file_path"));
        if (fp && fp !== "0" && fp !== "undefined" &&
            (fp.indexOf("/") >= 0 || fp.indexOf("\\") >= 0)) {
            var d = dirOf(fp);
            if (d) { log("using Live Set folder: " + d); return d; }
        }
    } catch (e) {}
    if (fallbackFile) {
        var d2 = dirOf(fallbackFile);
        if (d2) { log("Set unsaved - using source file folder: " + d2); return d2; }
    }
    return null;
}

// ---- entry A: decompose the selected clip -------------------------------------
function decompose() {
    if (busy) { log("busy - send 'reset' if stuck."); return; }
    var found = selectedClip();
    if (!found) return;
    runFilterOnly = filterOnly;
    var f = "";
    if (!runFilterOnly) {
        f = resolveFolder(found.path);
        if (!f) {
            log("choose an output folder (remembered afterwards)...");
            waitingForFolder = "decompose";
            outlet(0, "openfolder", "bang");
            return;
        }
    }
    runFolder = f;
    runSrc = SRC;
    insertAt = (found.trackIdx >= 0) ? found.trackIdx + 1 : -1;
    arrTime = found.arrTime;
    srcClipProps = found.props;
    busy = true; waitingForSrc = true;
    log("loading clip: " + found.path);
    outlet(0, "src", "replace", found.path);
}

function srcloaded() {
    if (!waitingForSrc) return;
    waitingForSrc = false;
    log("output -> " + runFolder);
    kickNMF();
}

function selectedClip() {
    var clip = new LiveAPI("live_set view detail_clip");
    if (!clip || clip.id == 0) {
        var slot = new LiveAPI("live_set view highlighted_clip_slot");
        if (slot && slot.id != 0 && parseInt(slot.get("has_clip")) === 1)
            clip = new LiveAPI(slot.unquotedpath + " clip");
    }
    if (!clip || clip.id == 0) { log("no clip selected - click an audio clip in Live first."); return null; }
    if (parseInt(clip.get("is_audio_clip")) !== 1) { log("selected clip is MIDI - pick an AUDIO clip."); return null; }
    var p = toNative(clip.get("file_path"));
    if (!p || p === "0" || p === "undefined") { log("cannot read clip file path."); return null; }

    var t = playheadTime();
    try {
        if (parseInt(clip.get("is_arrangement_clip")) === 1)
            t = num(clip.get("start_time"));
    } catch (e) {}

    var props = null;
    try {
        props = {
            warping:      num(clip.get("warping"))      ? 1 : 0,
            looping:      num(clip.get("looping"))      ? 1 : 0,
            loop_start:   num(clip.get("loop_start")),
            loop_end:     num(clip.get("loop_end")),
            start_marker: num(clip.get("start_marker")),
            end_marker:   num(clip.get("end_marker"))
        };
    } catch (e) { props = null; }

    return { path: p, trackIdx: trackIndexFromPath(clip.unquotedpath),
             arrTime: t, props: props };
}

function playheadTime() {
    try { return num(new LiveAPI("live_set").get("current_song_time")) || 0; }
    catch (e) { return 0; }
}

// ---- entry B: manually loaded buffer -------------------------------------------
function start() { startWith(SRC, "start"); }
function startCapture() {
    if (bufFrames(CAP) < 1000) { log("capture buffer is empty."); return; }
    startWith(CAP, "capture");
}

function startWith(srcBuf, resumeWord) {
    if (busy) { log("busy - send 'reset' if stuck."); return; }
    runFilterOnly = filterOnly;
    var f = "";
    if (!runFilterOnly) {
        f = resolveFolder(null);
        if (!f) {
            log("choose an output folder (remembered afterwards)...");
            waitingForFolder = resumeWord;
            outlet(0, "openfolder", "bang");
            return;
        }
    }
    runFolder = f;
    runSrc = srcBuf;
    if (srcBuf === CAP) {
        // place results where the listen toggle was turned ON
        insertAt = capInsertAt;
        arrTime = capArrTime;
        srcClipProps = null;
        busy = true;
        log("output -> " + (runFolder || "(filter only)") +
            "  placement: beat " + arrTime.toFixed(2));
        kickNMF();
        return;
    }
    var t = new LiveAPI("live_set view selected_track");
    var sel = (t && t.id != 0) ? trackIndexFromPath(t.unquotedpath) : -1;
    insertAt = (sel >= 0) ? sel + 1 : -1;
    arrTime = playheadTime();
    srcClipProps = null;
    busy = true;
    log("output -> " + runFolder);
    kickNMF();
}

// ---- NMF pass launcher (attributes set explicitly every time) -------------------
function excerptRange() {
    var frames = bufFrames(runSrc);
    var ex = Math.min(frames > 0 ? frames : EXCERPT_FRAMES, EXCERPT_FRAMES);
    var st = (frames > ex) ? Math.floor((frames - ex) / 2) : 0;
    return [st, ex];
}

function kickNMF() {
    outlet(0, "nmf", "components", count);
    outlet(0, "nmf", "bases", BASES);
    outlet(0, "nmf", "activations", ACTS);
    outlet(0, "nmf", "numchans", 1);      // analyze one channel: stereo/mp3 safe
    if (centroidMode || fastMode) {
        nmfPhase = centroidMode ? "clearn" : "learn";
        var needResyn = (centroidMode && descriptor === 3) ? 1 : 0;  // pitch needs audio
        if (numSlices > 1) { buildTrainingBuffer(); return; }   // continues in xb chain
        var r = excerptRange();
        outlet(0, "nmf", "source", runSrc);
        outlet(0, "nmf", "basesmode", 0);
        outlet(0, "nmf", "resynthmode", needResyn);
        outlet(0, "nmf", "startframe", r[0]);
        outlet(0, "nmf", "numframes", r[1]);
        log("stage 1: learning " + count + " bases on excerpt (frames " +
            r[0] + ".." + (r[0] + r[1]) + ")...");
    } else {
        nmfPhase = "single";
        outlet(0, "nmf", "source", runSrc);
        outlet(0, "nmf", "basesmode", 0);
        outlet(0, "nmf", "resynthmode", runFilterOnly ? 0 : 1);
        outlet(0, "nmf", "startframe", 0);
        outlet(0, "nmf", "numframes", -1);
        log("decomposing full file into " + count + " components" +
            (runFilterOnly ? " (filter-only)" : "") + "...");
    }
    nmfRunning = true;
    outlet(0, "nmf", "bang");
}

// ---- scattered learning: concatenate K slices into the training buffer -------------
function buildTrainingBuffer() {
    var frames = bufFrames(runSrc);
    if (frames <= 0) { log("source buffer empty."); reset(); return; }
    var total = Math.min(frames, EXCERPT_FRAMES);
    var sliceLen = Math.floor(total / numSlices);
    xbSeq = [];
    for (var k = 0; k < numSlices; k++) {
        var st = (numSlices > 1)
            ? Math.floor(k * (frames - sliceLen) / (numSlices - 1))
            : Math.floor((frames - sliceLen) / 2);
        xbSeq.push({ srcStart: st, destStart: k * sliceLen, len: sliceLen });
    }
    log("building training buffer: " + numSlices + " slices of " + sliceLen +
        " frames, evenly spread across the file...");
    xbIdx = 0; phase = "xb";
    xbNext();
}

function xbNext() {
    if (xbIdx >= xbSeq.length) {
        // training buffer ready -> learn from it
        outlet(0, "nmf", "source", TRAIN);
        outlet(0, "nmf", "basesmode", 0);
        outlet(0, "nmf", "resynthmode", (centroidMode && descriptor === 3) ? 1 : 0);
        outlet(0, "nmf", "startframe", 0);
        outlet(0, "nmf", "numframes", -1);
        log("stage 1: learning " + count + " bases on scattered slices...");
        nmfRunning = true;
        outlet(0, "nmf", "bang");
        return;
    }
    var s = xbSeq[xbIdx];
    outlet(0, "compose", "source", runSrc);
    outlet(0, "compose", "startchan", 0);
    outlet(0, "compose", "numchans", -1);
    outlet(0, "compose", "startframe", s.srcStart);
    outlet(0, "compose", "numframes", s.len);
    outlet(0, "compose", "gain", 1.0);
    outlet(0, "compose", "destgain", 0);
    outlet(0, "compose", "deststartchan", 0);
    outlet(0, "compose", "deststartframe", s.destStart);
    outlet(0, "compose", "destination", TRAIN);
    composeRunning = true;
    outlet(0, "compose", "bang");
}

// ---- NMF pass completed ----------------------------------------------------------
function nmfdone() {
    if (!busy) return;
    if (!nmfRunning) { log("(ignoring unexpected nmf output, phase=" + nmfPhase + ")"); return; }
    nmfRunning = false;
    log("(nmf pass done, phase=" + nmfPhase + ")");

    if (nmfPhase === "learn") {                     // fast mode -> apply pass
        nmfPhase = "apply";
        outlet(0, "nmf", "source", runSrc);
        outlet(0, "nmf", "basesmode", 2);
        outlet(0, "nmf", "resynthmode", runFilterOnly ? 0 : 1);
        outlet(0, "nmf", "startframe", 0);
        outlet(0, "nmf", "numframes", -1);
        log("stage 2: applying fixed bases to full file...");
        nmfRunning = true;
        outlet(0, "nmf", "bang");
        return;
    }

    if (nmfPhase === "clearn") {                    // descriptor mode -> rank & build 2 bases
        if (descriptor === 3) { startPitchChain(); return; }
        try { rankFromScores(channelScores()); }
        catch (e) { log("cannot read bases buffer (" + e + ")."); reset(); }
        return;
    }

    if (nmfPhase === "capply") {                    // centroid apply finished
        runCount = 2;
        runBasesBuf = BASES2;
        runNames = [ chosenName(), "rest" ];
        maybeExtract();
        return;
    }

    // "single" or "apply": all N components
    runCount = count;
    runBasesBuf = BASES;
    runNames = null;
    maybeExtract();
}

// extract channels + build tracks, or (filter-only) go straight to filter fill
function maybeExtract() {
    if (runFilterOnly) {
        log("filter-only mode: skipping files/tracks, loading filter bases...");
        phase = "bases"; bidx = 0;
        basesNext();
        return;
    }
    beginExtraction();
}

function beginExtraction() {
    idx = 0; runPaths = []; stampStr = timestamp(); phase = "comp";
    log("frames: src=" + bufFrames(runSrc) + " resynth=" + bufFrames(RESYN));
    log("extracting " + runCount + " channels...");
    composeNext();
}

// ---- descriptor ranking + summed-bases construction ---------------------------------
// Score each learned component from its base spectrum (and, for amplitude,
// its activation envelope). Higher score = rank 1.
function channelScores() {
    var b = new Buffer(BASES);
    var frames = b.framecount();
    var acts = null, aframes = 0;
    if (descriptor === 4) {
        try { acts = new Buffer(ACTS); aframes = acts.framecount(); }
        catch (e) { acts = null; log("no activations buffer - amplitude uses base energy only."); }
    }
    var out = [];
    for (var c = 0; c < count; c++) {
        var m = b.peek(c + 1, 0, frames);          // Buffer channels are 1-based
        if (!(m instanceof Array)) m = [m];
        var i, sum = 0;
        for (i = 0; i < m.length; i++) sum += m[i];
        var score = 0;
        if (descriptor === 1) {                     // spectral centroid (brightness)
            var w = 0;
            for (i = 0; i < m.length; i++) w += i * m[i];
            score = (sum > 0) ? w / sum : 0;
        } else if (descriptor === 2) {              // spectral flatness (noisiness)
            var lg = 0;
            for (i = 0; i < m.length; i++) lg += Math.log(m[i] + 1e-9);
            var gmean = Math.exp(lg / m.length);
            score = gmean / ((sum / m.length) + 1e-9);
        } else if (descriptor === 3) {              // dominant peak (pitch proxy)
            var best = 1;
            for (i = 2; i < m.length; i++) if (m[i] > m[best]) best = i;
            score = best;
        } else {                                    // amplitude (activation x base energy)
            var ae = 1;
            if (acts && aframes > 0) {
                var a = acts.peek(c + 1, 0, aframes);
                if (!(a instanceof Array)) a = [a];
                ae = 0;
                for (i = 0; i < a.length; i++) ae += a[i];
                ae /= a.length;
            }
            score = ae * sum;
        }
        out.push({ chan: c, score: score });
    }
    return out;
}

// ---- true pitch ranking: fluid.bufpitch~ -> fluid.bufstats~ on resynth audio -------
function startPitchChain() {
    phase = "pit";
    outlet(0, "pitch", "source", RESYN);
    outlet(0, "pitch", "features", PITCHF);
    log("analyzing component pitches (fluid.bufpitch~)...");
    descRunning = true;
    outlet(0, "pitch", "bang");
}

function pitchdone() {
    if (!busy || phase !== "pit") return;
    if (!descRunning) { log("(ignoring unexpected pitch output)"); return; }
    descRunning = false;
    phase = "sta";
    outlet(0, "stats", "source", PITCHF);
    outlet(0, "stats", "stats", PITCHS);
    outlet(0, "stats", "select", "mid");
    descRunning = true;
    outlet(0, "stats", "bang");
}

function statsdone() {
    if (!busy || phase !== "sta") return;
    if (!descRunning) { log("(ignoring unexpected stats output)"); return; }
    descRunning = false;
    var scores = [];
    try {
        var b = new Buffer(PITCHS);
        // layout: 2 channels per component (median pitch Hz, median confidence)
        var s = "pitch medians: ";
        for (var c = 0; c < count; c++) {
            var hz = Number(b.peek(c * 2 + 1, 0, 1));
            var cf = Number(b.peek(c * 2 + 2, 0, 1));
            if (isNaN(hz)) hz = 0;
            scores.push({ chan: c, score: hz });
            s += (c + 1) + ": " + hz.toFixed(1) + " Hz (conf " +
                 (isNaN(cf) ? 0 : cf).toFixed(2) + ")  ";
        }
        log(s);
    } catch (e) {
        log("pitch buffers unreadable (" + e + ") - falling back to peak-frequency.");
        scores = channelScores();
    }
    rankFromScores(scores);
}

function chosenName() {
    return "chosen (" + DESC_NAMES[descriptor - 1] + " rank " + keepRank + ")";
}

function rankFromScores(cents) {
    cents.sort(function (a, z) { return z.score - a.score; });   // highest first

    var dn = DESC_NAMES[descriptor - 1];
    var s = dn + " ranking (rank: channel, score): ";
    for (var r = 0; r < cents.length; r++)
        s += (r + 1) + ":" + (cents[r].chan + 1) + " (" + cents[r].score.toFixed(2) + ")  ";
    log(s);

    var kr = Math.min(Math.max(keepRank, 1), count);
    if (kr !== keepRank) log("keep rank clamped to " + kr);
    var chosen = cents[kr - 1].chan;
    log("keeping " + dn + " rank " + kr + " = original channel " + (chosen + 1) +
        "; summing the other " + (count - 1) + " into 'rest'.");

    // build the compose sequence: chosen -> ch0 (clear), others summed -> ch1
    mkSeq = [ { src: chosen, dest: 0, destgain: 0 } ];
    var firstOther = true;
    for (var c2 = 0; c2 < count; c2++) {
        if (c2 === chosen) continue;
        mkSeq.push({ src: c2, dest: 1, destgain: firstOther ? 0 : 1 });
        firstOther = false;
    }
    mkIdx = 0; phase = "mkb";
    mkbNext();
}

function mkbNext() {
    if (mkIdx >= mkSeq.length) {
        if (runFilterOnly) {
            // filter only needs the 2-channel template - skip the full-file pass
            runCount = 2;
            runBasesBuf = BASES2;
            runNames = [ chosenName(), "rest" ];
            log("filter-only: skipping full-file pass, loading filter bases...");
            phase = "bases"; bidx = 0;
            basesNext();
            return;
        }
        // 2-channel template ready -> apply pass on the whole file
        nmfPhase = "capply";
        outlet(0, "nmf", "source", runSrc);
        outlet(0, "nmf", "components", 2);
        outlet(0, "nmf", "bases", BASES2);
        outlet(0, "nmf", "basesmode", 2);
        outlet(0, "nmf", "resynthmode", runFilterOnly ? 0 : 1);
        outlet(0, "nmf", "startframe", 0);
        outlet(0, "nmf", "numframes", -1);
        log("stage 2: separating full file into chosen vs rest...");
        nmfRunning = true;
        outlet(0, "nmf", "bang");
        return;
    }
    var st = mkSeq[mkIdx];
    outlet(0, "compose", "source", BASES);
    outlet(0, "compose", "startchan", st.src);
    outlet(0, "compose", "numchans", 1);
    outlet(0, "compose", "startframe", 0);
    outlet(0, "compose", "numframes", -1);
    outlet(0, "compose", "gain", 1.0);
    outlet(0, "compose", "destgain", st.destgain);
    outlet(0, "compose", "deststartchan", st.dest);
    outlet(0, "compose", "deststartframe", 0);
    outlet(0, "compose", "destination", BASES2);
    composeRunning = true;
    outlet(0, "compose", "bang");
}

// ---- extraction + filter-fill state machine ------------------------------------------
function composeNext() {
    if (idx >= runCount) {
        createTracks(runPaths);
        phase = "bases"; bidx = 0;
        basesNext();
        return;
    }
    outlet(0, "mono", "sizeinsamps", 1);
    outlet(0, "compose", "source", RESYN);
    outlet(0, "compose", "startchan", idx);
    outlet(0, "compose", "numchans", 1);
    outlet(0, "compose", "startframe", 0);
    var srcLen = bufFrames(runSrc);
    outlet(0, "compose", "numframes", (srcLen > 0) ? srcLen : -1);
    outlet(0, "compose", "gain", 1.0);
    outlet(0, "compose", "destgain", 0);
    outlet(0, "compose", "deststartchan", 0);
    outlet(0, "compose", "deststartframe", 0);
    outlet(0, "compose", "destination", MONO);
    composeRunning = true;
    outlet(0, "compose", "bang");
}

function basesNext() {
    if (bidx >= MAXCOMP) {
        busy = false; nmfPhase = "single";
        log("filter ready: bases 1.." + Math.min(runCount, MAXCOMP) +
            " active" + (runCount === 2 ? " (1 = chosen, 2 = rest)" : "") + ".");
        return;
    }
    var real = (bidx < runCount);
    outlet(0, "compose", "source", runBasesBuf);
    outlet(0, "compose", "startchan", real ? bidx : 0);
    outlet(0, "compose", "numchans", 1);
    outlet(0, "compose", "startframe", 0);
    outlet(0, "compose", "numframes", -1);
    outlet(0, "compose", "gain", real ? 1.0 : 0.000001);
    outlet(0, "compose", "destgain", 0);
    outlet(0, "compose", "deststartchan", bidx);
    outlet(0, "compose", "deststartframe", 0);
    outlet(0, "compose", "destination", ACTIVE);
    composeRunning = true;
    outlet(0, "compose", "bang");
}

function composedone() {
    if (!busy) return;
    if (!composeRunning) { log("(ignoring unexpected compose output, phase=" + phase + ")"); return; }
    composeRunning = false;
    if (phase === "xb")    { xbIdx++; xbNext(); return; }
    if (phase === "mkb")   { mkIdx++; mkbNext(); return; }
    if (phase === "bases") { bidx++; basesNext(); return; }
    // phase "comp": write extracted channel to disk
    if (idx === 0) log("frames: mono=" + bufFrames(MONO) + " (should equal src)");
    var nm = runNames ? runNames[idx] : (NAME_PREFIX + (idx + 1));
    var p = runFolder + "/nmf_" + stampStr + "_" +
            nm.replace(/[^A-Za-z0-9]+/g, "_") + ".wav";
    outlet(0, "mono", "write", p);
    log("wrote " + p);
    runPaths.push(p);
    idx++;
    var t = new Task(composeNext, this);
    t.schedule(50);
}

function timestamp() {
    function pad(x) { return (x < 10 ? "0" : "") + x; }
    var d = new Date();
    return "" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" +
           pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

// ---- Live version / clip loading / track building -----------------------------------
function liveVersion() {
    try {
        var app = new LiveAPI("live_app");
        return [ parseInt(app.call("get_major_version")),
                 parseInt(app.call("get_minor_version")),
                 parseInt(app.call("get_bugfix_version")) ];
    } catch (e) { return null; }
}
function versionSupported(v) {
    if (!v) return true;
    if (v[0] > 12) return true;
    if (v[0] < 12) return false;
    if (v[1] > 0) return true;
    return v[2] >= 5;
}

var goodVariant = 1;
function tryLoadClip(slot, nat) {
    var win = nat.replace(/\//g, "\\");
    var variants = [ '"' + nat + '"', nat, '"' + win + '"', win ];
    var order = [goodVariant];
    for (var k = 0; k < variants.length; k++) if (k !== goodVariant) order.push(k);
    for (var o = 0; o < order.length; o++) {
        var v = order[o];
        try { slot.call("create_audio_clip", variants[v]); } catch (e) {}
        if (parseInt(slot.get("has_clip")) === 1) { goodVariant = v; return true; }
    }
    return false;
}

function setSafe(obj, prop, val, isFloat) {
    if (typeof val !== "number" || isNaN(val)) return;
    if (isFloat && val === Math.floor(val)) val += 0.000001;
    try { obj.set(prop, val); }
    catch (e) { log("could not set " + prop + "=" + val); }
}

function createTracks(paths) {
    var ver = liveVersion();
    log("Live version: " + (ver ? ver.join(".") : "unknown"));
    if (ver && !versionSupported(ver))
        log("ERROR: Live " + ver.join(".") + " lacks create_audio_clip (needs 12.0.5+).");

    var song = new LiveAPI("live_set");
    var total = song.getcount("tracks");
    var base = (insertAt >= 0 && insertAt <= total) ? insertAt : total;
    var failed = 0;

    for (var i = 0; i < paths.length; i++) {
        var nm = runNames ? runNames[i] : (NAME_PREFIX + (i + 1));
        var tIdx = base + i;
        song.call("create_audio_track", tIdx);

        var track = new LiveAPI("live_set tracks " + tIdx);
        track.set("name", nm);
        if (TRACK_COLOR >= 0) track.set("color_index", TRACK_COLOR);

        var slotPath = "live_set tracks " + tIdx + " clip_slots " + CLIP_SCENE;
        var slot = new LiveAPI(slotPath);
        var nat = toNative(paths[i]);

        if (!tryLoadClip(slot, nat)) {
            failed++; log("FAILED to load: " + nat); continue;
        }

        var clip = new LiveAPI(slotPath + " clip");
        clip.set("name", nm);
        if (TRACK_COLOR >= 0) clip.set("color_index", TRACK_COLOR);

        if (srcClipProps) {
            setSafe(clip, "warping", srcClipProps.warping, false);
            setSafe(clip, "looping", srcClipProps.looping, false);
            setSafe(clip, "loop_end", srcClipProps.loop_end, true);
            setSafe(clip, "loop_start", srcClipProps.loop_start, true);
            setSafe(clip, "end_marker", srcClipProps.end_marker, true);
            setSafe(clip, "start_marker", srcClipProps.start_marker, true);
        } else if (UNWARP) {
            clip.set("warping", 0);
        }

        if (TO_ARRANGEMENT) {
            try {
                track.call("duplicate_clip_to_arrangement", "id " + clip.id, arrTime);
                if (!KEEP_SESSION_CLIP) slot.call("delete_clip");
            } catch (e) { log("arrangement placement failed: " + e); }
        }
    }

    var view = new LiveAPI("live_set view");
    var firstNew = new LiveAPI("live_set tracks " + base);
    view.set("selected_track", "id " + firstNew.id);

    if (failed > 0)
        log(failed + "/" + paths.length + " clips failed - files ARE on disk. Live must be 12.0.5+.");
    else
        log("done: " + paths.length + " tracks created" +
            (TO_ARRANGEMENT ? " (clips in Arrangement at beat " + arrTime + ")" : "") + ".");
    insertAt = -1;
}
