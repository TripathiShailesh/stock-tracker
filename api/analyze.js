// Edge Runtime — 30s timeout on Vercel Hobby (vs 10s for serverless)
export const config = { runtime: 'edge' };

export default async function handler(req) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol');
  const name   = searchParams.get('name')   || symbol;
  const sector = searchParams.get('sector') || '';

  if (!symbol) {
    return json({ error: 'symbol is required' }, 400, corsHeaders);
  }

  try {
    const tdKey = process.env.TWELVE_DATA_KEY;
    if (!tdKey) throw new Error('TWELVE_DATA_KEY env var not set in Vercel');

    // ── 1. Fetch 6 months daily OHLCV + live quote from Twelve Data ─────────
    const [tsRes, quoteRes] = await Promise.all([
      fetch(
        `https://api.twelvedata.com/time_series?symbol=${symbol}&exchange=NSE&interval=1day&outputsize=130&apikey=${tdKey}`
      ),
      fetch(
        `https://api.twelvedata.com/quote?symbol=${symbol}&exchange=NSE&apikey=${tdKey}`
      )
    ]);

    const [tsData, quoteData] = await Promise.all([tsRes.json(), quoteRes.json()]);

    if (tsData.status === 'error') {
      throw new Error(`Twelve Data: ${tsData.message || 'symbol not found on NSE'}`);
    }

    // Twelve Data returns newest-first — reverse for chronological order
    const rows    = (tsData.values || []).slice().reverse();
    const closes  = rows.map(r => parseFloat(r.close)).filter(v => !isNaN(v));
    const volumes = rows.map(r => parseFloat(r.volume)).filter(v => !isNaN(v));

    if (closes.length < 14) {
      throw new Error(`Only ${closes.length} data points — need at least 14`);
    }

    const price     = parseFloat(quoteData.close)         || closes[closes.length - 1];
    const high52w   = parseFloat(quoteData.fifty_two_week?.high)  || Math.max(...closes);
    const low52w    = parseFloat(quoteData.fifty_two_week?.low)   || Math.min(...closes);
    const prevClose = parseFloat(quoteData.previous_close) || closes[closes.length - 2];
    const changePct = ((price - prevClose) / prevClose) * 100;

    // ── 2. Compute indicators ────────────────────────────────────────────────
    const sma20     = avg(closes.slice(-20));
    const sma50     = closes.length >= 50 ? avg(closes.slice(-50)) : null;
    const ema12     = calcEMA(closes, 12);
    const ema26     = calcEMA(closes, 26);
    const macd      = ema12 - ema26;
    const rsi       = calcRSI(closes);
    const change30d = closes.length >= 30
      ? ((closes[closes.length-1] - closes[closes.length-30]) / closes[closes.length-30]) * 100
      : null;
    const avgVol20  = avg(volumes.slice(-20));
    const lastVol   = volumes[volumes.length-1] || avgVol20;
    const volRatio  = avgVol20 > 0 ? lastVol / avgVol20 : 1;

    // ── 3. Call Claude ───────────────────────────────────────────────────────
    const smaLine = (val, label) => val
      ? `- ${label}: Rs.${val.toFixed(2)} (price ${price > val ? 'ABOVE' : 'BELOW'} by ${Math.abs(((price/val)-1)*100).toFixed(1)}%)`
      : '';

    const prompt = `You are a professional technical analyst for Indian equity markets.
Analyse ONLY the following technical data for ${name} (NSE: ${symbol}${sector ? ', Sector: ' + sector : ''}).
Pure technical analysis only — no fundamentals, no macro.

LIVE DATA (from Twelve Data / NSE):
- Current Price: Rs.${price.toFixed(2)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}% today)
${smaLine(sma20, '20-day SMA')}
${smaLine(sma50, '50-day SMA')}
- RSI (14): ${rsi.toFixed(1)} — ${rsi > 70 ? 'OVERBOUGHT' : rsi < 30 ? 'OVERSOLD' : 'neutral zone'}
- MACD: ${macd.toFixed(2)} (${macd > 0 ? 'bullish momentum' : 'bearish momentum'})
- 30-day return: ${change30d !== null ? change30d.toFixed(2) + '%' : 'N/A'}
- 52-week range: Rs.${low52w.toFixed(2)} – Rs.${high52w.toFixed(2)}
- Distance from 52w high: ${((price/high52w-1)*100).toFixed(1)}%
- Distance from 52w low: +${((price/low52w-1)*100).toFixed(1)}%
- Volume vs 20d avg: ${(volRatio*100).toFixed(0)}%

Reply with ONLY valid JSON — no markdown, no extra text:
{
  "signal": "BUY_MORE",
  "confidence": "HIGH",
  "summary": "2-3 sentence technical overview",
  "technicalPoints": ["point 1", "point 2", "point 3"],
  "support": "Rs.XXX - brief reason",
  "resistance": "Rs.XXX - brief reason",
  "outlook": "1-2 sentence short-term outlook (2-4 weeks)"
}
signal must be exactly: BUY_MORE, HOLD, or REVIEW
confidence must be exactly: HIGH, MEDIUM, or LOW`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
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
    });

    if (!claudeRes.ok) {
      const t = await claudeRes.text();
      throw new Error('Claude API error: ' + t.slice(0, 200));
    }

    const claudeData = await claudeRes.json();
    const raw = claudeData.content[0].text.trim()
      .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const analysis = JSON.parse(raw);

    return json({
      symbol:     symbol.toUpperCase(),
      name,
      indicators: {
        price:     +price.toFixed(2),
        changePct: +changePct.toFixed(2),
        sma20:     +sma20.toFixed(2),
        sma50:     sma50 ? +sma50.toFixed(2) : null,
        rsi:       +rsi.toFixed(1),
        macd:      +macd.toFixed(2),
        change30d: change30d !== null ? +change30d.toFixed(2) : null,
        high52w:   +high52w.toFixed(2),
        low52w:    +low52w.toFixed(2),
        volRatio:  +volRatio.toFixed(2),
      },
      analysis,
      fetchedAt: new Date().toISOString()
    }, 200, corsHeaders);

  } catch (err) {
    console.error('[analyze edge]', err.message);
    return json({ error: err.message }, 500, corsHeaders);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}
function avg(arr) {
  const v = arr.filter(x => !isNaN(x) && x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}
function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = avg(closes.slice(0, period));
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}
function calcRSI(closes, period) {
  period = period || 14;
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  const start = closes.length - period;
  for (let i = start; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs = (gains / period) / ((losses / period) || 0.001);
  return 100 - 100 / (1 + rs);
}
