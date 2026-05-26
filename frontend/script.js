(() => {
  "use strict";

  /** After TTS stops, ignore mic input briefly so your speaker is not mistaken for you */
  const POST_TTS_GUARD_MS = 150;
  /** Silence before flush — command after wake waits longer until you speak */
  const SILENCE_COMMAND_EMPTY_MS = 1500;
  const SILENCE_COMMAND_ACTIVE_MS = 800;
  const SILENCE_WAKE_TAIL_MS = 600;
  const SILENCE_DEFAULT_MS = 1200;
  const SILENCE_MS = SILENCE_DEFAULT_MS;
  const HOUR_MS = 60 * 60 * 1000;

  const WAKE_ALIASES = [
    "hey friend",
    "hai friend",
    "hey fri end",
    "hay friend",
    "hey frend",
    "hey frind",
    "hey fren",
    "a friend"
  ];

  const LS_TOPICS = "noor_topicsCovered_v1";
  const LS_WEAK = "noor_weakTopics_v1";
  const DEBUG_ENDPOINT = "http://127.0.0.1:7911/ingest/e58e53c4-15bd-44f4-b870-f930b1648f48";
  const DEBUG_SESSION_ID = "d2d0d9";
  const DEBUG_RUN_ID = "run1";

  function debugLog(hypothesisId, location, message, data) {
    // #region agent log
    fetch(DEBUG_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": DEBUG_SESSION_ID
      },
      body: JSON.stringify({
        sessionId: DEBUG_SESSION_ID,
        runId: DEBUG_RUN_ID,
        hypothesisId,
        location,
        message,
        data,
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion
  }
  // #region agent log
  debugLog("H5", "Noor/index.html:startup", "Noor app script booted", {
    href: window.location.href
  });
  // #endregion

  const Phase = {
    NEED_MIC_GATE: "need_mic_gate",
    STANDBY: "standby",
    COMMAND: "command",
    PLAN_SUBJECTS: "plan_q1",
    PLAN_HOURS: "plan_q2",
    PLAN_WEAK: "plan_q3",
    QUIZ_RUN: "quiz_run",
    QUIZ_ANSWER: "quiz_answer"
  };

  /** === DOM ================================================ */
  const $status = document.getElementById("statusText");
  const $badge = document.getElementById("statusBadge");
  const $live = document.getElementById("liveTranscript");
  const $aria = document.getElementById("liveRegion");
  const waveCanvas = document.getElementById("waveCanvas");
  const waveCtx = waveCanvas.getContext("2d");

  const LS_CARE = "noorCareCircle_v1";
  const MEDICINE_MS = 4 * 60 * 60 * 1000;

  /** === Mutable state ====================================== */
  let phase = Phase.NEED_MIC_GATE;
  let recognition = null;
  let recoLang = "en-IN";
  let synthVoices = [];
  let recognitionMuted = false;
  /** While true, discard recognition (your TTS echo / chime — do not stop the mic session). */
  let speechOutputActive = false;
  let medicineTimerId = null;
  let medicineActive = false;

  /** Latest full caption from Web Speech (final + interim); avoids doubled text bugs */
  let liveRecoText = "";
  let silenceTimer = null;
  let postTtsQuietUntil = 0;
  /** Text right after wake, e.g. "news", kept until reco returns results after unmute */
  let wakeRemainderDraft = "";
  let lastRecoError = "";
  let micPermissionBlocked = false;

  let suppressAnythingElseOnce = false;
  let planDraft = [];

  /** === Announcements ====================================== */
  function announce(t) {
    $aria.textContent = t || "";
  }

  const bodyStateMap = {
    mic: "mic",
    standby: "standby",
    waking: "listen",
    listen: "listen",
    think: "think",
    speak: "speak",
    quiz: "quiz",
    plan: "plan",
    err: "think"
  };

  const badgeMap = {
    mic: "Setup",
    standby: "Ready",
    waking: "Hey Friend",
    listen: "Listening",
    think: "Thinking",
    speak: "Speaking",
    quiz: "Quiz",
    plan: "Planner",
    err: "Error"
  };

  function status(key) {
    const m = {
      mic: "Press Space or Enter once, then say Hey Friend for calls, guidance, or reminders.",
      standby: "Listening for Hey Friend — your voice is in control.",
      waking: "Heard you — one moment.",
      listen: "Go ahead, I am listening.",
      think: "Working on that…",
      speak: "Here is the reply.",
      quiz: "Waiting for your answer, A B C or D.",
      plan: "Building your day plan — answer in a few words.",
      err: "Something went wrong — you can try again."
    };
    const t = m[key] || key;
    $status.textContent = t;
    announce(t);
    const b = bodyStateMap[key] || "standby";
    document.body.className = "state-" + b;
    if ($badge) $badge.textContent = badgeMap[key] || "Noor";
  }

  function loadJSON(key, fb) {
    try {
      return JSON.parse(sessionStorage.getItem(key) || "null") || fb;
    } catch {
      return fb;
    }
  }

  function saveJSON(key, v) {
    sessionStorage.setItem(key, JSON.stringify(v));
  }

  function getCare() {
    try {
      return JSON.parse(localStorage.getItem(LS_CARE) || "{}");
    } catch {
      return {};
    }
  }

  function setCare(o) {
    localStorage.setItem(LS_CARE, JSON.stringify(o));
  }

  /** === Normalize / fuzzy wake ============================== */
  function normalizeSpeech(s) {
    return String(s || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^a-z0-9\u0900-\u0c7f\s']/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function levenshteinRatio(a, b) {
    if (!a.length && !b.length) return 1;
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const c = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + c);
      }
    }
    const dist = dp[m][n];
    return 1 - dist / Math.max(m, n, 1);
  }

  function findWake(norm) {
    if (!norm) return { hit: false, rest: "" };
    for (const w of WAKE_ALIASES) {
      const i = norm.indexOf(w);
      if (i !== -1) {
        const rest = norm.slice(i + w.length).replace(/^[,.\s]+/, "").trim();
        return { hit: true, rest: normalizeSpeech(rest) };
      }
    }
    const words = norm.split(" ");
    for (let s = 0; s < Math.max(0, words.length - 1); s++) {
      const bigram = `${words[s] || ""} ${words[s + 1] || ""}`.trim();
      for (const w of WAKE_ALIASES) {
        if (levenshteinRatio(bigram, w) >= 0.88) {
          const tail = normalizeSpeech(words.slice(s + 2).join(" "));
          return { hit: true, rest: tail };
        }
      }
    }
    return { hit: false, rest: "" };
  }

  /** Remove wake aliases so routing sees "news" not "hey drishti news" (fixes No response bug). */
  function stripWakeFromUtterance(normIn) {
    const extras = ["hey drushti", "hey drusty", "hey dusty", "pair drishti", "pay drishti"];
    const pool = [...new Set([...WAKE_ALIASES, ...extras])].sort((a, b) => b.length - a.length);
    let s = normalizeSpeech(normIn);
    let prev = "";
    while (s && s !== prev) {
      prev = s;
      for (const w of pool) {
        let idx = s.indexOf(w);
        while (idx !== -1) {
          s = normalizeSpeech(s.slice(0, idx) + " " + s.slice(idx + w.length));
          idx = s.indexOf(w);
        }
      }
    }
    return s;
  }

  function detectLangFromText(raw) {
    const t = String(raw || "");
    if (/[\u0900-\u097F]/.test(t))
      return { label: "Hindi", reco: "hi-IN", ttsCode: "hi-IN", claudeLang: "Hindi" };
    if (/[\u0C00-\u0C7F]/.test(t))
      return { label: "Telugu", reco: "te-IN", ttsCode: "te-IN", claudeLang: "Telugu" };
    if (/[\u0B80-\u0BFF]/.test(t))
      return { label: "Tamil", reco: "ta-IN", ttsCode: "ta-IN", claudeLang: "Tamil" };
    return { label: "English", reco: "en-IN", ttsCode: "en-IN", claudeLang: "English conversational" };
  }

  function preferredVoice(langCode) {
    const voices = synthVoices;
    return (
      voices.find((v) => v.lang === langCode && v.localService !== false)
      || voices.find((v) => (v.lang || "").toLowerCase().startsWith(langCode.split("-")[0]))
      || voices.find((v) => /en|hi|ta|te/i.test(v.lang || ""))
      || voices[0]
      || null
    );
  }

  /** === Chime + waveform ================================== */
  function playChime() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      g.gain.setValueAtTime(0.001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.22);
    } catch (_) {}
  }

  function playAlertSignal() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const freqs = [920, 690, 520];
      let t0 = ctx.currentTime;
      freqs.forEach((hz, i) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "square";
        osc.frequency.value = hz;
        g.gain.setValueAtTime(0.001, t0 + i * 0.12);
        g.gain.exponentialRampToValueAtTime(0.14, t0 + i * 0.12 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.12 + 0.18);
        osc.connect(g);
        g.connect(ctx.destination);
        osc.start(t0 + i * 0.12);
        osc.stop(t0 + i * 0.12 + 0.2);
      });
    } catch (_) {}
  }

  let waveT = 0;
  let wavesOn = false;
  function animateWave(dt) {
    const g = waveCtx.createLinearGradient(0, 0, waveCanvas.width, 0);
    g.addColorStop(0, "#4fd1c5");
    g.addColorStop(0.5, "#ffd65c");
    g.addColorStop(1, "#4fd1c5");
    waveCtx.fillStyle = "#08090d";
    waveCtx.fillRect(0, 0, waveCanvas.width, waveCanvas.height);
    const mid = waveCanvas.height / 2;
    waveCtx.strokeStyle = g;
    waveCtx.lineWidth = 3;
    waveCtx.beginPath();
    const amp = wavesOn ? 34 : 5;
    const sp = wavesOn ? 1.1 : 0.35;
    for (let x = 0; x <= waveCanvas.width; x += 10) {
      const y =
        mid +
        Math.sin(waveT * 0.09 + x * 0.04) * amp * Math.sin(waveT * 0.035);
      waveCtx.lineTo(x, y);
    }
    waveCtx.stroke();
    waveT += dt * sp;
  }
  let lastT = performance.now();
  requestAnimationFrame(function tick(ts) {
    animateWave(ts - lastT);
    lastT = ts;
    requestAnimationFrame(tick);
  });

  /** === TTS =============================================== */
  function speakUtter(text, langInfo) {
    return new Promise((resolve) => {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.95;
      u.lang = langInfo.ttsCode;
      const v = preferredVoice(langInfo.ttsCode);
      if (v) u.voice = v;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    });
  }

  async function speakBlocking(text, langHint) {
    speechOutputActive = true;
    status("speak");
    wavesOn = false;
    liveRecoText = "";
    try {
      await speakUtter(text, langHint || detectLangFromText(text));
    } finally {
      speechOutputActive = false;
      postTtsQuietUntil = Date.now() + POST_TTS_GUARD_MS;
      wavesOn = true;
      if (phase === Phase.STANDBY) status("standby");
      else if (phase === Phase.COMMAND) status("listen");
      else if (phase === Phase.QUIZ_ANSWER || phase === Phase.QUIZ_RUN) status("quiz");
      else if (
        phase === Phase.PLAN_SUBJECTS ||
        phase === Phase.PLAN_HOURS ||
        phase === Phase.PLAN_WEAK
      )
        status("plan");
    }
  }

  /** === Recognition ======================================= */
  function ensureRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) throw new Error("SpeechRecognition unsupported");
    if (recognition) return recognition;
    recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      wavesOn = true;
      if ([Phase.STANDBY, Phase.COMMAND, Phase.PLAN_SUBJECTS, Phase.PLAN_HOURS,
        Phase.PLAN_WEAK, Phase.QUIZ_ANSWER, Phase.QUIZ_RUN].includes(phase)) {
        if (phase === Phase.STANDBY) status("standby");
      }
    };
    recognition.onerror = (evt) => {
      const code = evt && evt.error ? evt.error : "";
      lastRecoError = code;
      if (code === "not-allowed" || code === "service-not-allowed") {
        micPermissionBlocked = true;
        status("mic");
        announce(
          "Microphone permission denied. Allow the mic once in the browser lock icon next to the address bar, then reload."
        );
        return;
      }
      if (code === "audio-capture") {
        scheduleRecoRestart(1200);
        return;
      }
      if (code === "no-speech") {
        scheduleRecoRestart(300);
        return;
      }
      scheduleRecoRestart(code === "aborted" ? 500 : 400);
    };
    recognition.onend = () => {
      scheduleRecoRestart();
    };
    recognition.onresult = handleRecoResult;

    recognition.lang = recoLang;
    return recognition;
  }

  let restartTimer = null;
  let lastRestartAt = 0;
  function scheduleRecoRestart(delayMs) {
    if (recognitionMuted || phase === Phase.NEED_MIC_GATE) return;
    clearTimeout(restartTimer);
    const d = typeof delayMs === "number" ? delayMs : recognitionMuted ? 300 : 150;
    restartTimer = setTimeout(startRecoSafe, d);
  }

  function startRecoSafe() {
    if (micPermissionBlocked) return;
    if (recognitionMuted || phase === Phase.NEED_MIC_GATE) return;
    try {
      ensureRecognition().lang = recoLang;
      recognition.start();
      lastRestartAt = Date.now();
    } catch (_) {
      const backoff = Math.min(1900, 200 + Math.max(0, Date.now() - lastRestartAt));
      restartTimer = setTimeout(startRecoSafe, backoff);
    }
  }

  /** === Silence / flush ==================================== */
  function resetSilence() {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }

  function currentSilenceMs() {
    const hasReco = !!liveRecoText.trim();
    if (phase === Phase.COMMAND) {
      if (wakeRemainderDraft.trim() && !hasReco) return SILENCE_WAKE_TAIL_MS;
      if (!hasReco) return SILENCE_COMMAND_EMPTY_MS;
      return SILENCE_COMMAND_ACTIVE_MS;
    }
    if (phase === Phase.QUIZ_ANSWER)
      return hasReco ? SILENCE_COMMAND_ACTIVE_MS : SILENCE_COMMAND_EMPTY_MS;
    if (
      phase === Phase.PLAN_SUBJECTS ||
      phase === Phase.PLAN_HOURS ||
      phase === Phase.PLAN_WEAK
    )
      return SILENCE_DEFAULT_MS;
    return SILENCE_DEFAULT_MS;
  }

  /** Countdown AFTER preDelayMs, then silence window then flush */
  function armSilence(preDelayMs) {
    resetSilence();
    const wait = typeof preDelayMs === "number" ? preDelayMs : 0;
    const dur = currentSilenceMs();
    silenceTimer = setTimeout(() => void flushBufferedUtterance(), wait + dur);
  }

  /** Rebuild full captions from SpeechRecognition results (fixes short/increment-only bugs). */
  function splitRecoResults(ev) {
    let finals = "";
    let interims = "";
    for (let i = 0; i < ev.results.length; i++) {
      const r = ev.results[i];
      const t = r[0].transcript;
      if (r.isFinal) finals += t;
      else interims += t;
    }
    return {
      finals: finals.trim(),
      interims: interims.trim(),
      display: `${finals}${interims}`.trim(),
      norm: normalizeSpeech(`${finals} ${interims}`)
    };
  }

  /** Optional: tweak TTS/read language hints without restarting the mic (stops spam prompts). */
  function refreshRecoLangHint(txt) {
    const want = detectLangFromText(txt).reco;
    if (want !== recoLang) recoLang = want;
  }

  function handleRecoResult(ev) {
    if (recognitionMuted) return;
    if (speechOutputActive || Date.now() < postTtsQuietUntil) return;
    const chunks = splitRecoResults(ev);

    liveRecoText = chunks.display.trim();
    if (phase !== Phase.STANDBY) {
      $live.textContent = chunks.display;
    }

    if (chunks.finals) refreshRecoLangHint(chunks.finals);

    if (phase === Phase.STANDBY) {
      standbyScan(chunks.norm);
      return;
    }

    armSilence();
  }

  function maybeRetargetRecoLang() {
    /* intentionally no-op: stopping recognition to swap lang caused repeated mic permission loops */
  }

  let wakeCooldown = false;
  function standbyScan(norm) {
    const { hit, rest } = findWake(norm);
    if (!hit || wakeCooldown) return;
    wakeCooldown = true;
    wakeRemainderDraft = rest ? rest.trim() : "";
    resetSilence();
    void onWake(rest);
    setTimeout(() => { wakeCooldown = false; }, 900);
  }

  async function onWake(rest) {
    phase = Phase.COMMAND;
    status("waking");
    playChime();

    wakeRemainderDraft = normalizeSpeech(rest) ? rest.trim() : "";
    liveRecoText = "";
    status("listen");
    armSilence(POST_TTS_GUARD_MS + 60);
  }

  async function flushBufferedUtterance() {
    resetSilence();
    const tail = wakeRemainderDraft ? wakeRemainderDraft.trim() : "";
    const recoPart = liveRecoText.trim();
    let raw = "";
    if (tail && recoPart) raw = `${tail} ${recoPart}`.trim();
    else raw = (tail || recoPart).trim();

    const langInfo = detectLangFromText(raw);
    recoLang = langInfo.reco;

    let norm = normalizeSpeech(raw);
    const intentNorm = stripWakeFromUtterance(norm);
    if (intentNorm.length) norm = intentNorm;
    // #region agent log
    debugLog("H2", "Noor/index.html:flushBufferedUtterance", "Utterance flushed", {
      phase,
      raw,
      norm,
      wakeRemainderDraft,
      recoPart
    });
    // #endregion

    if (phase === Phase.QUIZ_ANSWER) {
      raw = recoPart.trim() || raw.trim();
      norm = normalizeSpeech(stripWakeFromUtterance(raw) || raw);
      liveRecoText = "";
      wakeRemainderDraft = "";
      if (quizAnswerResolver) {
        const finish = quizAnswerResolver;
        quizAnswerResolver = null;
        finish({ raw: raw || "skip", norm });
      }
      status("quiz");
      return;
    }

    wakeRemainderDraft = "";
    liveRecoText = "";

    if (phase === Phase.PLAN_SUBJECTS || phase === Phase.PLAN_HOURS || phase === Phase.PLAN_WEAK) {
      await handlePlannerLine(raw, norm, langInfo);
      return;
    }

    if (phase === Phase.COMMAND) {
      if (!norm) {
        await speakBlocking(
          "I did not hear a command after the wake phrase. Say Hey Friend again, then your request.",
          langInfo
        );
        phase = Phase.STANDBY;
        status("standby");
        return;
      }
      suppressAnythingElseOnce = false;
      try {
        await routeCommand(norm, raw, langInfo);
      } catch (err) {
        // #region agent log
        debugLog("H4", "Noor/index.html:flushBufferedUtterance", "routeCommand exception", {
          error: err && err.message ? err.message : String(err),
          norm,
          raw
        });
        // #endregion
        throw err;
      }

      const skipClosing =
        suppressAnythingElseOnce ||
        phase === Phase.PLAN_SUBJECTS ||
        phase === Phase.PLAN_HOURS ||
        phase === Phase.PLAN_WEAK;

      if (!skipClosing) await speakBlocking("Anything else? Say Hey Friend again for another request.", langInfo);
      suppressAnythingElseOnce = false;

      liveRecoText = "";
      phase = Phase.STANDBY;
      status("standby");
      return;
    }

    phase = Phase.STANDBY;
    status("standby");
  }

  /** === Local replies / news =============================== */
  function safeItems(items, n) {
    return Array.isArray(items) ? items.filter(Boolean).slice(0, n) : [];
  }

  function parseNewsItems(xmlText) {
    try {
      const xml = new DOMParser().parseFromString(xmlText, "application/xml");
      const nodes = Array.from(xml.querySelectorAll("item > title, entry > title"));
      return safeItems(nodes.map((n) => n.textContent?.trim()), 6);
    } catch {
      return [];
    }
  }

  async function fetchFeedTitles(url) {
    const proxied = "https://api.allorigins.win/raw?url=" + encodeURIComponent(url);
    try {
      const res = await fetch(proxied, { cache: "no-store" });
      if (!res.ok) return [];
      const txt = await res.text();
      return parseNewsItems(txt);
    } catch {
      return [];
    }
  }

  async function newsBrief(langInfo) {
    status("think");
    const now = Date.now();
    const memo = loadJSON("noor_news_cache_v1", { t: 0, headlines: [] });
    let headlines = Array.isArray(memo.headlines) ? memo.headlines : [];
    if (!headlines.length || now - (memo.t || 0) > NEWS_CACHE_MS) {
      const all = [];
      for (const feed of NEWS_FEEDS) {
        const items = await fetchFeedTitles(feed);
        all.push(...items);
        if (all.length >= 6) break;
      }
      headlines = safeItems([...new Set(all)], 4);
      if (headlines.length) saveJSON("noor_news_cache_v1", { t: now, headlines });
    }
    if (!headlines.length) {
      await speakBlocking(
        "I cannot pull live headlines right now. Please check internet and ask me news again.",
        langInfo
      );
      return;
    }
    const speech = "Top headlines. " + headlines.map((h, i) => `Headline ${i + 1}. ${h}.`).join(" ");
    await speakBlocking(speech, langInfo);
  }

  function localTutorReply(raw, langInfo) {
    const n = normalizeSpeech(raw);
    if (/\bphotosynthesis\b/.test(n)) {
      return "Photosynthesis is how green plants make food using sunlight, water, and carbon dioxide. It mostly happens in leaves. The plant stores this food as energy for growth. Want a very short memory trick for this?";
    }
    if (/\bpythagoras|triangle\b/.test(n)) {
      return "In a right triangle, the square of the longest side equals the sum of squares of the other two sides. Think of it as longest side check for right angle triangles. Would you like one quick example?";
    }
    if (/\bnewton\b/.test(n)) {
      return "Newton's first law says objects keep resting or moving straight unless a force changes them. Second law links force to mass and acceleration. Third law means every action has an equal opposite reaction. Want this in one-line revision form?";
    }
    if (/\bwhat time\b|\bwhat day\b/.test(n)) {
      return `Current local time is ${new Date().toLocaleString()}.`;
    }
    if (/(access|open|install|browser|use noor|how.*noor)/i.test(norm)) {
      return "People can access Noor through a browser link. After the first load, core voice actions work on this device without API keys. It can also be installed like a simple web app if the browser supports it.";
    }
    if (/(secure|security|privacy|contact|contacts|safe|permission)/i.test(norm)) {
      return "Your contacts are safe. Noor stores family numbers, medicine notes, and saved directions only on this device. It does not upload them to any server. Microphone, location, call, and SMS actions depend on browser or phone permission.";
    }
    if (/(offline|new place|unknown place|google maps|map)/i.test(norm)) {
      return "Offline guidance works only for saved places like library, lab, classroom, home, or washroom. For a new unknown place, Noor will ask you to connect internet, share location, or call a trusted helper.";
    }
    return `I heard: ${raw}. I can help with caretaker alerts, emergency SOS, location, indoor guide, call family, medicines, hydration, and study support. What would you like now?`;
  }

  async function caretakerHungry(langInfo) {
    playAlertSignal();
    const c = getCare();
    const msg =
      "Noor alert: I need food or meal help. Please check on me. Sent from my voice assistant.";
    await speakBlocking("Sending a hungry alert through your phone if possible.", langInfo);
    if (c.caretaker) {
      try {
        window.location.href = `sms:${c.caretaker.replace(/\s/g, "")}?body=${encodeURIComponent(msg)}`;
      } catch (_) {}
    }
    if (navigator.share) {
      try {
        await navigator.share({ title: "Noor care alert", text: msg });
      } catch (_) {}
    }
    if (navigator.vibrate) navigator.vibrate([180, 120, 180]);
    if (c.caretaker) {
      await speakBlocking(
        "If your device opened messages, send when ready. Otherwise call out to your caretaker. Say 'repeat alert' to send again.",
        langInfo
      );
    } else {
      await speakBlocking(
        "Add a caretaker SMS number in care settings for automatic texting. For now, please call aloud for food help. Say 'repeat alert' to try again.",
        langInfo
      );
    }
  }

  async function dialFamily(norm, langInfo) {
    const c = getCare();
    let num = (c.daughter || "").trim();
    if (!num) num = (c.caretaker || "").trim();
    if (!num) {
      await speakBlocking(
        "Save a family or caretaker phone number in care settings first, with country code. Then say call my daughter or call family again.",
        langInfo
      );
      return;
    }
    const clean = num.replace(/[^\d+]/g, "");
    if (!clean) {
      await speakBlocking(
        "I found a saved contact entry but could not parse a phone number. Please update it in care settings with digits and the country code.",
        langInfo
      );
      return;
    }
    if (navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(clean);
      } catch (_) {}
    }
    const spokenNumber = clean
      .replace(/\+/g, "plus ")
      .split("")
      .join(" ");
    await speakBlocking(
      `Here is the saved family number: ${spokenNumber}. I copied it to the clipboard so you can paste it into your calling app. Say Hey Friend again for another request.`,
      langInfo
    );
  }

  function getSavedPlaces() {
    const c = getCare();
    const raw = String(c.places || "");
    const places = {};
    raw.split(/\n+/).forEach((line) => {
      const parts = line.split(":");
      if (parts.length >= 2) {
        const name = normalizeSpeech(parts.shift());
        const steps = parts.join(":").trim();
        if (name && steps) places[name] = steps;
      }
    });
    return places;
  }

  async function guideSavedPlace(langInfo, raw, norm) {
    status("think");
    const places = getSavedPlaces();
    const builtIn = {
      washroom: "Keep one hand lightly on the left wall, walk slowly, count two doorways, then stop and listen for water flow or exhaust fan noise. If crowded, ask a nearby person for elbow guidance.",
      bathroom: "Keep one hand lightly on the left wall, walk slowly, count two doorways, then stop and listen for water flow or exhaust fan noise. If crowded, ask a nearby person for elbow guidance.",
      library: "From the classroom door, walk straight about twenty steps, turn left, continue ten steps, and stop near the quiet reading area.",
      lab: "From the classroom, walk straight to the corridor, turn right after the second door, and ask for the computer lab entrance.",
      classroom: "Follow the main corridor slowly, keep to the left side, and ask a nearby person to confirm the room number before entering.",
      home: "Home route must be saved by a guardian first. For outdoor travel, please use location sharing or call family."
    };
    const all = { ...builtIn, ...places };
    let place = "";
    Object.keys(all).forEach((k) => {
      if (!place && norm.includes(k)) place = k;
    });
    if (!place) {
      await speakBlocking(
        "I can guide offline only to saved places like library, lab, classroom, home, or washroom. For a new unknown place, please connect internet, share location, or call family.",
        langInfo
      );
      return;
    }
    await speakBlocking(
      `Offline guide to ${place}. ${all[place]} Move slowly, pause often, and ask a nearby person to confirm if the path feels unsafe.`,
      langInfo
    );
  }

  async function checkGeolocationStatus() {
    if (!navigator.geolocation) return "unsupported";
    if (!navigator.permissions) return "prompt";
    try {
      const status = await navigator.permissions.query({ name: "geolocation" });
      return status.state || "prompt";
    } catch {
      return "prompt";
    }
  }

  async function shareLocationSpoken(langInfo) {
    const statusState = await checkGeolocationStatus();
    if (!navigator.geolocation) {
      await speakBlocking(
        "Location is unavailable in this browser. Open the page in a browser that supports geolocation or serve it over HTTPS.",
        langInfo
      );
      return;
    }
    if (!window.isSecureContext) {
      await speakBlocking(
        "Location needs a secure browser context. Open this page over HTTPS or localhost and allow location access.",
        langInfo
      );
      return;
    }
    if (statusState === "denied") {
      await speakBlocking(
        "Location permission is blocked. Enable location for this site in browser settings, then try again.",
        langInfo
      );
      return;
    }
    status("think");
    await new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const lat = pos.coords.latitude.toFixed(4);
          const lon = pos.coords.longitude.toFixed(4);
          await speakBlocking(
            `Approximate latitude ${lat}, longitude ${lon}. Share these numbers if someone is trying to reach you. Say 'repeat location' to hear again.`,
            langInfo
          );
          if (navigator.share) {
            try {
              await navigator.share({
                title: "My location (approx)",
                text: `Approx location: ${lat}, ${lon} (Noor voice assistant)`
              });
            } catch (_) {}
          }
          resolve();
        },
        async (err) => {
          let message;
          if (err && err.code === 1) {
            message = "Location permission is blocked. Enable location for this site in browser settings, then try again.";
          } else if (err && err.code === 2) {
            message = "Location services are unavailable. Try again in a place with better signal or ensure your device can share location.";
          } else if (err && err.code === 3) {
            message = "Location request timed out. Try again and allow a moment for the browser to find your position.";
          } else {
            message = "Unable to read location right now. Please try again with location enabled.";
          }
          await speakBlocking(message, langInfo);
          resolve();
        },
        { enableHighAccuracy: true, timeout: 14000, maximumAge: 60000 }
      );
    });
  }

  async function readClock(langInfo) {
    const line = new Date().toLocaleString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "numeric"
    });
    await speakBlocking(`The time is ${line}. Say 'repeat time' to hear it again.`, langInfo);
  }

  async function medicineSpoken(langInfo) {
    const c = getCare();
    const note = (document.getElementById("inMeds")?.value || c.meds || "").trim();
    if (!note) {
      await speakBlocking(
        "No medicine notes saved. Someone can add them in care settings on this page.",
        langInfo
      );
      return;
    }
    await speakBlocking(
      `Please follow your doctor instructions. Your saved medicine note is: ${note}. Say 'repeat medicine' to hear it again.`,
      langInfo
    );
  }

  async function waterReminderStart(langInfo) {
    clearInterval(waterTimerId);
    waterActive = true;
    waterTimerId = setInterval(() => {
      if (!waterActive) return;
      playChime();
      speakUtter("Friendly water reminder. Sip if you can. Say 'stop water' to cancel.", langInfo).catch(() => {});
    }, WATER_MS);
    await speakBlocking(
      "Okay. I will chime about every thirty minutes for water. Say stop water reminders to end.",
      langInfo
    );
  }

  async function waterReminderStop(langInfo) {
    clearInterval(waterTimerId);
    waterTimerId = null;
    waterActive = false;
    await speakBlocking("Water reminders are off.", langInfo);
  }

  async function medicineReminderStart(langInfo) {
    clearInterval(medicineTimerId);
    medicineActive = true;
    medicineTimerId = setInterval(() => {
      if (!medicineActive) return;
      playChime();
      speakUtter("Medicine reminder. Please check your saved medicine note now.", langInfo).catch(() => {});
    }, MEDICINE_MS);
    await speakBlocking(
      "Medicine reminders are on every four hours. Say stop medicine reminders to end.",
      langInfo
    );
  }

  async function medicineReminderStop(langInfo) {
    clearInterval(medicineTimerId);
    medicineTimerId = null;
    medicineActive = false;
    await speakBlocking("Medicine reminders are off.", langInfo);
  }

  async function uneasyHealth(langInfo, raw) {
    playAlertSignal();
    await speakBlocking(
      "If this feels urgent, call one one two or ask someone nearby to help immediately.",
      langInfo
    );
    await speakBlocking(
      "Sit down if you can, loosen tight clothing, and take slow breaths in and out. If possible sip water safely and ask someone nearby to stay with you.",
      langInfo
    );
  }

  async function attentionTips(langInfo) {
    await speakBlocking(
      "To draw attention, try a firm double clap, say excuse me toward nearby voices, or use your phone accessibility shortcut if you have one.",
      langInfo
    );
  }

  async function speakHelp(langInfo) {
    await speakBlocking(
      "You can say: Hey Friend, call my daughter; Hey Friend, guide me to library; Hey Friend, share my location; Hey Friend, what medicine should I take; Hey Friend, stop medicine reminders; or Hey Friend, emergency. Say help again if you want to hear these examples again.",
      langInfo
    );
  }

  /** === Planner =========================================== */
  async function beginPlanner(langInfo) {
    suppressAnythingElseOnce = true;
    planDraft = [];
    phase = Phase.PLAN_SUBJECTS;
    status("plan");
    await speakBlocking("Plan my day. First, which subjects do you want?", langInfo);
  }

  async function handlePlannerLine(raw, norm, langInfo) {
    if (phase === Phase.PLAN_SUBJECTS) {
      planDraft.push({ key: "subjects", raw });
      phase = Phase.PLAN_HOURS;
      await speakBlocking("How many hours can you study today?", langInfo);
      return;
    }
    if (phase === Phase.PLAN_HOURS) {
      planDraft.push({ key: "hours", raw });
      phase = Phase.PLAN_WEAK;
      await speakBlocking("Any weak areas you want emphasized today?", langInfo);
      return;
    }
    planDraft.push({ key: "weak", raw });
    status("think");
    const payload = `
Subjects: ${planDraft.find((x) => x.key === "subjects")?.raw}.
Hours available: ${planDraft.find((x) => x.key === "hours")?.raw}.
Weak areas: ${planDraft.find((x) => x.key === "weak")?.raw}.

Create a humane day plan with hourly blocks plus short breathing breaks.`;

    suppressAnythingElseOnce = false;
    phase = Phase.STANDBY;

    const subjects = planDraft.find((x) => x.key === "subjects")?.raw || "general studies";
    const hoursRaw = planDraft.find((x) => x.key === "hours")?.raw || "3";
    const weakRaw = planDraft.find((x) => x.key === "weak")?.raw || "revision";
    const hoursNum = Math.max(1, Math.min(10, parseInt(hoursRaw.replace(/[^\d]/g, ""), 10) || 3));
    const per = Math.max(30, Math.floor((hoursNum * 60) / Math.max(1, subjects.split(",").length)));
    await speakBlocking(
      `Great. Today's plan is ${hoursNum} hours focused on ${subjects}. Start with 5 minutes warm up. Then do ${per} minute study blocks with 5 minute breaks. Give extra revision to ${weakRaw}. End with a 10 minute recap by speaking what you learned.`,
      langInfo
    );

    hourlyActive = true;
    clearInterval(hourlyTimerId);
    hourlyTimerId = setInterval(() => {
      if (!hourlyActive) return;
      playChime();
      speakUtter(
        "Hour reminder. Stretch, sip water, and continue your gentle study block.",
        { ttsCode: langInfo.ttsCode, reco: langInfo.reco, label: langInfo.label, claudeLang: langInfo.claudeLang }
      ).catch(() => {});
    }, HOUR_MS);

    await speakBlocking("Hourly chime reminders armed. Say stop reminders to mute them.", langInfo);

    liveRecoText = "";
    phase = Phase.STANDBY;
    status("standby");
  }

  /** === Teach / Quiz ====================================== */
  async function teaching(norm, langInfo, raw) {
    const m =
      normalizeSpeech(raw).match(/teach\s+me\s+(.+?)\s+for\s+(.+)$/i) ||
      norm.match(/teach\s+me\s+(.+?)\s+for\s+(.+)$/i);
    const topic = m ? m[1].trim() : "this idea";
    const subject = m ? m[2].trim() : "study";

    status("think");
    const txt =
      `Let us learn ${topic} in ${subject}. Start from the core idea, then connect it to one real life example, and finally revise in one line. ` +
      localTutorReply(raw, langInfo);
    await speakBlocking(txt, langInfo);

    const list = loadJSON(LS_TOPICS, []);
    list.push({ topic, subject, t: Date.now() });
    saveJSON(LS_TOPICS, list);

    if (list.length >= 3 && list.length % 3 === 0) {
      const slice = list.slice(-3).map((x) => x.topic).join(", ");
      await speakBlocking("Let me quiz you on what we covered.", langInfo);
      await runGeneratedQuiz(
        slice,
        langInfo,
        2,
        slice.split(", ").filter(Boolean),
        Phase.COMMAND
      );
    }
  }

  function parseQuizJson(text, limit) {
    const s = Math.max(text.indexOf("{"), 0);
    const e = text.lastIndexOf("}");
    const chunk = e >= s ? text.slice(s, e + 1) : text;
    try {
      const o = JSON.parse(chunk);
      const keys = ["q1", "q2", "q3"];
      const out = [];
      for (let i = 0; i < limit && i < keys.length; i++) {
        const q = o[keys[i]];
        if (!q?.question || !Array.isArray(q.choices)) continue;
        out.push({
          question: q.question,
          choices: q.choices.slice(0, 4),
          answerLetter: String(q.answerLetter || "A").toUpperCase()[0],
          hint: ""
        });
      }
      return out.filter((x) => x.choices.length === 4);
    } catch {
      return [];
    }
  }

  function makeLocalQuiz(topicText, n) {
    const topic = (topicText || "general revision").trim();
    const bank = [
      {
        question: `On ${topic}, what is the best first study step?`,
        choices: ["Recall basics first", "Skip basics", "Only memorize answers", "Avoid revision"],
        answerLetter: "A",
        hint: topic
      },
      {
        question: `During revision of ${topic}, what improves retention most?`,
        choices: ["Short repeated practice", "One very long session", "No breaks", "Studying while distracted"],
        answerLetter: "A",
        hint: topic
      },
      {
        question: `When stuck on ${topic}, what should you do?`,
        choices: ["Break problem into smaller parts", "Quit immediately", "Guess without thinking", "Skip all examples"],
        answerLetter: "A",
        hint: topic
      }
    ];
    return bank.slice(0, Math.max(1, Math.min(3, n)));
  }

  async function runGeneratedQuiz(prompt, langInfo, n, weakTopics, resumePhaseAfter) {
    status("think");
    const qs = makeLocalQuiz(prompt || weakTopics?.[0] || "revision", n);
    await runQuizInteractive(qs, langInfo, resumePhaseAfter);
  }

  function normalizeAnswer(norm) {
    const mOpt = norm.match(/option\s*([abcd])/i);
    if (mOpt) return mOpt[1].toUpperCase();
    const m = norm.match(/\b([abcd])\b/i);
    return m ? m[1].toUpperCase() : "";
  }

  function waitQuizAnswer() {
    return new Promise((resolve) => {
      const fail = setTimeout(() => finalize(null), 32000);

      function finalize(blob) {
        clearTimeout(fail);
        liveRecoText = "";
        quizAnswerResolver = null;
        phase = Phase.QUIZ_RUN;
        resolve(blob || { raw: "skip", norm: "skip" });
      }

      quizAnswerResolver = finalize;
      phase = Phase.QUIZ_ANSWER;
      status("quiz");

      liveRecoText = "";
      armSilence(POST_TTS_GUARD_MS + 80);
    });
  }

  function markQuizThinking() {
    phase = Phase.QUIZ_RUN;
  }

  async function runQuizInteractive(questions, langInfo, resumePhase) {
    quizQuestions = questions;
    quizScore = 0;
    phase = Phase.QUIZ_RUN;

    async function bumpWeak(question, missed) {
      if (!missed) return;
      const mem = loadJSON(LS_WEAK, []);
      mem.push({ topic: question.hint || question.question.slice(0, 40), t: Date.now() });
      saveJSON(LS_WEAK, mem.slice(-48));
    }

    for (let i = 0; i < questions.length; i++) {
      quizIndex = i;
      const q = questions[i];
      const labs = ["A", "B", "C", "D"];
      const opts = labs
        .map((L, idx) => `Option ${L}: ${q.choices[idx] || ""}`)
        .join(". ");
      markQuizThinking();
      await speakBlocking(`Question ${i + 1}. ${q.question}. ${opts}`, langInfo);

      const ansObj = await waitQuizAnswer();
      const norm = normalizeSpeech(ansObj?.norm || normalizeSpeech(ansObj?.raw || ""));
      const sel = normalizeAnswer(norm);
      const ok = sel && sel === q.answerLetter;
      quizScore += ok ? 1 : 0;

      await bumpWeak(q, !ok);

      markQuizThinking();
      await speakBlocking(
        ok ? "Exactly right!" : `The best answer was option ${q.answerLetter}.`,
        langInfo
      );

      liveRecoText = "";
    }

    const weakPeek = loadJSON(LS_WEAK, [])
      .slice(-5)
      .map((x) => x.topic)
      .join(", ") || "none stored yet";

    await speakBlocking(
      `Quiz wrap. Score ${quizScore} out of ${questions.length}. We will soften weak spots like ${weakPeek}.`,
      langInfo
    );

    phase = resumePhase || Phase.STANDBY;
  }

  /** === Routing =========================================== */
  async function routeCommand(norm, raw, langInfo) {
    // #region agent log
    debugLog("H1", "Noor/index.html:routeCommand", "Routing command", {
      norm,
      raw,
      phase
    });
    // #endregion

    const doneIntent = /\bdone\b|\bfinished\b|\bthat'?s all\b|\bstop news\b/i.test(norm);
    if (doneIntent) {
      // #region agent log
      debugLog("H3", "Noor/index.html:routeCommand", "Done-style intent heard", { norm, raw });
      // #endregion
      await speakBlocking("Okay, stopped.", langInfo);
      return;
    }

    if (/\bstop medicine reminders?\b|\bcancel medicine reminders?\b/i.test(norm)) {
      await medicineReminderStop(langInfo);
      return;
    }



    if (
      /\bwhat('s| is) (the )?time\b|\bread (me )?(the )?time\b|\bwhat day\b|\bwhat('s| is) today\b|\brepeat time\b/i.test(norm)
    ) {
      await readClock(langInfo);
      return;
    }



    if (
      /\b(call|phone|ring|dial)\s+(my\s+)?(daughter|son|family|wife|husband|mother|father|mom|dad|parents?)\b|\bcall again\b/i.test(
        norm
      )
    ) {
      await dialFamily(norm, langInfo);
      return;
    }

    const guideIntent =
      /\b(guide|take me|where is|find|locate|how do i go|directions? to|continue guidance)\b/i.test(norm) ||
      /^\s*(washroom|bathroom|toilet|restroom|loo|library|lab|classroom|home)\s*$/i.test(norm.trim());
    if (guideIntent) {
      await guideSavedPlace(langInfo, raw, norm);
      return;
    }

    if (/\b(where am i|where is my location|my location|share (my )?location|send (my )?location)\b|\brepeat location\b/i.test(norm)) {
      await shareLocationSpoken(langInfo);
      return;
    }

    if (
      (/\b(medicine|medication|pills?|tablets?)\b/i.test(norm) &&
      /\b(what|which|should i take|do i take|remind|my medication|my medicine)\b/i.test(norm)) ||
      /\brepeat medicine\b/i.test(norm)
    ) {
      await medicineSpoken(langInfo);
      return;
    }

    if (/\b(remind me.*medicine|medicine reminder|medicine reminders?|start (?:medicine|medication) reminders?)\b/i.test(norm)) {
      await medicineReminderStart(langInfo);
      return;
    }

    if (/\bstatus\b|\bwhat'?s active\b|\bactive reminders\b/i.test(norm)) {
      let statusMsg = "Current status: ";
      const active = [];
      if (medicineActive) active.push("medicine reminders");
      if (active.length) {
        statusMsg += active.join(", ") + " are active.";
      } else {
        statusMsg += "No reminders are currently active.";
      }
      await speakBlocking(statusMsg + " Say stop followed by the reminder type to cancel any.", langInfo);
      return;
    }

    if (
      /\b(dizzy|faint|fainting|can('t| not) breathe|severe pain|chest pain|feel very sick)\b/i.test(norm)
    ) {
      await uneasyHealth(langInfo, raw);
      return;
    }

    if (/\b(get|need) (someone('s)? )?attention\b|\bhow do i get help from people nearby\b/i.test(norm)) {
      await attentionTips(langInfo);
      return;
    }

    if (
      /(help|what can i say|what can i ask|how do i use|usage)/i.test(norm) &&
      !/\b(help me|emergency|112|one one two|urgent)\b/i.test(norm)
    ) {
      await speakHelp(langInfo);
      return;
    }

    if (
      /\bemergency\b|\bone one two\b|\b112\b|\bhelp me\b|\burgent\b/i.test(norm) ||
      /\brepeat emergency\b/i.test(norm)
    ) {
      playAlertSignal();
      await speakBlocking(
        "Emergency. India's emergency number is one one two. Stay where you are safe and call out if you need a person nearby.",
        langInfo
      );
      try {
        window.location.href = "tel:112";
      } catch (_) {}
      await speakBlocking("If you can, dial one one two now or ask someone to help you call. Say 'repeat emergency' if you need to hear this again.", langInfo);
      return;
    }

    if (/\bstatus\b|\bwhat'?s active\b|\bactive reminders\b/i.test(norm)) {
      let statusMsg = "Current status: ";
      const active = [];
      if (medicineActive) active.push("medicine reminders");
      if (active.length) {
        statusMsg += active.join(", ") + " are active.";
      } else {
        statusMsg += "No reminders are currently active.";
      }
      await speakBlocking(statusMsg + " Say stop followed by the reminder type to cancel any.", langInfo);
      return;
    }

    status("think");
    await speakBlocking(localTutorReply(raw, langInfo), langInfo);
  }

  /** === Bootstrap ======================================= */
  function hydrateVoices() {
    synthVoices = speechSynthesis.getVoices() || [];
  }
  hydrateVoices();
  speechSynthesis.onvoiceschanged = hydrateVoices;

  let micOpened = false;
  async function openMicOnce() {
    if (micOpened) return;
    micOpened = true;
    phase = Phase.STANDBY;
    status("standby");
    recoLang = detectLangFromText(navigator.language || "").reco || "en-IN";

    window.removeEventListener("keydown", tapUnlock);
    document.body.removeEventListener("touchstart", tapUnlock);

    // Browser audio unlock must happen inside the Space/Enter user action.
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const dummy = new AC();
      await dummy.resume?.();
      await dummy.close?.();
    } catch (_) {}

    // IMPORTANT FIX:
    // After pressing Space/Enter, Noor should speak the welcome guidance first.
    // Then only the microphone recognition starts, so the welcome voice is not cut or missed.
    const welcomeText =
      "You are live. Say Hey Friend, then ask for a phone call, indoor guidance, saved place directions, your location, medicine reminder, or emergency. Say help for more example phrases.";

    try {
      await speakBlocking(welcomeText, {
        ttsCode: "en-IN",
        label: "English",
        reco: "en-IN",
        claudeLang: "English"
      });
    } catch (_) {}

    try {
      ensureRecognition();
      startRecoSafe();
      debugLog("H5", "Noor/index.html:openMicOnce", "Microphone unlock attempted after welcome voice", {
        recoLang,
        phase
      });
    } catch {
      announce("SpeechRecognition unavailable in this browser.");
    }
  }

  function tapUnlock(ev) {
    if (phase !== Phase.NEED_MIC_GATE && micOpened) return;
    const okKey = ev.type === "keydown" && (ev.code === "Space" || ev.code === "Enter");
    const okTouch = ev.type === "touchstart";
    if (!okKey && !okTouch) return;
    if (okKey && ev.repeat) return;
    if (ev.type === "keydown" && !(ev.code === "Space" || ev.code === "Enter")) return;
    if (ev.cancelable) ev.preventDefault();
    void openMicOnce();
  }

  function initClock() {
    const el = document.getElementById("clockEl");
    const tick = () => {
      if (el) el.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    };
    tick();
    setInterval(tick, 1000);
  }

  function initBattery() {
    const el = document.getElementById("batteryEl");
    if (!el) return;
    if (navigator.getBattery) {
      navigator.getBattery().then((b) => {
        const upd = () => {
          el.textContent = Math.round(b.level * 100) + "%";
        };
        upd();
        b.addEventListener("levelchange", upd);
      });
    } else {
      el.textContent = "—";
    }
  }

  function initCarePanel() {
    const c = getCare();
    const d = document.getElementById("inDaughter");
    const ca = document.getElementById("inCaretaker");
    const m = document.getElementById("inMeds");
    if (d && c.daughter) d.value = c.daughter;
    if (ca && c.caretaker) ca.value = c.caretaker;
    if (m && c.meds) m.value = c.meds;
    document.getElementById("btnSaveCare")?.addEventListener("click", () => {
      setCare({
        daughter: document.getElementById("inDaughter")?.value?.trim() || "",
        caretaker: document.getElementById("inCaretaker")?.value?.trim() || "",
        meds: document.getElementById("inMeds")?.value?.trim() || "",
        places: document.getElementById("inPlaces")?.value?.trim() || ""
      });
      announce("Care settings saved on this device.");
      void speakBlocking(
        "Saved. Your numbers and medicine notes stay on this device only.",
        { ttsCode: "en-IN", label: "English", reco: "en-IN", claudeLang: "English" }
      );
    });
  }

  initClock();
  initBattery();
  initCarePanel();

  status("mic");
  window.addEventListener("keydown", tapUnlock);
  document.body.addEventListener("touchstart", tapUnlock);

})();