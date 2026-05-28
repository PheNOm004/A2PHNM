// ── Global state ─────────────────────────────────────────────────
var isAutomatic  = true;        // true = auto mode, false = manual
var hvacState    = 'idle';      // 'idle' | 'heating' | 'cooling'
var targetTemp   = 22.0;        // desired indoor temp (always stored in °C)
var idleBand     = 1.0;         // ±°C dead-band before HVAC activates
var outdoorTemp  = null;        // from OpenWeatherMap (°C)
var outdoorFeels = null;
var outdoorHum   = null;
var outdoorDesc  = '--';
var currentCity  = 'Sydney';
var tempHistory  = [];          // ring buffer: { ts, temp, target }
var isCelsius    = true;
var MAX_HISTORY  = 60;          // 60 × 2 s = 2 min of live history

var WEATHER_KEY = (typeof WEATHER_API_KEY !== 'undefined') ? WEATHER_API_KEY : '';
var COAST_FACTOR          = 0.15;  // auto-updated from weather; fine-tunable by user
var THERMAL_COEFF         = 0.035; // auto-updated from weather; fine-tunable by user
var COAST_ASYMMETRY       = 0.0;   // -1 = warm bias, 0 = neutral, +1 = cool bias
const FAN_MIN_RUN_MINS    = 10;    // minimum fan run before appliance is added (fixed)

// ── PocketBase ────────────────────────────────────────────────────
var PB = (typeof PB_URL !== 'undefined') ? PB_URL : 'http://localhost:8090';
var settingsId    = null;   // record ID for PATCH calls
var openEventId   = null;   // ID of the currently-open hvac_events record
var prevHvacState    = 'idle'; // for state-transition detection in jsloop
var fanStartTime     = null;   // Date.now() when current fan run started
var outdoorWarmPolls = 0;      // consecutive weather fetches where outdoor >= indoor (cooling commitment guard)
var outdoorCoolPolls = 0;      // consecutive weather fetches where outdoor <= indoor (heating commitment guard)
var currentRange  = '1h';
var analysisCache = [];     // last-fetched events (avoids re-fetch on input change)
var manualDevice  = 'idle';    // tracks which device manualControl() last activated
var lastKnownTemp = null;      // last parsed indoor temp — shared with event helpers
var _histMeta     = null;      // geometry snapshot from last renderHistoryChart — used by hover tooltip
var STATE_COLORS  = {
    heating:      '#f04040',
    'fan+heater': '#f87060',
    'fan-heat':   '#e09030',
    cooling:      '#40a8f8',
    'fan+ac':     '#2bc4d8',
    fan:          '#24d09a',
    idle:         '#4e6580'
};

// Modal has its own temp/unit so changes can be discarded before confirming
var modalTargetTemp = 22.0;
var modalIsCelsius  = true;

// ── Helpers ───────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

// dispTemp: absolute conversion — adds 32 for °F (e.g. 22 °C → 71.6 °F)
// dispDelta: difference conversion — only scales, no +32 (e.g. 2 °C → 3.6 °F)
function dispTemp(c)  { return (isCelsius ? c : c*9/5+32).toFixed(1); }
function dispDelta(d) { return (isCelsius ? d : d*9/5).toFixed(1); }
function dispUnit()   { return isCelsius ? '°C' : '°F'; }
function dispBand()   { return '±' + dispDelta(idleBand) + dispUnit(); }

// Initialise and clear a canvas, returning { ctx, W, H } or null if not found.
// Handles HiDPI scaling — call once per render, then draw with returned ctx/W/H.
function initCanvas(id, fallbackH) {
    var c = $(id); if (!c) return null;
    var dpr = window.devicePixelRatio || 1;
    var rect = c.parentElement.getBoundingClientRect();
    var W = rect.width || 600, H = rect.height || (fallbackH || 180);
    c.width = W*dpr; c.height = H*dpr;
    c.style.width = W+'px'; c.style.height = H+'px';
    var ctx = c.getContext('2d');
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.fillStyle = '#0c1220'; ctx.fillRect(0,0,W,H);
    return {ctx:ctx, W:W, H:H};
}

// Silent-fail PocketBase helpers
function _pbHeaders() {
    var h = {'Content-Type': 'application/json'};
    if (typeof PB_API_TOKEN !== 'undefined' && PB_API_TOKEN) h['Authorization'] = 'Bearer ' + PB_API_TOKEN;
    return h;
}
function pbPost(path, body) {
    return fetch(PB+path, {method:'POST', headers:_pbHeaders(), body:JSON.stringify(body)})
        .then(function(r){return r.ok?r:null;}).catch(function(){return null;});
}
function pbPatch(path, body) {
    return fetch(PB+path, {method:'PATCH', headers:_pbHeaders(), body:JSON.stringify(body)})
        .then(function(r){return r.ok?r:null;}).catch(function(){return null;});
}

// ── Unit toggle ───────────────────────────────────────────────────
function setUnit(celsius) {
    isCelsius = celsius;
    $('btn-c').className = 'unit-opt' + (celsius  ? ' active' : '');
    $('btn-f').className = 'unit-opt' + (!celsius ? ' active' : '');
    var u = dispUnit();
    $('temp-unit').innerText    = u;
    $('target-temp').innerText  = dispTemp(targetTemp) + u;
    $('idle-band').innerText    = dispBand();
    $('out-temp-lbl').innerText = 'Temp ' + u;
    if (outdoorTemp  !== null) $('out-temp').innerText  = dispTemp(outdoorTemp);
    if (outdoorFeels !== null) $('out-feels').innerText = dispTemp(outdoorFeels) + u;
    patchSettings();
}

// ── Mode ──────────────────────────────────────────────────────────
function setMode(mode) {
    if (!isAutomatic && mode === 'manual') return;
    if (isAutomatic  && mode === 'auto')   return;
    if (mode === 'manual') {
        // Close any open auto-mode event before handing over control
        if (prevHvacState !== 'idle') closeHvacEvent(lastKnownTemp);
        isAutomatic = false;
        hvacState = 'idle';
        manualDevice = 'idle';
        prevHvacState = 'idle';
        setBadge('manual', 'Manual');
        $('mode-display').innerText = 'Manual';
        updateRec('Manual mode — device control active. AI monitoring continues.', '');
    } else {
        // Close any open manual-mode event before returning to auto
        if (manualDevice !== 'idle') closeHvacEvent(lastKnownTemp);
        isAutomatic = true;
        manualDevice = 'idle';
        prevHvacState = 'idle';
        $('mode-display').innerText = 'Auto';
    }
    $('mode-label').innerText = isAutomatic ? 'Automatic' : 'Manual';
    $('btn-auto').className   = 'btn-mode' + (isAutomatic  ? ' active' : '');
    $('btn-manual').className = 'btn-mode' + (!isAutomatic ? ' active' : '');
    $('manual').style.display = isAutomatic ? 'none' : 'block';
}

