// api/weekly-update.js
// Vercel Cron Job — runs every Monday at 8:00 AM
// Re-analyses all stocks in WATCHLIST and writes fresh data.json to the repo via GitHub API
// Triggered automatically by Vercel; can also be called manually at /api/weekly-update

export const config = { runtime: 'edge' };

// ─── WATCHLIST ───────────────────────────────────────────────────────────────
// Add or remove stocks here. Each entry needs symbol, name, and sector.
// Sectors: railways | banking | it | fmcg | pharma | capital_markets | real_estate | auto | metals | energy
const WATCHLIST = [
  { symbol: 'TITAGARH',  name: 'Titagarh Rail Systems Ltd',  sector: 'railways' },
  // Add more stocks here e.g.:
  // { symbol: 'HDFCBANK',  name: 'HDFC Bank Ltd',               sector: 'banking'  },
  // { symbol: 'TCS',       name: 'Tata Consultancy Services',   sector: 'it'       },
];

export default async function handler(req) {
  // Simple auth check — optional but recommended
  // Set CRON_SECRET in Vercel environment variables and pass as ?secret=xxx
  const { searchParams } = new URL(req.url);
  const secret = searchParams.get('secret');
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';

  const results = { updated: [], failed: [], timestamp: new Date().toISOString() };

  // Analyse each stock sequentially (avoid rate limits)
  for (const stock of WATCHLIST) {
    try {
      console.log(`Analysing ${stock.symbol}...`);
      const res = await fetch(
        `${baseUrl}/api/analyze?symbol=${stock.symbol}&sector=${stock.sector}&name=${encodeURIComponent(stock.name)}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const analysis = await res.json();
      if (analysis.error) throw new Error(analysis.error);

      results.updated.push({ symbol: stock.symbol, signal: analysis.signal });
      results[stock.symbol] = analysis;

      // Small delay to be polite to Yahoo Finance
      await new Promise(r => setTimeout(r, 2000));

    } catch (err) {
      console.error(`Failed ${stock.symbol}:`, err.message);
      results.failed.push({ symbol: stock.symbol, error: err.message });
    }
  }

  // Optionally write results to GitHub (if GITHUB_TOKEN + GITHUB_REPO are set)
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPO) {
    try {
      await writeDataJsonToGitHub(results);
      results.githubUpdated = true;
    } catch (err) {
      console.error('GitHub write failed:', err.message);
      results.githubError = err.message;
    }
  }

  return new Response(JSON.stringify(results, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── Write data.json back to GitHub repo ─────────────────────────────────────
// This makes the analysis persist across devices — anyone who opens the site
// sees the latest Monday analysis without needing to re-run it.
async function writeDataJsonToGitHub(results) {
  const repo   = process.env.GITHUB_REPO;   // e.g. "shailesh14apr/stock-tracker"
  const token  = process.env.GITHUB_TOKEN;   // GitHub PAT with repo write access
  const branch = process.env.GITHUB_BRANCH || 'main';
  const path   = 'data.json';

  // Build the data.json content
  const payload = {
    lastUpdated: results.timestamp,
    watchlist: Object.values(results)
      .filter(v => v && typeof v === 'object' && v.symbol)
      .map(v => v.symbol),
    stocks: Object.fromEntries(
      Object.values(results)
        .filter(v => v && typeof v === 'object' && v.symbol)
        .map(v => [v.symbol, v])
    ),
  };

  const content = btoa(JSON.stringify(payload, null, 2));

  // Get current file SHA (needed for update)
  const getRes = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`,
    { headers: { Authorization: `token ${token}`, 'User-Agent': 'stock-tracker' } }
  );
  const current = getRes.ok ? await getRes.json() : null;

  // Commit updated data.json
  const putRes = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `token ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'stock-tracker',
      },
      body: JSON.stringify({
        message: `chore: weekly stock analysis update ${new Date().toISOString().split('T')[0]}`,
        content,
        sha: current?.sha,
        branch,
      }),
    }
  );

  if (!putRes.ok) {
    const err = await putRes.text();
    throw new Error(`GitHub API error: ${err}`);
  }
}
