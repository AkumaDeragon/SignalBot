// SignalBot Beauty Gemini Worker
// Real market data + technical indicators + recommendation label + news aggregation

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/health') {
        return json({
          ok: true,
          name: 'SignalBot Beauty Gemini Worker v17',
          hasGeminiKey: !!env.GEMINI_API_KEY,
          model: env.GEMINI_MODEL || 'gemini-2.5-flash',
          endpoints: ['POST /api/analyze'],
          marketSources: { crypto: ['binance', 'okx', 'coinbase'], stock: ['yahoo_quote', 'yahoo_chart', 'finmind_tw', 'twse', 'tpex', 'stooq'] },
          newsSources: ['Google News RSS', 'Yahoo Finance Search', 'GDELT fallback']
        });
      }
      if (url.pathname === '/api/analyze' && request.method === 'POST') {
        const input = await request.json().catch(() => ({}));
        return json(await analyze(input, env));
      }
      return json({ ok: false, error: 'Not found' }, 404);
    } catch (err) {
      return json({ ok: false, error: 'ANALYZE_FAILED', message: String(err?.message || err) }, 500);
    }
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' }
  });
}

async function analyze(input, env) {
  const assetType = input.assetType === 'crypto' ? 'crypto' : 'stock';
  const interval = normalizeInterval(input.interval || '1d', assetType);
  const range = input.range || '6mo';
  const rawTicker = String(input.ticker || (assetType === 'crypto' ? 'BTC' : 'AAPL')).trim().toUpperCase();
  const sourcePref = String(input.source || 'auto').toLowerCase();

  const prices = await fetchPriceSeries(rawTicker, assetType, interval, range, sourcePref, env);
  if (!prices.candles?.length || prices.candles.length < 40) throw new Error(`行情資料不足：${rawTicker}`);

  const tech = computeTechnicals(prices.candles);
  const quotePack = await fetchMultiQuotes(rawTicker, assetType, prices, env).catch(() => ({ quotes: [], quoteCandidates: [], closeCandidates: [], consensus: null, spreadPct: null, closePrice: null, priceVsClosePct: null, warning: '多重報價暫時不可用' }));
  if (quotePack?.consensus?.price) {
    tech.livePrice = quotePack.consensus.price;
    prices.liveQuote = quotePack.consensus;
  }

  const [market, news] = await Promise.all([
    fetchMarketContext(assetType).catch(err => ({ items: [], scoreAdj: 0, summary: `市場環境暫時不可用：${err.message}` })),
    fetchNews(rawTicker, assetType).catch(err => ({ articles: [], sourceMix: [], summary: `新聞暫時不可用：${err.message}` }))
  ]);
  const cross = quotePack.quotes || [];

  const scorePack = computeScore(tech, market, news, assetType);
  if (quotePack.warning) scorePack.warnings.unshift(quotePack.warning);
  if (quotePack.priceVsClosePct != null && Math.abs(quotePack.priceVsClosePct) > 1) {
    scorePack.warnings.unshift(`現價與K線收盤差異 ${quotePack.priceVsClosePct.toFixed(2)}%，可能是盤中/延遲報價與歷史K線時間差。`);
  }
  scorePack.warnings = scorePack.warnings.slice(0, 6);
  let ai = null;
  if (input.useAI !== false && env.GEMINI_API_KEY) {
    ai = await callGemini({ rawTicker, assetType, prices, tech, market, news, scorePack, cross }, env)
      .catch(err => ({ error: String(err?.message || err) }));
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    ticker: rawTicker,
    normalizedTicker: prices.normalizedTicker,
    assetType,
    source: prices.source,
    sourceKey: prices.sourceKey,
    score: scorePack.score,
    direction: scorePack.direction,
    recommendation: scorePack.recommendation,
    recommendationTone: scorePack.recommendationTone,
    confidence: scorePack.confidence,
    riskLevel: scorePack.riskLevel,
    reasons: scorePack.reasons,
    warnings: scorePack.warnings,
    actionPlan: scorePack.actionPlan,
    price: tech.livePrice || tech.close,
    closePrice: tech.close,
    liveQuote: prices.liveQuote || null,
    priceCheck: quotePack,
    crossChecks: cross,
    change1dPct: tech.change1dPct,
    candles: prices.candles.slice(-240),
    technicals: tech,
    market,
    news,
    ai,
    notes: sourceNotes(assetType)
  };
}

