// ── Global state ─────────────────────────────────────────────────
var isAutomatic  = true;        // true = auto mode, false = manual
var hvacState    = 'idle';      // 'idle' | 'heating' | 'cooling'
var targetTemp   = 22.0;        // desired indoor temp (always stored in °C)
var idleBand     = 1.0;         // ±°C dead-band before HVAC activates
var SHUTOFF_BUFFER      = 0.3;   // °C before target to cut devices (simple mode)
var USE_DYNAMIC_SHUTOFF = false; // when true: use COAST_FACTOR/THERMAL_COEFF/COAST_ASYMMETRY instead
var COAST_FACTOR        = 0.15;  // scales thermal momentum contribution to shutoff offset
var THERMAL_COEFF       = 0.035; // scales outdoor/indoor temp gap contribution to shutoff offset
var COAST_ASYMMETRY     = 0.0;   // -1 = warm bias, 0 = neutral, +1 = cool bias
var outdoorTemp  = null;        // from OpenWeatherMap (°C)
var outdoorFeels = null;
var outdoorHum   = null;
var outdoorDesc  = '--';
var currentCity  = 'Sydney';
var tempHistory  = [];          // ring buffer: { ts, temp, target }
var isCelsius    = true;
var MAX_HISTORY  = 60;          // 60 × 2 s = 2 min of live history

var WEATHER_KEY = (typeof WEATHER_API_KEY !== 'undefined') ? WEATHER_API_KEY : '5732f6a4fa41c14b18de41eb88a325be';
const FAN_MIN_RUN_MINS    = 10; // minimum fan run before appliance is added (fixed)

// ── API base URL ──────────────────────────────────────────────────
// Browser: uses the same origin as the page (works on localhost dev + production).
// Linx runtime: localStorage throws, so falls back to the production URL.
const PB = (function(){
    try {
        var u = localStorage.getItem('hvac_pb_url');
        if (u && u.trim()) return u.trim();
        return location.origin;
    } catch(e) {
        return 'https://thisphnmm.com'; // Linx runtime — post to production
    }
})();
var settingsId    = null;
var openEventId   = null;
var prevHvacState    = 'idle';
var fanStartTime     = null;
var outdoorWarmPolls = 0;
var outdoorCoolPolls = 0;
var currentRange  = '1h';
var analysisCache = [];
var manualDevice  = 'idle';
var lastKnownTemp = null;
var _histMeta     = null;
var _dbTick       = 0;        // counts loop cycles; DB write happens every 15th (≈30 s)
var _showDotLabels = true;    // show/hide temperature labels on event dots in history chart
var STATE_COLORS  = {
    heating:      '#f04040',
    'fan+heater': '#f87060',
    'fan-heat':   '#e09030',
    cooling:      '#40a8f8',
    'fan+ac':     '#2bc4d8',
    fan:          '#24d09a',
    idle:         '#4e6580'
};

var modalTargetTemp = 22.0;
var modalIsCelsius  = true;