// ── Target & band ─────────────────────────────────────────────────
// Clamps to 10–35 °C, snaps to nearest 0.5 °C
function adjustTarget(delta) {
    targetTemp = Math.max(10, Math.min(35, Math.round((targetTemp+delta)*2)/2));
    $('target-temp').innerText = dispTemp(targetTemp) + dispUnit();
    patchSettings();
}

// Clamps to 0.5–3.0 °C
function adjustIdleBand(delta) {
    idleBand = Math.max(0.5, Math.min(3.0, Math.round((idleBand+delta)*2)/2));
    $('idle-band').innerText = dispBand();
    var el2=$('idle-band-2'); if (el2) el2.innerText=dispBand();
    patchSettings();
}

// Manual override for auto-calculated weather coefficients
function updateCoeff() {
    var cf=parseFloat(($('coast-factor')||{}).value);
    var tc=parseFloat(($('thermal-coeff')||{}).value);
    if (!isNaN(cf)&&cf>0) COAST_FACTOR=parseFloat(cf.toFixed(3));
    if (!isNaN(tc)&&tc>0) THERMAL_COEFF=parseFloat(tc.toFixed(3));
    patchSettings();
}

// Coasting direction bias: -1 = warm-biased, 0 = neutral, +1 = cool-biased
function coastAsymmetryLabel() {
    if (Math.abs(COAST_ASYMMETRY) < 0.05) return 'Neutral';
    var pct = Math.abs(Math.round(COAST_ASYMMETRY * 100));
    return COAST_ASYMMETRY > 0 ? 'Cool +' + pct + '%' : 'Warm +' + pct + '%';
}
function adjustCoastAsymmetry(delta) {
    COAST_ASYMMETRY = Math.max(-1.0, Math.min(1.0, Math.round((COAST_ASYMMETRY + delta) * 10) / 10));
    var el=$('coast-asymmetry-val'); if (el) el.innerText=coastAsymmetryLabel();
    patchSettings();
}

// Auto-calculates shutoff coefficients from live outdoor data.
// Called every time weather is successfully fetched (every 5 min).
// COAST_FACTOR: larger outdoor/indoor gap → more thermal momentum → shut off sooner
// THERMAL_COEFF: higher humidity → better wall heat-transfer → wider shutoff margin
function updateCoeffsFromWeather() {
    var indoorRef = lastKnownTemp !== null ? lastKnownTemp : targetTemp;
    var diff = Math.abs(outdoorTemp - indoorRef);
    // 0.050 at 0°C gap → 0.150 at 10°C gap (default) → 0.300 at 25°C gap
    COAST_FACTOR  = parseFloat(Math.max(0.050, Math.min(0.300, 0.050 + diff * 0.010)).toFixed(3));
    // 0.010 at 0% humidity → 0.035 at 50% (default) → 0.060 at 100%
    THERMAL_COEFF = parseFloat(Math.max(0.010, Math.min(0.060, 0.010 + (outdoorHum||50)/100 * 0.050)).toFixed(3));
    // Sync input displays so user can see the auto-calculated values
    var cfEl=$('coast-factor'); if (cfEl) cfEl.value=COAST_FACTOR.toFixed(3);
    var tcEl=$('thermal-coeff'); if (tcEl) tcEl.value=THERMAL_COEFF.toFixed(3);
    patchSettings();
}

// ── Manual control ────────────────────────────────────────────────
function allOff() { [RedLed, GreenLed, InletFan].forEach(turnOff); }

function manualControl(cmd) {
    if (isAutomatic) { alert('Switch to Manual mode first.'); return; }
    if (manualDevice !== 'idle') closeHvacEvent(lastKnownTemp);
    allOff();
    ['heater','cooler','fan'].forEach(function(d) { setDevice(d, false, ''); });
    if (cmd === 'heater') {
        turnOn(RedLed);
        setDevice('heater', true, 'heat');
        manualDevice = 'heating';
        setBadge('heating', 'Heating');
        updateRec('Manual: Heater on.', 'heat');
    } else if (cmd === 'cooler') {
        turnOn(GreenLed);
        setDevice('cooler', true, 'cool');
        manualDevice = 'cooling';
        setBadge('cooling', 'Cooling');
        updateRec('Manual: Cooler / AC on.', 'cool');
    } else if (cmd === 'fan') {
        turnOn(InletFan);
        setDevice('fan', true, 'cool');
        manualDevice = 'fan';
        setBadge('cooling', 'Cooling');
        updateRec('Manual: Inlet fan on.', 'cool');
    } else if (cmd === 'heater+fan') {
        turnOn(RedLed);
        turnOn(InletFan);
        setDevice('heater', true, 'heat');
        setDevice('fan', true, 'heat');
        manualDevice = 'fan+heater';
        setBadge('heating', 'Heating');
        updateRec('Manual: Fan + Heater on.', 'heat');
    } else if (cmd === 'cooler+fan') {
        turnOn(GreenLed);
        turnOn(InletFan);
        setDevice('cooler', true, 'cool');
        setDevice('fan', true, 'cool');
        manualDevice = 'fan+ac';
        setBadge('cooling', 'Cooling');
        updateRec('Manual: Fan + AC on.', 'cool');
    } else {
        manualDevice = 'idle';
        setBadge('manual', 'Manual');
        updateRec('Manual mode — all devices off.', '');
    }
    prevHvacState = manualDevice;
    if (manualDevice !== 'idle') openHvacEvent(manualDevice, lastKnownTemp);
}

// ── DOM helpers ───────────────────────────────────────────────────
// setDevice: 'heater' targets #heater and #heater-state
function setDevice(name, active, type) {
    $(name).className = 'device-item' + (active ? (type==='heat' ? ' active-heat' : ' active-cool') : '');
    var s = $(name+'-state');
    s.innerText = active ? 'Active' : 'Off';
    s.className = 'device-state ' + (active ? 'status-on' : 'status-off');
}

function setBadge(type, label) {
    $('system-badge').className = 'status-badge ' + type;
    $('system-badge').innerText = label;
}