function normalizeInterval(v, assetType) {
  if (assetType === 'crypto') return ({ '1d': '1d', '日線': '1d', '1wk': '1w', '週線': '1w', '1h': '1h', '4h': '4h' })[v] || '1d';
  return ['1d', '1wk', '1mo'].includes(v) ? v : '1d';
}

function sourceNotes(assetType) {
  if (assetType === 'crypto') return '加密貨幣支援 Binance 與 OKX，auto 會優先 Binance，失敗改 OKX；同時做跨交易所報價檢查。';
  return '股票多重報價支援 Yahoo Quote / Yahoo Chart、FinMind、TWSE 上市、TPEx 上櫃與 Stooq 備援。國泰 / 富邦若要接券商專屬 API，建議另外做本機端安全版，不要把帳密放公開網站。';
}

function median(nums) {
  const a = nums.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function quotePackFrom(quotes, fallbackClose) {
  const clean = quotes
    .filter(q => q && Number.isFinite(Number(q.price)) && Number(q.price) > 0)
    .map(q => ({ ...q, price: Number(q.price) }));

  const hasCloseLike = clean.some(q => ['close', 'chart-close', 'daily-close'].includes(q.type));
  if (!hasCloseLike && Number.isFinite(Number(fallbackClose)) && Number(fallbackClose) > 0) {
    clean.push({ source: 'K線最後收盤', price: Number(fallbackClose), type: 'close', time: new Date().toISOString() });
  }

  // 重點：現價不要被 K 線收盤價拉歪。
  // 先用 live / delayed / prev-close 這類 quote 來源取中位數；沒有 quote 才退回 K 線或日收盤。
  const quoteCandidates = clean.filter(q => ['live', 'delayed', 'prev-close'].includes(q.type));
  const closeCandidates = clean.filter(q => ['close', 'chart-close', 'daily-close'].includes(q.type));
  const basis = quoteCandidates.length ? quoteCandidates : closeCandidates;
  const med = median(basis.map(q => q.price));

  const allPrices = clean.map(q => q.price);
  const min = allPrices.length ? Math.min(...allPrices) : null;
  const max = allPrices.length ? Math.max(...allPrices) : null;
  const spreadPct = med ? ((max - min) / med) * 100 : null;
  const closePrice = Number.isFinite(Number(fallbackClose)) ? Number(fallbackClose) : null;
  const priceVsClosePct = med && closePrice ? ((med - closePrice) / closePrice) * 100 : null;

  const consensus = med ? {
    source: quoteCandidates.length >= 2 ? '多重即時報價中位數' : quoteCandidates.length === 1 ? quoteCandidates[0].source : (basis[0]?.source || 'K線收盤'),
    price: med,
    basis: quoteCandidates.length ? 'quote' : 'close',
    time: new Date().toISOString()
  } : null;

  return {
    quotes: clean,
    quoteCandidates,
    closeCandidates,
    consensus,
    spreadPct,
    closePrice,
    priceVsClosePct,
    warning: spreadPct != null && spreadPct > 2 ? `報價來源差異 ${spreadPct.toFixed(2)}%，請再確認交易所或盤中資料。` : null
  };
}

async function fetchMultiQuotes(rawTicker, assetType, prices, env = {}) {
  const fallbackClose = prices.candles?.[prices.candles.length - 1]?.close;
  if (assetType === 'crypto') {
    const base = normalizeCryptoSymbol(rawTicker);
    const jobs = [
      fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${base}USDT`).then(r => r.ok ? r.json() : null).then(d => d?.price ? { source: 'Binance', symbol: `${base}USDT`, price: Number(d.price), type: 'live' } : null).catch(() => null),
      fetch(`https://www.okx.com/api/v5/market/ticker?instId=${base}-USDT`).then(r => r.ok ? r.json() : null).then(d => d?.data?.[0]?.last ? { source: 'OKX', symbol: `${base}-USDT`, price: Number(d.data[0].last), type: 'live' } : null).catch(() => null),
      fetch(`https://api.coinbase.com/v2/prices/${base}-USD/spot`).then(r => r.ok ? r.json() : null).then(d => d?.data?.amount ? { source: 'Coinbase', symbol: `${base}-USD`, price: Number(d.data.amount), type: 'live' } : null).catch(() => null)
    ];
    return quotePackFrom(await Promise.all(jobs), fallbackClose);
  }

  const symbol = normalizeStockTicker(rawTicker);
  const stockId = normalizeTaiwanStockId(rawTicker);
  const jobs = [
    fetchYahooQuote(symbol),
    { source: 'Yahoo Chart', symbol, price: Number(fallbackClose), type: 'chart-close', time: new Date().toISOString() }
  ];

  if (stockId) {
    jobs.push(fetchTwMarketQuote(stockId, 'tse'));
    jobs.push(fetchTwMarketQuote(stockId, 'otc'));
    jobs.push(fetchFinMindLatestQuote(stockId, env));
  } else {
    jobs.push(fetchStooqQuote(symbol));
  }

  return quotePackFrom(await Promise.all(jobs), fallbackClose);
}

async function fetchYahooQuote(symbol) {
  return fetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`, { headers: { accept: 'application/json', 'user-agent': 'SignalBot/3.3' } })
    .then(r => r.ok ? r.json() : null)
    .then(d => {
      const q = d?.quoteResponse?.result?.[0];
      const price = q?.regularMarketPrice || q?.postMarketPrice || q?.preMarketPrice || q?.regularMarketPreviousClose;
      return Number.isFinite(Number(price)) ? { source: 'Yahoo Quote', symbol, price: Number(price), type: 'live' } : null;
    }).catch(() => null);
}

function normalizeTaiwanStockId(raw) {
  const s = String(raw || '').toUpperCase().trim().replace('.TW', '');
  return /^[0-9]{4,6}[A-Z]?$/.test(s) ? s : null;
}

async function fetchTwMarketQuote(stockId, market) {
  const ex = market === 'otc' ? 'otc' : 'tse';
  const source = market === 'otc' ? 'TPEx 上櫃' : 'TWSE 上市';
  const exCh = `${ex}_${stockId}.tw`;
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0&_=${Date.now()}`;
  const res = await fetch(url, {
    headers: {
      accept: 'application/json,text/plain,*/*',
      referer: 'https://mis.twse.com.tw/stock/index.jsp',
      'user-agent': 'SignalBot/3.3'
    }
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const d = await res.json().catch(() => null);
  const q = d?.msgArray?.[0];
  if (!q) return null;
  const rawPrice = q.z && q.z !== '-' ? q.z : (q.y && q.y !== '-' ? q.y : null);
  const price = Number(String(rawPrice || '').replace(/,/g, ''));
  return Number.isFinite(price) && price > 0 ? { source, symbol: `${stockId}.TW`, price, type: q.z && q.z !== '-' ? 'live' : 'prev-close' } : null;
}

async function fetchFinMindLatestQuote(stockId, env = {}) {
  let url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${encodeURIComponent(stockId)}&start_date=${dateDaysAgo(12)}`;
  if (env.FINMIND_TOKEN) url += `&token=${encodeURIComponent(env.FINMIND_TOKEN)}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } }).catch(() => null);
  if (!res || !res.ok) return null;
  const d = await res.json().catch(() => null);
  const rows = Array.isArray(d?.data) ? d.data : [];
  const lastRow = rows.reverse().find(x => Number.isFinite(Number(x.close)) && Number(x.close) > 0);
  return lastRow ? { source: 'FinMind 台股', symbol: `${stockId}.TW`, price: Number(lastRow.close), type: 'daily-close', time: lastRow.date } : null;
}

