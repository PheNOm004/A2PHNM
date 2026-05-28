// Runs every 2 s — reads DS18B20, drives the state machine, updates display and database.

// ── Remote settings sync ──────────────────────────────────────────
// Re-reads PocketBase settings every 60 cycles (≈2 min) so changes made
// from the remote Netlify dashboard (target temp, idle band, mode, etc.)
// take effect in the hardware loop without restarting Linx.
_dbTick = (_dbTick || 0);  // ensure initialised before first use below
if (_dbTick > 0 && _dbTick % 60 === 0) {
  fetch(PB + "/api/collections/settings/records?perPage=1")
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (!d.items || !d.items.length) return;
      var s = d.items[0];
      if (s.target_temp  != null) targetTemp      = s.target_temp;
      if (s.idle_band    != null) idleBand        = s.idle_band;
      if (s.shutoff_buffer != null) SHUTOFF_BUFFER = s.shutoff_buffer;
      if (s.is_celsius   != null) isCelsius       = s.is_celsius;
      // Refresh display labels to match any changed values
      $("target-temp").innerText = dispTemp(targetTemp) + dispUnit();
      $("idle-band").innerText   = dispBand();
      var ib2 = $("idle-band-2"); if (ib2) ib2.innerText = dispBand();
      var sb  = $("shutoff-buffer-val"); if (sb) sb.innerText = dispDelta(SHUTOFF_BUFFER) + dispUnit();
    })
    .catch(function(){});
}

// D14 (FanEnable) must stay HIGH to power the inlet fan relay board
turnOn(FanEnable);

var currentTemp = DS18X20_In(tempSensor);
$("indoor-temp").innerText = currentTemp;