// type: 'heat' | 'cool' | 'idle' | '' — sets the coloured left-border style
function updateRec(msg, type) {
    var el = $('ai-rec');
    el.innerHTML = msg;
    el.className = 'rec-box' + (type==='heat' ? ' rec-heat' : type==='cool' ? ' rec-cool' : type==='idle' ? ' rec-idle' : '');
}

function humLabel(h) {
    return h<30 ? 'dry' : h<45 ? 'slightly dry' : h<=60 ? 'comfortable' : h<=70 ? 'slightly humid' : 'humid';
}

// ── Live history & 2-min chart ────────────────────────────────────
function addToHistory(temp) {
    tempHistory.push({ts:Date.now(), temp:temp, target:targetTemp});
    if (tempHistory.length > MAX_HISTORY) tempHistory.shift(); // keep buffer bounded
    renderChart();
}

function renderChart() {
    if (tempHistory.length < 2) return;
    var cv = initCanvas('temp-chart'); if (!cv) return;
    var ctx=cv.ctx, W=cv.W, H=cv.H;
    var pad={top:16,right:16,bottom:28,left:46};
    var cW=W-pad.left-pad.right, cH=H-pad.top-pad.bottom, n=tempHistory.length;

    // Convert stored °C to display unit at render time
    var vals = tempHistory.map(function(h) {
        return {temp:isCelsius?h.temp:h.temp*9/5+32, target:isCelsius?h.target:h.target*9/5+32};
    });

    // Auto-scale Y: pad ±0.5 around actual range; guard against flat line (range=0)
    var allV = vals.map(function(v){return v.temp;}).concat(vals.map(function(v){return v.target;}));
    var minV=Math.min.apply(null,allV)-0.5, maxV=Math.max.apply(null,allV)+0.5, range=(maxV-minV)||1;

    function xOf(i) { return pad.left + (i/(n-1))*cW; }
    function yOf(v) { return pad.top  + cH - ((v-minV)/range)*cH; }

    // Grid lines
    ctx.strokeStyle='#1c2840'; ctx.lineWidth=1;
    ctx.fillStyle='#4e6580'; ctx.font='10px system-ui'; ctx.textAlign='right';
    for (var i=0; i<=4; i++) {
        var gv=minV+(range/4)*i, gy=yOf(gv);
        ctx.beginPath(); ctx.moveTo(pad.left,gy); ctx.lineTo(pad.left+cW,gy); ctx.stroke();
        ctx.fillText(gv.toFixed(1)+'°', pad.left-4, gy+4);
    }

    // Target line (dashed teal), then indoor temp line (solid white)
    function drawLine(color, lw, dash, getter) {
        ctx.strokeStyle=color; ctx.lineWidth=lw; ctx.setLineDash(dash||[]);
        ctx.beginPath();
        vals.forEach(function(v,i){i===0?ctx.moveTo(xOf(i),yOf(getter(v))):ctx.lineTo(xOf(i),yOf(getter(v)));});
        ctx.stroke(); ctx.setLineDash([]);
    }
    drawLine('#11c8b5', 1.5, [5,4], function(v){return v.target;});
    drawLine('#ccd6e8', 2,   [],    function(v){return v.temp;});

    // X-axis time labels ("now", "-10s", etc.)
    var now=Date.now();
    ctx.fillStyle='#4e6580'; ctx.font='9px system-ui'; ctx.textAlign='center';
    [0,0.25,0.5,0.75,1].forEach(function(f){
        var idx=Math.round(f*(n-1)), ago=Math.round((now-tempHistory[idx].ts)/1000);
        ctx.fillText(ago<3?'now':'-'+ago+'s', xOf(idx), H-6);
    });

    // Legend
    ctx.textAlign='left'; ctx.font='10px system-ui';
    [['#ccd6e8','Indoor',4],['#11c8b5','Target',80]].forEach(function(l){
        ctx.fillStyle=l[0]; ctx.fillRect(pad.left+l[2], pad.top+4, 12,3);
        ctx.fillText(l[1], pad.left+l[2]+16, pad.top+11);
    });
}

// ── Weather ───────────────────────────────────────────────────────
// Always fetches metric (°C) — conversion happens at display time
async function fetchWeather() {
    try {
        var city = ($('city-in').value.trim() || currentCity).replace(/\s*,\s*/g,',');
        // Normalise "Liverpool, AU" → "Liverpool,AU" so OWM parses the country code correctly.
        // Preserve user's query as currentCity (not d.name) so country code survives auto-refresh.
        var r = await fetch('https://api.openweathermap.org/data/2.5/weather?q='+encodeURIComponent(city)+'&appid='+WEATHER_KEY+'&units=metric');
        if (!r.ok) return;
        var d = await r.json();
        currentCity=city; outdoorTemp=d.main.temp; outdoorFeels=d.main.feels_like;
        outdoorHum=d.main.humidity; outdoorDesc=d.weather[0].description;
        // Track consecutive polls where outdoor is not cooler than indoor —
        // used by the fan commitment window to confirm a genuine temp crossover.
        var indoorRef = tempHistory.length > 0 ? tempHistory[tempHistory.length-1].temp : targetTemp;
        outdoorWarmPolls = (outdoorTemp >= indoorRef) ? outdoorWarmPolls + 1 : 0;
        outdoorCoolPolls = (outdoorTemp <= indoorRef) ? outdoorCoolPolls + 1 : 0;
        var cap=function(s){return s.replace(/\b\w/g,function(c){return c.toUpperCase();});};
        $('city-label').innerText   = d.name+', '+d.sys.country;
        $('out-temp').innerText     = dispTemp(outdoorTemp);
        $('out-feels').innerText    = dispTemp(outdoorFeels)+dispUnit();
        $('out-humidity').innerText = outdoorHum;
        $('out-wind').innerText     = d.wind.speed.toFixed(1);
        $('out-pressure').innerText = d.main.pressure;
        $('out-conditions').innerText = cap(outdoorDesc);
        $('out-temp-lbl').innerText = 'Temp '+dispUnit();
        var inp=$('city-in'); inp.value=''; inp.placeholder=d.name+', '+d.sys.country;
        updateCoeffsFromWeather(); // recalculate shutoff tuning from fresh outdoor data
    } catch(e) {}
}

function updateCity() { fetchWeather(); }

