/* ==================================================================
   chesslib/book.js  —  shared opening-book loader.

   createBook(variantName) -> { lookup(key), info(), variant }

   Books live at  chesslib/books/<variant>/  (variant = config name/id,
   lowercased).  Layout:

     manifest.json
        { variant, plies, depth, engineVersion, positions,
          shards: [ "<shardId>", ... ] }
        A shardId is a SHORT PREFIX of the position-key string; positions
        are partitioned into the shard whose id is a prefix of their key.
        A small book may have a single shard.

     <shardId>.json
        { "<positionKey>": [ {"san":"...","cp":<int>}, ... ], ... }
        The array is sorted BEST-FOR-THE-SIDE-TO-MOVE first; cp is a
        WHITE-RELATIVE centipawn score (positive = better for White).

   The manifest is fetched once (lazily) and cached; each shard is fetched
   lazily the first time a key that maps to it is looked up, then cached in
   memory.  Fetch URLs are resolved relative to THIS module's location
   (chesslib/book.js), so `./books/<variant>/…` works on GitHub Pages
   regardless of the page's depth.

   Everything fails gracefully: a missing book / shard / position simply
   makes lookup() resolve to null; no exception ever escapes.
   ================================================================== */

export function createBook(variantName){
  const variant = String(variantName || '').toLowerCase();
  const baseUrl = new URL(`./books/${variant}/`, import.meta.url);

  let manifestP = null;          // Promise<manifest|null> (memoized)
  let manifest  = null;          // resolved manifest object, or null
  const shardCache = new Map();  // shardId -> Promise<map|null>

  function loadManifest(){
    if(manifestP) return manifestP;
    manifestP = fetch(new URL('manifest.json', baseUrl))
      .then(r => r && r.ok ? r.json() : null)
      .then(m => { manifest = (m && Array.isArray(m.shards)) ? m : null; return manifest; })
      .catch(() => { manifest = null; return null; });
    return manifestP;
  }

  // The shard a key belongs to: the shard whose id is a prefix of the key.
  // Prefer the longest matching prefix so nested/variable-length shard ids
  // (and a single catch-all "" shard) all work.
  function shardFor(m, k){
    let best = null;
    for(const s of m.shards){
      if(k.startsWith(s) && (best === null || s.length > best.length)) best = s;
    }
    return best;
  }

  function loadShard(id){
    if(shardCache.has(id)) return shardCache.get(id);
    // catch-all shard id "" → a safe filename (a literal ".json" dotfile isn't
    // reliably served by GitHub Pages); named shards keep "<id>.json".
    const fname = id === '' ? 'shard.json' : (encodeURIComponent(id) + '.json');
    const p = fetch(new URL(fname, baseUrl))
      .then(r => r && r.ok ? r.json() : null)
      .catch(() => null);
    shardCache.set(id, p);
    return p;
  }

  // Returns the ranked [{san,cp}] array for `key`, or null if the position
  // isn't in the book (or the book / shard isn't available).  Never throws.
  async function lookup(key){
    try{
      const m = await loadManifest();
      if(!m) return null;
      const id = shardFor(m, key);
      if(id == null) return null;
      const map = await loadShard(id);
      if(!map) return null;
      const arr = map[key];
      return (Array.isArray(arr) && arr.length) ? arr : null;
    }catch(_e){
      return null;
    }
  }

  // The resolved manifest (for depth / plies labels), or null until loaded.
  function info(){ return manifest; }

  return { lookup, info, variant };
}
