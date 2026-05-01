export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, name, sector } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol is required' });

  const YF_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com/',
    'Origin': 'https://finance.yahoo.com'
  };

  try {
    // ── Step 1: get a crumb + session cookie from Yahoo Finance ─────────────
    const { crumb, cookie } = await getYahooCrumb(YF_HEADERS);

    const ySymbol = symbol.replace('&', '%26') + '.NS';
    const authHeaders = { ...YF_HEADERS, 'Cookie': cookie };

    // ── Step 2: fetch chart + quote in parallel with 8s timeout ─────────────
    const [chartRes, quoteRes] = await Promise.all([
      fetchWithTimeout(
        `https://query1.finance.yahoo.com/v8/finance/chart/${ySymbol}?interval=1d&range=6mo&crumb=${crumb}`,
        { headers: authHeaders }, 8000
      ),
      fetchWithTimeout(
        `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ySymbol}&crumb=${crumb}`,
        { headers: authHeaders }, 8000
      )
    ]);

    const chartData = await chartRes.json();
    const quoteData = await quoteRes.json();

    const chart = chartData?.chart?.result?.[0];
    const quote = quoteData?.quoteResponse?.result?.[0];

    if (!chart) {
      const errMsg = chartData?.chart?.error?.description || `No data found for ${symbol}.NS`;
      throw new Error(errMsg);
    }

    // ── Step 3: extract indicators ───────────────────────────────────────────
    const rawCloses  = chart.indicators.quote[0].close  || [];
    const rawVolumes = chart.indicators.quote[0].volume || [];
    const closes  = rawCloses.filter(c => c != null);
    const volumes = rawVolumes.filter(v => v != null);

    if (closes.length < 14) throw new Error('Not enough price history (need 14+ days)');

    const currentPrice = quote?.regularMarketPrice           ?? closes.at(-1);
    const high52w      = quote?.fiftyTwoWeekHigh             ?? Math.max(...closes);
    const low52w       = quote?.fiftyTwoWeekLow              ?? Math.min(...closes);
    const prevClose    = quote?.regularMarketPreviousClose   ?? closes.at(-2);
    const changePct    = ((currentPrice - prevClose) / prevClose) * 100;

    const sma20    = avg(closes.slice(-20));
    const sma50    = closes.length >= 50 ? avg(closes.slice(-50)) : null;
    const ema12    = calcEMA(closes, 12);
    const ema26    = calcEMA(closes, 26);
    const macd     = ema12 - ema26;
    const rsi      = calcRSI(closes);
    const change30d = closes.length >= 30
      ? ((closes.at(-1) - closes.at(-30)) / closes.at(-30)) * 100
      : null;

    const avgVol20 = avg(volumes.slice(-20));
    const volRatio = avgVol20 > 0 ? (volumes.at(-1) ?? avgVol20) / avgVol20 : 1;

    // ── Step 4: call Claude with 15s timeout ─────────────────────────────────
    const smaLine = (val, label) => val
      ? `- ${label}: ₹${val.toFixed(2)} (price ${currentPrice > val ? 'ABOVE' : 'BELOW'} by ${Math.abs(((currentPrice / val) - 1) * 100).toFixed(1)}%)`
      : '';

    const prompt = `You are a professional technical analyst for Indian equity markets.
Analyse ONLY the technical data for ${name || symbol} (NSE: ${symbol}${sector ? ', Sector: ' + sector : ''}).
Do NOT discuss fundamentals or macro — pure price/volume/momentum analysis only.

LIVE TECHNICAL DATA:
- Current Price: ₹${currentPrice.toFixed(2)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}% today)
${smaLine(sma20, '20-day SMA')}
${smaLine(sma50, '50-day SMA')}
- RSI (14): ${rsi.toFixed(1)} — ${rsi > 70 ? 'OVERBOUGHT' : rsi < 30 ? 'OVERSOLD' : 'neutral zone'}
- MACD: ${macd.toFixed(2)} (${macd > 0 ? 'bullish momentum' : 'bearish momentum'})
- 30-day return: ${change30d !== null ? change30d.toFixed(2) + '%' : 'N/A'}
- 52-week range: ₹${low52w.toFixed(2)} – ₹${high52w.toFixed(2)}
- % from 52w high: ${((currentPrice / high52w - 1) * 100).toFixed(1)}%
- % from 52w low: +${((currentPrice / low52w - 1) * 100).toFixed(1)}%
- Volume vs 20d avg: ${(volRatio * 100).toFixed(0)}%

Respond with ONLY valid JSON (no markdown, no preamble):
{
  "signal": "BUY_MORE" | "HOLD" | "REVIEW",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "summary": "2-3 sentence technical overview",
  "technicalPoints": ["point 1", "point 2", "point 3"],
  "support": "₹XXX — brief reason",
  "resistance": "₹XXX — brief reason",
  "outlook": "Short-term outlook (2–4 weeks) in 1–2 sentences"
}`;

    const claudeRes = await fetchWithTimeout(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 600,
          messages: [{ role: 'user', content: prompt }]
        })
      },
      15000  // 15s for Claude
    );

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      throw new Error('Claude API error: ' + err.slice(0, 200));
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content[0].text.trim()
      .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const analysis = JSON.parse(rawText);

    return res.status(200).json({
      symbol:    symbol.toUpperCase(),
      name:      name || symbol,
      indicators: {
        price:      +currentPrice.toFixed(2),
        changePct:  +changePct.toFixed(2),
        sma20:      +sma20.toFixed(2),
        sma50:      sma50 ? +sma50.toFixed(2) : null,
        rsi:        +rsi.toFixed(1),
        macd:       +macd.toFixed(2),
        change30d:  change30d !== null ? +change30d.toFixed(2) : null,
        high52w:    +high52w.toFixed(2),
        low52w:     +low52w.toFixed(2),
        volRatio:   +volRatio.toFixed(2),
      },
      analysis,
      fetchedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('[analyze] error:', err.message);
    const status = err.message.includes('timed out') ? 504 : 500;
    return res.status(status).json({ error: err.message });
  }
}

// ── Yahoo Finance crumb (required since 2024) ────────────────────────────────
async function getYahooCrumb(headers) {
  // 1. Hit the consent/main page to get a session cookie
  const pageRes = await fetchWithTimeout(
    'https://fc.yahoo.com',
    { headers },
    6000
  );
  const cookie = pageRes.headers.get('set-cookie') || '';

  // 2. Exchange the cookie for a crumb
  const crumbRes = await fetchWithTimeout(
    'https://query1.finance.yahoo.com/v1/test/getcrumb',
    { headers: { ...headers, Cookie: cookie } },
    6000
  );
  const crumb = await crumbRes.text();

  if (!crumb || crumb.includes('error') || crumb.length > 20) {
    // Fallback: try without crumb (older endpoints still work sometimes)
    return { crumb: '', cookie: '' };
  }
  return { crumb: encodeURIComponent(crumb.trim()), cookie };
}

// ── fetch with AbortController timeout ──────────────────────────────────────
async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error(`Request timed out after ${ms / 1000}s`);
    throw err;
  }
}

// ── Technical indicator helpers ──────────────────────────────────────────────
function avg(arr) {
  const v = arr.filter(x => x != null);
  return v.reduce((a, b) => a + b, 0) / v.length;
}
function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = avg(closes.slice(0, period));
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  const start = closes.length - period;
  for (let i = start; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs = (gains / period) / ((losses / period) || 0.001);
  return 100 - 100 / (1 + rs);
}