// ── PocketBase: settings ──────────────────────────────────────────
async function loadSettings() {
    try {
        var r = await fetch(PB+'/api/collections/settings/records?perPage=1');
        if (!r.ok) return;
        var d = await r.json();
        if (d.totalItems === 0) {
            $('setup-modal').style.display = 'flex'; // first run
        } else {
            var s=d.items[0];
            settingsId=s.id; targetTemp=s.target_temp||targetTemp; idleBand=s.idle_band||idleBand;
            isCelsius = s.is_celsius !== undefined ? s.is_celsius : isCelsius;
            if (s.coast_factor         != null) COAST_FACTOR          = s.coast_factor;
            if (s.thermal_coeff        != null) THERMAL_COEFF         = s.thermal_coeff;
            if (s.coast_asymmetry      != null) COAST_ASYMMETRY       = s.coast_asymmetry;
            if (s.cost_kwh    != null) { var el=$('cost-kwh');    if (el) el.value=s.cost_kwh;    }
            if (s.watt_heater != null) { var el=$('watt-heater'); if (el) el.value=s.watt_heater; }
            if (s.watt_cooler != null) { var el=$('watt-cooler'); if (el) el.value=s.watt_cooler; }
            if (s.watt_fan    != null) { var el=$('watt-fan');    if (el) el.value=s.watt_fan;    }
            if (s.city) { currentCity=s.city; $('city-in').value=s.city; }
            setUnit(isCelsius);
            $('target-temp').innerText = dispTemp(targetTemp)+dispUnit();
            $('idle-band').innerText   = dispBand();
            var ib2=$('idle-band-2');   if (ib2) ib2.innerText=dispBand();
            var cfEl=$('coast-factor');   if (cfEl) cfEl.value=COAST_FACTOR.toFixed(3);
            var tcEl=$('thermal-coeff');  if (tcEl) tcEl.value=THERMAL_COEFF.toFixed(3);
            var caEl=$('coast-asymmetry-val'); if (caEl) caEl.innerText=coastAsymmetryLabel();
        }
    } catch(e) {}
}

async function patchSettings() {
    if (!settingsId) return;
    var kwh = parseFloat(($('cost-kwh')   ||{}).value) || 25;
    var wH  = parseFloat(($('watt-heater')||{}).value) || 1000;
    var wC  = parseFloat(($('watt-cooler')||{}).value) || 1500;
    var wF  = parseFloat(($('watt-fan')   ||{}).value) || 50;
    pbPatch('/api/collections/settings/records/'+settingsId, {
        target_temp:targetTemp, idle_band:idleBand, is_celsius:isCelsius,
        coast_factor:COAST_FACTOR, thermal_coeff:THERMAL_COEFF, coast_asymmetry:COAST_ASYMMETRY,
        cost_kwh:kwh, watt_heater:wH, watt_cooler:wC, watt_fan:wF
    });
}

// ── Startup modal ─────────────────────────────────────────────────
function modalAdjTemp(delta) {
    modalTargetTemp = Math.max(10, Math.min(35, Math.round((modalTargetTemp+delta)*2)/2));
    $('modal-temp-val').innerText = (modalIsCelsius?modalTargetTemp:modalTargetTemp*9/5+32).toFixed(1)+(modalIsCelsius?'°C':'°F');
}

function modalSetUnit(celsius) {
    modalIsCelsius=celsius;
    $('modal-btn-c').className='unit-opt'+(celsius ?' active':'');
    $('modal-btn-f').className='unit-opt'+(!celsius?' active':'');
    modalAdjTemp(0);
}

async function saveSetup() {
    var city=($('modal-city').value.trim()||'Sydney').replace(/\s*,\s*/g,',');
    try {
        var r = await pbPost('/api/collections/settings/records', {
            target_temp:modalTargetTemp, idle_band:idleBand, city:city, is_celsius:modalIsCelsius,
            coast_factor:COAST_FACTOR, thermal_coeff:THERMAL_COEFF, coast_asymmetry:COAST_ASYMMETRY,
            cost_kwh:25, watt_heater:1000, watt_cooler:1500, watt_fan:50
        });
        if (r) settingsId = (await r.json()).id;
    } catch(e) {}
    targetTemp=modalTargetTemp; isCelsius=modalIsCelsius; currentCity=city;
    $('city-in').value=city;
    setUnit(isCelsius);
    $('target-temp').innerText=dispTemp(targetTemp)+dispUnit();
    $('setup-modal').style.display='none';
    fetchWeather();
}

// ── Sidebar ───────────────────────────────────────────────────────
function toggleSidebar() { $('sidebar').classList.toggle('collapsed'); }

// Show one view, hide the others, load data on demand
function showView(name) {
    ['control','history','analysis'].forEach(function(v) {
        $('view-'+v).style.display = v===name ? '' : 'none';
        $('nav-' +v).className     = 'nav-btn'+(v===name?' active':'');
    });
    if (name==='history')  loadHistory(currentRange);
    if (name==='analysis') loadAnalysis();
}

// ── PocketBase: HVAC event logging ────────────────────────────────
async function openHvacEvent(type, temp) {
    try {
        var r = await pbPost('/api/collections/hvac_events/records', {type:type, ts_start:new Date().toISOString(), start_temp:temp, duration_mins:0});
        if (r) openEventId = (await r.json()).id;
    } catch(e) {}
}

async function closeHvacEvent(temp) {
    if (!openEventId) return;
    var id=openEventId; openEventId=null; // clear immediately to prevent double-close
    try {
        var resp = await fetch(PB+'/api/collections/hvac_events/records/'+id);
        if (!resp.ok) return;
        var ev = await resp.json();
        var startMs = ev.ts_start ? new Date(ev.ts_start).getTime() : 0;
        var dur = startMs ? (Date.now()-startMs)/60000 : 0;
        pbPatch('/api/collections/hvac_events/records/'+id, {ts_end:new Date().toISOString(), end_temp:temp, duration_mins:parseFloat(dur.toFixed(2))});
    } catch(e) {}
}

