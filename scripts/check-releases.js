#!/usr/bin/env node
/**
 * ANIME//DB — Moteur de vérification automatique des sorties de chapitres
 * -----------------------------------------------------------------
 * Auto-détection MangaDex & Auto-sauvegarde de l'ID dans data.json.
 */

const cheerio = require('cheerio');

const MANGADEX_API_URL = 'https://api.mangadex.org';

/* ============================================================
   1. UTILS & PARSING DE TITRE / CHAPITRE
   ============================================================ */

function parseChapterNumber(text) {
  if (text === null || text === undefined || text === '') return null;
  const value = String(text).trim();
  const match = value.match(/(?:chapitre|chapter|scan|ch\.?|c)\s*[-:#]?\s*(\d+(?:\.\d+)?)/i)
             || value.match(/^\s*(\d+(?:\.\d+)?)(?:\s|$)/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  return isNaN(num) ? null : num;
}

function compareChapters(current, previous) {
  const currentNumber = parseChapterNumber(current);
  const previousNumber = parseChapterNumber(previous);
  if (currentNumber !== null && previousNumber !== null) {
    return currentNumber - previousNumber;
  }
  if (currentNumber !== null) return 1;
  if (previousNumber !== null) return -1;
  return String(current).localeCompare(String(previous), undefined, { numeric: true });
}

function cleanTitle(title) {
  return (title || '').replace(/\([^)]*\)/g, '').trim();
}

/* ============================================================
   2. RECHERCHE ET RÉCUPÉRATION MANGADEX
   ============================================================ */

/**
 * Recherche de secours sur AniList avec le titre texte du manga
 */
async function fetchAniListLatestChapter(title) {
  if (!title) return null;
  const clean = cleanTitle(title);
  const query = `
    query ($search: String) {
      Media (search: $search, type: MANGA) {
        id
        chapters
        title { romaji english native }
      }
    }
  `;
  try {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables: { search: clean } })
    });
    if (!res.ok) return null;
    const json = await res.json();
    const chapters = json?.data?.Media?.chapters;
    if (chapters && chapters > 0) {
      return {
        chapter: chapters,
        url: `https://anilist.co/manga/${json.data.Media.id}`,
        source: 'anilist'
      };
    }
  } catch (e) {
    return null;
  }
  return null;
}

/**
 * Recherche l'ID MangaDex correspondant à un titre texte.
 * Utilise l'endpoint de recherche /manga et tente de trouver une correspondance
 * exacte (titre principal ou titre alternatif) avant de se rabattre sur le
 * premier résultat renvoyé (le plus pertinent selon MangaDex).
 */
async function searchMangaDexIdByTitle(title) {
  if (!title) return null;
  const clean = cleanTitle(title);
  if (!clean) return null;

  try {
    const params = new URLSearchParams();
    params.set('title', clean);
    params.set('limit', '5');
    params.append('order[relevance]', 'desc');

    const url = `${MANGADEX_API_URL}/manga?${params.toString()}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'AnimeDB-Checker/2.0' } });
    if (!res.ok) return null;

    const json = await res.json();
    if (!json.data || !Array.isArray(json.data) || json.data.length === 0) return null;

    const normalizedSearch = clean.toLowerCase();

    // 1. On cherche une correspondance exacte (titre principal ou alternatif)
    for (const manga of json.data) {
      const attrs = manga.attributes || {};
      const candidateTitles = [
        ...Object.values(attrs.title || {}),
        ...(attrs.altTitles || []).flatMap(t => Object.values(t))
      ];
      if (candidateTitles.some(t => (t || '').toLowerCase() === normalizedSearch)) {
        return manga.id;
      }
    }

    // 2. Sinon, on prend le résultat le plus pertinent renvoyé par MangaDex
    return json.data[0].id || null;
  } catch (e) {
    return null;
  }
}

/**
 * Interroge le flux de chapitres MangaDex pour UNE langue donnée et renvoie
 * le chapitre le plus élevé trouvé (ou null si rien n'est disponible).
 */
async function fetchMangaDexFeedForLang(mangadexId, lang) {
  try {
    const params = new URLSearchParams({
      limit: '500',
      'order[chapter]': 'desc',
      'translatedLanguage[]': lang,
      includeFuturePublishAt: '0',
    });
    const url = `${MANGADEX_API_URL}/manga/${encodeURIComponent(mangadexId)}/feed?${params}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'AnimeDB-Checker/2.0' } });
    if (!res.ok) return null;

    const json = await res.json();
    if (!json.data || !Array.isArray(json.data) || json.data.length === 0) return null;

    let bestNumberedChapter = null;
    let firstChapter = null;

    for (const item of json.data) {
      const chAttr = item.attributes;
      if (!chAttr || typeof item.id !== 'string') continue;
      const chapterNumber = String(chAttr.chapter ?? '').trim();
      const chapter = {
        chapter: chapterNumber || 'Oneshot',
        url: `https://mangadex.org/chapter/${item.id}`,
        source: `mangadex_${lang}`,
      };
      if (!firstChapter) firstChapter = chapter;

      const numericChapter = parseChapterNumber(chapterNumber);
      if (numericChapter !== null && (
        !bestNumberedChapter || numericChapter > bestNumberedChapter.numericChapter
      )) {
        bestNumberedChapter = { ...chapter, numericChapter };
      }
    }

    if (bestNumberedChapter) {
      const { numericChapter, ...chapter } = bestNumberedChapter;
      return chapter;
    }
    return firstChapter;
  } catch (e) {
    return null;
  }
}

