-- D1 schema — mirrors the three PocketBase collections

CREATE TABLE IF NOT EXISTS settings (
    id                  TEXT PRIMARY KEY,
    target_temp         REAL    DEFAULT 22.0,
    idle_band           REAL    DEFAULT 1.0,
    is_celsius          INTEGER DEFAULT 1,
    shutoff_buffer      REAL    DEFAULT 0.3,
    use_dynamic_shutoff INTEGER DEFAULT 0,
    coast_factor        REAL    DEFAULT 0.15,
    thermal_coeff       REAL    DEFAULT 0.035,
    coast_asymmetry     REAL    DEFAULT 0.0,
    cost_kwh            REAL    DEFAULT 25,
    watt_heater         REAL    DEFAULT 1000,
    watt_cooler         REAL    DEFAULT 1500,
    watt_fan            REAL    DEFAULT 50,
    city                TEXT    DEFAULT 'Sydney'
);

CREATE TABLE IF NOT EXISTS readings (
    id          TEXT PRIMARY KEY,
    indoor_temp REAL,
    target_temp REAL,
    hvac_state  TEXT,
    ts          TEXT
);
CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts);

CREATE TABLE IF NOT EXISTS hvac_events (
    id            TEXT PRIMARY KEY,
    type          TEXT,
    ts_start      TEXT,
    ts_end        TEXT,
    start_temp    REAL,
    end_temp      REAL,
    duration_mins REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON hvac_events(ts_start);
