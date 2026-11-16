import db from './db.js';
import youtubeMusic from './youtubeMusic.js';
import { sanitizeSegment, sanitizeTitle } from './libraryParser.js';

/**
 * Common genre keywords and aliases for matching vibes against tracks.
 */
const GENRE_ALIASES = {
  grunge: ['grunge', 'alternative rock', 'post-grunge', 'alt-rock', '90s rock'],
  alternative: ['alternative', 'alt-rock', 'indie rock', 'indie', 'college rock'],
  rock: ['rock', 'classic rock', 'hard rock', 'garage rock', 'blues rock'],
  metal: ['metal', 'heavy metal', 'thrash', 'doom', 'death metal', 'prog metal', 'numetal'],
  punk: ['punk', 'pop-punk', 'post-punk', 'hardcore', 'emo'],
  synthwave: ['synthwave', 'retrowave', 'electronic', 'synth-pop', 'outrun', 'darksynth'],
  pop: ['pop', 'dance-pop', 'synth-pop', 'indie pop', 'electropop'],
  electronic: ['electronic', 'techno', 'house', 'edm', 'trance', 'downtempo', 'ambient'],
  hiphop: ['hip hop', 'hip-hop', 'rap', 'trap', 'boom bap', 'conscious rap'],
  rnb: ['r&b', 'soul', 'neo-soul', 'contemporary r&b', 'funk'],
  jazz: ['jazz', 'smooth jazz', 'bop', 'fusion', 'swing', 'blues'],
  lofi: ['lo-fi', 'lofi', 'chillhop', 'ambient', 'chillout', 'downtempo'],
  acoustic: ['acoustic', 'folk', 'singer-songwriter', 'unplugged', 'indie folk'],
  classical: ['classical', 'orchestral', 'instrumental', 'soundtrack', 'score']
};

