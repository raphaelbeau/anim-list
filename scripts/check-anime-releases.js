#!/usr/bin/env node
/**
 * ANIME//DB — moteur de vérification des sorties anime (AniList)
 * -----------------------------------------------------------------
 * Gestion automatique du passage de saison via les relations `SEQUEL` d'AniList.
 */

const ANILIST_URL = 'https://graphql.anilist.co';

/* ============================================================
   1. REQUÊTES GRAPHQL ANILIST (AVEC RELATIONS DE SUITE)
   ============================================================ */

/** Requête AniList incluant la relation SEQUEL pour détecter automatiquement la saison suivante */
const ANILIST_QUERY_BY_ID = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    title { romaji english }
    status
    episodes
    nextAiringEpisode {
      airingAt
      timeUntilAiring
      episode
    }
    relations {
      edges {
        relationType(version: 2)
        node {
          id
          title { romaji english }
          status
          episodes
          nextAiringEpisode {
            airingAt
            timeUntilAiring
            episode
          }
        }
      }
    }
  }
}`;

const ANILIST_QUERY_BY_SEARCH = `
query ($search: String) {
  Media(search: $search, type: ANIME) {
    id
    title { romaji english }
    status
    episodes
    nextAiringEpisode {
      airingAt
      timeUntilAiring
      episode
    }
    relations {
      edges {
        relationType(version: 2)
        node {
          id
          title { romaji english }
          status
          episodes
          nextAiringEpisode {
            airingAt
            timeUntilAiring
            episode
          }
        }
      }
    }
  }
}`;

async function queryAnilist(query, variables) {
  try {
    const res = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.data?.Media || null;
  } catch (e) {
    return null;
  }
}

function cleanTitle(title) {
  return (title || '').replace(/\([^)]*\)/g, '').trim();
}

async function fetchAnilistMedia(entry) {
  const sa = entry.suivi_anime || {};
  if (sa.anilist_id) {
    const byId = await queryAnilist(ANILIST_QUERY_BY_ID, { id: Number(sa.anilist_id) });
    if (byId) return byId;
  }
  return await queryAnilist(ANILIST_QUERY_BY_SEARCH, { search: cleanTitle(entry.title) });
}

function computeEpisodesReleased(media) {
  if (media.nextAiringEpisode) {
    return Math.max(0, media.nextAiringEpisode.episode - 1);
  }
  if (media.status === 'FINISHED') {
    return media.episodes ?? null;
  }
  if (media.status === 'NOT_YET_RELEASED') {
    return 0;
  }
  return media.episodes ?? null;
}

/** Cherche s'il existe une suite (SEQUEL) dans l'arbre des relations AniList */
function findSequelMedia(media) {
  if (!media?.relations?.edges) return null;
  const sequelEdge = media.relations.edges.find(edge => edge.relationType === 'SEQUEL');
  return sequelEdge ? sequelEdge.node : null;
}

/* ============================================================
   2. ÉVALUATION DES RÈGLES DE NOTIFICATION
   ============================================================ */

function evaluateAnimeNotification(entry, sa) {
  if (!sa || !sa.notification_mode || sa.notification_mode === 'disabled') return null;
  const label = entry.nickname || entry.title;

  if (sa.notification_mode === 'season_complete') {
    const alreadyNotified = sa.last_notified_season != null && sa.last_notified_season >= sa.current_season;
    if (sa.season_status !== 'FINISHED' || alreadyNotified) return null;

    return {
      type: 'season_complete',
      title: '🔔 SAISON TERMINÉE',
      message: `${label} — Saison ${sa.current_season}\nLa saison est maintenant complète.\nTu peux commencer ton visionnage.`,
      tags: ['tada', 'tv'],
      click: null,
      newLastNotifiedSeason: sa.current_season,
    };
  }

  if (sa.notification_mode === 'each_episode') {
    if (sa.episodes_released == null) return null;

    if (sa.last_notified_episode === null || sa.last_notified_episode === undefined) {
      return { type: 'baseline_only', newLastNotifiedEpisode: sa.episodes_released };
    }

    if (sa.episodes_released <= sa.last_notified_episode) return null;

    return {
      type: 'each_episode',
      title: '📺 Nouvel épisode disponible',
      message: `${label} — épisode ${sa.episodes_released}\nUn nouvel épisode vient de sortir.`,
      tags: ['tv', 'clapper'],
      click: entry.anime_url || null,
      newLastNotifiedEpisode: sa.episodes_released,
    };
  }

  return null;
}

/**
 * @param {Array} entries
 * @param {object} [ntfyConfig]
 */
async function checkAnimeReleases(entries, ntfyConfig = null) {
  const tracked = (entries || []).filter(
    e => e && e.suivi_anime && e.suivi_anime.notification_mode && e.suivi_anime.notification_mode !== 'disabled'
  );

  const results = [];
  const seasonCompleteAlerts = [];
  const newEpisodeAlerts = [];

  const defaultTopic = ntfyConfig?.default_topic || ntfyConfig?.topic || null;

  for (const entry of tracked) {
    const sa = entry.suivi_anime;
    const checkedAt = new Date().toISOString();
    let media = await fetchAnilistMedia(entry);

    if (!media) {
      results.push({
        id: entry.id, title: entry.title, nickname: entry.nickname || '',
        found: false, checkedAt,
      });
      continue;
    }

    let currentSeason = sa.current_season != null ? sa.current_season : 1;

    // --- TRANSITION AUTOMATIQUE DE SAISON ---
    // Si la saison actuelle enregistrée est FINISHED, on regarde si une suite existe déjà
    if (media.status === 'FINISHED') {
      const sequel = findSequelMedia(media);
      if (sequel) {
        // Une suite (Saison suivante) est trouvée ! On bascule automatiquement dessus.
        media = sequel;
        currentSeason += 1;
      }
    }

    const episodesReleased = computeEpisodesReleased(media);
    const nextEpisodeDate = media.nextAiringEpisode
      ? new Date(media.nextAiringEpisode.airingAt * 1000).toISOString()
      : null;

    const update = {
      anilist_id: media.id,
      current_season: currentSeason,
      episodes_released: episodesReleased,
      episodes_total: media.episodes ?? null,
      season_status: media.status,
      next_episode_number: media.nextAiringEpisode ? media.nextAiringEpisode.episode : null,
      next_episode_date: nextEpisodeDate,
      last_check: checkedAt,
    };

    const upToDateSa = { ...sa, ...update };
    const alert = evaluateAnimeNotification(entry, upToDateSa);
    const resolvedTopic = sa.ntfy_topic || defaultTopic;

    if (alert && alert.type === 'baseline_only') {
      update.last_notified_episode = alert.newLastNotifiedEpisode;
    } else if (alert && alert.type === 'season_complete') {
      update.last_notified_season = alert.newLastNotifiedSeason;
      seasonCompleteAlerts.push({
        id: entry.id, title: entry.title, nickname: entry.nickname || '',
        ntfy_topic: resolvedTopic, anime_url: entry.anime_url || null,
        ...alert,
      });
    } else if (alert && alert.type === 'each_episode') {
      update.last_notified_episode = alert.newLastNotifiedEpisode;
      newEpisodeAlerts.push({
        id: entry.id, title: entry.title, nickname: entry.nickname || '',
        ntfy_topic: resolvedTopic, anime_url: entry.anime_url || null,
        ...alert,
      });
    }

    const row = {
      id: entry.id, title: entry.title, nickname: entry.nickname || '',
      ntfy_topic: sa.ntfy_topic || null,
      found: true, checkedAt, ...update,
    };
    row._update = update;
    results.push(row);
  }

  return { results, seasonCompleteAlerts, newEpisodeAlerts };
}

/* ============================================================
   3. ÉMISSION — POST vers ntfy
   ============================================================ */

async function sendAnimeNtfyNotification(ntfyConfig, item) {
  const topic = item.ntfy_topic
    || (ntfyConfig && ntfyConfig.default_topic)
    || (ntfyConfig && ntfyConfig.topic);
  if (!topic) {
    return { ok: false, error: 'Aucun topic ntfy configuré (ni sur cette œuvre, ni via default_topic).' };
  }
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
    return { ok: false, error: 'Impossible de contacter le serveur ntfy (réseau ?)' };
  }
}

async function notifyAnimeAlerts(seasonCompleteAlerts, newEpisodeAlerts, ntfyConfig) {
  const outcomes = [];
  for (const item of seasonCompleteAlerts || []) {
    const r = await sendAnimeNtfyNotification(ntfyConfig, item);
    outcomes.push({ id: item.id, title: item.title, kind: 'season_complete', ok: r.ok, error: r.error });
  }
  for (const item of newEpisodeAlerts || []) {
    const r = await sendAnimeNtfyNotification(ntfyConfig, item);
    outcomes.push({ id: item.id, title: item.title, kind: 'each_episode', ok: r.ok, error: r.error });
  }
  return outcomes;
}

module.exports = {
  queryAnilist, fetchAnilistMedia, computeEpisodesReleased, checkAnimeReleases,
  evaluateAnimeNotification, sendAnimeNtfyNotification, notifyAnimeAlerts,
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

    const { results, seasonCompleteAlerts, newEpisodeAlerts } = await checkAnimeReleases(entries, ntfyConfig);

    console.error(`Animes suivis vérifiés : ${results.length}`);
    console.error(`Saisons terminées détectées : ${seasonCompleteAlerts.length}`);
    console.error(`Nouveaux épisodes détectés : ${newEpisodeAlerts.length}`);

    let dataChanged = false;
    if (shouldWrite) {
      const byId = new Map(entries.map(e => [e.id, e]));
      for (const row of results) {
        const entry = byId.get(row.id);
        if (!entry || !entry.suivi_anime || !row._update) continue;
        Object.assign(entry.suivi_anime, row._update);
        dataChanged = true;
      }
      if (dataChanged) {
        fs.writeFileSync(filePath, JSON.stringify(entries, null, 1) + '\n', 'utf-8');
        console.error(`${filePath} mis à jour (${results.length} anime(s) suivi(s)).`);
      }
    }

    let notifyOutcomes = [];
    const totalAlerts = seasonCompleteAlerts.length + newEpisodeAlerts.length;
    if (totalAlerts && ntfyConfig) {
      notifyOutcomes = await notifyAnimeAlerts(seasonCompleteAlerts, newEpisodeAlerts, ntfyConfig);
      const sent = notifyOutcomes.filter(o => o.ok).length;
      console.error(`Notifications envoyées : ${sent}/${notifyOutcomes.length}`);
    }

    const cleanResults = results.map(({ _update, ...rest }) => rest);

    console.log(JSON.stringify({
      results: cleanResults, seasonCompleteAlerts, newEpisodeAlerts, notifyOutcomes, dataChanged,
    }, null, 1));
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
