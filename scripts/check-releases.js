#!/usr/bin/env node
/**
 * ANIME//DB — moteur de vérification des sorties anime (AniList)
 * -----------------------------------------------------------------
 * Pour chaque anime suivi (`suivi_anime.notification_mode !== 'disabled'`),
 * interroge l'API GraphQL AniList pour connaître le statut de diffusion de
 * la saison, le nombre d'épisodes sortis, et la date du prochain épisode.
 *
 * Deux notifications possibles :
 *   - "saison_complete" : dès que la SAISON EN COURS (le Media pointé par
 *     anilist_id) passe à season_status === 'FINISHED'. Ça ne dépend jamais
 *     de l'état de la franchise entière : sur AniList, chaque saison d'un
 *     anime est en général sa propre fiche Media, donc `status` reflète déjà
 *     naturellement l'état de CETTE saison précise, pas celui de la série
 *     dans son ensemble (voir règle 3 du cahier des charges).
 *   - "each_episode" : dès que `episodes_released` augmente par rapport à
 *     `last_notified_episode`.
 *
 * Aucune dépendance externe (fetch natif de Node 18+).
 */

const ANILIST_URL = 'https://graphql.anilist.co';

/* ============================================================
   1. REQUÊTES GRAPHQL ANILIST
   ============================================================ */

