// The season the bot writes to. This site stores the current season as
// data/currentSeasonId, and the season list (with status) as data/seasons = [{id,name,status}].
// (Older builds used data/seasonMeta / data/defaultSeasonId — still honored as a fallback.)
// A season is a valid write target unless it is explicitly status:'finished' (locked).
async function activeSeasonId() {
  // Primary: this site's real fields.
  let seasons = null, currentId = null;
  try { seasons = await (await fetch(`${FB}/data/seasons.json`)).json(); } catch {}
  try { currentId = await (await fetch(`${FB}/data/currentSeasonId.json`)).json(); } catch {}

  const statusOf = (id) => {
    if (Array.isArray(seasons)) {
      const s = seasons.find(x => x && String(x.id) === String(id));
      return s ? (s.status || null) : null;
    }
    return null;
  };

  // 1) An explicitly-active season in data/seasons wins.
  if (Array.isArray(seasons)) {
    const a = seasons.find(s => s && s.status === 'active');
    if (a && a.id != null) return a.id;
  }
  // 2) The current season, unless it's explicitly finished (locked).
  if (currentId != null && statusOf(currentId) !== 'finished') return currentId;

  // 3) Legacy fallback: older data/seasonMeta + data/defaultSeasonId layout.
  let meta = null;
  try { meta = await (await fetch(`${FB}/data/seasonMeta.json`)).json(); } catch {}
  if (Array.isArray(meta)) {
    const a = meta.find(s => s && s.status === 'active');
    if (a && a.id != null) return a.id;
  }
  try {
    const def = await (await fetch(`${FB}/data/defaultSeasonId.json`)).json();
    if (def != null) {
      const e = Array.isArray(meta) ? meta.find(s => s && String(s.id) === String(def)) : null;
      if (!e || e.status !== 'finished') return def;
    }
  } catch {}

  return null; // nothing usable → do not write
}