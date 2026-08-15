// The season the bot writes to. Mirrors the WEBSITE's own logic so they always agree:
//   1. A season explicitly marked status:'active' in data/seasonMeta wins.
//   2. Otherwise, the data/defaultSeasonId is treated as active — UNLESS its seasonMeta
//      entry explicitly says status:'finished' (a finished season is never a write target).
// Only if there's truly no active season AND no usable default does it return null.
async function activeSeasonId() {
  let meta = null;
  try {
    const res = await fetch(`${FB}/data/seasonMeta.json`);
    meta = await res.json();
  } catch (e) { console.error('[sync] seasonMeta fetch failed', e); }

  // 1) Explicit active season.
  if (Array.isArray(meta)) {
    const a = meta.find(s => s && s.status === 'active');
    if (a && a.id != null) return a.id;
  }

  // 2) Fall back to defaultSeasonId (the site's notion of "the current season"),
  //    as long as it isn't explicitly finished.
  try {
    const res = await fetch(`${FB}/data/defaultSeasonId.json`);
    const def = await res.json();
    if (def != null) {
      const entry = Array.isArray(meta) ? meta.find(s => s && String(s.id) === String(def)) : null;
      if (!entry || entry.status !== 'finished') return def;
    }
  } catch (e) { console.error('[sync] defaultSeasonId fetch failed', e); }

  return null; // no active season → do not write
}