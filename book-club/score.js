/* Book-club scoring model.
 *
 * Every "taste" axis predicts the star rating you'd give a candidate from a
 * different slice of your Goodreads history, shrinks it toward your overall
 * average when evidence is thin, then maps it to 0-100 where 50 is your
 * average book and each star above/below moves 50 points. "Club" axes judge
 * the book as a group pick. Pure functions, no DOM: runs in the browser and
 * under Node for testing.
 */
(function (root) {
  'use strict';

  const AXES = [
    { key: 'author', label: 'Author affinity', short: 'Author', group: 'taste', weight: 0.20,
      help: 'How I rated this author, plus authors with a direct literary link (at half weight).' },
    { key: 'theme', label: 'Theme match', short: 'Themes', group: 'taste', weight: 0.35,
      help: 'My ratings of books whose themes overlap this one, weighted by how much they overlap.' },
    { key: 'crowd', label: 'Crowd signal', short: 'Crowd', group: 'taste', weight: 0.20,
      help: 'What the Goodreads average predicts for me, using how my ratings track the crowd.' },
    { key: 'length', label: 'Length fit', short: 'Length', group: 'taste', weight: 0.10,
      help: 'How I have rated books of similar page count.' },
    { key: 'era', label: 'Era fit', short: 'Era', group: 'taste', weight: 0.15,
      help: 'How I have rated books published around the same time.' },
    { key: 'discuss', label: 'Discussion potential', short: 'Discussion', group: 'club', weight: 0.60,
      help: 'Hand-scored: how much a group will have to argue about.' },
    { key: 'access', label: 'Group-friendly', short: 'Group-friendly', group: 'club', weight: 0.40,
      help: 'Short, widely available and broadly liked books are easier to get a whole club through.' },
  ];

  const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
  const normAuthor = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const stars = (r) => `${r}★`;
  const short = (t) => t.replace(/\s*\(.*\)$/, '').replace(/:.*$/, '');

  // Weighted mean of ratings with `prior` weight pulling toward mu.
  function shrink(pairs, mu, prior) {
    let sw = 0, swr = 0;
    for (const [w, r] of pairs) { sw += w; swr += w * r; }
    return { pred: (swr + prior * mu) / (sw + prior), n: sw };
  }

  function buildProfile(read) {
    const rated = read.filter((b) => b.rating > 0);
    const n = rated.length;
    const mu = rated.reduce((s, b) => s + b.rating, 0) / n;

    // Least-squares fit: your rating ~ a + b * goodreads average.
    const xs = rated.filter((b) => b.avg);
    const mx = xs.reduce((s, b) => s + b.avg, 0) / xs.length;
    const my = xs.reduce((s, b) => s + b.rating, 0) / xs.length;
    let sxy = 0, sxx = 0;
    for (const b of xs) { sxy += (b.avg - mx) * (b.rating - my); sxx += (b.avg - mx) ** 2; }
    const slope = sxx ? sxy / sxx : 0;
    const crowd = { slope, intercept: my - slope * mx, meanAvg: mx, bias: my - mx };

    // Average rating per theme tag, for the "your taste" panel.
    const tagStats = {};
    for (const b of rated) for (const t of b.tags) {
      (tagStats[t] ||= { tag: t, n: 0, sum: 0 });
      tagStats[t].n++; tagStats[t].sum += b.rating;
    }
    const tags = Object.values(tagStats)
      .map((t) => ({ ...t, avg: t.sum / t.n }))
      .sort((a, b) => b.avg - a.avg || b.n - a.n);

    const dist = [1, 2, 3, 4, 5].map((s) => rated.filter((b) => b.rating === s).length);
    return { rated, n, mu, crowd, tags, dist, unrated: read.length - n };
  }

  const toScore = (pred, mu) => clamp(50 + (pred - mu) * 50);

  function scoreAuthor(c, P) {
    const pairs = [], notes = [];
    for (const b of P.rated) {
      if (normAuthor(b.author) === normAuthor(c.author)) {
        pairs.push([1, b.rating]); notes.push(`I gave ${c.author}'s ${short(b.title)} ${stars(b.rating)}`);
      }
    }
    for (const k of c.kindred || []) {
      const hits = P.rated.filter((b) => normAuthor(b.author) === normAuthor(k.author));
      for (const b of hits) {
        pairs.push([0.5, b.rating]);
        notes.push(`${k.author}: ${short(b.title)} ${stars(b.rating)}. ${k.why}`);
      }
    }
    if (!pairs.length) return { score: 50, pred: P.mu, n: 0, notes: [`No ${c.author} (or close kin) on my read shelf yet, so this stays neutral.`] };
    const { pred, n } = shrink(pairs, P.mu, 1);
    return { score: toScore(pred, P.mu), pred, n, notes };
  }

  function scoreTheme(c, P) {
    const A = new Set(c.tags);
    const matches = [];
    for (const b of P.rated) {
      if (!b.tags.length) continue;
      const shared = b.tags.filter((t) => A.has(t));
      if (!shared.length) continue;
      const sim = shared.length / Math.sqrt(A.size * b.tags.length);
      matches.push({ b, sim, w: sim * sim, shared });
    }
    // Only the closest neighbours count; otherwise every book sharing one
    // broad tag drags the prediction back to your overall average.
    matches.sort((x, y) => y.w - x.w);
    const top = matches.slice(0, 10);
    const { pred, n } = shrink(top.map((m) => [m.w, m.b.rating]), P.mu, 0.5);
    const notes = matches.slice(0, 4).map((m) =>
      `${short(m.b.title)} ${stars(m.b.rating)} (shares ${m.shared.join(', ')})`);
    return { score: toScore(pred, P.mu), pred, n, notes, matches: matches.slice(0, 6) };
  }

  function scoreCrowd(c, P) {
    const { slope, intercept, bias } = P.crowd;
    const pred = clamp(intercept + slope * c.avg, 1, 5);
    const dir = bias >= 0 ? 'above' : 'below';
    return {
      score: toScore(pred, P.mu), pred, n: P.n,
      notes: [`Goodreads average ${c.avg.toFixed(2)} → about ${pred.toFixed(2)}★ for me. I rate ${Math.abs(bias).toFixed(2)}★ ${dir} the crowd on average.`],
    };
  }

  function kernelAxis(c, P, value, sigma, fmt, unit) {
    const target = value(c);
    const pairs = [];
    let near = [];
    for (const b of P.rated) {
      const v = value(b);
      if (v == null || !isFinite(v)) continue;
      const w = Math.exp(-0.5 * ((v - target) / sigma) ** 2);
      if (w > 0.01) { pairs.push([w, b.rating]); near.push({ b, w }); }
    }
    const { pred, n } = shrink(pairs, P.mu, 1);
    near.sort((x, y) => y.w - x.w);
    const closeish = near.filter((x) => x.w > 0.5);
    const avgNear = closeish.length ? closeish.reduce((s, x) => s + x.b.rating, 0) / closeish.length : null;
    const notes = [avgNear != null
      ? `${closeish.length} rated books ${fmt(c)} average ${avgNear.toFixed(2)}★ from me.`
      : `Few rated books ${fmt(c)}; leaning on my overall average.`];
    return { score: toScore(pred, P.mu), pred, n, notes };
  }

  const scoreLength = (c, P) => kernelAxis(
    c, P, (b) => (b.pages >= 60 ? Math.log(b.pages) : null), 0.3,
    (x) => `near ${x.pages} pages`);

  const scoreEra = (c, P) => kernelAxis(
    c, P, (b) => b.year || null, 20,
    (x) => `from around ${Math.round(x.year / 10) * 10}`);

  function scoreAccess(c) {
    const len = clamp(100 - ((c.pages - 150) / 500) * 100);
    const pop = clamp(((Math.log10(c.ratingsCount || 1) - 3) / 3) * 100);
    const liked = clamp(((c.avg - 3.3) / 1.0) * 100);
    const score = 0.55 * len + 0.25 * pop + 0.2 * liked;
    return {
      score,
      notes: [`${c.pages} pages; ${c.ratingsCount.toLocaleString('en-US')} Goodreads ratings, avg ${c.avg.toFixed(2)}.`],
    };
  }

  function scoreCandidate(c, P) {
    const axes = {
      author: scoreAuthor(c, P),
      theme: scoreTheme(c, P),
      crowd: scoreCrowd(c, P),
      length: scoreLength(c, P),
      era: scoreEra(c, P),
      discuss: { score: c.discussion, notes: [c.discussionWhy] },
      access: scoreAccess(c),
    };
    const group = (g) => {
      const ax = AXES.filter((a) => a.group === g);
      const tw = ax.reduce((s, a) => s + a.weight, 0);
      return ax.reduce((s, a) => s + a.weight * axes[a.key].score, 0) / tw;
    };
    // Predicted stars: taste axes' weighted predictions.
    const tAx = AXES.filter((a) => a.group === 'taste');
    const predStars = tAx.reduce((s, a) => s + a.weight * axes[a.key].pred, 0) /
      tAx.reduce((s, a) => s + a.weight, 0);
    return { c, axes, taste: group('taste'), club: group('club'), predStars };
  }

  function rank(candidates, read, tasteWeight = 0.6) {
    const P = buildProfile(read);
    const results = candidates.map((c) => scoreCandidate(c, P));
    for (const r of results) r.overall = tasteWeight * r.taste + (1 - tasteWeight) * r.club;
    results.sort((a, b) => b.overall - a.overall);
    return { profile: P, results };
  }

  const api = { AXES, buildProfile, scoreCandidate, rank };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BookScore = api;
})(typeof window !== 'undefined' ? window : globalThis);
