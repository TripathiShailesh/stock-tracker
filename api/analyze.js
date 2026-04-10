// api/analyze.js
// Vercel Edge Function — fetches live Yahoo Finance data, calls Claude, returns structured analysis JSON
// Triggered by the frontend whenever a new stock is added or manually refreshed

export const config = { runtime: 'edge' };

// ─── Sector-specific focus points & signal logic ───────────────────────────
const SECTOR_CONFIGS = {
  railways: {
    focusPoints: 'Order book size and visibility (most critical metric), freight vs passenger segment mix, wagon procurement cycles from Indian Railways, Vande Bharat / metro project wins, wheelset supply situation, EBITDA margin trend',
    keyMetricNames: 'orderBook, pe, ebitdaMargin, revenueGrowthYoY, patMargin, debtorDays',
    buySignal: 'P/E below 50x AND order book stable or growing AND no major negative developments',
    sellSignal: 'Order book drops >20% QoQ OR revenue declines 3 consecutive quarters OR major govt railway capex cut',
  },
  banking: {
    focusPoints: 'P/B ratio is the primary valuation metric (not P/E), NIM trend (expanding = good), GNPA and NNPA for asset quality, CASA ratio for low-cost funding, credit growth vs system growth, ROE and ROA',
    keyMetricNames: 'pb, nim, gnpa, nnpa, car, roe, roa, casa',
    buySignal: 'P/B below 2.5x AND GNPA improving or stable AND NIM stable/expanding AND ROE above 14%',
    sellSignal: 'GNPA rising sharply above 4% OR NIM compression over 50bps for 2 quarters OR ROE drops below 10%',
  },
  it: {
    focusPoints: 'Revenue growth YoY (constant currency preferred), EBIT margin trend, deal wins TCV (total contract value) as forward indicator, attrition rate for talent stability, P/E relative to growth rate (PEG ratio), cash generation',
    keyMetricNames: 'revenueGrowthYoY, ebitMargin, dealWins, attrition, pe, cashPerShare',
    buySignal: 'Revenue growth accelerating AND EBIT margin stable/expanding AND deal wins pipeline healthy',
    sellSignal: 'Revenue growth below 5% for 3 quarters OR EBIT margin compression >200bps OR major client concentration loss',
  },
  fmcg: {
    focusPoints: 'Volume growth is the real demand signal (not just value growth which includes price hikes), EBITDA margin expansion/contraction, rural vs urban demand split, distribution reach, premium mix shift, raw material cost headwinds',
    keyMetricNames: 'volumeGrowth, valueGrowth, ebitdaMargin, pe, evEbitda, dividendYield',
    buySignal: 'Volume growth positive AND EBITDA margin expanding AND P/E below 50x for the quality',
    sellSignal: 'Volume growth negative for 2+ quarters OR EBITDA margin below 15% OR major market share loss',
  },
  pharma: {
    focusPoints: 'US business % of revenue (high-value generics), R&D spend as % of revenue (pipeline investment), ANDA approvals/filings count, any FDA warning letters or import alerts, domestic formulations growth, EBITDA margin',
    keyMetricNames: 'rdPercent, usRevPercent, andaApproved, ebitdaMargin, pe, debtEquity',
    buySignal: 'US pipeline healthy AND no FDA issues AND EBITDA margin above 20% AND R&D above 6% of revenue',
    sellSignal: 'FDA warning letter OR US revenue declining >15% YoY OR R&D cuts signal weak pipeline',
  },
  capital_markets: {
    focusPoints: 'AUM growth is the primary driver, active client base growth, market share in broking volumes, revenue mix between broking vs advisory vs asset management, P/E relative to growth, ROE',
    keyMetricNames: 'aumGrowth, aum, activeClients, marketShare, pe, roe',
    buySignal: 'AUM growth above 20% AND market share stable/growing AND ROE above 20%',
    sellSignal: 'AUM declining OR regulatory action on broking practices OR ROE drops below 15%',
  },
  real_estate: {
    focusPoints: 'Pre-sales (bookings) is the most critical metric — leads revenue by 2-3 years, collections efficiency (cash vs bookings), net debt level especially post launches, unsold inventory months, land bank for future growth',
    keyMetricNames: 'preSales, preSalesGrowth, collections, netDebt, landBank, pe',
    buySignal: 'Pre-sales growing YoY AND collections above 80% of bookings AND net debt/equity below 0.5x',
    sellSignal: 'Pre-sales declining for 2 quarters OR collections efficiency deteriorating OR net debt rising sharply',
  },
  auto: {
    focusPoints: 'Volume growth by segment (2W, PV, CV), EV penetration % as transition indicator, EBITDA margin trend, market share shifts, inventory channel days, commodity input cost impact',
    keyMetricNames: 'volumeGrowth, evMix, ebitdaMargin, marketShare, pe, debtEquity',
    buySignal: 'Volume growth positive AND EV transition on track AND EBITDA margin above 10%',
    sellSignal: 'Volume declining for 2 quarters OR market share loss >200bps OR EV ramp-up delayed significantly',
  },
  metals: {
    focusPoints: 'EBITDA per tonne is the core metric (not absolute revenue), net debt/EBITDA for leverage, commodity price sensitivity (LME steel/aluminium/copper), production volume vs capacity utilisation, coking coal cost',
    keyMetricNames: 'ebitdaPerTonne, netDebtEbitda, productionVol, pe, dividendYield, roe',
    buySignal: 'Net debt/EBITDA below 2x AND commodity prices stable/rising AND EBITDA/tonne expanding',
    sellSignal: 'Net debt/EBITDA above 3x OR commodity price crash OR production disruption',
  },
  energy: {
    focusPoints: 'Dividend yield is primary attraction for PSU energy stocks, EV/EBITDA for valuation (capex-heavy, P/E less useful), reserve replacement ratio for upstream, refining margins for downstream, renewable transition capex',
    keyMetricNames: 'dividendYield, evEbitda, roe, netDebt, pe, replacementRatio',
    buySignal: 'Dividend yield above 4% AND debt manageable AND ROE above 12%',
    sellSignal: 'Dividend cut OR major regulatory change in fuel pricing OR debt/equity above 1.5x',
  },
};

