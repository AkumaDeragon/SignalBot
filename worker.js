// Cloudflare Worker for SignalBot Real
// Deploy this file to Cloudflare Workers and set optional secret GEMINI_API_KEY.
// Routes:
//   GET  /api/health
//   POST /api/analyze  { ticker, assetType: 'stock'|'crypto', interval: '1d', range: '6mo', useAI: true }

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization',
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/health') return json({ ok: true, service: 'signalbot-real', time: new Date().toISOString() });
      if (url.pathname === '/api/analyze' && request.method === 'POST') {
        const body = await request.json();
        const result = await analyze(body, env);
        return json(result);
      }
      return json({ error: 'not_found' }, 404);
    } catch (err) {
      return json({ error: 'worker_error', message: String(err && err.message ? err.message : err) }, 500);
    }
  }
};

function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: CORS }); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function avg(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0) / arr.length : null; }
function pct(a, b) { return b ? ((a - b) / b) * 100 : null; }
function last(arr) { return arr[arr.length - 1]; }

async function analyze(input, env) {
  const assetType = input.assetType === 'crypto' ? 'crypto' : 'stock';
  const ticker = normalizeTicker(String(input.ticker || '').trim().toUpperCase(), assetType);
  const interval = input.interval || '1d';
  const range = input.range || '6mo';

  const [pricePack, newsPack, marketPack] = await Promise.allSettled([
    fetchPriceSeries(ticker, assetType, interval, range),
    fetchNews(ticker),
    fetchMarketContext(assetType)
  ]);

  if (pricePack.status !== 'fulfilled' || !pricePack.value.candles || pricePack.value.candles.length < 50) {
    throw new Error('行情資料不足，可能是代號錯誤、資料源暫時不可用，或此標的不支援。');
  }

  const prices = pricePack.value;
  const tech = computeTechnicals(prices.candles);
  const market = marketPack.status === 'fulfilled' ? marketPack.value : { items: [], scoreAdj: 0, summary: '市場環境資料暫時不可用。' };
  const news = newsPack.status === 'fulfilled' ? newsPack.value : { articles: [], summary: '新聞資料暫時不可用。' };
  const scorePack = computeScore(tech, market, news, assetType);

  let ai = null;
  if (input.useAI !== false && env && env.GEMINI_API_KEY) {
    ai = await callGemini({ ticker, assetType, prices, tech, market, news, scorePack }, env).catch(err => ({ error: String(err.message || err) }));
  }

  return {
    ticker,
    assetType,
    generatedAt: new Date().toISOString(),
    source: prices.source,
    score: scorePack.score,
    direction: scorePack.direction,
    confidence: scorePack.confidence,
    riskLevel: scorePack.riskLevel,
    reasons: scorePack.reasons,
    warnings: scorePack.warnings,
    price: prices.candles[prices.candles.length - 1].close,
    change1dPct: tech.change1dPct,
    candles: prices.candles.slice(-180),
    technicals: tech,
    market,
    news,
    ai
  };
}

function normalizeTicker(raw, assetType) {
  if (!raw) return assetType === 'crypto' ? 'BTCUSDT' : 'AAPL';
  if (assetType === 'crypto') {
    let s = raw.replace(/[-_\/]/g, '').replace('USDT', '').replace('USD', '');
    return `${s}USDT`;
  }
  if (/^\d{4}$/.test(raw)) return `${raw}.TW`;
  if (/^\d{4}\.TW$/.test(raw)) return raw;
  return raw;
}

async function fetchPriceSeries(ticker, assetType, interval, range) {
  if (assetType === 'crypto') return fetchBinanceKlines(ticker, interval);
  return fetchYahooChart(ticker, interval, range);
}

async function fetchBinanceKlines(symbol, interval = '1d') {
  const safeInterval = ['15m','1h','4h','1d','1w'].includes(interval) ? interval : '1d';
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${safeInterval}&limit=240`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
  const arr = await res.json();
  const candles = arr.map(k => ({
    time: new Date(k[0]).toISOString().slice(0,10),
    open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5])
  })).filter(c => Number.isFinite(c.close));
  return { source: 'Binance Spot Klines', candles };
}

async function fetchYahooChart(symbol, interval = '1d', range = '6mo') {
  const safeInterval = ['1d','1wk','1mo'].includes(interval) ? interval : '1d';
  const safeRange = ['1mo','3mo','6mo','1y','2y'].includes(range) ? range : '6mo';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${safeRange}&interval=${safeInterval}&includePrePost=false&events=div%2Csplits`;
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'SignalBot/1.0' } });
  if (!res.ok) throw new Error(`Yahoo chart HTTP ${res.status}`);
  const data = await res.json();
  const r = data.chart && data.chart.result && data.chart.result[0];
  if (!r || !r.timestamp || !r.indicators || !r.indicators.quote) throw new Error('Yahoo chart malformed');
  const q = r.indicators.quote[0];
  const candles = r.timestamp.map((ts, i) => ({
    time: new Date(ts * 1000).toISOString().slice(0,10),
    open: Number(q.open[i]), high: Number(q.high[i]), low: Number(q.low[i]), close: Number(q.close[i]), volume: Number(q.volume[i] || 0)
  })).filter(c => Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close));
  return { source: 'Yahoo Finance chart endpoint', candles };
}

