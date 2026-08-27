#!/usr/bin/env node
/**
 * ANIME//DB — moteur de vérification des chapitres (autonome)
 */

function cleanTitle(title) {
  return (title || '').replace(/\([^)]*\)/g, '').trim();
}

/**
 * Source 1 : MangaDex
 */
async function checkMangaDex(title) {
  try {
    const q = encodeURIComponent(cleanTitle(title));
    const searchRes = await fetch(`https://api.mangadex.org/manga?title=${q}&limit=1`);
    if (!searchRes.ok) return null;
    const searchJson = await searchRes.json();
    const manga = searchJson?.data?.[0];
    if (!manga) return null;

    const aggRes = await fetch(`https://api.mangadex.org/manga/${manga.id}/aggregate`);
    if (!aggRes.ok) return null;
    const agg = await aggRes.json();

    let maxChapter = null;
    for (const vol of Object.values(agg.volumes || {})) {
      for (const chap of Object.values(vol.chapters || {})) {
        const n = parseFloat(chap.chapter);
        if (!isNaN(n) && (maxChapter === null || n > maxChapter)) maxChapter = n;
      }
    }
    return maxChapter;
  } catch (e) {
    return null;
  }
}

/**
 * Source 2 : RSS générique
 */
async function checkGenericRss(scanUrl) {
  if (!scanUrl) return null;
  try {
    const origin = new URL(scanUrl).origin;
    const candidates = [scanUrl, `${origin}/feed`, `${origin}/rss`, `${origin}/rss.xml`];

    for (const url of candidates) {
      let feedUrl = null;
      try {
        const pageRes = await fetch(url, { headers: { 'User-Agent': 'anime-db-checker' } });
        if (!pageRes.ok) continue;
        const contentType = pageRes.headers.get('content-type') || '';
        const text = await pageRes.text();
        if (contentType.includes('xml') || text.trim().startsWith('<?xml') || text.includes('<rss')) {
          feedUrl = url;
        } else {
          const m = text.match(/<link[^>]+type=["']application\/rss\+xml["'][^>]+href=["']([^"']+)["']/i);
          if (m) feedUrl = new URL(m[1], origin).toString();
        }
      } catch (e) {}

      if (feedUrl) {
        const feedRes = await fetch(feedUrl);
        if (!feedRes.ok) continue;
        const xml = await feedRes.text();
        const titles = [...xml.matchAll(/<title>([^<]*)<\/title>/gi)].map(m => m[1]);
        let maxChapter = null;
        for (const t of titles) {
          const m = t.match(/(?:chap(?:itre|ter)?\.?\s*)(\d+(?:\.\d+)?)/i);
          if (m) {
            const n = parseFloat(m[1]);
            if (maxChapter === null || n > maxChapter) maxChapter = n;
          }
        }
        if (maxChapter !== null) return maxChapter;
      }
    }
  } catch (e) {}
  return null;
}

async function findLatestChapter(entry) {
  const viaMangaDex = await checkMangaDex(entry.title);
  if (viaMangaDex !== null) return { chapter: viaMangaDex, source: 'mangadex' };

  const viaRss = await checkGenericRss(entry.scan_url);
  if (viaRss !== null) return { chapter: viaRss, source: 'rss' };

  return null;
}

/* ============================================================
   VÉRIFICATION + COMPARAISON (CORRIGÉE)
   ============================================================ */

async function checkReleases(entries) {
  // Supporte les deux structures : e.suivi.suivi_actif OU directement présent/suivi dans data.json
  const tracked = (entries || []).filter(e => {
    if (!e) return false;
    if (e.suivi && typeof e.suivi.suivi_actif !== 'undefined') return e.suivi.suivi_actif;
    return true; // Par défaut, on prend les entrées du fichier
  });

  const results = [];
  const newReleases = [];

  for (const entry of tracked) {
    const found = await findLatestChapter(entry);
    
    // Récupération souple des valeurs (objet suivi ou clés directes)
    const previous = entry.suivi?.dernier_chapitre_paru ?? entry.previousChapter ?? entry.latestChapter ?? null;
    const ntfyTopic = entry.suivi?.ntfy_topic ?? entry.ntfy_topic ?? null;
    const checkedAt = new Date().toISOString();

    if (!found) {
      results.push({
        id: entry.id, title: entry.title, nickname: entry.nickname || '',
        scan_url: entry.scan_url || null, ntfy_topic: ntfyTopic,
        previousChapter: previous, latestChapter: null,
        source: null, isNew: false, checkedAt,
      });
      continue;
    }

    // Un chapitre est nouveau s'il existe une valeur précédente ET que la nouvelle valeur est strictement supérieure
    const isNew = previous !== null && previous !== undefined && found.chapter > previous;

    const row = {
      id: entry.id, title: entry.title, nickname: entry.nickname || '',
      scan_url: entry.scan_url || null, ntfy_topic: ntfyTopic,
      previousChapter: previous,
      latestChapter: found.chapter,
      source: found.source, isNew, checkedAt,
    };

    results.push(row);
    if (isNew) newReleases.push(row);
  }

  return { results, newReleases };
}

/* ============================================================
   NOTIFICATION — ntfy (AVEC FALLBACK TOPIC GLOBAL)
   ============================================================ */

async function sendNtfyNotification(ntfyConfig, release) {
  // Prise en compte du fallback default_topic
  const topic = (release && release.ntfy_topic)
    || (ntfyConfig && ntfyConfig.default_topic)
    || (ntfyConfig && ntfyConfig.topic);

  if (!topic) {
    console.error(`❌ Échec envoi pour "${release.title}" : Aucun topic trouvé.`);
    return { ok: false, error: 'Aucun topic ntfy configuré (ni sur cette œuvre, ni via default_topic).' };
  }

  const server = ((ntfyConfig && ntfyConfig.server) || 'https://ntfy.sh').replace(/\/+$/, '');
  const label = release.nickname || release.title;

  console.error(`📡 Envoi notification pour "${label}" sur le topic "${topic}" (Chapitre ${release.latestChapter})...`);

  const headers = {
    'Title': `🔔 Nouveau chapitre — ${label}`,
    'Tags': 'bookmark_tabs',
  };
  if (release.scan_url) headers['Click'] = release.scan_url;

  try {
    const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers,
      body: `Chapitre ${release.latestChapter} disponible`,
    });
    if (!res.ok) return { ok: false, error: `ntfy a répondu ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Impossible de contacter le serveur ntfy' };
  }
}

async function notifyNewReleases(newReleases, ntfyConfig) {
  const outcomes = [];
  for (const release of newReleases || []) {
    const result = await sendNtfyNotification(ntfyConfig, release);
    outcomes.push({ id: release.id, title: release.title, ok: result.ok, error: result.error });
  }
  return outcomes;
}

module.exports = {
  checkMangaDex, checkGenericRss, findLatestChapter, checkReleases,
  sendNtfyNotification, notifyNewReleases,
};

/* ============================================================
   CLI
   ============================================================ */
if (require.main === module) {
  (async () => {
    const fs = require('fs');
    const args = process.argv.slice(2).filter(a => a !== '--write');
    const shouldWrite = process.argv.includes('--write');
    const filePath = args[0];
    const ntfyConfigPath = args[1];

    if (shouldWrite && !filePath) {
      console.error('--write nécessite un chemin de fichier en 1er argument.');
      process.exit(1);
    }

    const raw = filePath ? fs.readFileSync(filePath, 'utf-8') : fs.readFileSync(0, 'utf-8');
    const entries = JSON.parse(raw);

    const { results, newReleases } = await checkReleases(entries);

    console.error(`Œuvres suivies vérifiées : ${results.length}`);
    console.error(`Nouveaux chapitres détectés : ${newReleases.length}`);

    let dataChanged = false;
    if (shouldWrite) {
      const byId = new Map(entries.map(e => [e.id, e]));
      for (const row of results) {
        const entry = byId.get(row.id);
        if (!entry) continue;

        // Mise à jour de la structure à plat ou dans l'objet suivi
        if (entry.suivi) {
          entry.suivi.derniere_verification = row.checkedAt;
          if (row.latestChapter !== null) entry.suivi.dernier_chapitre_paru = row.latestChapter;
        } else {
          entry.checkedAt = row.checkedAt;
          if (row.previousChapter === null || row.previousChapter === undefined) {
            entry.previousChapter = row.latestChapter;
          } else {
            entry.previousChapter = row.previousChapter;
          }
          if (row.latestChapter !== null) entry.latestChapter = row.latestChapter;
        }
        dataChanged = true;
      }
      if (dataChanged) {
        fs.writeFileSync(filePath, JSON.stringify(entries, null, 1) + '\n', 'utf-8');
        console.error(`${filePath} mis à jour (${results.length} œuvre(s) suivie(s)).`);
      }
    }

    let notifyOutcomes = [];
    if (newReleases.length) {
      let ntfyConfig = null;
      if (ntfyConfigPath) {
        try {
          ntfyConfig = JSON.parse(fs.readFileSync(ntfyConfigPath, 'utf-8'));
        } catch (e) {
          console.error(`⚠️ Impossible de lire ${ntfyConfigPath}`);
        }
      }
      if (ntfyConfig) {
        notifyOutcomes = await notifyNewReleases(newReleases, ntfyConfig);
        const sent = notifyOutcomes.filter(o => o.ok).length;
        console.error(`Notifications envoyées : ${sent}/${notifyOutcomes.length}`);
      }
    }

    console.log(JSON.stringify({ results, newReleases, notifyOutcomes, dataChanged }, null, 1));
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