async function fetchStooqQuote(symbol) {
  let s = String(symbol || '').toLowerCase().trim();
  if (!s.includes('.')) s = `${s}.us`;
  if (s.endsWith('.tw')) return null;
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(s)}&f=sd2t2ohlcv&h&e=csv`;
  const res = await fetch(url, { headers: { accept: 'text/csv', 'user-agent': 'SignalBot/3.3' } }).catch(() => null);
  if (!res || !res.ok) return null;
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const headers = lines[0].split(',').map(x => x.trim().toLowerCase());
  const vals = lines[1].split(',').map(x => x.trim());
  const idxClose = headers.indexOf('close');
  const price = Number(vals[idxClose]);
  return Number.isFinite(price) && price > 0 ? { source: 'Stooq', symbol: s, price, type: 'delayed' } : null;
}

async function fetchPriceSeries(rawTicker, assetType, interval, range, sourcePref, env) {
  if (assetType === 'crypto') {
    const errors = [];
    const order = sourcePref === 'okx' ? ['okx', 'binance'] : sourcePref === 'binance' ? ['binance', 'okx'] : ['binance', 'okx'];
    for (const s of order) {
      try {
        if (s === 'binance') return await fetchBinanceKlines(rawTicker, interval);
        if (s === 'okx') return await fetchOkxCandles(rawTicker, interval);
      } catch (err) { errors.push(`${s}: ${err.message}`); }
    }
    throw new Error(errors.join(' | '));
  }

  const isTW = /^[0-9]{4,6}[A-Z]?(\.TW)?$/.test(rawTicker);
  const errors = [];
  const order = sourcePref === 'finmind_tw' ? ['finmind_tw', 'yahoo'] : sourcePref === 'yahoo' ? ['yahoo', 'finmind_tw'] : ['yahoo', 'finmind_tw'];
  for (const s of order) {
    try {
      if (s === 'finmind_tw' && isTW) return await fetchFinMindTW(rawTicker, range, env);
      if (s === 'yahoo') return await fetchYahooChart(normalizeStockTicker(rawTicker), interval, range);
    } catch (err) { errors.push(`${s}: ${err.message}`); }
  }
  throw new Error(errors.join(' | '));
}

function normalizeCryptoSymbol(raw) {
  let base = String(raw || 'BTC').toUpperCase().trim();
  base = base.replace(/[-_\/]/g, '').replace(/USDT$/, '').replace(/USD$/, '').replace(/TWD$/, '');
  return base || 'BTC';
}
function normalizeStockTicker(raw) {
  const s = String(raw || 'AAPL').toUpperCase().trim();
  if (/^[0-9]{4,6}[A-Z]?$/.test(s)) return `${s}.TW`;
  return s;
}
function validCandle(c) {
  return [c.open, c.high, c.low, c.close].every(Number.isFinite) && c.high >= c.low && c.close > 0;
}
function rangeToDays(range) { return ({ '1mo': 45, '3mo': 110, '6mo': 220, '1y': 410, '2y': 760 })[range] || 220; }
function dateDaysAgo(days) { const d = new Date(Date.now() - days * 86400000); return d.toISOString().slice(0, 10); }

async function fetchBinanceKlines(rawTicker, interval = '1d') {
  const base = normalizeCryptoSymbol(rawTicker);
  const symbol = `${base}USDT`;
  const intv = ({ '1d': '1d', '1w': '1w', '1h': '1h', '4h': '4h' })[interval] || '1d';
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${intv}&limit=240`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
  const arr = await res.json();
  const candles = (Array.isArray(arr) ? arr : []).map(k => ({
    time: new Date(Number(k[0])).toISOString().slice(0, 10),
    open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5])
  })).filter(validCandle);
  sanityCryptoPrice(base, candles);
  return { source: 'Binance Spot Klines', sourceKey: 'binance', normalizedTicker: symbol, candles };
}