/**
 * Récupère le dernier chapitre via MangaDex, en comparant les scans FR et EN
 * (les deux flux sont interrogés en parallèle, on garde le chapitre le plus
 * récent des deux), avec secours sur AniList si aucun des deux ne remonte rien.
 */
async function fetchMangaDexLatestChapter(mangadexIdOrTitle, preferredLang = 'fr') {
  if (!mangadexIdOrTitle) return null;

  try {
    let mangadexId = mangadexIdOrTitle;
    let foundNewId = null;

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mangadexIdOrTitle);
    if (!isUuid) {
      mangadexId = await searchMangaDexIdByTitle(mangadexIdOrTitle);
      if (mangadexId) foundNewId = mangadexId;
    }

    // 1. Tente MangaDex si un ID est présent : FR et EN en parallèle
    if (mangadexId) {
      const langsToCheck = new Set(['fr', 'en']);
      if (preferredLang && /^[a-z]{2}(?:-[a-z]{2})?$/i.test(preferredLang)) {
        const normalizedLang = preferredLang.toLowerCase();
        if (!['vo', 'vf'].includes(normalizedLang)) langsToCheck.add(normalizedLang);
      }

      const feedResults = await Promise.all(
        [...langsToCheck].map(lang => fetchMangaDexFeedForLang(mangadexId, lang))
      );

      let best = null;
      for (const res of feedResults) {
        if (res && (!best || compareChapters(res.chapter, best.chapter) > 0)) {
          best = res;
        }
      }

      if (best) {
        best.discovered_id = foundNewId;
        return best;
      }
    }

    // 2. Secours sur AniList en passant le titre texte original
    const aniListRes = await fetchAniListLatestChapter(mangadexIdOrTitle);
    if (aniListRes) {
      if (foundNewId) aniListRes.discovered_id = foundNewId;
      return aniListRes;
    }

    return null;
  } catch (e) {
    return null;
  }
}

/* ============================================================
   3. RÉCUPÉRATION COMIX ET SCRAPING DES SITES SCAN_URL
   ============================================================ */

function getScanProvider(scanUrl) {
  if (!scanUrl) return null;
  if (scanUrl.toLowerCase() === 'mangadex') return 'mangadex';

  try {
    const url = new URL(scanUrl);
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'comix.to' || hostname.endsWith('.comix.to')) return 'comix';
    if (hostname === 'mangadex.org' || hostname.endsWith('.mangadex.org')) return 'mangadex';
  } catch (e) {
    return null;
  }
  return null;
}

function extractMangaDexId(scanUrl) {
  if (!scanUrl || scanUrl.toLowerCase() === 'mangadex') return null;
  try {
    const url = new URL(scanUrl);
    if (getScanProvider(scanUrl) !== 'mangadex') return null;
    return url.pathname.match(
      /^\/title\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i
    )?.[1] || null;
  } catch (e) {
    return null;
  }
}

function extractComixSlug(scanUrl) {
  let url;
  try {
    url = new URL(scanUrl);
  } catch (e) {
    throw new Error('URL Comix invalide.');
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname !== 'comix.to' && !hostname.endsWith('.comix.to')) {
    throw new Error('L’URL fournie ne pointe pas vers Comix.');
  }
  const match = url.pathname.match(/^\/title\/([^/]+)/i);
  if (!match) throw new Error('URL Comix invalide : identifiant du manga introuvable.');
  return decodeURIComponent(match[1]);
}

function isCloudflareChallenge(html) {
  return /challenge-platform|cf-chl-|\/cdn-cgi\/challenge|checking your browser|verify you are human|just a moment\.\.\./i.test(html)
    || /(?:attention required|error 1020|error 1015).{0,100}cloudflare|cloudflare.{0,100}(?:attention required|error 1020|error 1015)/i.test(html);
}

