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
   2. ÉVALUATION DES RÈGLES DE NOTIFICATION
   ============================================================ */

/**
 * Décide si une notification doit partir pour cette œuvre, à partir de son
 * état de suivi À JOUR (c'est-à-dire après avoir appliqué les valeurs
 * fraîchement récupérées depuis AniList : season_status, current_season,
 * episodes_released...).
 *
 * Ne fait AUCUN appel réseau — fonction pure, facile à tester isolément.
 *
 * @param {object} entry - l'œuvre (title, nickname, anime_url...)
 * @param {object} sa - suivi_anime À JOUR (après mise à jour des champs AniList)
 * @returns {null | {type: 'baseline_only', ...} | {type: 'season_complete'|'each_episode', title, message, tags, click, ...}}
 */
function evaluateAnimeNotification(entry, sa) {
  if (!sa || !sa.notification_mode || sa.notification_mode === 'disabled') return null;
  const label = entry.nickname || entry.title;

  if (sa.notification_mode === 'season_complete') {
    // Condition d'envoi : season_status === 'FINISHED' ET
    // (last_notified_season est null OU last_notified_season < current_season)
    const alreadyNotified = sa.last_notified_season != null && sa.last_notified_season >= sa.current_season;
    if (sa.season_status !== 'FINISHED' || alreadyNotified) return null;

    return {
      type: 'season_complete',
      title: '🔔 SAISON TERMINÉE',
      message: `${label} — Saison ${sa.current_season}\nLa saison est maintenant complète.\nTu peux commencer ton visionnage.`,
      tags: ['tada', 'tv'],
      click: null, // AUCUNE redirection pour ce mode, volontairement
      newLastNotifiedSeason: sa.current_season,
    };
  }

  if (sa.notification_mode === 'each_episode') {
    if (sa.episodes_released == null) return null;

    // Première vérification (jamais notifié pour cette œuvre) : on pose
    // juste une référence de départ, sans notifier — sinon un anime déjà
    // bien avancé (ex: 900 épisodes) spammerait une fausse alerte dès
    // l'activation du suivi.
    if (sa.last_notified_episode === null || sa.last_notified_episode === undefined) {
      return { type: 'baseline_only', newLastNotifiedEpisode: sa.episodes_released };
    }

    // Condition d'envoi : episodes_released > last_notified_episode
    if (sa.episodes_released <= sa.last_notified_episode) return null;

    return {
      type: 'each_episode',
      title: '📺 Nouvel épisode disponible',
      message: `${label} — épisode ${sa.episodes_released}\nUn nouvel épisode vient de sortir.`,
      tags: ['tv', 'clapper'],
      click: entry.anime_url || null, // redirige vers le lien de visionnage, contrairement au mode saison
      newLastNotifiedEpisode: sa.episodes_released,
    };
  }

  return null;
}

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

    // On évalue les règles sur l'état "à jour" (valeurs fraîches d'AniList
    // fusionnées avec le reste du suivi existant), sans encore rien écrire.
    const upToDateSa = { ...sa, ...update };
    const alert = evaluateAnimeNotification(entry, upToDateSa);

    if (alert && alert.type === 'baseline_only') {
      update.last_notified_episode = alert.newLastNotifiedEpisode;
    } else if (alert && alert.type === 'season_complete') {
      update.last_notified_season = alert.newLastNotifiedSeason;
      seasonCompleteAlerts.push({
        id: entry.id, title: entry.title, nickname: entry.nickname || '',
        ntfy_topic: sa.ntfy_topic || null, anime_url: entry.anime_url || null,
        ...alert,
      });
    } else if (alert && alert.type === 'each_episode') {
      update.last_notified_episode = alert.newLastNotifiedEpisode;
      newEpisodeAlerts.push({
        id: entry.id, title: entry.title, nickname: entry.nickname || '',
        ntfy_topic: sa.ntfy_topic || null, anime_url: entry.anime_url || null,
        ...alert,
      });
    }

    const row = {
      id: entry.id, title: entry.title, nickname: entry.nickname || '',
      ntfy_topic: sa.ntfy_topic || null,
      found: true, checkedAt, ...update,
    };
    row._update = update; // consommé par le CLI pour appliquer --write ; retiré avant impression
    results.push(row);
  }

  return { results, seasonCompleteAlerts, newEpisodeAlerts };
}

/* ============================================================
   3. ÉMISSION — POST vers ntfy
   ============================================================ */

/**
 * Envoie une notification ntfy pour une alerte déjà évaluée par
 * evaluateAnimeNotification().
 *
 * IMPORTANT — pourquoi le format JSON et pas les headers HTTP classiques
 * (Title/Tags/Click) : les valeurs de headers HTTP doivent être encodables
 * en Latin-1 (ByteString). Or les titres demandés ici contiennent des
 * emojis ("🔔", "📺") qui ne le sont pas — les envoyer dans un header ferait
 * planter fetch() avec une erreur "invalid header value". ntfy propose donc
 * une API de publication alternative : un POST en JSON vers l'URL racine du
 * serveur (topic inclus dans le corps), qui accepte n'importe quel texte
 * UTF-8 sans restriction. C'est la méthode recommandée par ntfy dès qu'un
 * titre ou message contient des caractères non-ASCII.
 *
 * @param {{server?: string, default_topic?: string, topic?: string}} ntfyConfig
 * @param {object} item - l'alerte retournée par evaluateAnimeNotification, enrichie
 *                         de `ntfy_topic` (override par œuvre, optionnel)
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
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
    tags: item.tags, // ex: ['tada','tv'] ou ['tv','clapper']
  };
  // Mode "chaque épisode" seulement : clique -> lien de visionnage.
  // Mode "saison complète" : item.click est toujours null, donc rien n'est ajouté.
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