/** Normalizes a string for fuzzy token comparison */
function clean(str = '') {
  return String(str || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extracts meaningful words (length >= 3) from text */
function extractTokens(text = '') {
  return clean(text)
    .split(' ')
    .filter((w) => w.length >= 3 && !['and', 'the', 'for', 'with', 'from', 'best', 'some', 'songs', 'music', 'vibe'].includes(w));
}

/**
 * Calculates a match score between a library track and the wizard criteria.
 */
function scoreTrack(track, { targetBands, targetSongs, vibeTokens, genreAliasesSet }) {
  let score = 0;
  const trackTitle = clean(track.title);
  const trackArtist = clean(track.artist);
  const trackAlbum = clean(track.album);
  const trackGenre = clean(track.genre);

  // 1. Favorite Songs Match (+70 points)
  for (const song of targetSongs) {
    if (song && (trackTitle === song || trackTitle.includes(song) || song.includes(trackTitle))) {
      score += 70;
      break;
    }
  }

  // 2. Target Bands / Artists Match (+60 for exact, +35 for partial)
  for (const band of targetBands) {
    if (band) {
      if (trackArtist === band) {
        score += 60;
        break;
      } else if (trackArtist.includes(band) || band.includes(trackArtist)) {
        score += 35;
        break;
      }
    }
  }

  // 3. Genre & Alias Matches (+35 points)
  for (const alias of genreAliasesSet) {
    if (trackGenre.includes(alias)) {
      score += 35;
      break;
    }
  }

  // 4. Vibe keyword matches in genre, title, album (+15 points per match, up to 30)
  let keywordHits = 0;
  for (const token of vibeTokens) {
    if (trackGenre.includes(token) || trackTitle.includes(token) || trackAlbum.includes(token)) {
      keywordHits += 1;
      score += 15;
      if (keywordHits >= 2) break;
    }
  }

  // 5. Variety jitter (0 - 6 points) to avoid identical playlist order every time
  score += Math.random() * 6;

  return score;
}

/**
 * Suggests a creative playlist name based on user inputs.
 */
function suggestPlaylistName(vibe, bands, songs) {
  const cleanBands = bands.filter(Boolean);
  const cleanSongs = songs.filter(Boolean);
  const cleanVibe = (vibe || '').trim();

  const titleCase = (s) =>
    s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.substr(1).toLowerCase());

  if (cleanBands.length >= 2 && cleanVibe) {
    return `${titleCase(cleanBands[0])} & ${titleCase(cleanBands[1])} · ${titleCase(cleanVibe)} Mix`;
  }
  if (cleanBands.length === 1 && cleanVibe) {
    return `${titleCase(cleanBands[0])} Vibe · ${titleCase(cleanVibe)}`;
  }
  if (cleanBands.length > 0) {
    return `${cleanBands.slice(0, 2).map(titleCase).join(' & ')} Vibe Mix`;
  }
  if (cleanVibe) {
    return `${titleCase(cleanVibe)} Mix`;
  }
  if (cleanSongs.length > 0) {
    return `${titleCase(cleanSongs[0])} & Similar Tracks`;
  }
  return 'Custom Vibe Playlist';
}

/**
 * Generates a playlist by analyzing the user's library and optionally discovering/downloading
 * missing songs from YouTube Music.
 */
export async function generateVibePlaylist(user, options = {}) {
  const {
    vibe = '',
    artists = [],
    favoriteSongs = [],
    targetCount = 50,
    discoverNew = false,
    discoverCount = 5
  } = options;

  const countTarget = Math.max(5, Math.min(100, parseInt(targetCount, 10) || 50));
  const newSongsLimit = Math.max(1, Math.min(25, parseInt(discoverCount, 10) || 5));

  // Normalize inputs
  const targetBands = (Array.isArray(artists) ? artists : String(artists || '').split(','))
    .map((b) => clean(b))
    .filter(Boolean);

  const targetSongs = (Array.isArray(favoriteSongs) ? favoriteSongs : String(favoriteSongs || '').split(','))
    .map((s) => clean(s))
    .filter(Boolean);

  const vibeTokens = extractTokens(vibe);

  // Build active genre aliases set from vibe tokens
  const genreAliasesSet = new Set();
  for (const token of vibeTokens) {
    genreAliasesSet.add(token);
    for (const [key, aliases] of Object.entries(GENRE_ALIASES)) {
      if (token.includes(key) || key.includes(token)) {
        for (const a of aliases) genreAliasesSet.add(a);
      }
    }
  }

  // 1. Analyze user's existing music library
  const libraryTracks = db.getUserItems(user.id, 'track') || [];
  const scoredTracks = [];

  for (const track of libraryTracks) {
    const score = scoreTrack(track, { targetBands, targetSongs, vibeTokens, genreAliasesSet });
    // Require a minimum affinity score
    if (score >= 15) {
      scoredTracks.push({ track, score });
    }
  }

  // Sort by score descending
  scoredTracks.sort((a, b) => b.score - a.score);

  // Determine library count quota vs discovery
  const libraryTarget = discoverNew ? Math.max(0, countTarget - newSongsLimit) : countTarget;

  // Pick library tracks with artist diversity cap (max 3-4 songs per artist)
  const artistCounts = new Map();
  const matchedTracks = [];
  const MAX_PER_ARTIST = libraryTracks.length > 30 ? 3 : 5;

  for (const { track } of scoredTracks) {
    const art = clean(track.artist || 'Unknown');
    const cur = artistCounts.get(art) || 0;
    if (cur < MAX_PER_ARTIST || scoredTracks.length < libraryTarget) {
      artistCounts.set(art, cur + 1);
      matchedTracks.push(track);
      if (matchedTracks.length >= libraryTarget) break;
    }
  }

  // If we couldn't reach the library target with strict threshold, relax scoring
  if (matchedTracks.length < libraryTarget && scoredTracks.length > matchedTracks.length) {
    for (const { track } of scoredTracks) {
      if (!matchedTracks.some((t) => t.id === track.id)) {
        matchedTracks.push(track);
        if (matchedTracks.length >= libraryTarget) break;
      }
    }
  }

  // 2. Discover missing songs not in the library (if enabled)
  let discoveredSongs = [];
  const neededDiscoverCount = discoverNew
    ? Math.min(newSongsLimit, Math.max(1, countTarget - matchedTracks.length))
    : 0;

  if (discoverNew && neededDiscoverCount > 0 && user.musicFolderId) {
    try {
      const searchQueries = [];

      // Add target artists top songs
      for (const b of targetBands.slice(0, 2)) {
        searchQueries.push(`${b} top songs`);
      }
      // Add favorite songs
      for (const s of targetSongs.slice(0, 2)) {
        searchQueries.push(`${s} song`);
      }
      // Add focused vibe / genre query (clean keywords only, not long comma strings)
      if (vibeTokens.length > 0) {
        const primaryVibe = vibeTokens.slice(0, 2).join(' ');
        searchQueries.push(`${primaryVibe} songs`);
      }
      if (targetBands.length > 0) {
        searchQueries.push(`${targetBands[0]} similar artists`);
      }

      // Existing titles set in library for fast deduplication
      const existingTitles = new Set(
        libraryTracks.map((t) => clean(t.title) + '::' + clean(t.artist))
      );
      const existingVideoIds = new Set(
        libraryTracks.map((t) => t.googleFileId).filter(Boolean)
      );

      const candidateSongs = [];
      const seenVideoIds = new Set();
      const hasNonLatinInput = /[^\u0000-\u024F\u1E00-\u1EFF]/.test(vibe + ' ' + targetBands.join(' '));

      // Search YouTube Music in parallel (limit to top 4 queries)
      const topQueries = searchQueries.slice(0, 4);
      const searchResults = await Promise.allSettled(
        topQueries.map((q) => youtubeMusic.search(q).catch(() => ({ songs: [] })))
      );

      for (const res of searchResults) {
        if (res.status === 'fulfilled' && res.value?.songs) {
          for (const s of res.value.songs) {
            if (!s?.videoId || seenVideoIds.has(s.videoId)) continue;
            seenVideoIds.add(s.videoId);

            // Filter out non-Latin scripts if query was pure Latin
            if (!hasNonLatinInput && /[^\u0000-\u024F\u1E00-\u1EFF\s\d.,!?'"()&/–—-]/.test((s.title || '') + ' ' + (s.artist || ''))) {
              continue;
            }

            // Duration check: sensible songs only (45s to 900s)
            if (s.durationSec && (s.durationSec < 45 || s.durationSec > 900)) {
              continue;
            }

            const titleKey = clean(s.title);
            const artistKey = clean(s.artist);
            const fullKey = titleKey + '::' + artistKey;

            // Check if already in library
            if (existingTitles.has(fullKey) || existingVideoIds.has(s.videoId)) {
              continue;
            }

            // Relevance verification against bands, songs, or vibe keywords
            const hasBandAffinity = targetBands.some((b) => artistKey.includes(b) || titleKey.includes(b) || b.includes(artistKey));
            const hasSongAffinity = targetSongs.some((song) => titleKey.includes(song) || song.includes(titleKey));
            const hasVibeAffinity = Array.from(genreAliasesSet).some((alias) => artistKey.includes(alias) || titleKey.includes(alias));
            const hasTokenAffinity = vibeTokens.some((tok) => artistKey.includes(tok) || titleKey.includes(tok));

            // If we have search criteria, require at least one affinity match
            if ((targetBands.length > 0 || targetSongs.length > 0 || vibeTokens.length > 0) &&
                !hasBandAffinity && !hasSongAffinity && !hasVibeAffinity && !hasTokenAffinity) {
              continue;
            }

            candidateSongs.push({
              videoId: s.videoId,
              title: s.title,
              artist: s.artist || targetBands[0] || 'Unknown Artist',
              album: s.album || 'Vibe Discovery',
              durationSec: s.durationSec || 210,
              thumbnail: s.thumbnail || null,
              newDiscovery: true
            });

            if (candidateSongs.length >= neededDiscoverCount) break;
          }
        }
        if (candidateSongs.length >= neededDiscoverCount) break;
      }

      discoveredSongs = candidateSongs.slice(0, neededDiscoverCount);
    } catch (err) {
      console.warn('[PlaylistWizard] Song discovery failed:', err.message);
    }
  }

  // If discovery yielded fewer tracks than needed, backfill from library if available
  if (matchedTracks.length + discoveredSongs.length < countTarget && scoredTracks.length > matchedTracks.length) {
    for (const { track } of scoredTracks) {
      if (!matchedTracks.some((t) => t.id === track.id)) {
        matchedTracks.push(track);
        if (matchedTracks.length + discoveredSongs.length >= countTarget) break;
      }
    }
  }

  const playlistName = suggestPlaylistName(vibe, targetBands, targetSongs);

  return {
    ok: true,
    playlistName,
    matchedTracks,
    discoveredSongs,
    stats: {
      libraryMatched: matchedTracks.length,
      discoveredCount: discoveredSongs.length,
      totalCount: matchedTracks.length + discoveredSongs.length
    }
  };
}
}

export default {
  generateVibePlaylist
};
