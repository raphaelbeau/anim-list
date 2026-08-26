#!/usr/bin/env node
/**
 * ANIME//DB — moteur de vérification des chapitres (autonome)
 * -------------------------------------------------------------
 * Ne fait qu'une chose : pour une liste d'œuvres avec le suivi activé,
 * trouve le dernier chapitre paru et le compare à `suivi.dernier_chapitre_paru`.
 *
 * Aucune dépendance externe (fetch natif de Node 18+). Pas de notification,
 * pas d'écriture de fichier, pas de GitHub Actions ici — juste la logique
 * de vérification, pensée pour être appelée par un futur orchestrateur.
 *
 * Format d'entrée attendu par œuvre (voir modèle de données ANIME//DB) :
 *   {
 *     id, title, nickname, scan_url, manga_status,
 *     progress_chapter,               // prochain chapitre que l'utilisateur doit lire
 *     suivi: { suivi_actif, dernier_chapitre_paru, derniere_verification, ntfy_topic }
 *   }
 *
 * Usage en CLI (pour tester manuellement) :
 *   node check-releases.js chemin/vers/data.json
 *   cat data.json | node check-releases.js
 */

/* ============================================================
   SOURCES DE PARUTION — testées en cascade
   ============================================================ */

function cleanTitle(title) {
  return (title || '').replace(/\([^)]*\)/g, '').trim();
}

/**
 * Source 1 : MangaDex — recherche le titre, puis lit le flux "aggregate"
 * (résumé de tous les volumes/chapitres) pour en tirer le numéro le plus élevé.
 * Retourne un nombre (chapitre) ou null si le titre n'est pas trouvé / erreur.
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
    return null; // réseau down, timeout, JSON invalide... on considère juste "pas trouvé ici"
  }
}

/**
 * Source 2 (repli) : RSS générique. On tente quelques emplacements usuels
 * (le lien lui-même, /feed, /rss, /rss.xml), ou on cherche une balise
 * <link rel="alternate" type="application/rss+xml"> sur la page du lien scan.
 * Une fois un flux trouvé, on extrait le plus grand numéro de chapitre
 * mentionné dans les titres d'items récents.
 *
 * Best-effort : beaucoup de sites de lecture n'exposent pas de RSS du tout,
 * dans ce cas on retourne simplement null (échec silencieux, pas une erreur).
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
          feedUrl = url; // ce candidat est déjà un flux
        } else {
          const m = text.match(/<link[^>]+type=["']application\/rss\+xml["'][^>]+href=["']([^"']+)["']/i);
          if (m) feedUrl = new URL(m[1], origin).toString();
        }
      } catch (e) { /* on essaie le candidat suivant */ }

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
  } catch (e) { /* pas de RSS exploitable sur ce site */ }
  return null;
}

/**
 * Vérification en cascade pour une œuvre : MangaDex d'abord, RSS ensuite
 * si MangaDex n'a rien donné (introuvable ou erreur). Retourne
 * { chapter, source } ou null si aucune source n'a rien trouvé.
 */
async function findLatestChapter(entry) {
  const viaMangaDex = await checkMangaDex(entry.title);
  if (viaMangaDex !== null) return { chapter: viaMangaDex, source: 'mangadex' };

  const viaRss = await checkGenericRss(entry.scan_url);
  if (viaRss !== null) return { chapter: viaRss, source: 'rss' };

  return null;
}

/* ============================================================
   VÉRIFICATION + COMPARAISON
   ============================================================ */

/**
 * @param {Array} entries - toutes les œuvres (le filtrage sur suivi_actif est fait ici)
 * @returns {Promise<{results: Array, newReleases: Array}>}
 *
 * `results`     : une ligne par œuvre suivie et effectivement vérifiée, qu'il y ait
 *                 ou non un nouveau chapitre — utile pour mettre à jour
 *                 `dernier_chapitre_paru` / `derniere_verification` en aval.
 * `newReleases` : sous-ensemble de `results` où un nouveau chapitre a été détecté,
 *                 prêt à être notifié — contient explicitement `scan_url`.
 *
 * Règle de comparaison :
 *  - si `dernier_chapitre_paru` est encore `null` (aucune vérification précédente),
 *    on ne peut rien "comparer" : on remonte quand même la valeur trouvée (pour
 *    poser une première référence) mais on ne la classe PAS en `newReleases`,
 *    sinon la toute première exécution notifierait chaque œuvre suivie d'un coup.
 *  - sinon, nouveau chapitre = valeur trouvée strictement supérieure à la valeur connue.
 */