function computeTechnicals(candles) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const vols = candles.map(c => c.volume || 0);
  const close = last(closes);
  const prevClose = closes[closes.length - 2] || close;
  const sma20 = sma(closes, 20), sma50 = sma(closes, 50), sma200 = sma(closes, Math.min(200, closes.length));
  const ema12 = ema(closes, 12), ema26 = ema(closes, 26);
  const macdLineSeries = emaSeries(closes, 12).map((v,i) => v - emaSeries(closes, 26)[i]);
  const macdSignalSeries = emaSeries(macdLineSeries.filter(Number.isFinite), 9);
  const macd = last(macdLineSeries);
  const macdSignal = last(macdSignalSeries);
  const macdHist = macd - macdSignal;
  const rsi14 = rsi(closes, 14);
  const bb = bollinger(closes, 20, 2);
  const atr14 = atr(candles, 14);
  const volume20 = avg(vols.slice(-20));
  const volumeRatio = volume20 ? (last(vols) / volume20) * 100 : null;
  const high20 = Math.max(...highs.slice(-20));
  const low20 = Math.min(...lows.slice(-20));
  const change1dPct = pct(close, prevClose);
  const change20dPct = closes.length > 21 ? pct(close, closes[closes.length - 21]) : null;
  const bbPosition = bb.upper !== bb.lower ? ((close - bb.lower) / (bb.upper - bb.lower)) * 100 : null;

  return {
    close, prevClose, change1dPct, change20dPct,
    sma20, sma50, sma200, ema12, ema26,
    rsi14, macd, macdSignal, macdHist,
    bollinger: bb, bbPosition,
    atr14, atrPct: atr14 ? atr14 / close * 100 : null,
    volume: last(vols), volume20, volumeRatio,
    high20, low20,
    trend: close > sma20 && sma20 > sma50 ? 'up' : close < sma20 && sma20 < sma50 ? 'down' : 'mixed'
  };
}

function sma(values, period) { const slice = values.slice(-period); return avg(slice); }
function ema(values, period) { return last(emaSeries(values, period)); }
function emaSeries(values, period) {
  const k = 2 / (period + 1);
  let out = [];
  let prev = values[0];
  for (const v of values) { prev = prev == null ? v : v * k + prev * (1 - k); out.push(prev); }
  return out;
}
function rsi(values, period) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i-1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}
function bollinger(values, period, mult) {
  const slice = values.slice(-period);
  const mean = avg(slice);
  const variance = avg(slice.map(v => Math.pow(v - mean, 2)));
  const sd = Math.sqrt(variance || 0);
  return { middle: mean, upper: mean + mult * sd, lower: mean - mult * sd, widthPct: mean ? ((mult * 2 * sd) / mean) * 100 : null };
}
function atr(candles, period) {
  if (candles.length <= period) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i-1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return avg(trs.slice(-period));
}

async function fetchNews(ticker) {
  const clean = ticker.replace('.TW','').replace('USDT','').replace(/[^A-Z0-9.]/g, '');
  const query = `${clean} finance OR stock OR crypto OR earnings OR market`;
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&format=json&maxrecords=12&sort=hybridrel&timespan=7d`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GDELT HTTP ${res.status}`);
  const data = await res.json();
  const articles = (data.articles || []).slice(0, 12).map(a => ({
    title: a.title || '', url: a.url || '', domain: a.domain || '', seendate: a.seendate || '', language: a.language || '', sourceCountry: a.sourcecountry || ''
  })).filter(a => a.title && a.url);
  return { summary: articles.length ? `近 7 天找到 ${articles.length} 則相關新聞。` : '近 7 天未找到足夠新聞。', articles };
}

async function fetchMarketContext(assetType) {
  const symbols = assetType === 'crypto' ? ['BTCUSDT','ETHUSDT'] : ['^GSPC','^IXIC','^VIX','^TNX'];
  const items = [];
  for (const s of symbols) {
    try {
      const p = assetType === 'crypto' ? await fetchBinanceKlines(s, '1d') : await fetchYahooChart(s, '1d', '3mo');
      const t = computeTechnicals(p.candles);
      items.push({ symbol: s, close: t.close, change1dPct: t.change1dPct, change20dPct: t.change20dPct, trend: t.trend });
    } catch (_) {}
  }
  let scoreAdj = 0;
  for (const it of items) {
    if (it.symbol === '^VIX') scoreAdj += it.change20dPct > 10 ? -5 : it.change20dPct < -10 ? 4 : 0;
    else scoreAdj += it.trend === 'up' ? 3 : it.trend === 'down' ? -3 : 0;
  }
  scoreAdj = clamp(scoreAdj, -10, 10);
  const summary = items.length ? `市場環境調整 ${scoreAdj >= 0 ? '+' : ''}${scoreAdj} 分。` : '市場環境資料不足。';
  return { items, scoreAdj, summary };
}