// ── History view ──────────────────────────────────────────────────
async function loadHistory(range) {
    currentRange=range;
    ['1h','6h','24h','7d'].forEach(function(r) {
        $('range-'+r).className='btn-range'+(r===range?' active':'');
    });

    var now=new Date(), from=new Date(now);
    if      (range==='1h')  from.setHours(now.getHours()-1);
    else if (range==='6h')  from.setHours(now.getHours()-6);
    else if (range==='24h') from.setDate(now.getDate()-1);
    else                     from.setDate(now.getDate()-7);

    // PocketBase filter format: 'ts>="2026-05-18 10:00:00"' — readings use explicit ts field
    var fStr=from.toISOString().replace('T',' ').slice(0,19);
    // For 1h: sort newest-first so the perPage cap gives us the most-recent data; reverse client-side.
    // For longer ranges: sort oldest-first to spread 500 samples evenly across the window.
    var readSort = range==='1h' ? '-ts' : 'ts';
    try {
        var res = await Promise.all([
            fetch(PB+'/api/collections/readings/records?sort='+readSort+'&perPage=500&filter='+encodeURIComponent('ts>="'+fStr+'"')).then(function(r){return r.json();}),
            fetch(PB+'/api/collections/hvac_events/records?sort=ts_start&perPage=500&filter='+encodeURIComponent('ts_start>="'+fStr+'"')).then(function(r){return r.json();})
        ]);
        var readItems = res[0].items||[];
        if (range==='1h') readItems = readItems.reverse(); // restore chronological order
        var evItems = res[1].items||[];
        renderHistoryChart(readItems, evItems);
        renderHistorySummary(readItems, evItems);
        attachHistoryTooltip();
        renderEventLog(evItems.slice().reverse()); // event log shows newest first
    } catch(e) {
        $('event-log').innerHTML='<div class="log-empty">PocketBase offline — start pocketbase.exe to enable history.</div>';
    }
}

function renderHistoryChart(readings, events) {
    var cv=initCanvas('history-chart'); if (!cv) return;
    var ctx=cv.ctx, W=cv.W, H=cv.H;
    if (readings.length < 2) {
        ctx.fillStyle='#4e6580'; ctx.font='13px system-ui'; ctx.textAlign='center';
        ctx.fillText('No data for this range yet.', W/2, H/2); return;
    }

    var pad={top:22,right:16,bottom:32,left:46};
    var cW=W-pad.left-pad.right, cH=H-pad.top-pad.bottom;

    // Null-guard target_temp: fall back to current targetTemp so NaN never enters Y-scale
    var vals=readings.map(function(r){
        var tgt = r.target_temp != null ? r.target_temp : targetTemp;
        return {
            ts:     new Date(r.ts).getTime(),
            temp:   isCelsius ? r.indoor_temp : r.indoor_temp*9/5+32,
            target: isCelsius ? tgt : tgt*9/5+32
        };
    });
    var minTs=vals[0].ts, maxTs=vals[vals.length-1].ts, tsRange=maxTs-minTs||1;
    var allV=vals.map(function(v){return v.temp;}).concat(vals.map(function(v){return v.target;}));
    var minV=Math.min.apply(null,allV)-0.5, vRange=(Math.max.apply(null,allV)+0.5-minV)||1;

    function xOf(ts){ return pad.left+((ts-minTs)/tsRange)*cW; }
    function yOf(v) { return pad.top+cH-((v-minV)/vRange)*cH; }

    // Unified color palette — matches CSS custom properties and badge/device colors
    var SC = STATE_COLORS;
    function scAlpha(hex) {
        var r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
        return 'rgba('+r+','+g+','+b+',0.13)';
    }

    // Pre-parse event timestamps once
    var evParsed=events.map(function(ev){
        return {type:ev.type, s:new Date(ev.ts_start).getTime(), e:ev.ts_end?new Date(ev.ts_end).getTime():maxTs, start_temp:ev.start_temp, end_temp:ev.end_temp};
    });

    // Coloured background bands
    evParsed.forEach(function(ev){
        var x0=xOf(Math.max(minTs,ev.s)), x1=xOf(Math.min(maxTs,ev.e));
        ctx.fillStyle=scAlpha(SC[ev.type]||SC.cooling);
        ctx.fillRect(x0, pad.top, Math.max(1,x1-x0), cH);
    });

    // Grid lines + Y-axis labels
    ctx.strokeStyle='#1c2840'; ctx.lineWidth=1;
    ctx.fillStyle='#4e6580'; ctx.font='10px system-ui'; ctx.textAlign='right';
    for (var gi=0; gi<=4; gi++) {
        var gv=minV+(vRange/4)*gi, gy=yOf(gv);
        ctx.beginPath(); ctx.moveTo(pad.left,gy); ctx.lineTo(pad.left+cW,gy); ctx.stroke();
        ctx.fillText(gv.toFixed(1)+'°', pad.left-4, gy+4);
    }

    // X-axis time labels — tick interval and format depend on range
    var tickMs = currentRange==='1h'?900000:currentRange==='6h'?3600000:currentRange==='24h'?14400000:86400000;
    var firstTick = Math.ceil(minTs/tickMs)*tickMs;
    ctx.fillStyle='#4e6580'; ctx.font='9px system-ui'; ctx.textAlign='center';
    for (var t=firstTick; t<=maxTs; t+=tickMs) {
        var tx=xOf(t); if (tx<pad.left+4||tx>pad.left+cW-4) continue;
        var d=new Date(t);
        var lbl=currentRange==='7d'
            ? ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()]+' '+(d.getMonth()+1)+'/'+(d.getDate())
            : (d.getHours()<10?'0':'')+d.getHours()+':'+(d.getMinutes()<10?'0':'')+d.getMinutes();
        ctx.fillText(lbl, tx, H-6);
        ctx.strokeStyle='#1c2840'; ctx.lineWidth=1;
        ctx.beginPath(); ctx.moveTo(tx,pad.top+cH); ctx.lineTo(tx,pad.top+cH+4); ctx.stroke();
    }

    // Target line — step-connect readings so target changes show as jumps, not diagonals
    var prevTgt=null;
    ctx.strokeStyle='#f59e0b'; ctx.lineWidth=1.5; ctx.setLineDash([5,4]);
    ctx.beginPath();
    vals.forEach(function(v,i){
        if (i===0) { ctx.moveTo(xOf(v.ts),yOf(v.target)); }
        else if (v.target !== prevTgt) {
            ctx.lineTo(xOf(v.ts),yOf(prevTgt)); // horizontal until this point
            ctx.lineTo(xOf(v.ts),yOf(v.target)); // then step vertically
        } else {
            ctx.lineTo(xOf(v.ts),yOf(v.target));
        }
        prevTgt=v.target;
    });
    ctx.stroke(); ctx.setLineDash([]);

    // Indoor temp line — colored by dominant HVAC state within each segment.
    // For each segment find the event with the most time overlap; if it covers any of the
    // segment, use that color — ensures line matches background bands consistently.
    function stateForSegment(ts0, ts1) {
        var bestType='idle', bestOverlap=0;
        for (var j=0; j<evParsed.length; j++) {
            var overlap=Math.min(ts1,evParsed[j].e)-Math.max(ts0,evParsed[j].s);
            if (overlap>bestOverlap) { bestOverlap=overlap; bestType=evParsed[j].type; }
        }
        return bestOverlap>0 ? bestType : 'idle';
    }
    ctx.lineWidth=2; ctx.setLineDash([]);
    for (var i=1; i<vals.length; i++) {
        ctx.strokeStyle=SC[stateForSegment(vals[i-1].ts,vals[i].ts)]||SC.idle;
        ctx.beginPath();
        ctx.moveTo(xOf(vals[i-1].ts),yOf(vals[i-1].temp));
        ctx.lineTo(xOf(vals[i].ts),yOf(vals[i].temp));
        ctx.stroke();
    }

    // Legend — top-left, inside top padding
    var legendItems=[
        {c:'#f59e0b',dash:true,l:'Target'},
        {c:SC.heating,l:'Heating'},{c:SC['fan+heater'],l:'Fan+Heater'},
        {c:SC['fan-heat'],l:'Fan(heat)'},{c:SC.cooling,l:'AC'},
        {c:SC['fan+ac'],l:'Fan+AC'},{c:SC.fan,l:'Fan(cool)'},{c:SC.idle,l:'Idle'}
    ];
    ctx.font='9px system-ui'; ctx.lineWidth=1.5;
    var lx=pad.left+2, ly=11;
    legendItems.forEach(function(it){
        ctx.strokeStyle=it.c; ctx.setLineDash(it.dash?[4,3]:[]);
        ctx.beginPath(); ctx.moveTo(lx,ly); ctx.lineTo(lx+12,ly); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle=it.c; ctx.textAlign='left';
        ctx.fillText(it.l, lx+14, ly+3);
        lx+=14+ctx.measureText(it.l).width+8;
    });

    // Dot + temp label at each event boundary
    evParsed.forEach(function(ev){
        var color=SC[ev.type]||SC.idle;
        function mark(ts, temp, above) {
            if (temp==null) return;
            var mx=xOf(ts), my=yOf(isCelsius?temp:temp*9/5+32);
            if (mx<pad.left||mx>pad.left+cW) return;
            ctx.beginPath(); ctx.arc(mx,my,4,0,Math.PI*2);
            ctx.fillStyle=color; ctx.fill();
            ctx.strokeStyle='#0c1220'; ctx.lineWidth=1.5; ctx.stroke();
            ctx.fillStyle=color; ctx.font='bold 9px system-ui'; ctx.textAlign='center';
            ctx.fillText((isCelsius?temp:temp*9/5+32).toFixed(1)+'°', mx, Math.max(pad.top+10,Math.min(H-pad.bottom-4,my+(above?-8:14))));
        }
        mark(ev.s, ev.start_temp, true);
        if (ev.e<maxTs) mark(ev.e, ev.end_temp, false);
    });
    _histMeta = {vals:vals, evParsed:evParsed, pad:pad, W:W, H:H, minTs:minTs, tsRange:tsRange, minV:minV, vRange:vRange, cW:cW, cH:cH};
}

