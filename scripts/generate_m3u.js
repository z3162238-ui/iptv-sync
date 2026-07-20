#!/usr/bin/env node
/**
 * Generate an M3U playlist by joining channels.csv + streams.csv
 *
 * Usage examples:
 *  node scripts/generate_m3u.js --channels data/channels.csv --streams data/streams.csv --output index.m3u
 *  CHANNELS_URL=... STREAMS_URL=... node scripts/generate_m3u.js --output index.m3u
 *
 * Filtering: pass --filter "id1,id2" and optionally --filter-by id|name|country (default id).
 * Or set env FILTER and FILTER_BY.
 */
const fs = require('fs');
const path = require('path');
+const axios = require('axios');
+// csv-parse sync import — be robust to module export shapes
+let parse;
+const _parseModule = require('csv-parse/sync');
+if (typeof _parseModule === 'function') {
+  parse = _parseModule;
+} else if (_parseModule && typeof _parseModule.parse === 'function') {
+  parse = _parseModule.parse;
+} else if (_parseModule && typeof _parseModule.default === 'function') {
+  parse = _parseModule.default;
+} else {
+  throw new Error('csv-parse/sync: parse function not found');
+}

const argv = require('minimist')(process.argv.slice(2), {
  string: ['channels', 'streams', 'output', 'filter', 'filter-by', 'channels-url', 'streams-url'],
  alias: { o: 'output' }
});

const COMMIT_DEFAULT = 'main';
const CHANNELS_URL = process.env.CHANNELS_URL || argv['channels-url'] ||
  `https://raw.githubusercontent.com/iptv-org/database/${COMMIT_DEFAULT}/data/channels.csv`;
const STREAMS_URL = process.env.STREAMS_URL || argv['streams-url'] ||
  `https://raw.githubusercontent.com/iptv-org/database/${COMMIT_DEFAULT}/data/streams.csv`;

const channelsPath = argv.channels || 'data/channels.csv';
const streamsPath = argv.streams || 'data/streams.csv';
const outputPath = argv.output || 'index.m3u';
const filterInput = argv.filter || process.env.FILTER || '';
const filterBy = (argv['filter-by'] || process.env.FILTER_BY || 'id').toLowerCase();

+async function readCsvFromFileOrUrl(localPath, url) {
+  // Always return a Promise (async function) so callers can .catch()
+  if (fs.existsSync(localPath)) {
+    const raw = fs.readFileSync(localPath, 'utf8');
+    return parse(raw, { columns: true, skip_empty_lines: true });
+  }
+  // fetch url
+  const r = await axios.get(url, { timeout: 20000 });
+  return parse(r.data, { columns: true, skip_empty_lines: true });
+}

function detectField(obj, candidates) {
  const keys = Object.keys(obj);
  for (const c of candidates) {
    const lc = c.toLowerCase();
    for (const k of keys) {
      if (k.toLowerCase() === lc) return k;
    }
  }
  // fallback: first matching substring
  for (const k of keys) {
    for (const c of candidates) {
      if (k.toLowerCase().includes(c.toLowerCase())) return k;
    }
  }
  return null;
}