async function checkReleases(entries) {
  const tracked = (entries || []).filter(e => e && e.suivi && e.suivi.suivi_actif);

  const results = [];
  const newReleases = [];

  for (const entry of tracked) {
    const found = await findLatestChapter(entry);
    const previous = entry.suivi.dernier_chapitre_paru;
    const checkedAt = new Date().toISOString();

    if (!found) {
      results.push({
        id: entry.id, title: entry.title, nickname: entry.nickname || '',
        scan_url: entry.scan_url || null, ntfy_topic: entry.suivi.ntfy_topic || null,
        previousChapter: previous, latestChapter: null,
        source: null, isNew: false, checkedAt,
      });
      continue;
    }

    const isBaseline = previous === null || previous === undefined;
    const isNew = !isBaseline && found.chapter > previous;

    const row = {
      id: entry.id, title: entry.title, nickname: entry.nickname || '',
      scan_url: entry.scan_url || null, ntfy_topic: entry.suivi.ntfy_topic || null,
      previousChapter: isBaseline ? null : previous,
      latestChapter: found.chapter,
      source: found.source, isNew, checkedAt,
    };
    results.push(row);
    if (isNew) newReleases.push(row);
  }

  return { results, newReleases };
}

/* ============================================================
   NOTIFICATION — ntfy
   ============================================================ */

/**
 * Envoie une notification ntfy pour une œuvre donnée.
 * Payload :
 *   - Titre : 🔔 Nouveau chapitre — [Nom de l'œuvre]   (nickname si présent, sinon titre)
 *   - Corps : Chapitre [X] disponible
 *   - Click : le scan_url de l'œuvre (tap sur la notif -> ouverture directe du lien de lecture)
 *
 * @param {{server?: string, topic: string}} ntfyConfig
 * @param {{title: string, nickname?: string, latestChapter: number, scan_url?: string, ntfy_topic?: string}} release
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function sendNtfyNotification(ntfyConfig, release) {
  const topic = (release && release.ntfy_topic) || (ntfyConfig && ntfyConfig.topic);
  if (!topic) {
    return { ok: false, error: 'Aucun topic ntfy configuré (ni sur cette œuvre, ni en global).' };
  }
  const server = ((ntfyConfig && ntfyConfig.server) || 'https://ntfy.sh').replace(/\/+$/, '');
  const label = release.nickname || release.title;

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
    return { ok: false, error: 'Impossible de contacter le serveur ntfy (réseau ?)' };
  }
}

/**
 * Envoie une notification pour chaque œuvre de `newReleases`. Continue même si
 * l'une des notifications échoue (ex: topic mal configuré) — chaque tentative
 * est reportée individuellement dans le tableau retourné, plutôt que de
 * bloquer les autres œuvres.
 *
 * @param {Array} newReleases - sortie de checkReleases().newReleases
 * @param {{server?: string, topic: string}} ntfyConfig
 * @returns {Promise<Array<{id: string, title: string, ok: boolean, error?: string}>>}
 */
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
   CLI — usage manuel / test :
     node check-releases.js data.json
     node check-releases.js data.json notif-config.json
     cat data.json | node check-releases.js
   ============================================================ */
if (require.main === module) {
  (async () => {
    const fs = require('fs');
    const filePath = process.argv[2];
    const ntfyConfigPath = process.argv[3];

    const raw = filePath ? fs.readFileSync(filePath, 'utf-8') : fs.readFileSync(0, 'utf-8');
    const entries = JSON.parse(raw);

    const { results, newReleases } = await checkReleases(entries);

    console.error(`Œuvres suivies vérifiées : ${results.length}`);
    console.error(`Nouveaux chapitres détectés : ${newReleases.length}`);

    let notifyOutcomes = [];
    if (newReleases.length && ntfyConfigPath) {
      const ntfyConfig = JSON.parse(fs.readFileSync(ntfyConfigPath, 'utf-8'));
      notifyOutcomes = await notifyNewReleases(newReleases, ntfyConfig);
      const sent = notifyOutcomes.filter(o => o.ok).length;
      console.error(`Notifications envoyées : ${sent}/${notifyOutcomes.length}`);
    } else if (newReleases.length && !ntfyConfigPath) {
      console.error('(Aucun fichier de config ntfy fourni en 2e argument — notifications non envoyées.)');
    }

    console.log(JSON.stringify({ results, newReleases, notifyOutcomes }, null, 1));
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
