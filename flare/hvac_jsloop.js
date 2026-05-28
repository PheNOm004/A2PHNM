// Runs every 2 s — reads DS18B20, drives the state machine, updates display and database.

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

  addToHistory(currentTemp); // push to 2-min ring buffer and redraw live chart

  // Trend: °C/hr from last 10 samples (≥3 required to suppress noise)
  var trendRate = null;
  if (tempHistory.length >= 3) {
    var sl = tempHistory.slice(-Math.min(tempHistory.length, 10));
    var dtHrs = (sl[sl.length - 1].ts - sl[0].ts) / 3600000; // ms → hours
    if (dtHrs > 0.0001)
      // guard: don't divide by near-zero
      trendRate = (sl[sl.length - 1].temp - sl[0].temp) / dtHrs;
  }

  // ── Dynamic shutoff offset ────────────────────────────────────
  // Shuts off slightly early to account for thermal momentum and natural drift.
  var momentumCoast =
    trendRate !== null ? Math.abs(trendRate) * COAST_FACTOR : 0;
  var naturalDrift =
    outdoorTemp !== null
      ? Math.abs(currentTemp - outdoorTemp) * THERMAL_COEFF
      : 0;
  // Cap at 50% of idle band so the system always runs at least half the band before shutoff
  var dynamicOffset = Math.max(
    0.1,
    Math.min(idleBand * 0.5, momentumCoast + naturalDrift),
  );

  // Per-direction shutoff: COAST_ASYMMETRY > 0 shuts cooling off earlier and heating later (cool bias)
  // Additive ±0.2 per unit of asymmetry, capped so shutoff never exceeds idleBand - 0.2
  var asymAdj = COAST_ASYMMETRY * 0.2;
  var coolShutoffOffset = Math.max(0.1, Math.min(idleBand - 0.2, dynamicOffset + asymAdj));
  var heatShutoffOffset = Math.max(0.1, Math.min(idleBand - 0.2, dynamicOffset - asymAdj));

  // ── State machine (hysteresis) ────────────────────────────────
  // Entry: only from idle when diff exceeds ±idleBand
  // Exit:  when diff is within coolShutoffOffset / heatShutoffOffset (per-direction)
  // Only runs in auto mode — manual mode controls hvacState directly via setMode()
  if (isAutomatic) {
    if (hvacState === "idle") {
      if (diff < -idleBand) hvacState = "heating";
      else if (diff > idleBand) hvacState = "cooling";
    }
    if (hvacState === "heating" && diff >= -heatShutoffOffset) hvacState = "idle";
    if (hvacState === "cooling" && diff <= coolShutoffOffset) hvacState = "idle";
  }

  // ── Device selection ──────────────────────────────────────────
  // Fan-first escalation: start fan-only, add appliance after FAN_MIN_RUN_MINS
  // if diff still > ½ idleBand. Drop appliance once diff falls within ½ idleBand.
  // outdoorWarmPolls/outdoorCoolPolls prevent a noisy weather reading from
  // cancelling a fan run mid-cycle.
  var activeDevice;
  var fanAge = fanStartTime !== null ? (Date.now() - fanStartTime) / 60000 : 0;

  if (hvacState === "idle") {
    activeDevice = "idle";
  } else if (hvacState === "cooling") {
    var outdoorCooler = outdoorTemp !== null && outdoorTemp < currentTemp;
    var prevFanCoolBased =
      prevHvacState === "fan" || prevHvacState === "fan+ac";
    var useFanCool =
      outdoorCooler ||
      (prevFanCoolBased && fanAge < FAN_MIN_RUN_MINS) ||
      (prevFanCoolBased && outdoorWarmPolls < 2);

    if (!useFanCool) {
      activeDevice = "cooling"; // AC only (outdoor not useful)
    } else if (!prevFanCoolBased) {
      activeDevice = "fan"; // fresh fan start
    } else if (prevHvacState === "fan+ac") {
      activeDevice = diff > idleBand * 0.5 ? "fan+ac" : "fan";
    } else {
      activeDevice = fanAge >= FAN_MIN_RUN_MINS && diff > idleBand * 0.5 ? "fan+ac" : "fan";
    }
  } else {
    // hvacState === 'heating'
    var outdoorWarmer = outdoorTemp !== null && outdoorTemp > currentTemp;
    var prevFanHeatBased =
      prevHvacState === "fan-heat" || prevHvacState === "fan+heater";
    var useFanHeat =
      outdoorWarmer ||
      (prevFanHeatBased && fanAge < FAN_MIN_RUN_MINS) ||
      (prevFanHeatBased && outdoorCoolPolls < 2);

    if (!useFanHeat) {
      activeDevice = "heating"; // heater only (outdoor not useful)
    } else if (!prevFanHeatBased) {
      activeDevice = "fan-heat"; // fresh fan start
    } else if (prevHvacState === "fan+heater") {
      activeDevice = Math.abs(diff) > idleBand * 0.5 ? "fan+heater" : "fan-heat";
    } else {
      activeDevice = fanAge >= FAN_MIN_RUN_MINS && Math.abs(diff) > idleBand * 0.5 ? "fan+heater" : "fan-heat";
    }
  }

  // Track fan start time across all fan-based phases (the fan relay stays on throughout
  // both fan-only and fan+appliance phases, so the clock runs continuously).
  var isFanBased =
    activeDevice === "fan" ||
    activeDevice === "fan+ac" ||
    activeDevice === "fan-heat" ||
    activeDevice === "fan+heater";
  var wasFanBased =
    prevHvacState === "fan" ||
    prevHvacState === "fan+ac" ||
    prevHvacState === "fan-heat" ||
    prevHvacState === "fan+heater";
  if (isFanBased && !wasFanBased)
    fanStartTime = Date.now(); // fan just turned on
  else if (!isFanBased) fanStartTime = null; // fan stopped, reset clock

  // Colour-code the large indoor temp readout
  $("indoor-temp").style.color =
    hvacState === "cooling"
      ? "#ef4444"
      : hvacState === "heating"
        ? "#38bdf8"
        : "#2dd4bf";

  // ── AI recommendation text ────────────────────────────────────
  // Builds the status paragraph shown in the rec box.
  function buildRec(statusLine) {
    var lines = [statusLine];
    if (trendRate !== null) {
      var abs = (Math.abs(trendRate) * (isCelsius ? 1 : 9 / 5)).toFixed(1);
      var dir = trendRate > 0 ? "rising" : "falling";
      if (Math.abs(trendRate) < 0.2) {
        lines.push("Temperature is <strong>stable</strong>.");
      } else {
        var note =
          hvacState === "idle" && trendRate > 0
            ? "watch for drift toward the upper threshold."
            : hvacState === "idle" && trendRate < 0
              ? "watch for drift toward the lower threshold."
              : hvacState === "cooling" && trendRate > 0
                ? "still climbing — cooling urgently needed."
                : hvacState === "cooling" && trendRate < 0
                  ? "cooling is working — temperature dropping."
                  : hvacState === "heating" && trendRate < 0
                    ? "still dropping — heating urgently needed."
                    : hvacState === "heating" && trendRate > 0
                      ? "heating is working — temperature rising."
                      : "";
        lines.push(
          "Trend: <strong>" +
            dir +
            "</strong> at " +
            abs +
            dispUnit() +
            "/hr" +
            (note ? " — " + note : "."),
        );
      }
    }
    if (outdoorHum !== null)
      lines.push(
        "Outdoor humidity: <strong>" +
          outdoorHum +
          "%</strong> — " +
          humLabel(outdoorHum) +
          ".",
      );
    if (outdoorTemp !== null) {
      var cap = function (s) {
        return s.replace(/\b\w/g, function (c) {
          return c.toUpperCase();
        });
      };
      var desc =
        outdoorDesc && outdoorDesc !== "--"
          ? " (" + cap(outdoorDesc) + ")"
          : "";
      lines.push(
        "Outdoor: <strong>" +
          dispTemp(outdoorTemp) +
          dispUnit() +
          "</strong>" +
          desc +
          ".",
      );
    }
    return lines.join("<br>");
  }

  // ── Execute state: drive GPIO outputs and update UI ───────────
  if (isAutomatic) {
    $("mode-display").innerText = "Auto";
    var shutoff;

    if (hvacState === "idle") {
      allOff();
      ["heater", "cooler", "fan"].forEach(function (d) {
        setDevice(d, false, "");
      });
      setBadge("idle", "Idle");
      updateRec(
        buildRec(
          "Indoor <strong>" +
            dispTemp(currentTemp) +
            dispUnit() +
            "</strong> — within " +
            dispBand() +
            " of target (" +
            dispTemp(targetTemp) +
            dispUnit() +
            "). No action required.",
        ),
        "idle",
      );
    } else if (hvacState === "cooling") {
      shutoff = dispTemp(targetTemp + coolShutoffOffset) + dispUnit();
      turnOff(RedLed);
      setDevice("heater", false, "");
      setBadge("cooling", "Cooling");

      if (activeDevice === "fan+ac") {
        // Fan alone not keeping up — AC added to assist
        turnOn(InletFan);
        turnOn(GreenLed);
        setDevice("fan", true, "cool");
        setDevice("cooler", true, "cool");
        updateRec(
          buildRec(
            "Indoor <strong>" +
              dispTemp(currentTemp) +
              dispUnit() +
              "</strong> — " +
              dispDelta(diff) +
              dispUnit() +
              " above target. Fan + AC assist active. Shutoff at <strong>" +
              shutoff +
              "</strong>.",
          ),
          "cool",
        );
      } else if (activeDevice === "fan") {
        // Outdoor cooler — inlet fan draws cool air in
        turnOn(InletFan);
        turnOff(GreenLed);
        setDevice("fan", true, "cool");
        setDevice("cooler", false, "");
        updateRec(
          buildRec(
            "Indoor <strong>" +
              dispTemp(currentTemp) +
              dispUnit() +
              "</strong> — " +
              dispDelta(diff) +
              dispUnit() +
              " above target. Outdoor (" +
              dispTemp(outdoorTemp) +
              dispUnit() +
              ") is cooler — inlet fan active. Shutoff at <strong>" +
              shutoff +
              "</strong>.",
          ),
          "cool",
        );
      } else {
        // Outdoor not cooler — AC only (GreenLed = D5 relay)
        turnOn(GreenLed);
        turnOff(InletFan);
        setDevice("cooler", true, "cool");
        setDevice("fan", false, "");
        var outNote =
          outdoorTemp !== null
            ? " Outdoor (" +
              dispTemp(outdoorTemp) +
              dispUnit() +
              ") not cooler — AC active."
            : " No outdoor data — AC active.";
        updateRec(
          buildRec(
            "Indoor <strong>" +
              dispTemp(currentTemp) +
              dispUnit() +
              "</strong> — " +
              dispDelta(diff) +
              dispUnit() +
              " above target." +
              outNote +
              " Shutoff at <strong>" +
              shutoff +
              "</strong>.",
          ),
          "cool",
        );
      }
    } else {
      // hvacState === 'heating'
      shutoff = dispTemp(targetTemp - heatShutoffOffset) + dispUnit();
      turnOff(GreenLed);
      setDevice("cooler", false, "");
      setBadge("heating", "Heating");

      if (activeDevice === "fan+heater") {
        // Fan alone not warming room enough — heater added to assist
        turnOn(InletFan);
        turnOn(RedLed); // RedLed = D18 relay
        setDevice("fan", true, "heat");
        setDevice("heater", true, "heat");
        updateRec(
          buildRec(
            "Indoor <strong>" +
              dispTemp(currentTemp) +
              dispUnit() +
              "</strong> — " +
              dispDelta(Math.abs(diff)) +
              dispUnit() +
              " below target. Fan + heater assist active. Shutoff at <strong>" +
              shutoff +
              "</strong>.",
          ),
          "heat",
        );
      } else if (activeDevice === "fan-heat") {
        // Outdoor warmer — inlet fan draws warm air in
        turnOn(InletFan);
        turnOff(RedLed);
        setDevice("fan", true, "heat");
        setDevice("heater", false, "");
        updateRec(
          buildRec(
            "Indoor <strong>" +
              dispTemp(currentTemp) +
              dispUnit() +
              "</strong> — " +
              dispDelta(Math.abs(diff)) +
              dispUnit() +
              " below target. Outdoor (" +
              dispTemp(outdoorTemp) +
              dispUnit() +
              ") is warmer — inlet fan drawing warm air in. Shutoff at <strong>" +
              shutoff +
              "</strong>.",
          ),
          "heat",
        );
      } else {
        // Outdoor not warmer — heater only (RedLed = D18 relay)
        turnOff(InletFan);
        turnOn(RedLed);
        setDevice("heater", true, "heat");
        setDevice("fan", false, "");
        updateRec(
          buildRec(
            "Indoor <strong>" +
              dispTemp(currentTemp) +
              dispUnit() +
              "</strong> — " +
              dispDelta(Math.abs(diff)) +
              dispUnit() +
              " below target. Heater active. Shutoff at <strong>" +
              shutoff +
              "</strong>.",
          ),
          "heat",
        );
      }
    }
  } else {
    $("mode-display").innerText = "Manual";
    var manualLine;
    if (manualDevice === "idle") {
      manualLine = "Manual mode — all devices off. Indoor <strong>" + dispTemp(currentTemp) + dispUnit() + "</strong>.";
    } else if (manualDevice === "heating") {
      manualLine = "Manual: Heater on. Indoor <strong>" + dispTemp(currentTemp) + dispUnit() + "</strong> — " + dispDelta(Math.abs(diff)) + dispUnit() + (diff < 0 ? " below" : " above") + " target.";
    } else if (manualDevice === "cooling") {
      manualLine = "Manual: Cooler/AC on. Indoor <strong>" + dispTemp(currentTemp) + dispUnit() + "</strong> — " + dispDelta(Math.abs(diff)) + dispUnit() + (diff < 0 ? " below" : " above") + " target.";
    } else if (manualDevice === "fan") {
      manualLine = "Manual: Inlet fan on. Indoor <strong>" + dispTemp(currentTemp) + dispUnit() + "</strong> — " + dispDelta(Math.abs(diff)) + dispUnit() + (diff < 0 ? " below" : " above") + " target.";
    } else if (manualDevice === "fan+heater") {
      manualLine = "Manual: Fan + Heater on. Indoor <strong>" + dispTemp(currentTemp) + dispUnit() + "</strong> — " + dispDelta(Math.abs(diff)) + dispUnit() + (diff < 0 ? " below" : " above") + " target.";
    } else {
      manualLine = "Manual: Fan + AC on. Indoor <strong>" + dispTemp(currentTemp) + dispUnit() + "</strong> — " + dispDelta(Math.abs(diff)) + dispUnit() + (diff < 0 ? " below" : " above") + " target.";
    }
    var manualRecType = (manualDevice === "heating" || manualDevice === "fan+heater") ? "heat" :
                        (manualDevice === "cooling" || manualDevice === "fan+ac" || manualDevice === "fan") ? "cool" : "";
    updateRec(buildRec(manualLine), manualRecType);
  }

  // POST a reading every 2 s (silent-fail)
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

  // Any device transition (e.g. fan-heat → fan+heater) closes old event, opens new one.
  if (isAutomatic && activeDevice !== prevHvacState) {
    if (prevHvacState !== "idle") closeHvacEvent(currentTemp);
    if (activeDevice !== "idle") openHvacEvent(activeDevice, currentTemp);
    prevHvacState = activeDevice;
  }
}

await mSec(2000);