function chooseStreamUrl(streams) {
  if (!streams || streams.length === 0) return null;
  // find url field
  const urlField = detectField(streams[0], ['url', 'stream', 'link', 'uri']);
  const disabledField = detectField(streams[0], ['disabled', 'remove', 'is_disabled']);
  const qualityField = detectField(streams[0], ['quality', 'type', 'resolution']);
  const good = streams.filter(s => {
    const url = (urlField && s[urlField]) ? s[urlField].trim() : '';
    if (!url || !/^https?:\/\//i.test(url)) return false;
    if (disabledField && s[disabledField]) {
      const v = String(s[disabledField]).toLowerCase();
      if (['1','true','yes'].includes(v)) return false;
    }
    return true;
  });
  if (good.length === 0) return null;
  // prefer HD-like quality
  good.sort((a,b) => {
    const qa = qualityField && a[qualityField] ? String(a[qualityField]).toLowerCase() : '';
    const qb = qualityField && b[qualityField] ? String(b[qualityField]).toLowerCase() : '';
    const score = q => (q.includes('1080')?100:(q.includes('720')?80:(q.includes('hd')?70:(q.includes('480')?50:10))));
    return score(qb) - score(qa);
  });
  return good[0][detectField(good[0], ['url','stream','link','uri'])];
}

(async () => {
  try {
    const [channels, streams] = await Promise.all([
      readCsvFromFileOrUrl(channelsPath, CHANNELS_URL).catch(e => { console.error('channels fetch failed', e.message); return []; }),
      readCsvFromFileOrUrl(streamsPath, STREAMS_URL).catch(e => { console.error('streams fetch failed', e.message); return []; })
    ]);

    if (!channels || channels.length === 0) {
      console.error('No channels data found. Exiting.');
      process.exit(1);
    }

    // index streams by channel id (stream file may use channel / channel_id)
    const streamChannelField = streams[0] ? detectField(streams[0], ['channel', 'channel_id', 'channelid', 'channelId']) : null;
    const streamMap = {};
    if (streams && streams.length) {
      for (const s of streams) {
        const key = streamChannelField ? (s[streamChannelField] || '').trim() : (s.id || '');
        if (!key) continue;
        streamMap[key] = streamMap[key] || [];
        streamMap[key].push(s);
      }
    }

    // channel fields detection
    const chIdField = detectField(channels[0], ['id']);
    const chNameField = detectField(channels[0], ['name']);
    const chLogoField = detectField(channels[0], ['logo', 'tvg-logo', 'tvg_logo']);
    const chGroupField = detectField(channels[0], ['categories', 'category', 'group', 'group-title']);

    // filters
    const filters = filterInput ? filterInput.split(',').map(s => s.trim()).filter(Boolean) : [];
    const filterLower = filters.map(f => f.toLowerCase());

    const out = ['#EXTM3U'];

    for (const ch of channels) {
      const chId = ch[chIdField] ? String(ch[chIdField]).trim() : '';
      const chName = ch[chNameField] ? String(ch[chNameField]).trim() : '';
      const chLogo = ch[chLogoField] ? String(ch[chLogoField]).trim() : '';
      const chGroup = ch[chGroupField] ? String(ch[chGroupField]).trim() : '';

      // filtering
      let include = true;
      if (filters.length) {
        if (filterBy === 'id') {
          include = filterLower.includes(chId.toLowerCase());
        } else if (filterBy === 'country') {
          const countryField = detectField(channels[0], ['country']);
          const country = countryField && ch[countryField] ? String(ch[countryField]).trim().toLowerCase() : '';
          include = filterLower.includes(country);
        } else if (filterBy === 'name') {
          include = filterLower.some(f => chName.toLowerCase().includes(f));
        } else {
          // default id
          include = filterLower.includes(chId.toLowerCase());
        }
      }

      if (!include) continue;

      // find stream url
      let url = null;
      // direct by id
      if (chId && streamMap[chId]) url = chooseStreamUrl(streamMap[chId]);
      // fallback: match by name
      if (!url) {
        for (const key of Object.keys(streamMap)) {
          if (!key) continue;
          if (key.toLowerCase() === chName.toLowerCase() || key.toLowerCase() === chId.toLowerCase()) {
            url = chooseStreamUrl(streamMap[key]);
            if (url) break;
          }
        }
      }

      if (!url) continue; // skip channels with no usable stream

      // build meta
      const metaParts = [];
      if (chLogo) metaParts.push(`tvg-logo="${chLogo}"`);
      if (chName) metaParts.push(`tvg-name="${chName}"`);
      if (chGroup) metaParts.push(`group-title="${chGroup}"`);
      const metaStr = metaParts.join(' ');
      const displayName = chName || chId || url;
      out.push(`#EXTINF:-1 ${metaStr},${displayName}`);
      out.push(url);
    }

    fs.writeFileSync(outputPath, out.join('\n') + '\n', 'utf8');
    console.log('Wrote', outputPath);
  } catch (err) {
    console.error('Error generating m3u:', err);
    process.exit(1);
  }
})();
