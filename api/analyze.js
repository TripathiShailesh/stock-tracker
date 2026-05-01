// CommonJS — do NOT add "type":"module" to package.json
const yahooFinance = require('yahoo-finance2').default;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, name, sector } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol is required' });

  try {
    // NSE suffix — M&M needs hyphen not ampersand
    const ySymbol = symbol.replace('&', '-') + '.NS';

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    // Fetch quote + historical chart in parallel
    const [quote, chart] = await Promise.all([
      yahooFinance.quote(ySymbol),
      yahooFinance.chart(ySymbol, { period1: sixMonthsAgo, interval: '1d' })
    ]);

    const closes  = (chart.quotes || []).map(q => q.close).filter(c => c != null);
    const volumes = (chart.quotes || []).map(q => q.volume).filter(v => v != null);

    if (closes.length < 14) {
      throw new Error(`Only ${closes.length} days of data for ${symbol} — need at least 14`);
    }

    const price     = quote.regularMarketPrice         || closes[closes.length - 1];
    const high52w   = quote.fiftyTwoWeekHigh           || Math.max.apply(null, closes);
    const low52w    = quote.fiftyTwoWeekLow            || Math.min.apply(null, closes);
    const prevClose = quote.regularMarketPreviousClose || closes[closes.length - 2];
    const changePct = ((price - prevClose) / prevClose) * 100;

    // ── Indicators ────────────────────────────────────────────────────────
    const sma20     = avg(closes.slice(-20));
    const sma50     = closes.length >= 50 ? avg(closes.slice(-50)) : null;
    const ema12     = calcEMA(closes, 12);
    const ema26     = calcEMA(closes, 26);
    const macd      = ema12 - ema26;
    const rsi       = calcRSI(closes);
    const change30d = closes.length >= 30
      ? ((closes[closes.length-1] - closes[closes.length-30]) / closes[closes.length-30]) * 100
      : null;
    const avgVol20 = avg(volumes.slice(-20));
    const lastVol  = volumes[volumes.length - 1] || avgVol20;
    const volRatio = avgVol20 > 0 ? lastVol / avgVol20 : 1;

    // ── Claude prompt ─────────────────────────────────────────────────────
    const smaLine = (val, label) => val
      ? `- ${label}: Rs.${val.toFixed(2)} (price ${price > val ? 'ABOVE' : 'BELOW'} by ${Math.abs(((price/val)-1)*100).toFixed(1)}%)`
      : '';

    const prompt = `You are a professional technical analyst for Indian equity markets.
Analyse ONLY the following technical data for ${name || symbol} (NSE: ${symbol}${sector ? ', Sector: ' + sector : ''}).
Pure technical analysis only — no fundamentals, no macro.

LIVE DATA:
- Current Price: Rs.${price.toFixed(2)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}% today)
${smaLine(sma20, '20-day SMA')}
${smaLine(sma50, '50-day SMA')}
- RSI (14): ${rsi.toFixed(1)} — ${rsi > 70 ? 'OVERBOUGHT' : rsi < 30 ? 'OVERSOLD' : 'neutral'}
- MACD: ${macd.toFixed(2)} (${macd > 0 ? 'bullish' : 'bearish'} momentum)
- 30-day return: ${change30d !== null ? change30d.toFixed(2)+'%' : 'N/A'}
- 52-week range: Rs.${low52w.toFixed(2)} to Rs.${high52w.toFixed(2)}
- Distance from 52w high: ${((price/high52w-1)*100).toFixed(1)}%
- Distance from 52w low: +${((price/low52w-1)*100).toFixed(1)}%
- Volume vs 20d average: ${(volRatio*100).toFixed(0)}%

Reply with ONLY valid JSON, no markdown, no extra text:
{
  "signal": "BUY_MORE",
  "confidence": "HIGH",
  "summary": "2-3 sentence overview",
  "technicalPoints": ["point 1", "point 2", "point 3"],
  "support": "Rs.XXX - reason",
  "resistance": "Rs.XXX - reason",
  "outlook": "1-2 sentence short-term outlook"
}
signal must be exactly one of: BUY_MORE, HOLD, REVIEW
confidence must be exactly one of: HIGH, MEDIUM, LOW`;

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
      throw new Error('Claude error: ' + t.slice(0, 200));
    }

    const claudeJson = await claudeRes.json();
    const raw = claudeJson.content[0].text.trim()
      .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const analysis = JSON.parse(raw);

    return res.status(200).json({
      symbol:    symbol.toUpperCase(),
      name:      name || symbol,
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
        volRatio:  +volRatio.toFixed(2)
      },
      analysis,
      fetchedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('[analyze]', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function avg(arr) {
  const v = arr.filter(x => x != null);
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
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs = (gains / period) / ((losses / period) || 0.001);
  return 100 - 100 / (1 + rs);
}
