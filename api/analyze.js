export const config = { runtime: 'edge' };

export default async function handler(req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

  const p      = new URL(req.url).searchParams;
  const symbol = p.get('symbol');
  const name   = p.get('name')   || symbol;
  const sector = p.get('sector') || '';

  if (!symbol) return err('symbol is required', 400, cors);

  // ── Quick env check — fail fast with a readable message ─────────────────
  const TD_KEY       = process.env.TWELVE_DATA_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!TD_KEY)       return err('TWELVE_DATA_KEY env var is not set in Vercel', 500, cors);
  if (!ANTHROPIC_KEY) return err('ANTHROPIC_API_KEY env var is not set in Vercel', 500, cors);

  try {
    // ── 1. Twelve Data: time series + quote (parallel, 10s each) ────────────
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), 10000);

    let tsData, quoteData;
    try {
      const [tsRes, qRes] = await Promise.all([
        fetch(`https://api.twelvedata.com/time_series?symbol=${symbol}&exchange=NSE&interval=1day&outputsize=130&apikey=${TD_KEY}`, { signal: controller.signal }),
        fetch(`https://api.twelvedata.com/quote?symbol=${symbol}&exchange=NSE&apikey=${TD_KEY}`, { signal: controller.signal })
      ]);
      [tsData, quoteData] = await Promise.all([tsRes.json(), qRes.json()]);
    } finally {
      clearTimeout(abort);
    }

    if (tsData.status === 'error')    return err('Twelve Data: ' + tsData.message, 500, cors);
    if (quoteData.status === 'error') return err('Twelve Data quote: ' + quoteData.message, 500, cors);

    // ── 2. Build indicator arrays ─────────────────────────────────────────
    const rows    = (tsData.values || []).slice().reverse(); // oldest → newest
    const closes  = rows.map(r => parseFloat(r.close)).filter(v => !isNaN(v));
    const volumes = rows.map(r => parseFloat(r.volume)).filter(v => !isNaN(v));

    if (closes.length < 14) return err(`Only ${closes.length} days of data — need 14+`, 500, cors);

    const price     = parseFloat(quoteData.close)                    || closes.at(-1);
    const high52w   = parseFloat(quoteData.fifty_two_week?.high)     || Math.max(...closes);
    const low52w    = parseFloat(quoteData.fifty_two_week?.low)      || Math.min(...closes);
    const prevClose = parseFloat(quoteData.previous_close)           || closes.at(-2);
    const changePct = ((price - prevClose) / prevClose) * 100;

    const sma20     = avg(closes.slice(-20));
    const sma50     = closes.length >= 50 ? avg(closes.slice(-50)) : null;
    const macd      = calcEMA(closes, 12) - calcEMA(closes, 26);
    const rsi       = calcRSI(closes);
    const change30d = closes.length >= 30
      ? ((closes.at(-1) - closes.at(-30)) / closes.at(-30)) * 100 : null;
    const avgVol20  = avg(volumes.slice(-20));
    const volRatio  = avgVol20 > 0 ? (volumes.at(-1) || avgVol20) / avgVol20 : 1;

    // ── 3. Claude — 15s timeout ───────────────────────────────────────────
    const smaLine = (v, l) => v
      ? `- ${l}: Rs.${v.toFixed(2)} (price ${price > v ? 'ABOVE' : 'BELOW'} by ${Math.abs(((price/v)-1)*100).toFixed(1)}%)`
      : '';

    const prompt = `You are a professional technical analyst for Indian equity markets.
Analyse ONLY technical data for ${name} (NSE: ${symbol}${sector ? ', Sector: ' + sector : ''}).
No fundamentals, no macro — pure price/volume/momentum analysis.

LIVE NSE DATA:
- Price: Rs.${price.toFixed(2)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}% today)
${smaLine(sma20, '20-day SMA')}
${smaLine(sma50, '50-day SMA')}
- RSI(14): ${rsi.toFixed(1)} — ${rsi > 70 ? 'OVERBOUGHT' : rsi < 30 ? 'OVERSOLD' : 'neutral'}
- MACD: ${macd.toFixed(2)} (${macd > 0 ? 'bullish' : 'bearish'})
- 30d return: ${change30d !== null ? change30d.toFixed(2) + '%' : 'N/A'}
- 52w range: Rs.${low52w.toFixed(2)} – Rs.${high52w.toFixed(2)}
- From 52w high: ${((price/high52w-1)*100).toFixed(1)}%
- From 52w low: +${((price/low52w-1)*100).toFixed(1)}%
- Volume vs 20d avg: ${(volRatio*100).toFixed(0)}%

Reply ONLY with valid JSON, no markdown:
{"signal":"BUY_MORE","confidence":"HIGH","summary":"...","technicalPoints":["...","...","..."],"support":"Rs.XXX - reason","resistance":"Rs.XXX - reason","outlook":"..."}
signal: BUY_MORE | HOLD | REVIEW
confidence: HIGH | MEDIUM | LOW`;

    const c2 = new AbortController();
    const t2 = setTimeout(() => c2.abort(), 15000);
    let claudeRes;
    try {
      claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001', // faster + cheaper than Sonnet for this
          max_tokens: 500,
          messages: [{ role: 'user', content: prompt }]
        }),
        signal: c2.signal
      });
    } finally {
      clearTimeout(t2);
    }

    if (!claudeRes.ok) return err('Claude: ' + (await claudeRes.text()).slice(0, 200), 500, cors);

    const cd  = await claudeRes.json();
    const raw = cd.content[0].text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const analysis = JSON.parse(raw);

    return ok({
      symbol: symbol.toUpperCase(), name,
      indicators: {
        price: +price.toFixed(2), changePct: +changePct.toFixed(2),
        sma20: +sma20.toFixed(2), sma50: sma50 ? +sma50.toFixed(2) : null,
        rsi: +rsi.toFixed(1), macd: +macd.toFixed(2),
        change30d: change30d !== null ? +change30d.toFixed(2) : null,
        high52w: +high52w.toFixed(2), low52w: +low52w.toFixed(2),
        volRatio: +volRatio.toFixed(2)
      },
      analysis,
      fetchedAt: new Date().toISOString()
    }, cors);

  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Request timed out — retry' : e.message;
    return err(msg, 500, cors);
  }
}

const ok  = (d, h) => new Response(JSON.stringify(d), { status: 200, headers: { 'Content-Type': 'application/json', ...h } });
const err = (m, s, h) => new Response(JSON.stringify({ error: m }), { status: s, headers: { 'Content-Type': 'application/json', ...h } });

function avg(a) { const v = a.filter(x => !isNaN(x)); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : 0; }
function calcEMA(c, p) { const k=2/(p+1); let e=avg(c.slice(0,p)); for(let i=p;i<c.length;i++) e=c[i]*k+e*(1-k); return e; }
function calcRSI(c, p=14) {
  if (c.length < p+1) return 50;
  let g=0, l=0;
  for (let i=c.length-p; i<c.length; i++) { const d=c[i]-c[i-1]; if(d>0) g+=d; else l-=d; }
  return 100 - 100/(1+(g/p)/((l/p)||0.001));
}