function renderEventLog(events) {
    var el=$('event-log');
    if (!events.length) { el.innerHTML='<div class="log-empty">No events in this period.</div>'; return; }
    var rows=events.map(function(ev){
        var cls=(ev.type==='heating'||ev.type==='fan+heater')?'ev-heat':(ev.type==='fan'||ev.type==='fan-heat')?'ev-fan':'ev-cool';
        var icon=ev.type==='heating'?'🔥':ev.type==='fan+heater'?'💨🔥':ev.type==='fan-heat'?'💨🌡️':ev.type==='fan'?'💨':ev.type==='fan+ac'?'💨❄️':'❄️';
        return '<tr class="'+cls+'"><td>'+new Date(ev.ts_start).toLocaleString()+'</td>'
            +'<td>'+icon+' '+ev.type+'</td>'
            +'<td>'+(ev.duration_mins?ev.duration_mins.toFixed(1)+' min':'ongoing')+'</td>'
            +'<td>'+(ev.start_temp!=null?dispTemp(ev.start_temp)+dispUnit():'--')+' → '+(ev.end_temp!=null?dispTemp(ev.end_temp)+dispUnit():'--')+'</td></tr>';
    }).join('');
    el.innerHTML='<table class="event-log-table"><thead><tr><th>Date / Time</th><th>Type</th><th>Duration</th><th>Temp Change</th></tr></thead><tbody>'+rows+'</tbody></table>';
}

function renderHistorySummary(readings, events) {
    var el=$('history-summary'); if (!el) return;
    if (!readings.length && !events.length) { el.style.display='none'; return; }
    var temps=readings.map(function(r){return isCelsius?r.indoor_temp:r.indoor_temp*9/5+32;});
    var avgTemp=temps.length?(temps.reduce(function(a,b){return a+b;},0)/temps.length):null;
    var minTemp=temps.length?Math.min.apply(null,temps):null;
    var maxTemp=temps.length?Math.max.apply(null,temps):null;
    var heatingMins=0, coolingMins=0, fanMins=0;
    events.forEach(function(ev){
        var m=ev.duration_mins||0;
        if (ev.type==='heating'||ev.type==='fan+heater') heatingMins+=m;
        else if (ev.type==='cooling'||ev.type==='fan+ac') coolingMins+=m;
        else if (ev.type==='fan'||ev.type==='fan-heat') fanMins+=m;
    });
    var u=dispUnit();
    var items=[];
    if (avgTemp!==null) items.push('<div class="hs-item"><div class="hs-val">'+avgTemp.toFixed(1)+u+'</div><div class="hs-lbl">Avg Temp</div></div>');
    if (minTemp!==null) items.push('<div class="hs-item"><div class="hs-val cool">'+minTemp.toFixed(1)+u+'</div><div class="hs-lbl">Min Temp</div></div>');
    if (maxTemp!==null) items.push('<div class="hs-item"><div class="hs-val heat">'+maxTemp.toFixed(1)+u+'</div><div class="hs-lbl">Max Temp</div></div>');
    items.push('<div class="hs-item"><div class="hs-val heat">'+(heatingMins>0?Math.round(heatingMins)+'m':'—')+'</div><div class="hs-lbl">Heating</div></div>');
    items.push('<div class="hs-item"><div class="hs-val cool">'+(coolingMins>0?Math.round(coolingMins)+'m':'—')+'</div><div class="hs-lbl">Cooling</div></div>');
    items.push('<div class="hs-item"><div class="hs-val fan">'+(fanMins>0?Math.round(fanMins)+'m':'—')+'</div><div class="hs-lbl">Fan</div></div>');
    items.push('<div class="hs-item"><div class="hs-val">'+events.length+'</div><div class="hs-lbl">Events</div></div>');
    el.innerHTML=items.join(''); el.style.display='flex';
}

