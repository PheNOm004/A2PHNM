// Cloudflare Pages Function — PocketBase-compatible REST API backed by D1
// Handles:
//   GET  /api/collections/{name}/records[?perPage&page&sort&filter]
//   POST /api/collections/{name}/records
//   GET  /api/collections/{name}/records/{id}
//   PATCH /api/collections/{name}/records/{id}

const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS },
    });
}

function randomId() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// Parse PocketBase filter strings into SQL WHERE clauses.
// Supported forms: field>="value"  field<="value"  field="value"
function parseFilter(filter) {
    if (!filter) return { clause: '', params: [] };
    const params = [];
    const clause = filter
        .replace(/(\w+)\s*>=\s*"([^"]+)"/g, (_, col, val) => { params.push(val); return `${col} >= ?`; })
        .replace(/(\w+)\s*<=\s*"([^"]+)"/g, (_, col, val) => { params.push(val); return `${col} <= ?`; })
        .replace(/(\w+)\s*=\s*"([^"]+)"/g,  (_, col, val) => { params.push(val); return `${col} = ?`; });
    return { clause, params };
}

// Map PocketBase sort strings ("-ts", "ts_start") to SQL ORDER BY
function parseSort(sort) {
    if (!sort) return 'rowid DESC';
    return sort.split(',').map(s => {
        const desc = s.startsWith('-');
        return `${desc ? s.slice(1) : s} ${desc ? 'DESC' : 'ASC'}`;
    }).join(', ');
}

// Allowed collections — guards against SQL injection via the table name
const ALLOWED = new Set(['settings', 'readings', 'hvac_events']);

export async function onRequest(context) {
    const { request, env, params } = context;
    const method = request.method.toUpperCase();

    // Preflight
    if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
    }

    const DB = env.DB;
    if (!DB) return json({ error: 'DB binding missing — check D1 is linked in Cloudflare dashboard' }, 500);

    // params.catchall is an array of path segments after /api/collections/
    // e.g. ['readings', 'records'] or ['readings', 'records', 'abc123']
    const segs = Array.isArray(params.catchall) ? params.catchall : (params.catchall || '').split('/').filter(Boolean);
    const collection = segs[0];
    const recordId   = segs[2]; // segs[1] === 'records'

    if (!ALLOWED.has(collection)) return json({ error: 'Unknown collection' }, 404);

    const url = new URL(request.url);

    // ── GET list ──────────────────────────────────────────────────────
    if (method === 'GET' && !recordId) {
        const perPage  = Math.min(parseInt(url.searchParams.get('perPage') || '30'), 500);
        const page     = Math.max(parseInt(url.searchParams.get('page') || '1'), 1);
        const offset   = (page - 1) * perPage;
        const orderBy  = parseSort(url.searchParams.get('sort'));
        const { clause, params: fp } = parseFilter(url.searchParams.get('filter'));

        const where = clause ? `WHERE ${clause}` : '';

        try {
            const [countRes, rowsRes] = await Promise.all([
                DB.prepare(`SELECT COUNT(*) AS n FROM ${collection} ${where}`).bind(...fp).first(),
                DB.prepare(`SELECT * FROM ${collection} ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).bind(...fp, perPage, offset).all(),
            ]);
            return json({
                page,
                perPage,
                totalItems: countRes.n,
                totalPages: Math.ceil(countRes.n / perPage),
                items: rowsRes.results || [],
            });
        } catch (e) {
            return json({ error: e.message }, 500);
        }
    }

    // ── GET single record ─────────────────────────────────────────────
    if (method === 'GET' && recordId) {
        try {
            const row = await DB.prepare(`SELECT * FROM ${collection} WHERE id = ?`).bind(recordId).first();
            if (!row) return json({ error: 'Not found' }, 404);
            return json(row);
        } catch (e) {
            return json({ error: e.message }, 500);
        }
    }

    // ── POST create ───────────────────────────────────────────────────
    if (method === 'POST') {
        let body;
        try { body = await request.json(); } catch { body = {}; }

        const id = randomId();
        const record = { id, ...body };
        const cols = Object.keys(record);
        const placeholders = cols.map(() => '?').join(', ');
        const vals = cols.map(c => record[c]);

        try {
            await DB.prepare(
                `INSERT INTO ${collection} (${cols.join(', ')}) VALUES (${placeholders})`
            ).bind(...vals).run();
            return json(record, 200);
        } catch (e) {
            return json({ error: e.message }, 500);
        }
    }

    // ── PATCH update ──────────────────────────────────────────────────
    if (method === 'PATCH' && recordId) {
        let body;
        try { body = await request.json(); } catch { body = {}; }

        const cols = Object.keys(body);
        if (cols.length === 0) return json({ error: 'Empty body' }, 400);
        const sets = cols.map(c => `${c} = ?`).join(', ');
        const vals = [...cols.map(c => body[c]), recordId];

        try {
            await DB.prepare(`UPDATE ${collection} SET ${sets} WHERE id = ?`).bind(...vals).run();
            const updated = await DB.prepare(`SELECT * FROM ${collection} WHERE id = ?`).bind(recordId).first();
            return json(updated || { id: recordId, ...body });
        } catch (e) {
            return json({ error: e.message }, 500);
        }
    }

    return json({ error: 'Method not allowed' }, 405);
}
