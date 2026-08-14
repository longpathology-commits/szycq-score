import { getStore } from '@netlify/blobs';

// 云端备份读写：标记/持股/资金 存到 Netlify Blobs（免费、持久、无需发助手）
const STORE = 'szycq-backup';
const KEY = 'cloud_backup';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async (request, context) => {
  const headers = { 'Content-Type': 'application/json', ...CORS };

  // 浏览器预检
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  let store;
  try {
    store = getStore({
      name: STORE,
      siteID: process.env.SITE_ID,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'blob store 初始化失败: ' + (e.message || e) }), { status: 500, headers });
  }

  try {
    if (request.method === 'GET') {
      let data = null;
      try { data = await store.get(KEY, { type: 'json' }); } catch (e) { data = null; }
      if (!data) data = { watch: [], hold: [], capital: null, updatedAt: null };
      return new Response(JSON.stringify(data), { headers });
    }
    if (request.method === 'POST' || request.method === 'PUT') {
      const body = await request.json().catch(() => ({}));
      const payload = {
        watch: Array.isArray(body.watch) ? body.watch : [],
        hold: Array.isArray(body.hold) ? body.hold : [],
        capital: (body.capital !== undefined ? body.capital : null),
        updatedAt: new Date().toISOString(),
      };
      await store.set(KEY, JSON.stringify(payload));
      return new Response(JSON.stringify({ ok: true, updatedAt: payload.updatedAt }), { headers });
    }
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e && e.message || e) }), { status: 500, headers });
  }
};