function attachHistoryTooltip() {
    var canvas=$('history-chart'), tip=$('chart-tooltip');
    if (!canvas||!tip) return;
    canvas.onmousemove=function(e) {
        if (!_histMeta) return;
        var rect=canvas.getBoundingClientRect();
        var mx=e.clientX-rect.left;
        var m=_histMeta;
        if (mx<m.pad.left||mx>m.pad.left+m.cW) { tip.style.display='none'; return; }
        var ts=m.minTs+((mx-m.pad.left)/m.cW)*m.tsRange;
        var nearest=null, minD=Infinity;
        m.vals.forEach(function(v){var d=Math.abs(v.ts-ts); if(d<minD){minD=d;nearest=v;}});
        if (!nearest) { tip.style.display='none'; return; }
        var state='idle';
        for (var i=0;i<m.evParsed.length;i++){var ev=m.evParsed[i]; if(nearest.ts>=ev.s&&nearest.ts<=ev.e){state=ev.type;break;}}
        var d=new Date(nearest.ts);
        var timeStr=d.getHours()+':'+(d.getMinutes()<10?'0':'')+d.getMinutes()+':'+(d.getSeconds()<10?'0':'')+d.getSeconds();
        tip.innerHTML='<div class="tip-time">'+timeStr+'</div>'
            +'<div class="tip-row"><span>Indoor</span><strong>'+nearest.temp.toFixed(1)+'°</strong></div>'
            +'<div class="tip-row"><span>Target</span><strong>'+nearest.target.toFixed(1)+'°</strong></div>'
            +'<div class="tip-row"><span>State</span><strong style="color:'+(STATE_COLORS[state]||'#4e6580')+'">'+state+'</strong></div>';
        var tipX=mx+12, tipY=(e.clientY-rect.top)-90;
        if (tipX+145>m.W) tipX=mx-155;
        if (tipY<0) tipY=4;
        tip.style.left=tipX+'px'; tip.style.top=tipY+'px'; tip.style.display='block';
    };
    canvas.onmouseleave=function(){tip.style.display='none';};
}

// ── Analysis view ─────────────────────────────────────────────────
async function loadAnalysis() {
    // Sync all tuning controls to current runtime values
    var ib2=$('idle-band-2');   if (ib2) ib2.innerText=dispBand();
    var cfEl=$('coast-factor');   if (cfEl) cfEl.value=COAST_FACTOR.toFixed(3);
    var tcEl=$('thermal-coeff');  if (tcEl) tcEl.value=THERMAL_COEFF.toFixed(3);
    var caEl=$('coast-asymmetry-val'); if (caEl) caEl.innerText=coastAsymmetryLabel();

    var from=new Date(); from.setDate(from.getDate()-7);
    var fStr=from.toISOString().replace('T',' ').slice(0,19);
    try {
        var r=await fetch(PB+'/api/collections/hvac_events/records?sort=ts_start&perPage=500&filter='+encodeURIComponent('ts_start>="'+fStr+'"'));
        analysisCache=(await r.json()).items||[];
    } catch(e) { analysisCache=[]; }
    renderRuntimeChart(analysisCache);
    buildInsights(analysisCache);
}

// Grouped bar chart: one group per day, three bars (heater/AC/fan) in minutes
function renderRuntimeChart(events) {
    var cv=initCanvas('runtime-chart',220); if (!cv) return;
    var ctx=cv.ctx, W=cv.W, H=cv.H;

    // Last 7 calendar days as YYYY-MM-DD strings
    var days=[];
    for (var i=6; i>=0; i--) { var d=new Date(); d.setDate(d.getDate()-i); days.push(d.toISOString().slice(0,10)); }

    // Accumulate runtime minutes per device type per day
    var totals={};
    days.forEach(function(day){totals[day]={heating:0,cooling:0,fan:0};});
    events.forEach(function(ev){
        var day=ev.ts_start.slice(0,10), mins=ev.duration_mins||0;
        if (!totals[day]) return;
        if      (ev.type==='heating')    totals[day].heating+=mins;
        else if (ev.type==='cooling')    totals[day].cooling+=mins;
        else if (ev.type==='fan')        totals[day].fan+=mins;
        else if (ev.type==='fan+ac')     { totals[day].fan+=mins; totals[day].cooling+=mins; }
        else if (ev.type==='fan-heat')   totals[day].fan+=mins;
        else if (ev.type==='fan+heater') { totals[day].fan+=mins; totals[day].heating+=mins; }
    });

    var maxMins=Math.max(1,Math.max.apply(null,days.map(function(day){return totals[day].heating+totals[day].cooling+totals[day].fan;})));
    var pad={top:16,right:16,bottom:36,left:46};
    var cW=W-pad.left-pad.right, cH=H-pad.top-pad.bottom;
    var groupW=cW/days.length, barW=groupW*0.65, subW=barW/3;

    // Y-axis grid (labels in minutes)
    ctx.strokeStyle='#1c2840'; ctx.lineWidth=1;
    ctx.fillStyle='#4e6580'; ctx.font='10px system-ui'; ctx.textAlign='right';
    for (var gi=0; gi<=4; gi++) {
        var gv=(maxMins/4)*gi, gy=pad.top+cH-(gv/maxMins)*cH;
        ctx.beginPath(); ctx.moveTo(pad.left,gy); ctx.lineTo(pad.left+cW,gy); ctx.stroke();
        ctx.fillText(Math.round(gv)+'m', pad.left-4, gy+4);
    }

    var series=['heating','cooling','fan'], colors=['#f04040','#40a8f8','#24d09a'];
    days.forEach(function(day,di){
        var cx=pad.left+di*groupW+groupW/2;
        series.forEach(function(type,si){
            var mins=totals[day][type]; if (!mins) return;
            ctx.fillStyle=colors[si];
            ctx.fillRect(cx-barW/2+si*subW, pad.top+cH-(mins/maxMins)*cH, subW-1, (mins/maxMins)*cH);
        });
        ctx.fillStyle='#4e6580'; ctx.font='9px system-ui'; ctx.textAlign='center';
        ctx.fillText(day.slice(5), cx, H-8);
    });

    // Legend — fan teal, AC blue, heater red (matches bar colours)
    ctx.textAlign='left'; ctx.font='9px system-ui'; var lx=pad.left;
    [['Heater','#f04040'],['AC (costly)','#40a8f8'],['Inlet Fan','#24d09a']].forEach(function(l){
        ctx.fillStyle=l[1]; ctx.fillRect(lx,pad.top+2,10,3);
        ctx.fillStyle='#4e6580'; ctx.fillText(l[0],lx+14,pad.top+11); lx+=72;
    });
}

