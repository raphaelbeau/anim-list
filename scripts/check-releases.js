#!/usr/bin/env node
/**
 * ANIME//DB — moteur de vérification des chapitres (autonome)
 * -------------------------------------------------------------
 * Ne fait qu'une chose : pour une liste d'œuvres avec le suivi activé,
 * trouve le dernier chapitre paru et le compare au chapitre précédent connu.
 */

function cleanTitle(title) {
  return (title || '').replace(/\([^)]*\)/g, '').trim();
}

/*
 * Source 1 : MangaDex — recherche le titre, puis lit le flux /feed
 * filtré uniquement sur le Français (fr) et l'Anglais (en).
 */
async function checkMangaDex(title) {
  try {
    const q = encodeURIComponent(cleanTitle(title));
    const searchRes = await fetch(`https://api.mangadex.org/manga?title=${q}&limit=1`);
    if (!searchRes.ok) return null;
    const searchJson = await searchRes.json();
    const manga = searchJson?.data?.[0];
    if (!manga) return null;

    // Récupération des 10 derniers chapitres parus uniquement en FR ou EN
    const feedUrl = `https://api.mangadex.org/manga/${manga.id}/feed?translatedLanguage[]=fr&translatedLanguage[]=en&order[chapter]=desc&limit=10`;
    const feedRes = await fetch(feedUrl);
    if (!feedRes.ok) return null;
    const feedJson = await feedRes.json();
    const chapters = feedJson?.data || [];

    if (chapters.length === 0) return null;

    // Le tout dernier chapitre paru (FR ou EN)
    const latestChapterNumStr = chapters[0].attributes.chapter;
    const rawChapter = parseFloat(latestChapterNumStr);

    if (isNaN(rawChapter)) return null;

    // Si une version française existe pour ce tout dernier numéro de chapitre, on privilégie le FR
    const frVersion = chapters.find(
      c => c.attributes.chapter === latestChapterNumStr && c.attributes.translatedLanguage === 'fr'
    );

    const selected = frVersion || chapters[0];
    const cleanNum = parseFloat(selected.attributes.chapter);

    // 💡 CORRECTION DU BUG DES DÉCIMALES (23.00000001 -> 23) :
    // On arrondit à 2 décimales max (ex: 23.5 reste 23.5, mais 23.00000001 devient 23)
    return Math.round(cleanNum * 100) / 100;
  } catch (e) {
    return null;
  }
}

/**
 * Source 2 (repli) : RSS générique
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

/**
 * Vérification en cascade pour une œuvre : MangaDex d'abord, RSS ensuite
 */
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
  // Prise en compte de la structure à plat OU sous-objet suivi
  const tracked = (entries || []).filter(e => {
    if (!e) return false;
    if (e.suivi && typeof e.suivi.suivi_actif !== 'undefined') return e.suivi.suivi_actif;
    return true; 
  });

  const results = [];
  const newReleases = [];

  for (const entry of tracked) {
    const found = await findLatestChapter(entry);
    
    // Extraction souple du chapitre précédent et du topic ntfy
    const previous = entry.previousChapter ?? entry.suivi?.dernier_chapitre_paru ?? null;
    const ntfyTopic = entry.ntfy_topic ?? entry.suivi?.ntfy_topic ?? null;
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

    // Un chapitre est NOUVEAU si :
    // 1. Il y avait déjà un previousChapter enregistré
    // 2. Le chapitre trouvé par l'API est strictement SUPÉRIEUR au previousChapter
    const isBaseline = previous === null || previous === undefined;
    const isNew = !isBaseline && found.chapter > previous;

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
   NOTIFICATION — ntfy (AVEC REPLI SUR default_topic)
   ============================================================ */

async function sendNtfyNotification(ntfyConfig, release) {
  const topic = (release && release.ntfy_topic)
    || (ntfyConfig && ntfyConfig.default_topic)
    || (ntfyConfig && ntfyConfig.topic);

  if (!topic) {
    console.error(`❌ Échec envoi pour "${release.title}" : Aucun topic ntfy configuré.`);
    return { ok: false, error: 'Aucun topic ntfy configuré (ni sur cette œuvre, ni via default_topic).' };
  }

  const server = ((ntfyConfig && ntfyConfig.server) || 'https://ntfy.sh').replace(/\/+$/, '');
  const label = release.nickname || release.title;

  console.error(`📡 Envoi notification pour "${label}" sur le topic "${topic}" (Chapitre ${release.latestChapter})...`);

  // Nettoyage strict ASCII pour le header Title (empêche tout crash de ByteString)
  const safeTitle = `Nouveau chapitre - ${label}`.replace(/[^\x00-\x7F]/g, '');

  const headers = {
    'Title': safeTitle,
    'Tags': 'bookmark_tabs,bell',
  };
  if (release.scan_url) headers['Click'] = release.scan_url;

  try {
    const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers,
      body: `Chapitre ${release.latestChapter} disponible`,
    });
    if (!res.ok) {
      console.error(`❌ Erreur serveur ntfy (${res.status})`);
      return { ok: false, error: `ntfy a répondu ${res.status}` };
    }
    console.error(`✅ Notification envoyée avec succès sur ntfy !`);
    return { ok: true };
  } catch (e) {
    console.error(`❌ Erreur réseau lors de l'envoi à ntfy :`, e.message);
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
   EXECUTION CLI
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

        // Mise à jour adaptative
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
