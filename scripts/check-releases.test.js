const test = require('node:test');
const assert = require('node:assert/strict');
const {
  checkMangaReleases,
  extractMangaDexId,
  fetchLatestComixChapter,
  fetchMangaDexLatestChapter,
  getScanProvider,
} = require('./check-releases');

const comixUrl = 'https://comix.to/title/zq1d5-fuufu-ijou-koibito-miman';

function comixResponse(chapter = 64) {
  const chapterSlug = String(chapter).replace(/^chapter\s*/i, '');
  const payload = {
    queries: {
      [JSON.stringify(['manga', 'zq1d5-fuufu-ijou-koibito-miman'])]: {
        hid: 'zq1d5',
        url: '/title/zq1d5-fuufu-ijou-koibito-miman',
        latestChapter: chapter,
        latestChapterUrl: `/title/zq1d5-fuufu-ijou-koibito-miman/11328924-chapter-${chapterSlug}`,
      },
    },
  };
  return {
    ok: true,
    status: 200,
    text: async () => `<script id="initial-data">${JSON.stringify(payload)}</script>`,
  };
}

test('detects MangaDex and Comix from scan_url', () => {
  assert.equal(getScanProvider(comixUrl), 'comix');
  assert.equal(getScanProvider('mangadex'), 'mangadex');
  assert.equal(getScanProvider('https://mangadex.org/title/87ffa375-bd2c-49ba-ba0c-6d78ea07c342'), 'mangadex');
  assert.equal(
    extractMangaDexId('https://mangadex.org/title/87ffa375-bd2c-49ba-ba0c-6d78ea07c342'),
    '87ffa375-bd2c-49ba-ba0c-6d78ea07c342'
  );
  assert.equal(getScanProvider('https://example.com/title/manga'), null);
});

test('reads the latest chapter from Comix embedded page data', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let requestedUrl;
  global.fetch = async (url) => {
    requestedUrl = String(url);
    return comixResponse('Chapter 64.5');
  };

  const result = await fetchLatestComixChapter(`${comixUrl}/11328924-chapter-64`);
  assert.equal(requestedUrl, comixUrl);
  assert.equal(result.chapter, 64.5);
  assert.equal(result.source, 'comix');
  assert.equal(result.url, `${comixUrl}/11328924-chapter-64.5`);
});

test('reports Cloudflare challenges without attempting a bypass', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => ({
    ok: false,
    status: 403,
    text: async () => '<html>Cloudflare challenge-platform</html>',
  });

  await assert.rejects(
    fetchLatestComixChapter(comixUrl),
    /challenge Cloudflare; aucun contournement n’est tenté/
  );
});

test('uses Comix alone when scan_url points to Comix', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const requestedUrls = [];
  global.fetch = async (url) => {
    requestedUrls.push(String(url));
    return comixResponse();
  };

  const entry = {
    id: 'manga-1',
    title: 'manga',
    scan_url: comixUrl,
    suivi: {
      suivi_actif: true,
      mangadex_id: '87ffa375-bd2c-49ba-ba0c-6d78ea07c342',
      last_notified_chapter: 63,
    },
  };
  const { results, newChapterAlerts } = await checkMangaReleases([entry]);

  assert.deepEqual(requestedUrls, [comixUrl]);
  assert.equal(results[0].source_used, 'comix');
  assert.equal(results[0].dernier_chapitre_paru, 64);
  assert.equal(newChapterAlerts.length, 1);
});

test('selects the highest numbered chapter across MangaDex languages', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (requestUrl) => {
    const url = new URL(String(requestUrl));
    const lang = url.searchParams.get('translatedLanguage[]');
    const chapter = lang === 'en' ? '52' : '50';
    const id = lang === 'en' ? 'chapter-en' : 'chapter-fr';
    return {
      ok: true,
      json: async () => ({
        data: [{ id, attributes: { chapter, readableAt: '2026-01-01T00:00:00Z' } }],
      }),
    };
  };

  const result = await fetchMangaDexLatestChapter(
    '87ffa375-bd2c-49ba-ba0c-6d78ea07c342',
    'vo'
  );
  assert.equal(result.chapter, '52');
  assert.equal(result.source, 'mangadex_en');
});