async function fetchLatestComixChapter(scanUrl) {
  const slug = extractComixSlug(scanUrl);
  const pageUrl = `https://comix.to/title/${encodeURIComponent(slug)}`;
  const response = await fetch(pageUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(15000),
  });
  const html = await response.text();

  if (isCloudflareChallenge(html)) {
    throw new Error('Comix est bloqué par un challenge Cloudflare; aucun contournement n’est tenté.');
  }
  if (!response.ok) throw new Error(`Comix a répondu HTTP ${response.status}.`);

  const $ = cheerio.load(html);
  const initialData = $('#initial-data').first().text().trim();
  if (!initialData) throw new Error('Les données manga intégrées à la page Comix sont introuvables.');

  let payload;
  try {
    payload = JSON.parse(initialData);
  } catch (e) {
    throw new Error('Comix a retourné des données manga intégrées invalides.');
  }
  if (!payload || typeof payload !== 'object' || !payload.queries || typeof payload.queries !== 'object') {
    throw new Error('Comix a retourné une structure de données manga invalide.');
  }

  const detail = Object.entries(payload.queries).find(([key, value]) => {
    if (!value || typeof value !== 'object') return false;
    const detailUrl = typeof value.url === 'string' ? value.url : '';
    const detailSlug = detailUrl.match(/^\/title\/([^/?#]+)/i)?.[1];
    let queryKeyMatches = false;
    try {
      const queryKey = JSON.parse(key);
      queryKeyMatches = Array.isArray(queryKey) && queryKey.includes(slug);
    } catch (e) {
      queryKeyMatches = false;
    }

    return detailSlug === slug ||
      detailSlug?.startsWith(`${slug}-`) ||
      (typeof value.hid === 'string' && slug.startsWith(`${value.hid}-`)) ||
      String(value.id ?? '') === slug ||
      queryKeyMatches;
  })?.[1];

  if (!detail || typeof detail !== 'object') {
    throw new Error(`Aucune fiche manga Comix ne correspond à « ${slug} ».`);
  }

  const chapterNumber = parseChapterNumber(detail.latestChapter);
  const chapterPath = typeof detail.latestChapterUrl === 'string'
    ? detail.latestChapterUrl.trim()
    : '';
  if (chapterNumber === null || !chapterPath) {
    throw new Error(`Le dernier chapitre est absent des données Comix pour « ${slug} ».`);
  }

  const chapterUrl = new URL(chapterPath, 'https://comix.to');
  if (chapterUrl.origin !== 'https://comix.to') {
    throw new Error('Comix a retourné une URL de chapitre externe.');
  }

  return {
    chapter: chapterNumber,
    url: chapterUrl.toString(),
    source: 'comix',
  };
}

function resolveUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).href;
  } catch (e) {
    return href;
  }
}

/**
 * Stratégie 1 : thème WordPress "Madara", utilisé par une grande partie des
 * sites de scan FR/EN (structure très stable : <li class="wp-manga-chapter">
 * contenant un <a> avec le texte "Chapter XXX").
 */
function extractMadaraChapters($, baseUrl) {
  const selectors = [
    '.wp-manga-chapter a',
    'li.wp-manga-chapter a',
    '.listing-chapters_wrap a',
    '.chapter-item a',
  ];

  let maxChapter = -1;
  let bestLink = null;

  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const $el = $(el);
      const text = $el.text().trim();
      const href = $el.attr('href');
      if (!href) return;

      const chNum = parseChapterNumber(text);
      if (chNum !== null && chNum > maxChapter) {
        maxChapter = chNum;
        bestLink = resolveUrl(href, baseUrl);
      }
    });
    if (maxChapter > -1) break; // un sélecteur a fonctionné, inutile de tester les autres
  }

  return maxChapter > -1 ? { chapter: maxChapter, url: bestLink } : null;
}

/**
 * Stratégie 2 (fallback) : recherche générique, restreinte en priorité aux
 * conteneurs dont la classe/id évoque une liste de chapitres, pour éviter de
 * remonter des liens de navigation/sidebar sans rapport. Le "premier nombre
 * trouvé" (sans mot-clé chapitre/chapter) n'est utilisé qu'en tout dernier
 * recours, à l'intérieur d'un conteneur ciblé.
 */