// Re-runs insights and persists cost values whenever any cost input changes
function refreshInsights() { buildInsights(analysisCache); patchSettings(); }

// Generates cost-minimisation insights from event data.
// Relay costs: heater relay → wHeat, cooler relay → wCool, fan relay → wFan (fan+ac runs both)
function buildInsights(events) {
    var el=$('analysis-insights');
    if (!events.length) {
        el.innerHTML='No data yet — HVAC events will appear here once the system logs heating/cooling cycles.';
        el.className='rec-box'; return;
    }
    var kwh=parseFloat($('cost-kwh').value)||25;
    var wHeat=parseFloat($('watt-heater').value)||1000;
    var wCool=parseFloat($('watt-cooler').value)||1500;
    var wFan=parseFloat($('watt-fan').value)||50;
    var cPk=kwh/100; // $ per kWh

    // Track relay runtimes separately — fan relay may run alongside heater/AC
    var heaterMins=0, acMins=0, fanRelayMins=0, fanOnlyMins=0;
    var shortCycles=0, dailyMins={};

    events.forEach(function(ev){
        var mins=ev.duration_mins||0, day=ev.ts_start.slice(0,10);
        if (mins>0&&mins<5) shortCycles++;
        dailyMins[day]=(dailyMins[day]||0)+mins;
        switch(ev.type){
            case 'heating':    heaterMins+=mins; break;
            case 'cooling':    acMins+=mins; break;
            case 'fan':        fanOnlyMins+=mins; fanRelayMins+=mins; break;
            case 'fan-heat':   fanOnlyMins+=mins; fanRelayMins+=mins; break;
            case 'fan+ac':     acMins+=mins; fanRelayMins+=mins; break;
            case 'fan+heater': heaterMins+=mins; fanRelayMins+=mins; break;
        }
    });

    var costHeat=(heaterMins/60)*(wHeat/1000)*cPk;
    var costCool=(acMins/60)*(wCool/1000)*cPk;
    var costFan=(fanRelayMins/60)*(wFan/1000)*cPk;
    var totalCost=costHeat+costCool+costFan;

    // Efficiency: what fraction of active cycles used only the fan (cheapest)?
    var totalActiveMins=heaterMins+acMins+fanOnlyMins;
    var efficiency=totalActiveMins>0?Math.round((fanOnlyMins/totalActiveMins)*100):0;
    var effLabel=efficiency>=70?'excellent':efficiency>=45?'good':efficiency>=20?'fair':'low';

    var activeDays=Math.max(1,Object.keys(dailyMins).length);
    var avgDailyMins=Math.round(totalActiveMins/activeDays);

    var rateHeat=(wHeat/1000*cPk*100).toFixed(1);
    var rateCool=(wCool/1000*cPk*100).toFixed(1);
    var rateFan=(wFan/1000*cPk*100).toFixed(1);

    var lines=[];

    lines.push(
        'Heater: <strong>'+(heaterMins/60).toFixed(1)+'h</strong> &nbsp;·&nbsp; '+
        'AC: <strong>'+(acMins/60).toFixed(1)+'h</strong> &nbsp;·&nbsp; '+
        'Fan: <strong>'+(fanRelayMins/60).toFixed(1)+'h</strong> '+
        '— avg <strong>'+avgDailyMins+' min/day</strong> HVAC active.'
    );

    lines.push(
        'Estimated cost: <strong>$'+totalCost.toFixed(2)+'</strong> this week '+
        '(heater $'+costHeat.toFixed(2)+', AC $'+costCool.toFixed(2)+', fan $'+costFan.toFixed(2)+').'
    );

    lines.push(
        'Running costs: heater <strong>'+rateHeat+'¢/hr</strong>, AC <strong>'+rateCool+'¢/hr</strong>, fan <strong>'+rateFan+'¢/hr</strong>.'
    );

    var potentialSave=acMins>0?((acMins/60)*((wCool-wFan)/1000)*cPk).toFixed(2):null;
    lines.push(
        'Ventilation efficiency: <strong>'+efficiency+'%</strong> fan-only cycles ('+effLabel+').'+
        (efficiency<40&&potentialSave&&parseFloat(potentialSave)>0.01
            ? ' Replacing AC cycles with fan when outdoor is cooler could save up to <strong>$'+potentialSave+'/wk</strong>.'
            : efficiency>=70?' Outdoor ventilation is well utilised — appliances activate only when necessary.':'')
    );

    if (shortCycles>=3)
        lines.push('<strong>'+shortCycles+' short cycles</strong> (<5 min) out of '+events.length+
            ' events — consider widening the idle band to prevent rapid cycling and reduce equipment wear.');

    var worstDay=null, worstMins=0;
    Object.keys(dailyMins).forEach(function(d){ if(dailyMins[d]>worstMins){worstMins=dailyMins[d];worstDay=d;} });
    if (worstDay&&worstMins>180)
        lines.push('Peak day: <strong>'+worstDay+'</strong> — '+Math.round(worstMins)+' min HVAC runtime.'+
            (worstMins>360?' High demand; check insulation or widen the idle band.':''));

    if (acMins>0&&fanOnlyMins>0) {
        var acFrac=Math.round(acMins/(acMins+fanOnlyMins)*100);
        if (acFrac>60)
            lines.push('Cooling split: <strong>'+acFrac+'%</strong> AC, <strong>'+(100-acFrac)+'%</strong> fan. '+
                'Fan is '+(Math.round((wCool-wFan)/Math.max(1,wFan)))+'× cheaper than AC — prioritise it when outdoor temp allows.');
    } else if (acMins>0&&fanOnlyMins===0) {
        lines.push('All cooling via AC this week — no fan-only cycles recorded. If outdoor temp dips below indoor, inlet fan alone can save the AC cost entirely.');
    }

    el.innerHTML=lines.join('<br>'); el.className='rec-box rec-idle';
}

// ── Init ──────────────────────────────────────────────────────────
loadSettings();
fetchWeather();
setInterval(fetchWeather, 300000);