async function fetchOkxCandles(rawTicker, interval = '1d') {
  const base = normalizeCryptoSymbol(rawTicker);
  const instId = `${base}-USDT`;
  const bar = ({ '1d': '1D', '1w': '1W', '1h': '1H', '4h': '4H' })[interval] || '1D';
  const url = `https://www.okx.com/api/v5/market/history-candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=240`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`OKX HTTP ${res.status}`);
  const data = await res.json();
  const rows = Array.isArray(data?.data) ? data.data : [];
  const candles = rows.map(k => ({
    time: new Date(Number(k[0])).toISOString().slice(0, 10),
    open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5])
  })).filter(validCandle).reverse();
  sanityCryptoPrice(base, candles);
  return { source: 'OKX Candlesticks History', sourceKey: 'okx', normalizedTicker: instId, candles };
}

function sanityCryptoPrice(base, candles) {
  const lastClose = candles?.[candles.length - 1]?.close;
  if (base === 'BTC' && lastClose < 1000) throw new Error(`BTC price sanity check failed: ${lastClose}`);
  if (base === 'ETH' && lastClose < 100) throw new Error(`ETH price sanity check failed: ${lastClose}`);
}

async function fetchYahooChart(symbol, interval = '1d', range = '6mo') {
  const safeInterval = ['1d', '1wk', '1mo'].includes(interval) ? interval : '1d';
  const safeRange = ['1mo', '3mo', '6mo', '1y', '2y'].includes(range) ? range : '6mo';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${safeRange}&interval=${safeInterval}&includePrePost=false&events=div%2Csplits`;
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'SignalBot/3.0' } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const data = await res.json();
  const r = data.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  const candles = (r?.timestamp || []).map((ts, i) => ({
    time: new Date(ts * 1000).toISOString().slice(0, 10),
    open: Number(q?.open?.[i]), high: Number(q?.high?.[i]), low: Number(q?.low?.[i]), close: Number(q?.close?.[i]), volume: Number(q?.volume?.[i] || 0)
  })).filter(validCandle);
  if (!candles.length) throw new Error('Yahoo malformed');
  return { source: 'Yahoo Finance chart endpoint', sourceKey: 'yahoo', normalizedTicker: symbol, candles };
}

async function fetchFinMindTW(rawTicker, range = '6mo', env) {
  const stockId = String(rawTicker).toUpperCase().replace('.TW', '');
  let url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${encodeURIComponent(stockId)}&start_date=${dateDaysAgo(rangeToDays(range))}`;
  if (env.FINMIND_TOKEN) url += `&token=${encodeURIComponent(env.FINMIND_TOKEN)}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`FinMind HTTP ${res.status}`);
  const data = await res.json();
  const candles = (Array.isArray(data?.data) ? data.data : []).map(k => ({
    time: k.date,
    open: Number(k.open), high: Number(k.max), low: Number(k.min), close: Number(k.close), volume: Number(k.Trading_Volume || k.volume || 0)
  })).filter(validCandle);
  if (!candles.length) throw new Error('FinMind empty');
  return { source: 'FinMind TaiwanStockPrice', sourceKey: 'finmind_tw', normalizedTicker: `${stockId}.TW`, candles };
}

async function fetchLiveQuoteSafe(normalizedTicker, assetType, sourceKey) {
  try {
    if (assetType === 'crypto') {
      if (sourceKey === 'okx') {
        const okx = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(normalizedTicker)}`).then(r => r.ok ? r.json() : null);
        return okx?.data?.[0]?.last ? { source: 'OKX ticker', price: Number(okx.data[0].last), time: new Date().toISOString() } : null;
      }
      const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(normalizedTicker)}`);
      if (!res.ok) return null;
      const data = await res.json();
      return { source: 'Binance ticker', price: Number(data.price), time: new Date().toISOString() };
    }
    return null;
  } catch (_) {
    return null;
  }
}

async function fetchCrossChecks(rawTicker, assetType) {
  if (assetType !== 'crypto') return [];
  const base = normalizeCryptoSymbol(rawTicker);
  const checks = [];
  const bin = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${base}USDT`).then(r => r.ok ? r.json() : null).catch(() => null);
  if (bin?.price) checks.push({ source: 'Binance', symbol: `${base}USDT`, price: Number(bin.price) });
  const okx = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${base}-USDT`).then(r => r.ok ? r.json() : null).catch(() => null);
  if (okx?.data?.[0]?.last) checks.push({ source: 'OKX', symbol: `${base}-USDT`, price: Number(okx.data[0].last) });
  return checks;
}

function computeTechnicals(candles) {
  const closes = candles.map(c => c.close), highs = candles.map(c => c.high), lows = candles.map(c => c.low), vols = candles.map(c => c.volume || 0);
  const close = last(closes), prevClose = closes[closes.length - 2] || close;
  const sma20 = sma(closes, 20), sma50 = sma(closes, 50), sma200 = sma(closes, Math.min(200, closes.length));
  const ema12s = emaSeries(closes, 12), ema26s = emaSeries(closes, 26);
  const macdLineSeries = ema12s.map((v, i) => v - ema26s[i]);
  const macdSignalSeries = emaSeries(macdLineSeries.filter(Number.isFinite), 9);
  const macd = last(macdLineSeries), macdSignal = last(macdSignalSeries), macdHist = macd - macdSignal;
  const rsi14 = rsi(closes, 14), bb = bollinger(closes, 20, 2), atr14 = atr(candles, 14);
  const volume20 = avg(vols.slice(-20));
  const volumeRatio = volume20 ? (last(vols) / volume20) * 100 : null;
  const change1dPct = pct(close, prevClose);
  const change20dPct = closes.length > 21 ? pct(close, closes[closes.length - 21]) : null;
  const bbPosition = bb.upper !== bb.lower ? ((close - bb.lower) / (bb.upper - bb.lower)) * 100 : null;
  return {
    close, prevClose, change1dPct, change20dPct, sma20, sma50, sma200,
    rsi14, macd, macdSignal, macdHist, bollinger: bb, bbPosition,
    atr14, atrPct: atr14 ? (atr14 / close) * 100 : null,
    volume: last(vols), volume20, volumeRatio,
    high20: Math.max(...highs.slice(-20)), low20: Math.min(...lows.slice(-20)),
    trend: close > sma20 && sma20 > sma50 ? 'up' : close < sma20 && sma20 < sma50 ? 'down' : 'mixed'
  };
}

function sma(values, period) { return avg(values.slice(-period)); }
function emaSeries(values, period) { const k = 2 / (period + 1); let out = [], prev = values[0]; for (const v of values) { prev = v * k + prev * (1 - k); out.push(prev); } return out; }
function rsi(values, period) { if (values.length <= period) return null; let gains = 0, losses = 0; for (let i = values.length - period; i < values.length; i++) { const diff = values[i] - values[i - 1]; if (diff >= 0) gains += diff; else losses -= diff; } if (losses === 0) return 100; const rs = gains / losses; return 100 - (100 / (1 + rs)); }
function bollinger(values, period, mult) { const slice = values.slice(-period); const mean = avg(slice); const variance = avg(slice.map(v => Math.pow(v - mean, 2))); const sd = Math.sqrt(variance || 0); return { middle: mean, upper: mean + mult * sd, lower: mean - mult * sd, widthPct: mean ? ((mult * 2 * sd) / mean) * 100 : null }; }
function atr(candles, period) { if (candles.length <= period) return null; const trs = []; for (let i = 1; i < candles.length; i++) { const c = candles[i], p = candles[i - 1]; trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))); } return avg(trs.slice(-period)); }
function avg(a) { const b = a.filter(Number.isFinite); return b.length ? b.reduce((x, y) => x + y, 0) / b.length : null; }
function last(a) { return a[a.length - 1]; }
function pct(now, before) { return before ? ((now - before) / before) * 100 : null; }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

async function fetchNews(ticker, assetType) {
  const cleanTicker = String(ticker).replace('.TW', '').trim();
  const googleQuery = assetType === 'crypto'
    ? `${cleanTicker} crypto OR ${cleanTicker} bitcoin OR ${cleanTicker} 幣`
    : `${cleanTicker} stock OR ${cleanTicker} earnings OR ${cleanTicker} 財報 OR ${cleanTicker} 股票`;

  const [google, yahoo, gdelt] = await Promise.all([
    fetchGoogleNewsRSS(googleQuery).catch(() => []),
    fetchYahooNews(cleanTicker).catch(() => []),
    fetchGdeltNews(cleanTicker, assetType).catch(() => [])
  ]);

  const all = dedupeArticles([...google, ...yahoo, ...gdelt]).slice(0, 12);
  const sourceMix = [...new Set(all.map(a => a.sourceLabel).filter(Boolean))];
  return {
    summary: all.length ? `已彙整 ${all.length} 則新聞，來源包含：${sourceMix.join('、')}。` : '未抓到足夠新聞。',
    sourceMix,
    articles: all
  };
}

async function fetchGoogleNewsRSS(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  const res = await fetch(url, { headers: { accept: 'application/rss+xml, application/xml, text/xml' } });
  if (!res.ok) throw new Error(`Google News RSS HTTP ${res.status}`);
  const xml = await res.text();
  const items = parseRSSItems(xml).map(i => ({ ...i, sourceLabel: 'Google News', sourceType: 'google' }));
  return items.slice(0, 6);
}

async function fetchYahooNews(query) {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=0&newsCount=8&enableFuzzyQuery=false&quotesQueryId=tss_match_phrase_query`;
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'SignalBot/3.0' } });
  if (!res.ok) throw new Error(`Yahoo News HTTP ${res.status}`);
  const data = await res.json();
  const news = Array.isArray(data?.news) ? data.news : [];
  return news.map(n => ({
    title: n.title || '',
    url: n.link || '',
    domain: n.publisher || 'Yahoo Finance',
    seendate: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString().slice(0, 16).replace('T', ' ') : '',
    sourceLabel: 'Yahoo Finance',
    sourceType: 'yahoo'
  })).filter(a => a.title && a.url).slice(0, 6);
}