function extractGenericChapters($, baseUrl) {
  const containerSelector = '[class*="chapter" i], [id*="chapter" i], [class*="episode" i]';
  const scopes = [$(containerSelector), $('body')];

  for (const [scopeIndex, $scope] of scopes.entries()) {
    const isTargetedScope = scopeIndex === 0;
    let maxChapter = -1;
    let bestLink = null;

    $scope.find('a').addBack('a').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href');
      if (!href || href.startsWith('#')) return;
      const text = $el.text().trim();

      const looksLikeChapterLink =
        /(?:chapitre|chapter|scan|ch[-_]|\/chapter\/|\/scan\/|\/read\/)/i.test(href) ||
        /(?:chapitre|chapter|scan|ch\.)/i.test(text);
      if (!looksLikeChapterLink) return;

      // On exige un mot-clé explicite avant le nombre pour éviter de confondre
      // avec une date, un compteur de vues ou un numéro de tome. Le fallback
      // "premier nombre trouvé" n'est autorisé que dans un conteneur ciblé.
      const keywordMatch = text.match(/(?:chapitre|chapter|scan|ch)[^\d]*(\d+(?:\.\d+)?)/i)
                         || href.match(/(?:chapter|chapitre|scan)[-_/]?(\d+(?:\.\d+)?)/i);
      const chNum = keywordMatch
        ? parseFloat(keywordMatch[1])
        : (isTargetedScope ? (parseChapterNumber(text) ?? parseChapterNumber(href)) : null);

      if (chNum !== null && !isNaN(chNum) && chNum > maxChapter) {
        maxChapter = chNum;
        bestLink = resolveUrl(href, baseUrl);
      }
    });

    if (maxChapter > -1) return { chapter: maxChapter, url: bestLink };
  }

  return null;
}

async function scrapeScanUrl(scanUrl) {
  if (!scanUrl) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    let res;
    try {
      res = await fetch(scanUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);

    const result = extractMadaraChapters($, scanUrl) || extractGenericChapters($, scanUrl);
    if (!result) return null;

    return {
      chapter: result.chapter,
      url: result.url || scanUrl,
      source: 'scan_url',
    };
  } catch (e) {
    return null;
  }
}

/* ============================================================
   4. LOGIQUE DE VERIFICATION
   ============================================================ */

function evaluateMangaNotification(entry, latestChapter, latestUrl) {
  const suivi = entry.suivi || {};
  if (!suivi || suivi.suivi_actif !== true) return null;

  const label = entry.nickname || entry.title;
  const lastNotified = suivi.last_notified_chapter ?? suivi.dernier_chapitre_notifie ?? null;

  if (lastNotified === null || lastNotified === undefined) {
    return {
      type: 'baseline_only',
      newLastNotifiedChapter: latestChapter
    };
  }

  if (compareChapters(latestChapter, lastNotified) <= 0) return null;

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
  const tracked = (entries || []).filter(e => e.suivi && e.suivi.suivi_actif === true);

  const results = [];
  const newChapterAlerts = [];
  const defaultTopic = ntfyConfig?.default_topic || ntfyConfig?.topic || null;

  for (const entry of tracked) {
    const suivi = entry.suivi || {};
    const checkedAt = new Date().toISOString();
    
    const scanUrl = entry.scan_url || suivi.scan_url || null;
    const scanProvider = getScanProvider(scanUrl);
    const mangadexTarget =
      extractMangaDexId(scanUrl) ||
      suivi.mangadex_id ||
      entry.mangadex_id ||
      entry.title ||
      null;
    const preferredLang = entry.lang || suivi.language || 'fr';
    let sourceError = null;

    let mangadexRes = null;
    let scanUrlRes = null;
    try {
      if (scanProvider === 'comix') {
        scanUrlRes = await fetchLatestComixChapter(scanUrl);
      } else if (scanProvider === 'mangadex') {
        mangadexRes = mangadexTarget
          ? await fetchMangaDexLatestChapter(mangadexTarget, preferredLang)
          : null;
      } else {
        [mangadexRes, scanUrlRes] = await Promise.all([
          mangadexTarget ? fetchMangaDexLatestChapter(mangadexTarget, preferredLang) : null,
          scanUrl ? scrapeScanUrl(scanUrl) : null,
        ]);
      }
    } catch (error) {
      sourceError = error instanceof Error ? error.message : String(error);
    }

    let releaseInfo = null;
    if (mangadexRes && scanUrlRes) {
      releaseInfo = mangadexRes.chapter >= scanUrlRes.chapter ? mangadexRes : scanUrlRes;
    } else {
      releaseInfo = mangadexRes || scanUrlRes || null;
    }

    if (!releaseInfo) {
      results.push({
        id: entry.id, title: entry.title, nickname: entry.nickname || '',
        found: false, checkedAt, ...(sourceError ? { error: sourceError } : {})
      });
      continue;
    }

    const update = {
      dernier_chapitre_paru: releaseInfo.chapter,
      derniere_verification: checkedAt,
      source_used: releaseInfo.source
    };

    // Auto-sauvegarde de l'ID MangaDex dans le JSON s'il a été découvert automatiquement
    if (releaseInfo.discovered_id) {
      update.mangadex_id = releaseInfo.discovered_id;
    }

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
   5. NTFY & EXÉCUTION CLI
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
  checkMangaReleases,
  fetchMangaDexLatestChapter,
  fetchLatestComixChapter,
  getScanProvider,
  extractMangaDexId,
  scrapeScanUrl,
  evaluateMangaNotification,
  notifyMangaAlerts,
  compareChapters,
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
