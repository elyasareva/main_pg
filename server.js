'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');

// Bind ke semua interface agar dashboard bisa dibuka dari perangkat lain di
// jaringan yang sama (mis. HP). Untuk pemakaian yang hanya boleh diakses mesin
// sendiri, jalankan dengan HOST=127.0.0.1.
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8787);
const SOURCE_URL = 'https://galeri24.co.id/harga-emas';
const CACHE_TTL_MS = 5 * 60 * 1000;
const ROOT = __dirname;

// Urutan pencarian tiap merek: id section di halaman resmi, lalu label tampilan.
const BRANDS = {
  galeri24: { label: 'Galeri 24', sections: ['GALERI 24'] },
  antam: { label: 'Antam', sections: ['ANTAM'] },
  ubs: { label: 'UBS', sections: ['UBS'] },
  lotus: { label: 'Lotus Archi', sections: ['LOTUS ARCHI'] },
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

let cache = { fetchedAt: 0, payload: null };

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function parseRupiah(text) {
  const digits = String(text || '').replace(/[^\d]/g, '');
  return digits ? Number(digits) : 0;
}

// Membaca tabel "Harga <merek>" dan mengambil harga jual untuk berat 1 gram.
function readSellPrice($, sectionIds) {
  for (const id of sectionIds) {
    const section = $(`[id="${id}"]`).first();
    if (!section.length) continue;

    let price = 0;
    section.find('.grid-cols-5').each((_, row) => {
      const cells = $(row).children('div');
      if (cells.length < 3) return;
      const weight = parseFloat($(cells[0]).text().trim().replace(',', '.'));
      if (weight === 1) {
        price = parseRupiah($(cells[1]).text());
        return false;
      }
      return undefined;
    });

    if (price > 0) return price;
  }
  return 0;
}

async function scrapePrices() {
  const response = await fetch(SOURCE_URL, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });

  if (!response.ok) {
    throw new Error(`Halaman sumber merespons HTTP ${response.status}`);
  }

  const $ = cheerio.load(await response.text());
  const prices = {};
  const missing = [];

  for (const [key, brand] of Object.entries(BRANDS)) {
    const price = readSellPrice($, brand.sections);
    if (price > 0) prices[key] = price;
    else missing.push(brand.label);
  }

  if (Object.keys(prices).length === 0) {
    throw new Error('Tidak ada harga 1 gram yang bisa dibaca dari halaman sumber');
  }

  return { prices, missing };
}

async function getPrices(forceRefresh) {
  const fresh = cache.payload && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (fresh && !forceRefresh) return { ...cache.payload, cached: true };

  const { prices, missing } = await scrapePrices();
  const payload = {
    source: SOURCE_URL,
    fetchedAt: new Date().toISOString(),
    prices,
    ...(missing.length ? { missing } : {}),
    note: missing.length
      ? `Harga ${missing.join(', ')} tidak ditemukan di halaman sumber; dashboard mempertahankan nilai terakhir.`
      : 'Harga jual 1 gram berhasil dibaca dari halaman resmi Galeri 24.',
  };

  cache = { fetchedAt: Date.now(), payload };
  return { ...payload, cached: false };
}

function serveStatic(res, pathname) {
  const name = pathname === '/' ? 'dashboard_sinkronisasi_galeri24.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = path.resolve(ROOT, name);

  if (!filePath.startsWith(ROOT + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return false;
  }

  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

  if (url.pathname === '/health') {
    return send(res, 200, {
      status: 'ok',
      proxy: 'galeri24-scraper',
      source: SOURCE_URL,
      endpoint: '/api/gold-prices',
      cachedSince: cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
    });
  }

  if (url.pathname === '/api/gold-prices') {
    const force = url.searchParams.get('refresh') === 'true';
    try {
      return send(res, 200, await getPrices(force));
    } catch (error) {
      console.error('Gagal mengambil harga:', error.message);
      // Sumber gagal: sajikan harga terakhir yang pernah berhasil, jangan mengarang harga baru.
      if (cache.payload) {
        return send(res, 200, {
          ...cache.payload,
          cached: true,
          stale: true,
          warning: `Gagal memperbarui dari sumber (${error.message}). Menampilkan harga terakhir.`,
        });
      }
      return send(res, 502, { error: 'Gagal mengambil harga dari sumber resmi.', detail: error.message });
    }
  }

  if (req.method === 'GET' && serveStatic(res, url.pathname)) return undefined;

  return send(res, 404, { error: 'Endpoint tidak ditemukan' });
});

server.listen(PORT, HOST, () => {
  console.log(`Proxy harga Galeri 24 aktif di: http://${HOST}:${PORT}`);
  console.log(`Dashboard: http://${HOST}:${PORT}/`);
});