if (!isNaN(parseFloat(currentTemp))) {
  currentTemp = parseFloat(currentTemp);
  lastKnownTemp = currentTemp;
  $("indoor-temp").innerText = dispTemp(currentTemp);

  // diff > 0: room is hotter than target. diff < 0: room is cooler.
  var diff = currentTemp - targetTemp;
  $("temp-diff").innerText =
    (diff >= 0 ? "+" : "") + dispDelta(diff) + dispUnit();

  addToHistory(currentTemp);

  // Trend: °C/hr from last 10 samples (≥3 required to suppress noise)
  var trendRate = null;
  if (tempHistory.length >= 3) {
    var sl = tempHistory.slice(-Math.min(tempHistory.length, 10));
    var dtHrs = (sl[sl.length - 1].ts - sl[0].ts) / 3600000;
    if (dtHrs > 0.0001)
      trendRate = (sl[sl.length - 1].temp - sl[0].temp) / dtHrs;
  }

  // ── Hard-limit shutoff ────────────────────────────────────────
  // Devices cut when temperature reaches within SHUTOFF_BUFFER of target.
  // Set SHUTOFF_BUFFER > 0 to let thermal momentum carry the rest of the way.
  var shutoffBuf = SHUTOFF_BUFFER || 0;

  // ── State machine (hysteresis) ────────────────────────────────
  // Entry: only from idle when diff exceeds ±idleBand
  // Exit:  when diff is within ±shutoffBuf of target
  if (isAutomatic) {
    if (hvacState === "idle") {
      if (diff < -idleBand) hvacState = "heating";
      else if (diff > idleBand) hvacState = "cooling";
    }
    if (hvacState === "heating" && diff >= -shutoffBuf) hvacState = "idle";
    if (hvacState === "cooling" && diff <= shutoffBuf)  hvacState = "idle";
  }

  // ── Device selection ──────────────────────────────────────────
  // Fan-first escalation: start fan-only, add appliance after FAN_MIN_RUN_MINS
  // if diff still > ½ idleBand. Drop appliance once diff falls within ½ idleBand.
  var activeDevice;
  var fanAge = fanStartTime !== null ? (Date.now() - fanStartTime) / 60000 : 0;

  if (hvacState === "idle") {
    activeDevice = "idle";

  } else if (hvacState === "cooling") {
    var outdoorCooler = outdoorTemp !== null && outdoorTemp < currentTemp;

    if (prevHvacState === "cooling") {
      // AC was already running — stay on AC. Never revert to fan mid-cycle.
      activeDevice = "cooling";
    } else if (prevHvacState === "fan") {
      // Fan is running — escalate to AC immediately if outdoor is warmer than indoor (pulling hot air in),
      // after timer expires, or after two consecutive warm polls confirm outdoor is no longer useful.
      var fanExpiredC  = fanAge >= FAN_MIN_RUN_MINS && diff > idleBand * 0.5;
      var outdoorWarm  = outdoorTemp !== null && outdoorTemp >= currentTemp; // outdoor actively unhelpful → immediate
      var outdoorWarmC = !outdoorCooler && outdoorWarmPolls >= 2;
      activeDevice = (fanExpiredC || outdoorWarm || outdoorWarmC) ? "cooling" : "fan";
    } else {
      // Fresh activation (was idle) — try fan first if outdoor is cooler, else go straight to AC.
      activeDevice = outdoorCooler ? "fan" : "cooling";
    }

  } else {
    // hvacState === 'heating'
    var outdoorWarmer = outdoorTemp !== null && outdoorTemp > currentTemp;

    if (prevHvacState === "heating") {
      // Heater was already running — stay on heater. Never revert to fan mid-cycle.
      activeDevice = "heating";
    } else if (prevHvacState === "fan-heat") {
      // Fan-heat is running — escalate to heater immediately if outdoor is cooler than indoor (pulling cold air in),
      // after timer expires, or after two consecutive cool polls confirm outdoor is no longer useful.
      var fanExpiredH  = fanAge >= FAN_MIN_RUN_MINS && Math.abs(diff) > idleBand * 0.5;
      var outdoorCool  = outdoorTemp !== null && outdoorTemp <= currentTemp; // outdoor actively unhelpful → immediate
      var outdoorCoolH = !outdoorWarmer && outdoorCoolPolls >= 2;
      activeDevice = (fanExpiredH || outdoorCool || outdoorCoolH) ? "heating" : "fan-heat";
    } else {
      // Fresh activation (was idle) — try fan first if outdoor is warmer, else go straight to heater.
      activeDevice = outdoorWarmer ? "fan-heat" : "heating";
    }
  }

  // ── Opposite-direction escalation ────────────────────────────────
  // If the fan has been on ≥3 min but temp is moving the WRONG way (≥1°C/hr), escalate immediately.
  if (hvacState === "cooling"  && activeDevice === "fan"      && trendRate !== null && trendRate >  1.0 && fanAge > 1)
    activeDevice = "cooling";   // temp rising despite fan → switch to AC now
  if (hvacState === "heating"  && activeDevice === "fan-heat" && trendRate !== null && trendRate < -1.0 && fanAge > 1)
    activeDevice = "heating";   // temp falling despite fan → switch to heater now

  var isFanBased =
    activeDevice === "fan" ||
    activeDevice === "fan-heat";
  var wasFanBased =
    prevHvacState === "fan" ||
    prevHvacState === "fan-heat";
  if (isFanBased && !wasFanBased)
    fanStartTime = Date.now();
  else if (!isFanBased) fanStartTime = null;

  $("indoor-temp").style.color =
    hvacState === "cooling"
      ? "#ef4444"
      : hvacState === "heating"
        ? "#38bdf8"
        : "#2dd4bf";

  // ── AI recommendation text ────────────────────────────────────
  function buildRec(statusLine) {
    // Trend arrow prepended to status line
    var arrow = trendRate === null || Math.abs(trendRate) < 0.2 ? "→" :
                trendRate > 0 ? "↑" : "↓";
    var lines = [arrow + " " + statusLine];

    if (trendRate !== null) {
      var absRate = Math.abs(trendRate) * (isCelsius ? 1 : 9 / 5);
      var absRateStr = absRate.toFixed(1);
      var dir = trendRate > 0 ? "rising" : "falling";

      if (Math.abs(trendRate) < 0.2) {
        lines.push("Temperature is <strong>stable</strong>.");
      } else {
        // Context-aware note
        var note, etaLine = null;
        if (hvacState === "idle") {
          var minsToEdge = null;
          if (trendRate > 0) {
            // Rising toward upper band
            minsToEdge = Math.round(Math.abs((idleBand - diff) / trendRate) * 60);
            note = "Drifting toward upper threshold";
            if (minsToEdge > 0 && minsToEdge < 120) note += " — HVAC may activate in ~<strong>" + minsToEdge + " min</strong>.";
            else note += ".";
          } else {
            // Falling toward lower band
            minsToEdge = Math.round(Math.abs((-idleBand - diff) / trendRate) * 60);
            note = "Drifting toward lower threshold";
            if (minsToEdge > 0 && minsToEdge < 120) note += " — HVAC may activate in ~<strong>" + minsToEdge + " min</strong>.";
            else note += ".";
          }
        } else if (hvacState === "cooling") {
          if (trendRate > 0) {
            note = "⚠ Still climbing — cooling urgently needed.";
          } else {
            // Temp falling (correct direction): estimate ETA to shutoff
            var shutoffDiff = shutoffBuf || 0; // shutoff when diff ≤ shutoffDiff
            var distToShutoff = diff - shutoffDiff;
            if (distToShutoff > 0 && Math.abs(trendRate) > 0.05) {
              var etaMins = Math.round((distToShutoff / Math.abs(trendRate)) * 60);
              if (etaMins > 0 && etaMins < 240)
                etaLine = "ETA to target: ~<strong>" + etaMins + " min</strong>.";
            }
            note = "Cooling is working — temperature dropping.";
          }
        } else {
          // heating
          if (trendRate < 0) {
            note = "⚠ Still falling — heating urgently needed.";
          } else {
            // Temp rising (correct direction): estimate ETA to shutoff
            var distToShutoffH = -diff - (shutoffBuf || 0);
            if (distToShutoffH > 0 && Math.abs(trendRate) > 0.05) {
              var etaMinsH = Math.round((distToShutoffH / Math.abs(trendRate)) * 60);
              if (etaMinsH > 0 && etaMinsH < 240)
                etaLine = "ETA to target: ~<strong>" + etaMinsH + " min</strong>.";
            }
            note = "Heating is working — temperature rising.";
          }
        }
        lines.push("Trend: <strong>" + dir + "</strong> at " + absRateStr + dispUnit() + "/hr — " + note);
        if (etaLine) lines.push(etaLine);
      }
    }

    if (outdoorHum !== null)
      lines.push("Outdoor humidity: <strong>" + outdoorHum + "%</strong> — " + humLabel(outdoorHum) + ".");

    if (outdoorTemp !== null) {
      var capStr = (outdoorDesc && outdoorDesc !== "--")
        ? " (" + outdoorDesc.replace(/\b\w/g, function(c){return c.toUpperCase();}) + ")"
        : "";
      lines.push("Outdoor: <strong>" + tempStr(outdoorTemp) + "</strong>" + capStr + ".");
    }

    return lines.join("<br>");
  }

  // ── Execute state: drive GPIO outputs and update UI ───────────
  if (isAutomatic) {
    $("mode-display").innerText = "Auto";
    var shutoffCoolTemp = tempStr(targetTemp + shutoffBuf);
    var shutoffHeatTemp = tempStr(targetTemp - shutoffBuf);

    if (hvacState === "idle") {
      allOff();
      ["heater", "cooler", "fan"].forEach(function (d) { setDevice(d, false, ""); });
      setBadge("idle", "Idle");
      updateRec(buildRec(
        "Indoor <strong>" + tempStr(currentTemp) + "</strong> — within " +
        dispBand() + " of target (" + tempStr(targetTemp) + "). No action required."
      ), "idle");

    } else if (hvacState === "cooling") {
      turnOff(RedLed);
      setDevice("heater", false, "");
      setBadge("cooling", "Cooling");

      if (activeDevice === "fan") {
        turnOn(InletFan); turnOff(GreenLed);
        setDevice("fan", true, "cool"); setDevice("cooler", false, "");
        updateRec(buildRec(
          "Indoor <strong>" + tempStr(currentTemp) + "</strong> — " +
          dispDelta(diff) + dispUnit() + " above target. " +
          "Outdoor (" + tempStr(outdoorTemp) + ") is cooler — inlet fan ventilating (no AC cost). " +
          "Shutoff at <strong>" + shutoffCoolTemp + "</strong>."
        ), "cool");
      } else {
        // activeDevice === "cooling" — AC only, fan off
        turnOn(GreenLed); turnOff(InletFan);
        setDevice("cooler", true, "cool"); setDevice("fan", false, "");
        var outNoteC = outdoorTemp !== null
          ? "Outdoor (" + tempStr(outdoorTemp) + ") not cooler than indoor — AC active."
          : "No outdoor data — AC active.";
        updateRec(buildRec(
          "Indoor <strong>" + tempStr(currentTemp) + "</strong> — " +
          dispDelta(diff) + dispUnit() + " above target. " +
          outNoteC + " Shutoff at <strong>" + shutoffCoolTemp + "</strong>."
        ), "cool");
      }

    } else {
      // hvacState === 'heating'
      turnOff(GreenLed);
      setDevice("cooler", false, "");
      setBadge("heating", "Heating");

      if (activeDevice === "fan-heat") {
        turnOn(InletFan); turnOff(RedLed);
        setDevice("fan", true, "heat"); setDevice("heater", false, "");
        updateRec(buildRec(
          "Indoor <strong>" + tempStr(currentTemp) + "</strong> — " +
          dispDelta(Math.abs(diff)) + dispUnit() + " below target. " +
          "Outdoor (" + tempStr(outdoorTemp) + ") is warmer — inlet fan drawing warm air in (no heater cost). " +
          "Shutoff at <strong>" + shutoffHeatTemp + "</strong>."
        ), "heat");
      } else {
        // activeDevice === "heating" — heater only, fan off
        turnOff(InletFan); turnOn(RedLed);
        setDevice("heater", true, "heat"); setDevice("fan", false, "");
        updateRec(buildRec(
          "Indoor <strong>" + tempStr(currentTemp) + "</strong> — " +
          dispDelta(Math.abs(diff)) + dispUnit() + " below target. " +
          "Heater active. Shutoff at <strong>" + shutoffHeatTemp + "</strong>."
        ), "heat");
      }
    }
  } else {
    $("mode-display").innerText = "Manual";
    var manualLine;
    var diffStr = dispDelta(Math.abs(diff)) + dispUnit() + (diff < 0 ? " below" : " above") + " target.";
    if (manualDevice === "heating") {
      manualLine = "Manual: Heater on. Indoor <strong>" + tempStr(currentTemp) + "</strong> — " + diffStr;
    } else if (manualDevice === "cooling") {
      manualLine = "Manual: Cooler/AC on. Indoor <strong>" + tempStr(currentTemp) + "</strong> — " + diffStr;
    } else if (manualDevice === "fan") {
      manualLine = "Manual: Inlet fan on. Indoor <strong>" + tempStr(currentTemp) + "</strong> — " + diffStr;
    } else {
      manualLine = "Manual mode — all devices off. Indoor <strong>" + tempStr(currentTemp) + "</strong>.";
    }
    var manualRecType = (manualDevice === "heating") ? "heat" :
                        (manualDevice === "cooling" || manualDevice === "fan") ? "cool" : "";
    updateRec(buildRec(manualLine), manualRecType);
  }

  // Detect state change (before prevHvacState is updated)
  var stateChanged = isAutomatic && activeDevice !== prevHvacState;

  if (isAutomatic && stateChanged) {
    if (prevHvacState !== "idle") closeHvacEvent(currentTemp);
    if (activeDevice !== "idle") openHvacEvent(activeDevice, currentTemp);
    prevHvacState = activeDevice;
  }

  // POST a reading every 15 cycles (≈30 s) or immediately on a state change
  // — keeps history dense enough for the 1 h chart without flooding the DB
  _dbTick = (_dbTick || 0) + 1;
  if (_dbTick % 15 === 0 || stateChanged) {
    fetch(PB + "/api/collections/readings/records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        indoor_temp: currentTemp,
        target_temp: targetTemp || 22.0,
        hvac_state: isAutomatic ? activeDevice : manualDevice,
        ts: new Date().toISOString(),
      }),
    }).catch(function () {});
  }
}

await mSec(2000);