async function fetchGdeltNews(query, assetType) {
  const q = assetType === 'crypto' ? `${query} cryptocurrency OR bitcoin OR crypto market` : `${query} finance OR stock OR earnings OR market`;
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&format=json&maxrecords=6&sort=hybridrel&timespan=7d`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GDELT HTTP ${res.status}`);
  const data = await res.json();
  return (data.articles || []).map(a => ({
    title: a.title || '',
    url: a.url || '',
    domain: a.domain || '',
    seendate: a.seendate || '',
    sourceLabel: a.domain || 'GDELT',
    sourceType: 'gdelt'
  })).filter(a => a.title && a.url).slice(0, 6);
}

function parseRSSItems(xml) {
  const items = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of blocks) {
    const title = decodeXml(getTag(block, 'title'));
    const link = decodeXml(getTag(block, 'link'));
    const pubDate = decodeXml(getTag(block, 'pubDate'));
    const source = decodeXml(getTag(block, 'source')) || 'Google News';
    if (title && link) items.push({ title, url: link, domain: source, seendate: pubDate, sourceLabel: source });
  }
  return items;
}
function getTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, 'i'));
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
}
function decodeXml(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function dedupeArticles(arr) {
  const seen = new Set();
  const out = [];
  for (const a of arr) {
    const key = (a.url || a.title || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key); out.push(a);
  }
  return out;
}

async function fetchMarketContext(assetType) {
  const items = [];
  if (assetType === 'crypto') {
    for (const s of ['BTC', 'ETH', 'SOL']) {
      try {
        const p = await fetchBinanceKlines(s, '1d');
        const t = computeTechnicals(p.candles);
        items.push({ symbol: `${s}USDT`, close: t.close, change1dPct: t.change1dPct, change20dPct: t.change20dPct, trend: t.trend });
      } catch (_) {}
    }
  } else {
    for (const s of ['^GSPC', '^IXIC', '^VIX', '^TNX']) {
      try {
        const p = await fetchYahooChart(s, '1d', '3mo');
        const t = computeTechnicals(p.candles);
        items.push({ symbol: s, close: t.close, change1dPct: t.change1dPct, change20dPct: t.change20dPct, trend: t.trend });
      } catch (_) {}
    }
  }
  let scoreAdj = 0;
  for (const it of items) {
    if (it.symbol === '^VIX') scoreAdj += it.change20dPct > 10 ? -5 : it.change20dPct < -10 ? 4 : 0;
    else scoreAdj += it.trend === 'up' ? 3 : it.trend === 'down' ? -3 : 0;
  }
  scoreAdj = clamp(scoreAdj, -10, 10);
  return { items, scoreAdj, summary: items.length ? `市場環境調整 ${scoreAdj >= 0 ? '+' : ''}${scoreAdj} 分。` : '市場環境資料不足。' };
}

function computeScore(tech, market, news, assetType) {
  let score = 50;
  const reasons = [];
  const warnings = [];

  if (tech.close > tech.sma20) { score += 6; reasons.push('收盤價站上 20 期均線'); } else { score -= 6; warnings.push('收盤價跌破 20 期均線'); }
  if (tech.sma20 > tech.sma50) { score += 8; reasons.push('20 期均線高於 50 期均線'); } else { score -= 8; warnings.push('20 期均線仍低於 50 期均線'); }
  if (tech.close > tech.sma200) { score += 5; reasons.push('仍在長期均線上方'); } else { score -= 5; warnings.push('位於長期均線下方'); }

  if (tech.rsi14 != null) {
    if (tech.rsi14 >= 70) { score -= 7; warnings.push('RSI 偏高，短線可能過熱'); }
    else if (tech.rsi14 >= 58) { score += 8; reasons.push('RSI 落在偏強區'); }
    else if (tech.rsi14 <= 30) { score -= 4; warnings.push('RSI 偏低，仍需等待止跌確認'); }
    else if (tech.rsi14 < 45) { score -= 4; warnings.push('RSI 動能偏弱'); }
  }

  if (tech.macdHist > 0) { score += 7; reasons.push('MACD 柱狀體為正'); } else { score -= 7; warnings.push('MACD 柱狀體為負'); }
  if (tech.change20dPct > 8) { score += 5; reasons.push('近 20 期動能轉強'); }
  if (tech.change20dPct < -8) { score -= 5; warnings.push('近 20 期跌幅偏大'); }
  if (tech.volumeRatio > 140 && tech.change1dPct > 0) { score += 4; reasons.push('上漲伴隨放量'); }
  if (tech.volumeRatio > 140 && tech.change1dPct < 0) { score -= 4; warnings.push('下跌伴隨放量'); }
  if (tech.atrPct > 6) { score -= 3; warnings.push('波動偏高，部位需保守'); }

  score += market.scoreAdj || 0;

  const newsCount = (news.articles || []).length;
  if (newsCount >= 5) reasons.push(`已抓到 ${newsCount} 則事件新聞供交叉參考`);
  else warnings.push('新聞量較少，事件面信心偏低');

  score = Math.round(clamp(score, 0, 100));
  const recommendationPack = recommendationByScore(score);
  const confidence = Math.round(clamp(44 + Math.abs(score - 50) * 0.72 + (newsCount ? 8 : 0), 35, 90));
  const riskLevel = tech.atrPct > 6 || score < 30 ? '高' : tech.atrPct > 3.5 || score < 45 ? '中' : '低';
  const direction = score >= 72 ? '偏多' : score >= 58 ? '偏多偏震盪' : score >= 45 ? '中性觀望' : score >= 30 ? '偏弱' : '弱勢';
  const actionPlan = recommendationPack.actionPlan;

  return {
    score,
    direction,
    recommendation: recommendationPack.label,
    recommendationTone: recommendationPack.tone,
    confidence,
    riskLevel,
    reasons: reasons.slice(0, 6),
    warnings: warnings.slice(0, 6),
    actionPlan
  };
}

function recommendationByScore(score) {
  if (score >= 82) return { label: '放心買', tone: 'strong-buy', actionPlan: '偏多明確，可考慮分 2~3 批進場；仍要設停損，不要一次重倉。' };
  if (score >= 68) return { label: '可以買', tone: 'buy', actionPlan: '可小到中等部位分批進場，優先等回檔或突破確認，不建議追太急。' };
  if (score >= 56) return { label: '等一下再買', tone: 'wait-buy', actionPlan: '結構尚可，但更適合等回檔、等量能確認或等突破後再布局。' };
  if (score >= 45) return { label: '先等等', tone: 'neutral', actionPlan: '先觀察，不急著進場；等技術指標轉強或事件落地後再判斷。' };
  if (score >= 30) return { label: '先不要', tone: 'avoid', actionPlan: '型態偏弱，暫不建議新開倉；若持有，應重新檢查停損和風險。' };
  return { label: '不要碰', tone: 'danger', actionPlan: '弱勢明顯，除非是高風險短打策略，否則建議避開。' };
}

async function callGemini(pack, env) {
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const prompt = `你是繁體中文投資研究助理。根據真實行情、技術指標、新聞標題、來源與市場環境，做出簡潔但實用的整理。\n\n請務必輸出：\n1. 一句結論（可以自然帶入 ${pack.scorePack.recommendation}）\n2. 技術面重點\n3. 新聞/人物/事件面重點\n4. 風險提醒\n5. 參考操作計畫（只能談分批、等待、停損，不可保證獲利或鼓勵梭哈）\n\n資料：${JSON.stringify({ ticker: pack.rawTicker, assetType: pack.assetType, source: pack.prices.source, price: pack.tech.livePrice || pack.tech.close, crossChecks: pack.cross, priceCheck: pack.prices.liveQuote, technicals: pack.tech, market: pack.market, news: pack.news.articles.slice(0, 8), scorePack: pack.scorePack }, null, 2)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.35, maxOutputTokens: 1000 }
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Gemini HTTP ${res.status}`);
  return { model, text: data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '' };
}
