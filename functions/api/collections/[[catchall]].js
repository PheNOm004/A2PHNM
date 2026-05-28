const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function json(data, status) {
    return new Response(JSON.stringify(data), {
        status: status || 200,
        headers: { 'Content-Type': 'application/json', ...CORS }
    });
}

function id() {
    return crypto.randomUUID().replaceAll('-', '').slice(0, 15);
}

const TABLES = {
    settings: ['id','created','updated','isAutomatic','targetTemp','idleBand','shutoffBuffer','useDynamicShutoff','coastFactor','thermalCoeff','coastAsymmetry','isCelsius','city'],
    readings: ['id','created','updated','ts','indoor_temp','target_temp','outdoor_temp','humidity','hvac_state'],
    hvac_events: ['id','created','updated','ts_start','ts_end','type','start_temp','end_temp','target_temp','duration_mins']
};

function sortSql(sort) {
    if (!sort) return 'created DESC';

    return sort.split(',').map(function(s) {
        var desc = s[0] === '-';
        var col = desc ? s.slice(1) : s;
        return col + (desc ? ' DESC' : ' ASC');
    }).join(', ');
}

function filterSql(filter) {
    if (!filter) return { where: '', vals: [] };

    var vals = [];

    var where = filter
        .replace(/(\w+)\s*>=\s*"([^"]+)"/g, function(_, col, val) {
            vals.push(val);
            return col + ' >= ?';
        })
        .replace(/(\w+)\s*<=\s*"([^"]+)"/g, function(_, col, val) {
            vals.push(val);
            return col + ' <= ?';
        })
        .replace(/(\w+)\s*=\s*"([^"]+)"/g, function(_, col, val) {
            vals.push(val);
            return col + ' = ?';
        });

    return { where: 'WHERE ' + where, vals: vals };
}

export async function onRequest(context) {
    var request = context.request;
    var env = context.env;
    var params = context.params;

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
    }

    if (!env.DB) {
        return json({ error: 'Missing Cloudflare D1 DB binding named DB' }, 500);
    }

    var segs = Array.isArray(params.catchall)
        ? params.catchall
        : String(params.catchall || '').split('/').filter(Boolean);

    var table = segs[0];
    var action = segs[1];
    var recordId = segs[2];

    if (!TABLES[table] || action !== 'records') {
        return json({ error: 'Unknown collection' }, 404);
    }

    var url = new URL(request.url);

    try {
        if (request.method === 'GET' && !recordId) {
            var page = Math.max(parseInt(url.searchParams.get('page') || '1'), 1);
            var perPage = Math.min(parseInt(url.searchParams.get('perPage') || '30'), 5000);
            var offset = (page - 1) * perPage;

            var f = filterSql(url.searchParams.get('filter'));
            var orderBy = sortSql(url.searchParams.get('sort'));

            var count = await env.DB.prepare(
                'SELECT COUNT(*) AS n FROM ' + table + ' ' + f.where
            ).bind(...f.vals).first();

            var rows = await env.DB.prepare(
                'SELECT * FROM ' + table + ' ' + f.where + ' ORDER BY ' + orderBy + ' LIMIT ? OFFSET ?'
            ).bind(...f.vals, perPage, offset).all();

            return json({
                page: page,
                perPage: perPage,
                totalItems: count.n,
                totalPages: Math.ceil(count.n / perPage),
                items: rows.results || []
            });
        }

        if (request.method === 'GET' && recordId) {
            var row = await env.DB.prepare(
                'SELECT * FROM ' + table + ' WHERE id = ?'
            ).bind(recordId).first();

            return row ? json(row) : json({ error: 'Not found' }, 404);
        }

        if (request.method === 'POST') {
            var body = await request.json().catch(function() { return {}; });
            var now = new Date().toISOString();

            var record = {
                id: body.id || id(),
                created: body.created || now,
                updated: body.updated || now,
                ...body
            };

            var cols = Object.keys(record).filter(function(c) {
                return TABLES[table].indexOf(c) !== -1;
            });

            var sql = 'INSERT INTO ' + table +
                ' (' + cols.join(',') + ') VALUES (' +
                cols.map(function() { return '?'; }).join(',') + ')';

            await env.DB.prepare(sql).bind(...cols.map(function(c) {
                return record[c];
            })).run();

            return json(record);
        }

        if (request.method === 'PATCH' && recordId) {
            var patch = await request.json().catch(function() { return {}; });
            patch.updated = new Date().toISOString();

            var cols = Object.keys(patch).filter(function(c) {
                return TABLES[table].indexOf(c) !== -1 && c !== 'id' && c !== 'created';
            });

            if (!cols.length) return json({ error: 'Empty update' }, 400);

            var sqlPatch = 'UPDATE ' + table + ' SET ' +
                cols.map(function(c) { return c + ' = ?'; }).join(', ') +
                ' WHERE id = ?';

            await env.DB.prepare(sqlPatch).bind(
                ...cols.map(function(c) { return patch[c]; }),
                recordId
            ).run();

            var updated = await env.DB.prepare(
                'SELECT * FROM ' + table + ' WHERE id = ?'
            ).bind(recordId).first();

            return json(updated);
        }

        return json({ error: 'Method not allowed' }, 405);

    } catch(e) {
        return json({ error: e.message }, 500);
    }
}