/** Recherche directe par anilist_id — cas nominal une fois l'ID connu. */
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
  }
}`;

/** Repli par titre — utilisé si anilist_id est encore vide (première
 *  vérification) ou si l'id enregistré ne répond plus (fiche supprimée/fusionnée
 *  côté AniList). Permet de résoudre puis de mémoriser l'id pour la suite. */
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

/** Récupère la fiche AniList d'une œuvre : par id si on l'a déjà, sinon par
 *  recherche du titre (et dans ce cas on renverra aussi l'id résolu). */
async function fetchAnilistMedia(entry) {
  const sa = entry.suivi_anime || {};
  if (sa.anilist_id) {
    const byId = await queryAnilist(ANILIST_QUERY_BY_ID, { id: Number(sa.anilist_id) });
    if (byId) return byId;
    // id invalide/supprimé côté AniList -> on retente par titre ci-dessous
  }
  return await queryAnilist(ANILIST_QUERY_BY_SEARCH, { search: cleanTitle(entry.title) });
}

/** Déduit le nombre d'épisodes déjà sortis à partir de la fiche AniList. */
function computeEpisodesReleased(media) {
  if (media.nextAiringEpisode) {
    // le prochain épisode n'est pas encore sorti -> tout ce qui précède l'est
    return Math.max(0, media.nextAiringEpisode.episode - 1);
  }
  if (media.status === 'FINISHED') {
    return media.episodes ?? null; // saison terminée : tout est sorti
  }
  if (media.status === 'NOT_YET_RELEASED') {
    return 0;
  }
  return media.episodes ?? null; // repli best-effort (CANCELLED, HIATUS...)
}

/* ============================================================
   2. VÉRIFICATION + DÉTECTION DES ALERTES
   ============================================================ */

/**
 * @param {Array} entries - toutes les œuvres (le filtrage sur notification_mode est fait ici)
 * @returns {Promise<{results: Array, seasonCompleteAlerts: Array, newEpisodeAlerts: Array}>}
 */
async function checkAnimeReleases(entries) {
  const tracked = (entries || []).filter(
    e => e && e.suivi_anime && e.suivi_anime.notification_mode && e.suivi_anime.notification_mode !== 'disabled'
  );

  const results = [];
  const seasonCompleteAlerts = [];
  const newEpisodeAlerts = [];

  for (const entry of tracked) {
    const sa = entry.suivi_anime;
    const checkedAt = new Date().toISOString();
    const media = await fetchAnilistMedia(entry);

    if (!media) {
      results.push({
        id: entry.id, title: entry.title, nickname: entry.nickname || '',
        found: false, checkedAt,
      });
      continue;
    }

    const episodesReleased = computeEpisodesReleased(media);
    const nextEpisodeDate = media.nextAiringEpisode
      ? new Date(media.nextAiringEpisode.airingAt * 1000).toISOString()
      : null;

    // current_season : AniList n'expose pas de "numéro de saison" universel
    // (chaque saison est simplement une fiche Media distincte). On garde donc
    // la valeur déjà présente sur la fiche si elle existe ; sinon on pose 1
    // par défaut, pour que la comparaison anti-spam ait quelque chose de
    // concret à comparer. Le script ne tente pas de deviner un futur numéro.
    const currentSeason = sa.current_season != null ? sa.current_season : 1;

    const update = {
      anilist_id: media.id,
      current_season: currentSeason,
      episodes_released: episodesReleased,
      episodes_total: media.episodes ?? null,
      season_status: media.status, // 'RELEASING' | 'FINISHED' | 'NOT_YET_RELEASED' | 'CANCELLED' | 'HIATUS'
      next_episode_number: media.nextAiringEpisode ? media.nextAiringEpisode.episode : null,
      next_episode_date: nextEpisodeDate,
      last_check: checkedAt,
    };

    const row = {
      id: entry.id, title: entry.title, nickname: entry.nickname || '',
      ntfy_topic: sa.ntfy_topic || null,
      found: true, checkedAt, ...update,
    };
    results.push(row);

    /* --- Règle 3 : "saison complète" ne regarde QUE season_status de CETTE
       saison (le Media identifié par anilist_id) — jamais un état "franchise
       entière terminée". On ne notifie qu'une fois par saison grâce à
       last_notified_season. */
    if (sa.notification_mode === 'season_complete' && update.season_status === 'FINISHED') {
      if (sa.last_notified_season !== currentSeason) {
        seasonCompleteAlerts.push({ ...row, seasonKey: currentSeason });
        update.last_notified_season = currentSeason;
      }
    }

    /* --- "chaque épisode" : notifie à chaque nouvel épisode détecté.
       Première vérification (last_notified_episode encore null) = juste une
       référence de départ, pas de notification (sinon un anime à 900
       épisodes déclencherait une alerte géante dès l'activation). */
    if (sa.notification_mode === 'each_episode' && episodesReleased != null) {
      const previouslyNotified = sa.last_notified_episode;
      if (previouslyNotified === null || previouslyNotified === undefined) {
        update.last_notified_episode = episodesReleased;
      } else if (episodesReleased > previouslyNotified) {
        newEpisodeAlerts.push({ ...row, previousEpisode: previouslyNotified });
        update.last_notified_episode = episodesReleased;
      }
    }

    row._update = update; // consommé par le CLI pour appliquer --write ; retiré avant impression
  }

  return { results, seasonCompleteAlerts, newEpisodeAlerts };
}

/* ============================================================
   3. NOTIFICATION — ntfy (jamais de lien de visionnage pour les animes)
   ============================================================ */

async function sendAnimeNtfy(ntfyConfig, item, kind) {
  const topic = item.ntfy_topic
    || (ntfyConfig && ntfyConfig.default_topic)
    || (ntfyConfig && ntfyConfig.topic);
  if (!topic) {
    return { ok: false, error: 'Aucun topic ntfy configuré (ni sur cette œuvre, ni via default_topic).' };
  }
  const server = ((ntfyConfig && ntfyConfig.server) || 'https://ntfy.sh').replace(/\/+$/, '');
  const label = item.nickname || item.title;

  let title, message, tags;
  if (kind === 'season_complete') {
    title = `Saison terminee - ${label}`.replace(/[^\x00-\x7F]/g, '');
    message = `La saison est maintenant complete (${item.episodes_released ?? '?'}/${item.episodes_total ?? '?'} episodes).`;
    tags = 'checkered_flag';
  } else {
    title = `Nouvel episode - ${label}`.replace(/[^\x00-\x7F]/g, '');
    message = `Episode ${item.episodes_released} disponible.`;
    tags = 'tv';
  }

  // Volontairement PAS de header "Click" : contrairement aux scans, on ne
  // renvoie jamais vers un site de visionnage pour les notifications anime.
  const headers = { Title: title, Tags: tags };

  try {
    const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
      method: 'POST', headers, body: message,
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
    const r = await sendAnimeNtfy(ntfyConfig, item, 'season_complete');
    outcomes.push({ id: item.id, title: item.title, kind: 'season_complete', ok: r.ok, error: r.error });
  }
  for (const item of newEpisodeAlerts || []) {
    const r = await sendAnimeNtfy(ntfyConfig, item, 'each_episode');
    outcomes.push({ id: item.id, title: item.title, kind: 'each_episode', ok: r.ok, error: r.error });
  }
  return outcomes;
}

module.exports = {
  queryAnilist, fetchAnilistMedia, computeEpisodesReleased, checkAnimeReleases,
  sendAnimeNtfy, notifyAnimeAlerts,
};

/* ============================================================
   CLI — usage :
     node check-anime-releases.js data.json notif-config.json --write
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

    const { results, seasonCompleteAlerts, newEpisodeAlerts } = await checkAnimeReleases(entries);

    console.error(`Animes suivis vérifiés : ${results.length}`);
    console.error(`Saisons terminées détectées : ${seasonCompleteAlerts.length}`);
    console.error(`Nouveaux épisodes détectés : ${newEpisodeAlerts.length}`);

    // 1) appliquer les résultats à data.json en premier, comme pour le
    //    scan checker — on ne veut jamais perdre une mise à jour à cause
    //    d'un souci de notification en aval.
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

    // 2) notifications — best-effort, ne doit jamais faire échouer le run
    let notifyOutcomes = [];
    const totalAlerts = seasonCompleteAlerts.length + newEpisodeAlerts.length;
    if (totalAlerts) {
      let ntfyConfig = null;
      if (ntfyConfigPath) {
        try {
          ntfyConfig = JSON.parse(fs.readFileSync(ntfyConfigPath, 'utf-8'));
        } catch (e) {
          console.error(`⚠️ Impossible de lire ${ntfyConfigPath} (${e.code || e.message}) — notifications ignorées cette fois.`);
        }
      } else {
        console.error('(Aucun fichier de config ntfy fourni en 2e argument — notifications non envoyées.)');
      }
      if (ntfyConfig) {
        notifyOutcomes = await notifyAnimeAlerts(seasonCompleteAlerts, newEpisodeAlerts, ntfyConfig);
        const sent = notifyOutcomes.filter(o => o.ok).length;
        console.error(`Notifications envoyées : ${sent}/${notifyOutcomes.length}`);
      }
    }

    // nettoyage avant impression (l'objet interne _update ne doit pas fuiter dans la sortie)
    const cleanResults = results.map(({ _update, ...rest }) => rest);

    console.log(JSON.stringify({
      results: cleanResults, seasonCompleteAlerts, newEpisodeAlerts, notifyOutcomes, dataChanged,
    }, null, 1));
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