// ── Helpers ───────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function dispTemp(c)  { return (isCelsius ? c : c*9/5+32).toFixed(1); }
function dispDelta(d) { return (isCelsius ? d : d*9/5).toFixed(1); }
function dispUnit()   { return isCelsius ? '°C' : '°F'; }
function dispBand()   { return '±' + dispDelta(idleBand) + dispUnit(); }
// Convenience: temperature value + unit in one string (e.g. "22.0°C")
function tempStr(c)   { return dispTemp(c) + dispUnit(); }

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
    if (isCelsius === celsius) {
        // Clicking the already-active unit button toggles dot labels on the history chart
        _showDotLabels = !_showDotLabels;
        if ($('view-history').style.display !== 'none') loadHistory(currentRange);
        return;
    }
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
        if (prevHvacState !== 'idle') closeHvacEvent(lastKnownTemp);
        isAutomatic = false;
        hvacState = 'idle';
        manualDevice = 'idle';
        prevHvacState = 'idle';
        setBadge('manual', 'Manual');
        $('mode-display').innerText = 'Manual';
        updateRec('Manual mode — device control active. AI monitoring continues.', '');
    } else {
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

// ── Target, band & shutoff buffer ─────────────────────────────────
function adjustTarget(delta) {
    targetTemp = Math.max(10, Math.min(35, Math.round((targetTemp+delta)*2)/2));
    $('target-temp').innerText = dispTemp(targetTemp) + dispUnit();
    patchSettings();
}

function adjustIdleBand(delta) {
    idleBand = Math.max(0.5, Math.min(3.0, Math.round((idleBand+delta)*2)/2));
    SHUTOFF_BUFFER = parseFloat(Math.min(SHUTOFF_BUFFER, Math.max(-2, idleBand - 0.2)).toFixed(1));
    $('idle-band').innerText = dispBand();
    var el2=$('idle-band-2');  if (el2) el2.innerText=dispBand();
    var el2b=$('idle-band-2b'); if (el2b) el2b.innerText=dispBand();
    var sbEl=$('shutoff-buffer-val'); if (sbEl) sbEl.innerText=dispDelta(SHUTOFF_BUFFER)+dispUnit();
    patchSettings();
}

function adjustShutoffBuffer(delta) {
    // Clamp -2.0–(idleBand - 0.2). Negative values let the system overshoot the target before cutting out.
    SHUTOFF_BUFFER = parseFloat(Math.max(-2, Math.min(idleBand - 0.2, Math.round((SHUTOFF_BUFFER + delta) * 10) / 10)).toFixed(1));
    var el=$('shutoff-buffer-val'); if (el) el.innerText=dispDelta(SHUTOFF_BUFFER)+dispUnit();
    patchSettings();
}

// ── Dynamic shutoff toggle ────────────────────────────────────────
function _syncDynamicUI() {
    var on = USE_DYNAMIC_SHUTOFF;
    var btn = $('btn-dynamic-toggle');
    if (btn) { btn.innerText = on ? 'Dynamic On' : 'Simple'; btn.className = 'btn-mode' + (on ? ' active' : ''); }
    var dynPanel = $('dynamic-controls'), simPanel = $('simple-controls');
    if (dynPanel) dynPanel.style.display = on ? '' : 'none';
    if (simPanel) simPanel.style.display = on ? 'none' : '';
}

function toggleDynamicShutoff() {
    USE_DYNAMIC_SHUTOFF = !USE_DYNAMIC_SHUTOFF;
    _syncDynamicUI();
    if (USE_DYNAMIC_SHUTOFF && outdoorTemp !== null) updateCoeffsFromWeather();
    patchSettings();
}

function coastAsymmetryLabel() {
    if (Math.abs(COAST_ASYMMETRY) < 0.05) return 'Neutral';
    var pct = Math.abs(Math.round(COAST_ASYMMETRY * 100));
    return COAST_ASYMMETRY > 0 ? 'Cool +' + pct + '%' : 'Warm +' + pct + '%';
}

function adjustCoastAsymmetry(delta) {
    COAST_ASYMMETRY = Math.max(-1.0, Math.min(1.0, Math.round((COAST_ASYMMETRY + delta) * 10) / 10));
    var el = $('coast-asymmetry-val'); if (el) el.innerText = coastAsymmetryLabel();
    patchSettings();
}

function updateCoeff() {
    var cf = parseFloat(($('coast-factor')  || {}).value);
    var tc = parseFloat(($('thermal-coeff') || {}).value);
    if (!isNaN(cf) && cf > 0) COAST_FACTOR  = parseFloat(cf.toFixed(3));
    if (!isNaN(tc) && tc > 0) THERMAL_COEFF = parseFloat(tc.toFixed(3));
    patchSettings();
}

function updateCoeffsFromWeather() {
    if (!USE_DYNAMIC_SHUTOFF) return;
    var indoorRef = lastKnownTemp !== null ? lastKnownTemp : targetTemp;
    var diff = Math.abs(outdoorTemp - indoorRef);
    COAST_FACTOR  = parseFloat(Math.max(0.050, Math.min(0.300, 0.050 + diff * 0.010)).toFixed(3));
    THERMAL_COEFF = parseFloat(Math.max(0.010, Math.min(0.060, 0.010 + (outdoorHum || 50) / 100 * 0.050)).toFixed(3));
    var cfEl = $('coast-factor');  if (cfEl) cfEl.value = COAST_FACTOR.toFixed(3);
    var tcEl = $('thermal-coeff'); if (tcEl) tcEl.value = THERMAL_COEFF.toFixed(3);
    patchSettings();
}

// ── Manual control ────────────────────────────────────────────────
// allOff guards against browser environments where Linx GPIO is unavailable
function allOff() {
    if (typeof turnOff !== 'undefined')
        [RedLed, GreenLed, InletFan].forEach(turnOff);
}

function manualControl(cmd) {
    if (isAutomatic) { alert('Switch to Manual mode first.'); return; }
    if (manualDevice !== 'idle') closeHvacEvent(lastKnownTemp);
    allOff();
    ['heater','cooler','fan'].forEach(function(d) { setDevice(d, false, ''); });
    if (cmd === 'heater') {
        if (typeof turnOn !== 'undefined') turnOn(RedLed);
        setDevice('heater', true, 'heat');
        manualDevice = 'heating';
        setBadge('heating', 'Heating');
        updateRec('Manual: Heater on.', 'heat');
    } else if (cmd === 'cooler') {
        if (typeof turnOn !== 'undefined') turnOn(GreenLed);
        setDevice('cooler', true, 'cool');
        manualDevice = 'cooling';
        setBadge('cooling', 'Cooling');
        updateRec('Manual: Cooler / AC on.', 'cool');
    } else if (cmd === 'fan') {
        if (typeof turnOn !== 'undefined') turnOn(InletFan);
        setDevice('fan', true, 'cool');
        manualDevice = 'fan';
        setBadge('cooling', 'Cooling');
        updateRec('Manual: Inlet fan on.', 'cool');
    } else {
        manualDevice = 'idle';
        setBadge('manual', 'Manual');
        updateRec('Manual mode — all devices off.', '');
    }
    prevHvacState = manualDevice;
    if (manualDevice !== 'idle') openHvacEvent(manualDevice, lastKnownTemp);
}

// ── DOM helpers ───────────────────────────────────────────────────
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
    if (tempHistory.length > MAX_HISTORY) tempHistory.shift();
    renderChart();
}

