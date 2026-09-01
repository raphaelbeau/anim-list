#!/usr/bin/env node
/**
 * ANIME//DB — Moteur de vérification des sorties de chapitres (Scans)
 * -----------------------------------------------------------------
 * Structure ajustée sur `suivi` et `suivi.suivi_actif`.
 */

const MANGADEX_API_URL = 'https://api.mangadex.org';

/* ============================================================
   1. PARSING DE NUMÉRO DE CHAPITRE
   ============================================================ */

function parseChapterNumber(text) {
  if (!text) return null;
  // Détecte "chapitre 12.5", "chapter-12.5", "ch. 12", "c12" ou chiffre isolé
  const match = text.match(/(?:chapitre|chapter|scan|ch|c)[^\d]*(\d+(?:\.\d+)?)/i) 
             || text.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  return isNaN(num) ? null : num;
}

/* ============================================================
   2. MANGADEX API
   ============================================================ */

async function fetchMangaDexLatestChapter(mangadexId, preferredLang = 'fr') {
  if (!mangadexId) return null;

  try {
    const lang = (preferredLang || 'fr').toLowerCase();
    const langParams = lang === 'fr' ? 'translatedLanguage[]=fr' : `translatedLanguage[]=${lang}`;

    const url = `${MANGADEX_API_URL}/manga/${mangadexId}/feed?limit=500&order[chapter]=desc&${langParams}&includeFuturePublishAt=0`;
    
    const res = await fetch(url, { headers: { 'User-Agent': 'AnimeDB-Checker/2.0' } });
    if (!res.ok) return null;

    const json = await res.json();
    if (!json.data || !Array.isArray(json.data) || json.data.length === 0) {
      if (lang === 'fr') {
        return await fetchMangaDexLatestChapter(mangadexId, 'en');
      }
      return null;
    }

    let maxChapter = -1;
    let latestChapterObj = null;

    for (const item of json.data) {
      const chAttr = item.attributes;
      if (!chAttr || !chAttr.chapter) continue;
      
      const chNum = parseFloat(chAttr.chapter);
      if (!isNaN(chNum) && chNum > maxChapter) {
        maxChapter = chNum;
        latestChapterObj = {
          chapter: chNum,
          url: `https://mangadex.org/chapter/${item.id}`,
          source: 'mangadex'
        };
      }
    }

    return latestChapterObj;
  } catch (e) {
    return null;
  }
}

/* ============================================================
   3. SCRAPING DE `SCAN_URL`
   ============================================================ */

async function scrapeScanUrl(scanUrl) {
  if (!scanUrl) return null;

  try {
    const res = await fetch(scanUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!res.ok) return null;
    const html = await res.text();

    const linkRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
    let match;
    let maxChapter = -1;
    let bestLink = null;

    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1];
      const text = match[2].replace(/<[^>]+>/g, '').trim();

      // Détection sur href ou texte du lien
      const isChapterLink = /(?:chapitre|chapter|scan|ch[-_]|\/chapter\/|\/scan\/)/i.test(href) ||
                            /(?:chapitre|chapter|scan|ch\.)/i.test(text);

      if (isChapterLink) {
        const numFromText = parseChapterNumber(text);
        const numFromHref = parseChapterNumber(href);
        const chNum = numFromText !== null ? numFromText : numFromHref;

        if (chNum !== null && chNum > maxChapter) {
          maxChapter = chNum;
          
          let fullUrl = href;
          if (href.startsWith('/')) {
            const urlObj = new URL(scanUrl);
            fullUrl = `${urlObj.origin}${href}`;
          } else if (!href.startsWith('http')) {
            fullUrl = `${scanUrl.replace(/\/+$/, '')}/${href}`;
          }
          
          bestLink = fullUrl;
        }
      }
    }

    if (maxChapter > -1) {
      return {
        chapter: maxChapter,
        url: bestLink || scanUrl,
        source: 'scan_url'
      };
    }

    return null;
  } catch (e) {
    return null;
  }
}

/* ============================================================
   4. ÉVALUATION DES NOTIFICATIONS ET COMPARAISON
   ============================================================ */

function evaluateMangaNotification(entry, latestChapter, latestUrl) {
  const suivi = entry.suivi || {};
  if (!suivi || suivi.suivi_actif !== true) return null;

  const label = entry.nickname || entry.title;
  const lastNotified = suivi.last_notified_chapter ?? suivi.dernier_chapitre_notifie ?? null;

  // Premier passage / Baseline
  if (lastNotified === null || lastNotified === undefined) {
    return {
      type: 'baseline_only',
      newLastNotifiedChapter: latestChapter
    };
  }

  if (latestChapter <= lastNotified) return null;

  return {
    type: 'new_chapter',
    title: '📖 Nouveau chapitre disponible',
    message: `${label} — Chapitre ${latestChapter}\nUn nouveau chapitre est en ligne !`,
    tags: ['books', 'open_book'],
    click: latestUrl || entry.scan_url || null,
    newLastNotifiedChapter: latestChapter
  };
}