function computeScore(tech, market, news, assetType) {
  let score = 50;
  const reasons = [];
  const warnings = [];

  if (tech.close > tech.sma20) { score += 6; reasons.push('收盤價高於 20 日均線'); } else { score -= 6; reasons.push('收盤價低於 20 日均線'); }
  if (tech.sma20 > tech.sma50) { score += 8; reasons.push('20 日均線高於 50 日均線，趨勢偏多'); } else { score -= 8; reasons.push('20 日均線低於 50 日均線，趨勢偏弱'); }
  if (tech.close > tech.sma200) score += 6; else score -= 6;

  if (tech.rsi14 != null) {
    if (tech.rsi14 >= 70) { score -= 8; warnings.push('RSI 偏高，短線可能過熱'); }
    else if (tech.rsi14 >= 55) { score += 8; reasons.push('RSI 位於強勢區'); }
    else if (tech.rsi14 <= 30) { score -= 4; warnings.push('RSI 偏低，代表弱勢或超賣，需等反轉確認'); }
    else if (tech.rsi14 < 45) score -= 5;
  }

  if (tech.macdHist > 0) { score += 7; reasons.push('MACD 柱狀體為正'); } else { score -= 7; reasons.push('MACD 柱狀體為負'); }
  if (tech.change20dPct > 8) score += 5;
  if (tech.change20dPct < -8) score -= 5;
  if (tech.volumeRatio > 140 && tech.change1dPct > 0) { score += 5; reasons.push('上漲伴隨放量'); }
  if (tech.volumeRatio > 140 && tech.change1dPct < 0) { score -= 5; warnings.push('下跌伴隨放量'); }
  if (tech.atrPct > (assetType === 'crypto' ? 8 : 5)) { score -= 4; warnings.push('波動率偏高，部位需要更保守'); }
  if (tech.bbPosition > 90) warnings.push('價格接近布林上軌，追高風險增加');
  if (tech.bbPosition < 10) warnings.push('價格接近布林下軌，需確認是否止跌');

  score += market.scoreAdj || 0;
  const newsCount = news.articles ? news.articles.length : 0;
  if (newsCount >= 5) reasons.push('近期新聞量足夠，可納入事件面觀察');
  else warnings.push('新聞資料較少，事件面判斷信心較低');

  score = Math.round(clamp(score, 0, 100));
  let direction = '觀望';
  if (score >= 72) direction = '偏多 / 可列入觀察買點';
  else if (score >= 60) direction = '偏多但等回測';
  else if (score >= 45) direction = '中性觀望';
  else if (score >= 32) direction = '偏弱 / 降低風險';
  else direction = '弱勢 / 避免追多';

  const confidence = clamp(Math.round(55 + Math.min(25, newsCount * 2) + (market.items && market.items.length ? 10 : 0)), 0, 90);
  const riskLevel = tech.atrPct > (assetType === 'crypto' ? 8 : 5) ? '高' : tech.atrPct > (assetType === 'crypto' ? 4 : 2.5) ? '中' : '低至中';
  return { score, direction, confidence, riskLevel, reasons: reasons.slice(0, 8), warnings: warnings.slice(0, 8) };
}

async function callGemini(ctx, env) {
  const compact = {
    ticker: ctx.ticker,
    assetType: ctx.assetType,
    score: ctx.scorePack,
    price: ctx.prices.candles[ctx.prices.candles.length - 1],
    technicals: ctx.tech,
    market: ctx.market,
    news: ctx.news.articles.slice(0, 8)
  };

  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const system = '你是謹慎的金融市場分析助手。用繁體中文。不可保證獲利，不可叫使用者重倉、借錢投資或把分析當成唯一依據。只輸出 JSON，格式為 {"summary":"...","peopleAndEvents":["..."],"bullCase":["..."],"bearCase":["..."],"plan":"..."}。';
  const prompt = `${system}\n\n以下是真實行情、技術指標、市場環境與新聞資料，請整理成可參考但保守的投資研究摘要：\n${JSON.stringify(compact)}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.25,
        maxOutputTokens: 1000,
        responseMimeType: 'application/json'
      }
    })
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`Gemini HTTP ${res.status}${msg ? ': ' + msg.slice(0, 180) : ''}`);
  }
  const data = await res.json();
  const text = (data.candidates || [])
    .flatMap(c => (c.content && c.content.parts) || [])
    .map(p => p.text || '')
    .join('')
    .replace(/```json|```/g, '')
    .trim();
  try { return JSON.parse(text); } catch (_) { return { summary: text }; }
}