function renderChart() {
    if (tempHistory.length < 2) return;
    var cv = initCanvas('temp-chart'); if (!cv) return;
    var ctx=cv.ctx, W=cv.W, H=cv.H;
    var pad={top:16,right:16,bottom:28,left:46};
    var cW=W-pad.left-pad.right, cH=H-pad.top-pad.bottom, n=tempHistory.length;

    var vals = tempHistory.map(function(h) {
        return {temp:isCelsius?h.temp:h.temp*9/5+32, target:isCelsius?h.target:h.target*9/5+32};
    });

    var allV = vals.map(function(v){return v.temp;}).concat(vals.map(function(v){return v.target;}));
    var minV=Math.min.apply(null,allV)-0.5, maxV=Math.max.apply(null,allV)+0.5, range=(maxV-minV)||1;

    function xOf(i) { return pad.left + (i/(n-1))*cW; }
    function yOf(v) { return pad.top  + cH - ((v-minV)/range)*cH; }

    ctx.strokeStyle='#1c2840'; ctx.lineWidth=1;
    ctx.fillStyle='#4e6580'; ctx.font='10px system-ui'; ctx.textAlign='right';
    for (var i=0; i<=4; i++) {
        var gv=minV+(range/4)*i, gy=yOf(gv);
        ctx.beginPath(); ctx.moveTo(pad.left,gy); ctx.lineTo(pad.left+cW,gy); ctx.stroke();
        ctx.fillText(gv.toFixed(1)+'°', pad.left-4, gy+4);
    }

    function drawLine(color, lw, dash, getter) {
        ctx.strokeStyle=color; ctx.lineWidth=lw; ctx.setLineDash(dash||[]);
        ctx.beginPath();
        vals.forEach(function(v,i){i===0?ctx.moveTo(xOf(i),yOf(getter(v))):ctx.lineTo(xOf(i),yOf(getter(v)));});
        ctx.stroke(); ctx.setLineDash([]);
    }
    drawLine('#11c8b5', 1.5, [5,4], function(v){return v.target;});
    drawLine('#ccd6e8', 2,   [],    function(v){return v.temp;});

    var now=Date.now();
    ctx.fillStyle='#4e6580'; ctx.font='9px system-ui'; ctx.textAlign='center';
    [0,0.25,0.5,0.75,1].forEach(function(f){
        var idx=Math.round(f*(n-1)), ago=Math.round((now-tempHistory[idx].ts)/1000);
        ctx.fillText(ago<3?'now':'-'+ago+'s', xOf(idx), H-6);
    });

    ctx.textAlign='left'; ctx.font='10px system-ui';
    [['#ccd6e8','Indoor',4],['#11c8b5','Target',80]].forEach(function(l){
        ctx.fillStyle=l[0]; ctx.fillRect(pad.left+l[2], pad.top+4, 12,3);
        ctx.fillText(l[1], pad.left+l[2]+16, pad.top+11);
    });
}

// ── Weather ───────────────────────────────────────────────────────
async function fetchWeather() {
    try {
        var city = ($('city-in').value.trim() || currentCity).replace(/\s*,\s*/g,',');
        var r = await fetch('https://api.openweathermap.org/data/2.5/weather?q='+encodeURIComponent(city)+'&appid='+WEATHER_KEY+'&units=metric');
        if (!r.ok) return;
        var d = await r.json();
        currentCity=city; outdoorTemp=d.main.temp; outdoorFeels=d.main.feels_like;
        outdoorHum=d.main.humidity; outdoorDesc=d.weather[0].description;
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
        updateCoeffsFromWeather();
    } catch(e) {}
}

function updateCity() { fetchWeather(); }