async function checkMangaReleases(entries, ntfyConfig = null) {
  // Filtrage basé strictement sur suivi.suivi_actif === true
  const tracked = (entries || []).filter(e => e.suivi && e.suivi.suivi_actif === true);

  const results = [];
  const newChapterAlerts = [];
  const defaultTopic = ntfyConfig?.default_topic || ntfyConfig?.topic || null;

  for (const entry of tracked) {
    const suivi = entry.suivi || {};
    const checkedAt = new Date().toISOString();
    
    const mangadexId = suivi.mangadex_id || entry.mangadex_id || null;
    const preferredLang = entry.lang || suivi.language || 'fr';
    const scanUrl = entry.scan_url || suivi.scan_url || null;

    // Récupération multi-sources en parallèle
    const [mangadexRes, scanUrlRes] = await Promise.all([
      mangadexId ? fetchMangaDexLatestChapter(mangadexId, preferredLang) : null,
      scanUrl ? scrapeScanUrl(scanUrl) : null
    ]);

    let releaseInfo = null;
    if (mangadexRes && scanUrlRes) {
      releaseInfo = mangadexRes.chapter >= scanUrlRes.chapter ? mangadexRes : scanUrlRes;
    } else {
      releaseInfo = mangadexRes || scanUrlRes || null;
    }

    if (!releaseInfo) {
      results.push({
        id: entry.id, title: entry.title, nickname: entry.nickname || '',
        found: false, checkedAt
      });
      continue;
    }

    const update = {
      dernier_chapitre_paru: releaseInfo.chapter,
      derniere_verification: checkedAt,
      source_used: releaseInfo.source
    };

    const alert = evaluateMangaNotification(entry, releaseInfo.chapter, releaseInfo.url);
    const resolvedTopic = suivi.ntfy_topic || defaultTopic;

    if (alert && alert.type === 'baseline_only') {
      update.last_notified_chapter = alert.newLastNotifiedChapter;
      update.dernier_chapitre_notifie = alert.newLastNotifiedChapter;
    } else if (alert && alert.type === 'new_chapter') {
      update.last_notified_chapter = alert.newLastNotifiedChapter;
      update.dernier_chapitre_notifie = alert.newLastNotifiedChapter;
      newChapterAlerts.push({
        id: entry.id, title: entry.title, nickname: entry.nickname || '',
        ntfy_topic: resolvedTopic,
        ...alert
      });
    }

    const row = {
      id: entry.id, title: entry.title, nickname: entry.nickname || '',
      ntfy_topic: suivi.ntfy_topic || null,
      found: true, checkedAt, ...update
    };
    row._update = update;
    results.push(row);
  }

  return { results, newChapterAlerts };
}

/* ============================================================
   5. ÉMISSION NTFY & CLI
   ============================================================ */

async function sendNtfyNotification(ntfyConfig, item) {
  const topic = item.ntfy_topic
    || (ntfyConfig && ntfyConfig.default_topic)
    || (ntfyConfig && ntfyConfig.topic);

  if (!topic) return { ok: false, error: 'Aucun topic ntfy configuré.' };

  const server = ((ntfyConfig && ntfyConfig.server) || 'https://ntfy.sh').replace(/\/+$/, '');

  const payload = {
    topic,
    title: item.title,
    message: item.message,
    tags: item.tags,
  };
  if (item.click) payload.click = item.click;

  try {
    const res = await fetch(server, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false, error: `ntfy a répondu ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Impossible de contacter le serveur ntfy.' };
  }
}

async function notifyMangaAlerts(newChapterAlerts, ntfyConfig) {
  const outcomes = [];
  for (const item of newChapterAlerts || []) {
    const r = await sendNtfyNotification(ntfyConfig, item);
    outcomes.push({ id: item.id, title: item.title, kind: 'new_chapter', ok: r.ok, error: r.error });
  }
  return outcomes;
}

module.exports = {
  checkMangaReleases, fetchMangaDexLatestChapter, scrapeScanUrl, evaluateMangaNotification, notifyMangaAlerts
};

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

    let ntfyConfig = null;
    if (ntfyConfigPath) {
      try {
        ntfyConfig = JSON.parse(fs.readFileSync(ntfyConfigPath, 'utf-8'));
      } catch (e) {
        console.error(`⚠️ Impossible de lire ${ntfyConfigPath} (${e.code || e.message}) — notifications ignorées.`);
      }
    }

    const raw = filePath ? fs.readFileSync(filePath, 'utf-8') : fs.readFileSync(0, 'utf-8');
    const entries = JSON.parse(raw);

    const { results, newChapterAlerts } = await checkMangaReleases(entries, ntfyConfig);

    console.error(`Mangas suivis vérifiés : ${results.length}`);
    console.error(`Nouveaux chapitres détectés : ${newChapterAlerts.length}`);

    let dataChanged = false;
    if (shouldWrite) {
      const byId = new Map(entries.map(e => [e.id, e]));
      for (const row of results) {
        const entry = byId.get(row.id);
        if (!entry || !row._update) continue;
        
        // Mise à jour ciblée dans le sous-objet `suivi`
        if (!entry.suivi) entry.suivi = {};
        Object.assign(entry.suivi, row._update);
        dataChanged = true;
      }
      if (dataChanged) {
        fs.writeFileSync(filePath, JSON.stringify(entries, null, 1) + '\n', 'utf-8');
        console.error(`${filePath} mis à jour (${results.length} manga(s) suivi(s)).`);
      }
    }

    let notifyOutcomes = [];
    if (newChapterAlerts.length && ntfyConfig) {
      notifyOutcomes = await notifyMangaAlerts(newChapterAlerts, ntfyConfig);
      const sent = notifyOutcomes.filter(o => o.ok).length;
      console.error(`Notifications envoyées : ${sent}/${notifyOutcomes.length}`);
    }

    const cleanResults = results.map(({ _update, ...rest }) => rest);

    console.log(JSON.stringify({
      results: cleanResults, newChapterAlerts, notifyOutcomes, dataChanged,
    }, null, 1));
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