// ─── Yahoo Finance data fetcher ─────────────────────────────────────────────
async function fetchYahooData(symbol) {
  const ticker = `${symbol}.NS`;
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=price,financialData,defaultKeyStatistics,recommendationTrend,summaryDetail,earnings`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; stock-tracker/1.0)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const r = data?.quoteSummary?.result?.[0];
    if (!r) throw new Error('No result from Yahoo Finance');

    const trend = r.recommendationTrend?.trend?.[0] || {};
    const totalAnalysts = (trend.strongBuy || 0) + (trend.buy || 0) + (trend.hold || 0) + (trend.sell || 0) + (trend.strongSell || 0);

    // Extract quarterly earnings
    const earningsQ = r.earnings?.earningsChart?.quarterly || [];
    const quarterlyRaw = earningsQ.slice(-4).map(q => ({
      quarter: q.date || '',
      eps_actual: q.actual?.raw || null,
      eps_estimate: q.estimate?.raw || null,
    }));

    return {
      price:              r.price?.regularMarketPrice?.raw || null,
      prevClose:          r.price?.regularMarketPreviousClose?.raw || null,
      changePercent:      r.price?.regularMarketChangePercent?.raw
                            ? parseFloat((r.price.regularMarketChangePercent.raw * 100).toFixed(2))
                            : 0,
      marketCap:          r.price?.marketCap?.raw || null,
      marketCapFmt:       r.price?.marketCap?.fmt || null,
      weekHigh52:         r.summaryDetail?.fiftyTwoWeekHigh?.raw || null,
      weekLow52:          r.summaryDetail?.fiftyTwoWeekLow?.raw || null,
      pe:                 r.summaryDetail?.trailingPE?.raw || null,
      forwardPE:          r.summaryDetail?.forwardPE?.raw || null,
      pb:                 r.defaultKeyStatistics?.priceToBook?.raw || null,
      eps:                r.defaultKeyStatistics?.trailingEps?.raw || null,
      dividendYield:      r.summaryDetail?.dividendYield?.raw
                            ? parseFloat((r.summaryDetail.dividendYield.raw * 100).toFixed(2))
                            : null,
      roe:                r.financialData?.returnOnEquity?.raw
                            ? parseFloat((r.financialData.returnOnEquity.raw * 100).toFixed(1))
                            : null,
      roa:                r.financialData?.returnOnAssets?.raw
                            ? parseFloat((r.financialData.returnOnAssets.raw * 100).toFixed(2))
                            : null,
      revenueGrowth:      r.financialData?.revenueGrowth?.raw
                            ? parseFloat((r.financialData.revenueGrowth.raw * 100).toFixed(1))
                            : null,
      grossMargin:        r.financialData?.grossMargins?.raw
                            ? parseFloat((r.financialData.grossMargins.raw * 100).toFixed(1))
                            : null,
      operatingMargin:    r.financialData?.operatingMargins?.raw
                            ? parseFloat((r.financialData.operatingMargins.raw * 100).toFixed(1))
                            : null,
      profitMargin:       r.financialData?.profitMargins?.raw
                            ? parseFloat((r.financialData.profitMargins.raw * 100).toFixed(1))
                            : null,
      debtToEquity:       r.financialData?.debtToEquity?.raw || null,
      currentRatio:       r.financialData?.currentRatio?.raw || null,
      targetMeanPrice:    r.financialData?.targetMeanPrice?.raw || null,
      targetHighPrice:    r.financialData?.targetHighPrice?.raw || null,
      targetLowPrice:     r.financialData?.targetLowPrice?.raw || null,
      analysts: {
        buy:   (trend.strongBuy || 0) + (trend.buy || 0),
        hold:   trend.hold || 0,
        sell:  (trend.sell || 0) + (trend.strongSell || 0),
        total:  totalAnalysts,
      },
      quarterlyEps: quarterlyRaw,
    };
  } catch (err) {
    console.error('Yahoo Finance error:', err.message);
    return {}; // Return empty — Claude will fill from training knowledge
  }
}

// ─── Claude prompt builder ───────────────────────────────────────────────────
function buildPrompt(symbol, name, sector, fd) {
  const today = new Date().toISOString().split('T')[0];
  const sc = SECTOR_CONFIGS[sector] || SECTOR_CONFIGS.railways;
  const upside = fd.price && fd.targetMeanPrice
    ? ((fd.targetMeanPrice - fd.price) / fd.price * 100).toFixed(1)
    : 'unknown';

  return `You are an expert Indian stock market analyst covering NSE-listed equities. Analyse ${symbol} (${name}), a ${sector} sector stock, as of ${today}.

LIVE DATA FROM YAHOO FINANCE (use these exact numbers where available):
Price: ₹${fd.price ?? 'N/A'} | Day change: ${fd.changePercent ?? 0}%
52W High: ₹${fd.weekHigh52 ?? 'N/A'} | 52W Low: ₹${fd.weekLow52 ?? 'N/A'}
Market Cap: ${fd.marketCapFmt ?? 'N/A'}
Trailing P/E: ${fd.pe ?? 'N/A'} | Forward P/E: ${fd.forwardPE ?? 'N/A'} | P/B: ${fd.pb ?? 'N/A'}
EPS (TTM): ₹${fd.eps ?? 'N/A'}
Dividend Yield: ${fd.dividendYield ?? 'N/A'}%
ROE: ${fd.roe ?? 'N/A'}% | ROA: ${fd.roa ?? 'N/A'}%
Revenue Growth YoY: ${fd.revenueGrowth ?? 'N/A'}%
Operating Margin: ${fd.operatingMargin ?? 'N/A'}% | Net Margin: ${fd.profitMargin ?? 'N/A'}%
Debt/Equity: ${fd.debtToEquity ?? 'N/A'}
Analyst Target — Mean: ₹${fd.targetMeanPrice ?? 'N/A'} | High: ₹${fd.targetHighPrice ?? 'N/A'} | Low: ₹${fd.targetLowPrice ?? 'N/A'} | Upside to mean: ${upside}%
Analyst Ratings: ${fd.analysts?.buy ?? 0} Buy | ${fd.analysts?.hold ?? 0} Hold | ${fd.analysts?.sell ?? 0} Sell

SECTOR FOCUS (${sector.toUpperCase()}):
Key metrics to prioritise: ${sc.keyMetricNames}
What matters most for this sector: ${sc.focusPoints}

SIGNAL LOGIC (long-term investor perspective, 1-3 year horizon):
BUY_MORE when: ${sc.buySignal}
REVIEW FOR EXIT when: ${sc.sellSignal}
HOLD otherwise when long-term thesis is intact

Using the live data above AND your training knowledge of ${symbol}, produce a comprehensive analysis. Return ONLY a single valid JSON object — no markdown, no explanation outside the JSON. Use this exact schema:

{
  "symbol": "${symbol}",
  "name": "${name}",
  "exchange": "NSE",
  "sector": "${sector}",
  "signal": "HOLD",
  "signalReason": "2–3 sentences explaining the signal using specific numbers and events",
  "lastUpdated": "${today}",
  "price": {
    "current": ${fd.price ?? 0},
    "weekHigh52": ${fd.weekHigh52 ?? 0},
    "weekLow52": ${fd.weekLow52 ?? 0},
    "changePercent": ${fd.changePercent ?? 0}
  },
  "targets": {
    "low": ${fd.targetLowPrice ?? 0},
    "average": ${fd.targetMeanPrice ?? 0},
    "high": ${fd.targetHighPrice ?? 0}
  },
  "analysts": {
    "buy": ${fd.analysts?.buy ?? 0},
    "hold": ${fd.analysts?.hold ?? 0},
    "sell": ${fd.analysts?.sell ?? 0},
    "total": ${fd.analysts?.total ?? 0}
  },
  "keyMetrics": {
    "METRIC_KEY": {
      "value": "display string e.g. 12.5% or ₹13,955 Cr or 65.5x",
      "raw": 12.5,
      "status": "good",
      "label": "Human readable label",
      "sub": "optional context e.g. Sector avg: 37x"
    }
  },
  "quarterly": [
    { "quarter": "Q4 FY25", "revenue": 1100, "ebitda": 132, "pat": 75 },
    { "quarter": "Q1 FY26", "revenue": 950, "ebitda": 114, "pat": 65 },
    { "quarter": "Q2 FY26", "revenue": 805, "ebitda": 96, "pat": 43 },
    { "quarter": "Q3 FY26", "revenue": 822, "ebitda": 99, "pat": 55 }
  ],
  "segments": [
    { "name": "Segment Name", "revenue": 665.7, "growth": -21.9, "color": "#2563eb" },
    { "name": "Segment Name 2", "revenue": 166.4, "growth": 236.8, "color": "#16a34a" }
  ],
  "competitors": [
    { "name": "Company Name", "symbol": "SYM", "orderBook": "N/A", "pe": "28x", "revenueGrowth": "+8%", "margin": "9%", "note": "brief differentiator", "isYou": false }
  ],
  "news": [
    { "date": "YYYY-MM-DD", "title": "Specific headline", "sentiment": "positive", "url": "" }
  ],
  "thesis": [
    { "pillar": "Pillar name", "icon": "🏭", "status": "on_track", "detail": "Specific detail with numbers" }
  ],
  "addTriggers": [
    "Specific price or event trigger e.g. Price dips below ₹600 (P/E ~48x)"
  ],
  "sellTriggers": [
    "Specific red flag trigger"
  ],
  "risks": [
    { "title": "Risk name", "severity": "high", "detail": "Specific risk detail" }
  ],
  "sources": [
    { "title": "Source name", "url": "https://..." }
  ]
}

Rules:
- keyMetrics MUST use the exact keys for this sector: ${sc.keyMetricNames}
- status values: "good" (green), "ok" (blue), "warn" (amber), "high" (red — bad)
- Use real numbers from the Yahoo Finance data above wherever provided
- Be specific in signalReason — cite actual metrics, not generic statements
- Include 5–6 news items (use your knowledge up to your training cutoff)
- Include 5–7 thesis pillars and 4–5 risks
- Return ONLY the JSON object, nothing else`;
}

// ─── Main handler ────────────────────────────────────────────────────────────
export default async function handler(req) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol')?.toUpperCase()?.trim();
  const sector = searchParams.get('sector') || 'railways';
  const name   = searchParams.get('name') || symbol;

  if (!symbol) {
    return new Response(JSON.stringify({ error: 'symbol parameter is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured in Vercel environment variables' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // 1. Fetch live financial data
    const financialData = await fetchYahooData(symbol);

    // 2. Call Claude API
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{ role: 'user', content: buildPrompt(symbol, name, sector, financialData) }],
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      throw new Error(`Claude API error ${claudeRes.status}: ${err}`);
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text || '';

    // 3. Extract JSON from Claude's response
    let analysis;
    const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      analysis = JSON.parse(fenceMatch[1].trim());
    } else {
      const start = rawText.indexOf('{');
      const end   = rawText.lastIndexOf('}') + 1;
      analysis = JSON.parse(rawText.slice(start, end));
    }

    return new Response(JSON.stringify(analysis), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    });

  } catch (err) {
    console.error('analyze error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