// ── PocketBase: settings ──────────────────────────────────────────
async function loadSettings() {
    // Pre-fill the PB URL field in the setup modal with whatever is currently saved
    var pbField = $('modal-pb-url');
    if (pbField) {
        var saved = localStorage.getItem('hvac_pb_url');
        if (saved) pbField.value = saved;
    }
    try {
        var r = await fetch(PB+'/api/collections/settings/records?perPage=1');
        if (!r.ok) { $('setup-modal').style.display = 'flex'; return; }
        var d = await r.json();
        if (d.totalItems === 0) {
            $('setup-modal').style.display = 'flex';
        } else {
            var s=d.items[0];
            settingsId=s.id; targetTemp=s.target_temp||targetTemp; idleBand=s.idle_band||idleBand;
            isCelsius = s.is_celsius !== undefined ? s.is_celsius : isCelsius;
            if (s.shutoff_buffer      != null) SHUTOFF_BUFFER      = s.shutoff_buffer;
            if (s.use_dynamic_shutoff != null) USE_DYNAMIC_SHUTOFF = s.use_dynamic_shutoff;
            if (s.coast_factor        != null) COAST_FACTOR        = s.coast_factor;
            if (s.thermal_coeff       != null) THERMAL_COEFF       = s.thermal_coeff;
            if (s.coast_asymmetry     != null) COAST_ASYMMETRY     = s.coast_asymmetry;
            if (s.cost_kwh    != null) { var el=$('cost-kwh');    if (el) el.value=s.cost_kwh;    }
            if (s.watt_heater != null) { var el=$('watt-heater'); if (el) el.value=s.watt_heater; }
            if (s.watt_cooler != null) { var el=$('watt-cooler'); if (el) el.value=s.watt_cooler; }
            if (s.watt_fan    != null) { var el=$('watt-fan');    if (el) el.value=s.watt_fan;    }
            if (s.city) { currentCity=s.city; $('city-in').value=s.city; }
            setUnit(isCelsius);
            $('target-temp').innerText = dispTemp(targetTemp)+dispUnit();
            $('idle-band').innerText   = dispBand();
            var ib2=$('idle-band-2');   if (ib2) ib2.innerText=dispBand();
            var sbEl=$('shutoff-buffer-val'); if (sbEl) sbEl.innerText=dispDelta(SHUTOFF_BUFFER)+dispUnit();
            var cfEl=$('coast-factor');        if (cfEl) cfEl.value=COAST_FACTOR.toFixed(3);
            var tcEl=$('thermal-coeff');       if (tcEl) tcEl.value=THERMAL_COEFF.toFixed(3);
            var caEl=$('coast-asymmetry-val'); if (caEl) caEl.innerText=coastAsymmetryLabel();
            _syncDynamicUI();
            $('setup-modal').style.display = 'none'; // settings exist — skip setup
            fetchWeather(); // re-fetch now that stored city is set
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
        shutoff_buffer:SHUTOFF_BUFFER,
        use_dynamic_shutoff:USE_DYNAMIC_SHUTOFF,
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
    // Save PocketBase URL to localStorage so it persists across page loads
    var pbInput = $('modal-pb-url');
    if (pbInput) {
        var pbVal = pbInput.value.trim().replace(/\/$/, ''); // strip trailing slash
        if (pbVal) localStorage.setItem('hvac_pb_url', pbVal);
        else localStorage.removeItem('hvac_pb_url');
        // Reload page so the new PB constant takes effect (it's evaluated at startup)
        if (pbVal && pbVal !== PB) { localStorage.setItem('hvac_pb_url', pbVal); location.reload(); return; }
    }
    var setupBody = {
        target_temp:modalTargetTemp, idle_band:idleBand, city:city, is_celsius:modalIsCelsius,
        shutoff_buffer:SHUTOFF_BUFFER,
        cost_kwh:25, watt_heater:1000, watt_cooler:1500, watt_fan:50
    };
    try {
        if (settingsId) {
            // Record already loaded — patch it instead of creating a duplicate
            await pbPatch('/api/collections/settings/records/'+settingsId, setupBody);
        } else {
            var r = await pbPost('/api/collections/settings/records', setupBody);
            if (r) settingsId = (await r.json()).id;
        }
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
    var id=openEventId; openEventId=null;
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

    var fStr=from.toISOString().replace('T',' ').slice(0,19);
    var readFilter = encodeURIComponent('ts>="'+fStr+'"');
    var evFilter   = encodeURIComponent('ts_start>="'+fStr+'"');
    try {
        var readItems, evItems;
        // Readings are written every ~30 s: 1h≈120, 6h≈720, 24h≈2880, 7d≈20160 records.
        // Fetch enough pages (sort=-ts, oldest→newest after combine) to cover each window.
        // 7d uses 10 pages (5000 records ≈ 42 h dense coverage; sparse older data still renders).
        var pageCount = range==='1h' ? 1 : range==='6h' ? 2 : range==='24h' ? 6 : 10;
        var pageNums = []; for (var _p=1; _p<=pageCount; _p++) pageNums.push(_p);
        var pages = await Promise.all(pageNums.map(function(pg) {
            return fetch(PB+'/api/collections/readings/records?sort=-ts&page='+pg+'&perPage=500&filter='+readFilter)
                .then(function(r){return r.json();});
        }));
        // Combine all pages then sort ascending by ts.
        // (sort=-ts means each page's items are newest→oldest internally; sorting after combine is simpler and correct.)
        readItems = [];
        for (var _i=0; _i<pages.length; _i++) readItems = readItems.concat(pages[_i].items||[]);
        readItems.sort(function(a,b){ return new Date(a.ts).getTime()-new Date(b.ts).getTime(); });
        var evRes = await fetch(PB+'/api/collections/hvac_events/records?sort=ts_start&perPage=500&filter='+evFilter).then(function(r){return r.json();});
        evItems = evRes.items||[];
        renderHistoryChart(readItems, evItems);
        renderHistorySummary(readItems, evItems);
        attachHistoryTooltip();
        renderEventLog(evItems.slice().reverse());
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

    var vals=readings.map(function(r){
        var tgt = r.target_temp != null ? r.target_temp : targetTemp;
        return {
            ts:     new Date(r.ts).getTime(),
            temp:   isCelsius ? r.indoor_temp : r.indoor_temp*9/5+32,
            target: isCelsius ? tgt : tgt*9/5+32
        };
    });

    // Thin to at most one point per 2px — prevents clustering on dense historical data
    var maxPts = Math.max(80, Math.floor(cW / 2));
    if (vals.length > maxPts) {
        var _step = vals.length / maxPts, _thinned = [];
        for (var _ti=0; _ti<maxPts; _ti++) _thinned.push(vals[Math.min(vals.length-1, Math.round(_ti*_step))]);
        vals = _thinned;
    }

    var minTs=vals[0].ts, maxTs=vals[vals.length-1].ts, tsRange=maxTs-minTs||1;
    var allV=vals.map(function(v){return v.temp;}).concat(vals.map(function(v){return v.target;}));
    var minV=Math.min.apply(null,allV)-0.5, vRange=(Math.max.apply(null,allV)+0.5-minV)||1;

    function xOf(ts){ return pad.left+((ts-minTs)/tsRange)*cW; }
    function yOf(v) { return pad.top+cH-((v-minV)/vRange)*cH; }

    var SC = STATE_COLORS;
    function scAlpha(hex) {
        var r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
        return 'rgba('+r+','+g+','+b+',0.13)';
    }

    var evParsed=events.map(function(ev){
        return {type:ev.type, s:new Date(ev.ts_start).getTime(), e:ev.ts_end?new Date(ev.ts_end).getTime():maxTs, start_temp:ev.start_temp, end_temp:ev.end_temp};
    });

    evParsed.forEach(function(ev){
        var x0=xOf(Math.max(minTs,ev.s)), x1=xOf(Math.min(maxTs,ev.e));
        ctx.fillStyle=scAlpha(SC[ev.type]||SC.cooling);
        ctx.fillRect(x0, pad.top, Math.max(1,x1-x0), cH);
    });

    ctx.strokeStyle='#1c2840'; ctx.lineWidth=1;
    ctx.fillStyle='#4e6580'; ctx.font='10px system-ui'; ctx.textAlign='right';
    for (var gi=0; gi<=4; gi++) {
        var gv=minV+(vRange/4)*gi, gy=yOf(gv);
        ctx.beginPath(); ctx.moveTo(pad.left,gy); ctx.lineTo(pad.left+cW,gy); ctx.stroke();
        ctx.fillText(gv.toFixed(1)+'°', pad.left-4, gy+4);
    }

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

    var prevTgt=null;
    ctx.strokeStyle='#f59e0b'; ctx.lineWidth=1.5; ctx.setLineDash([5,4]);
    ctx.beginPath();
    vals.forEach(function(v,i){
        if (i===0) { ctx.moveTo(xOf(v.ts),yOf(v.target)); }
        else if (v.target !== prevTgt) {
            ctx.lineTo(xOf(v.ts),yOf(prevTgt));
            ctx.lineTo(xOf(v.ts),yOf(v.target));
        } else {
            ctx.lineTo(xOf(v.ts),yOf(v.target));
        }
        prevTgt=v.target;
    });
    ctx.stroke(); ctx.setLineDash([]);

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

    var legendItems=[
        {c:'#f59e0b',dash:true,l:'Target'},
        {c:SC.heating,l:'Heating'},
        {c:SC['fan-heat'],l:'Fan(heat)'},
        {c:SC.cooling,l:'AC'},
        {c:SC.fan,l:'Fan(cool)'},
        {c:SC.idle,l:'Idle'}
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
    // Dot-label hint — right-aligned in the legend row
    var hintTxt = _showDotLabels ? '● labels on' : '○ labels off';
    ctx.font='8px system-ui'; ctx.fillStyle='#4e6580'; ctx.textAlign='right';
    ctx.fillText('click °C/°F to toggle  ' + hintTxt, pad.left+cW, ly+3);

    evParsed.forEach(function(ev){
        var color=SC[ev.type]||SC.idle;
        function mark(ts, temp, above) {
            if (temp==null) return;
            var mx=xOf(ts), my=yOf(isCelsius?temp:temp*9/5+32);
            if (mx<pad.left||mx>pad.left+cW) return;
            ctx.beginPath(); ctx.arc(mx,my,4,0,Math.PI*2);
            ctx.fillStyle=color; ctx.fill();
            ctx.strokeStyle='#0c1220'; ctx.lineWidth=1.5; ctx.stroke();
            if (_showDotLabels) {
                ctx.fillStyle=color; ctx.font='bold 9px system-ui'; ctx.textAlign='center';
                ctx.fillText((isCelsius?temp:temp*9/5+32).toFixed(1)+'°', mx, Math.max(pad.top+10,Math.min(H-pad.bottom-4,my+(above?-8:14))));
            }
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
    var ib2=$('idle-band-2');          if (ib2) ib2.innerText=dispBand();
    var sbEl=$('shutoff-buffer-val');  if (sbEl) sbEl.innerText=dispDelta(SHUTOFF_BUFFER)+dispUnit();
    var cfEl=$('coast-factor');        if (cfEl) cfEl.value=COAST_FACTOR.toFixed(3);
    var tcEl=$('thermal-coeff');       if (tcEl) tcEl.value=THERMAL_COEFF.toFixed(3);
    var caEl=$('coast-asymmetry-val'); if (caEl) caEl.innerText=coastAsymmetryLabel();
    _syncDynamicUI();

    var from=new Date(); from.setDate(from.getDate()-7);
    var fStr=from.toISOString().replace('T',' ').slice(0,19);
    try {
        var r=await fetch(PB+'/api/collections/hvac_events/records?sort=ts_start&perPage=500&filter='+encodeURIComponent('ts_start>="'+fStr+'"'));
        analysisCache=(await r.json()).items||[];
    } catch(e) { analysisCache=[]; }
    renderRuntimeChart(analysisCache);
    buildInsights(analysisCache);
}

function renderRuntimeChart(events) {
    var cv=initCanvas('runtime-chart',220); if (!cv) return;
    var ctx=cv.ctx, W=cv.W, H=cv.H;

    var days=[];
    for (var i=6; i>=0; i--) { var d=new Date(); d.setDate(d.getDate()-i); days.push(d.toISOString().slice(0,10)); }

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

    ctx.textAlign='left'; ctx.font='9px system-ui'; var lx=pad.left;
    [['Heater','#f04040'],['AC (costly)','#40a8f8'],['Inlet Fan','#24d09a']].forEach(function(l){
        ctx.fillStyle=l[1]; ctx.fillRect(lx,pad.top+2,10,3);
        ctx.fillStyle='#4e6580'; ctx.fillText(l[0],lx+14,pad.top+11); lx+=72;
    });
}

function refreshInsights() { buildInsights(analysisCache); patchSettings(); }

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
    var cPk=kwh/100;

    var heaterMins=0, acMins=0, fanRelayMins=0, fanOnlyMins=0;
    var shortCycles=0, dailyMins={};
    // Escalation counts: fan→AC and fan-heat→heater transitions
    var fanCoolTotal=0, fanCoolEscalated=0, fanHeatTotal=0, fanHeatEscalated=0;

    events.forEach(function(ev, i){
        var mins=ev.duration_mins||0, day=ev.ts_start.slice(0,10);
        if (mins>0&&mins<5) shortCycles++;
        dailyMins[day]=(dailyMins[day]||0)+mins;
        switch(ev.type){
            case 'heating':    heaterMins+=mins; break;
            case 'cooling':    acMins+=mins; break;
            case 'fan':        fanOnlyMins+=mins; fanRelayMins+=mins; fanCoolTotal++; break;
            case 'fan-heat':   fanOnlyMins+=mins; fanRelayMins+=mins; fanHeatTotal++; break;
            case 'fan+ac':     acMins+=mins; fanRelayMins+=mins; break;
            case 'fan+heater': heaterMins+=mins; fanRelayMins+=mins; break;
        }
        // Check if this fan event was immediately followed by an appliance escalation
        var next = events[i+1];
        if (next && ev.type === 'fan'      && next.type === 'cooling')  fanCoolEscalated++;
        if (next && ev.type === 'fan-heat' && next.type === 'heating')  fanHeatEscalated++;
    });

    var costHeat=(heaterMins/60)*(wHeat/1000)*cPk;
    var costCool=(acMins/60)*(wCool/1000)*cPk;
    var costFan=(fanRelayMins/60)*(wFan/1000)*cPk;
    var totalCost=costHeat+costCool+costFan;

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
        'Estimated cost: <strong>A$'+totalCost.toFixed(2)+'</strong> this week '+
        '(heater A$'+costHeat.toFixed(2)+', AC A$'+costCool.toFixed(2)+', fan A$'+costFan.toFixed(2)+').'
    );

    lines.push(
        'Running costs: heater <strong>'+rateHeat+'¢/hr</strong>, AC <strong>'+rateCool+'¢/hr</strong>, fan <strong>'+rateFan+'¢/hr</strong>.'
    );

    var potentialSave=acMins>0?((acMins/60)*((wCool-wFan)/1000)*cPk).toFixed(2):null;
    lines.push(
        'Ventilation efficiency: <strong>'+efficiency+'%</strong> fan-only cycles ('+effLabel+').'+
        (efficiency<40&&potentialSave&&parseFloat(potentialSave)>0.01
            ? ' Replacing AC cycles with fan when outdoor is cooler could save up to <strong>A$'+potentialSave+'/wk</strong>.'
            : efficiency>=70?' Outdoor ventilation is well utilised — appliances activate only when necessary.':'')
    );

    // Escalation stats (fan-first strategy effectiveness)
    var escalParts = [];
    if (fanCoolTotal > 0) {
        var fanCoolResolved = fanCoolTotal - fanCoolEscalated;
        var fanCoolPct = Math.round(fanCoolResolved / fanCoolTotal * 100);
        escalParts.push('cooling: fan resolved <strong>'+fanCoolPct+'%</strong> unaided'+
            (fanCoolEscalated > 0 ? ', escalated to AC <strong>'+fanCoolEscalated+'×</strong>' : ''));
    }
    if (fanHeatTotal > 0) {
        var fanHeatResolved = fanHeatTotal - fanHeatEscalated;
        var fanHeatPct = Math.round(fanHeatResolved / fanHeatTotal * 100);
        escalParts.push('heating: fan resolved <strong>'+fanHeatPct+'%</strong> unaided'+
            (fanHeatEscalated > 0 ? ', escalated to heater <strong>'+fanHeatEscalated+'×</strong>' : ''));
    }
    if (escalParts.length > 0)
        lines.push('Fan-first strategy — ' + escalParts.join('; ') + '.');

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

// ── Live data polling (browser / Netlify remote view) ─────────────
// In Linx, hvac_jsloop.js drives the DOM directly every 2 s.
// In a regular browser (Netlify), poll PocketBase for the latest reading
// so the Control view shows real sensor data without the hardware loop.
(function startLivePolling() {
    if (typeof turnOn !== 'undefined') return; // Linx runtime — skip

    var lastReadingTs = null;
    var pollCount = 0;

    // Full recommendation builder — mirrors hvac_jsloop.js buildRec()
    function buildRec(temp, diff, state) {
        var trendRate = null;
        if (tempHistory.length >= 3) {
            var sl = tempHistory.slice(-Math.min(tempHistory.length, 10));
            var dtHrs = (sl[sl.length - 1].ts - sl[0].ts) / 3600000;
            if (dtHrs > 0.0001)
                trendRate = (sl[sl.length - 1].temp - sl[0].temp) / dtHrs;
        }

        var shutoffBuf = SHUTOFF_BUFFER || 0;
        var arrow = trendRate === null || Math.abs(trendRate) < 0.2 ? '→'
                  : trendRate > 0 ? '↑' : '↓';
        var shutoffCool = tempStr(targetTemp + shutoffBuf);
        var shutoffHeat = tempStr(targetTemp - shutoffBuf);
        var absDiff     = dispDelta(Math.abs(diff)) + dispUnit();

        // Status line
        var statusLine;
        if (state === 'idle') {
            statusLine = arrow + ' Indoor <strong>' + tempStr(temp) + '</strong> — within ' +
                dispBand() + ' of target (' + tempStr(targetTemp) + '). No action required.';
        } else if (state === 'cooling') {
            var outNote = outdoorTemp !== null
                ? 'Outdoor (' + tempStr(outdoorTemp) + ') not cooler than indoor — AC active.'
                : 'No outdoor data — AC active.';
            statusLine = arrow + ' Indoor <strong>' + tempStr(temp) + '</strong> — ' +
                dispDelta(diff) + dispUnit() + ' above target. ' + outNote +
                ' Shutoff at <strong>' + shutoffCool + '</strong>.';
        } else if (state === 'fan') {
            statusLine = arrow + ' Indoor <strong>' + tempStr(temp) + '</strong> — ' +
                dispDelta(diff) + dispUnit() + ' above target. Outdoor (' +
                (outdoorTemp !== null ? tempStr(outdoorTemp) : '--') +
                ') is cooler — inlet fan ventilating (no AC cost). Shutoff at <strong>' + shutoffCool + '</strong>.';
        } else if (state === 'heating') {
            statusLine = arrow + ' Indoor <strong>' + tempStr(temp) + '</strong> — ' +
                absDiff + ' below target. Heater active. Shutoff at <strong>' + shutoffHeat + '</strong>.';
        } else if (state === 'fan-heat') {
            statusLine = arrow + ' Indoor <strong>' + tempStr(temp) + '</strong> — ' +
                absDiff + ' below target. Outdoor (' +
                (outdoorTemp !== null ? tempStr(outdoorTemp) : '--') +
                ') is warmer — inlet fan drawing warm air in (no heater cost). Shutoff at <strong>' + shutoffHeat + '</strong>.';
        } else {
            statusLine = arrow + ' Indoor <strong>' + tempStr(temp) + '</strong>.';
        }

        var lines = [statusLine];

        // Trend line
        if (trendRate !== null) {
            var absRate = (Math.abs(trendRate) * (isCelsius ? 1 : 9 / 5)).toFixed(1);
            var dir = trendRate > 0 ? 'rising' : 'falling';
            if (Math.abs(trendRate) < 0.2) {
                lines.push('Temperature is <strong>stable</strong>.');
            } else {
                var note, etaLine = null;
                if (state === 'idle') {
                    var edge = trendRate > 0 ? idleBand - diff : -idleBand - diff;
                    var mins = Math.round(Math.abs(edge / trendRate) * 60);
                    note = trendRate > 0
                        ? 'Drifting toward upper threshold'
                        : 'Drifting toward lower threshold';
                    if (mins > 0 && mins < 120) note += ' — HVAC may activate in ~<strong>' + mins + ' min</strong>.';
                    else note += '.';
                } else if (state === 'cooling' || state === 'fan') {
                    if (trendRate > 0) {
                        note = '⚠ Still climbing — cooling urgently needed.';
                    } else {
                        note = 'Cooling is working — temperature dropping.';
                        var dist = diff - shutoffBuf;
                        if (dist > 0 && Math.abs(trendRate) > 0.05) {
                            var eta = Math.round((dist / Math.abs(trendRate)) * 60);
                            if (eta > 0 && eta < 240) etaLine = 'ETA to target: ~<strong>' + eta + ' min</strong>.';
                        }
                    }
                } else {
                    if (trendRate < 0) {
                        note = '⚠ Still falling — heating urgently needed.';
                    } else {
                        note = 'Heating is working — temperature rising.';
                        var distH = -diff - shutoffBuf;
                        if (distH > 0 && Math.abs(trendRate) > 0.05) {
                            var etaH = Math.round((distH / Math.abs(trendRate)) * 60);
                            if (etaH > 0 && etaH < 240) etaLine = 'ETA to target: ~<strong>' + etaH + ' min</strong>.';
                        }
                    }
                }
                lines.push('Trend: <strong>' + dir + '</strong> at ' + absRate + dispUnit() + '/hr — ' + note);
                if (etaLine) lines.push(etaLine);
            }
        }

        if (outdoorHum !== null)
            lines.push('Outdoor humidity: <strong>' + outdoorHum + '%</strong> — ' + humLabel(outdoorHum) + '.');
        if (outdoorTemp !== null) {
            var capStr = (outdoorDesc && outdoorDesc !== '--')
                ? ' (' + outdoorDesc.replace(/\b\w/g, function(c) { return c.toUpperCase(); }) + ')'
                : '';
            lines.push('Outdoor: <strong>' + tempStr(outdoorTemp) + '</strong>' + capStr + '.');
        }

        return lines.join('<br>');
    }

    function pollLiveData() {
        pollCount++;

        // Auto-refresh history view when it's open (every 6 polls = 30 s)
        if (pollCount % 6 === 0) {
            var histView = $('view-history');
            if (histView && histView.style.display !== 'none') loadHistory(currentRange);
        }

        // Re-sync settings every 30 polls (~150 s)
        if (pollCount % 30 === 1) {
            fetch(PB + '/api/collections/settings/records?perPage=1')
                .then(function(r) { return r.json(); })
                .then(function(d) {
                    if (!d.items || !d.items.length) return;
                    var s = d.items[0];
                    if (s.target_temp != null) { targetTemp = s.target_temp; $('target-temp').innerText = dispTemp(targetTemp)+dispUnit(); }
                    if (s.idle_band != null) { idleBand = s.idle_band; $('idle-band').innerText = dispBand(); var ib2=$('idle-band-2'); if(ib2) ib2.innerText=dispBand(); }
                    if (s.shutoff_buffer != null) { SHUTOFF_BUFFER = s.shutoff_buffer; var sb=$('shutoff-buffer-val'); if(sb) sb.innerText=dispDelta(SHUTOFF_BUFFER)+dispUnit(); }
                    if (s.is_celsius != null && s.is_celsius !== isCelsius) setUnit(s.is_celsius);
                })
                .catch(function() {});
        }

        fetch(PB + '/api/collections/readings/records?sort=-ts&perPage=1')
            .then(function(r) { return r.json(); })
            .then(function(d) {
                if (!d.items || !d.items.length) {
                    $('indoor-temp').innerText = '--';
                    $('indoor-temp').style.color = '#4e6580';
                    setBadge('idle', 'Idle');
                    updateRec('⏳ Waiting for device — no readings in database yet. Ensure the Linx device is running and connected.', '');
                    return;
                }
                var rec = d.items[0];
                var temp = parseFloat(rec.indoor_temp);
                if (isNaN(temp)) return;

                var ageMs  = Date.now() - new Date(rec.ts).getTime();
                var stale  = ageMs > 300000;
                var ageStr = ageMs < 60000 ? Math.round(ageMs / 1000) + 's ago'
                                           : Math.round(ageMs / 60000) + ' min ago';

                // target_temp in a reading reflects what the device had at post time —
                // do NOT override browser targetTemp from it (settings are the source of truth)

                lastKnownTemp = temp;
                var diff  = temp - targetTemp;
                var state = rec.hvac_state || 'idle';

                $('indoor-temp').innerText = dispTemp(temp) + (stale ? ' ⚠' : '');
                $('indoor-temp').style.color = stale ? '#4e6580' :
                    (state === 'cooling' || state === 'fan') ? '#ef4444' :
                    (state === 'heating' || state === 'fan-heat') ? '#38bdf8' : '#2dd4bf';

                $('temp-diff').innerText =
                    (diff >= 0 ? '+' : '') + dispDelta(diff) + dispUnit();

                if (stale) {
                    setDevice('heater', false, '');
                    setDevice('cooler', false, '');
                    setDevice('fan',    false, '');
                    setBadge('idle', 'Offline');
                    updateRec(
                        '⚠ Last reading ' + ageStr + ' — device not sending data. ' +
                        'Last known indoor: <strong>' + tempStr(temp) + '</strong>.',
                        'idle'
                    );
                } else {
                    setDevice('heater', state === 'heating' || state === 'fan+heater', 'heat');
                    setDevice('cooler', state === 'cooling' || state === 'fan+ac',    'cool');
                    setDevice('fan',
                        state === 'fan' || state === 'fan-heat' || state === 'fan+heater' || state === 'fan+ac',
                        (state === 'fan' || state === 'fan+ac') ? 'cool' : 'heat');

                    if (state === 'cooling' || state === 'fan' || state === 'fan+ac')               setBadge('cooling', 'Cooling');
                    else if (state === 'heating' || state === 'fan-heat' || state === 'fan+heater') setBadge('heating', 'Heating');
                    else                                                                             setBadge('idle', 'Idle');

                    var recType = (state === 'cooling' || state === 'fan' || state === 'fan+ac') ? 'cool'
                                : (state === 'heating' || state === 'fan-heat' || state === 'fan+heater') ? 'heat' : 'idle';

                    // Add to live chart on every poll (smooth chart even with 10s PB writes)
                    addToHistory(temp);
                    if (rec.ts !== lastReadingTs) lastReadingTs = rec.ts;

                    updateRec(buildRec(temp, diff, state), recType);
                }
            })
            .catch(function() {});
    }

    pollLiveData();
    setInterval(pollLiveData, 5000);
})();
