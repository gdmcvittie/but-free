import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'fraudio-test-'));
process.env.DATA_DIR = DATA_DIR;

const db = (await import('../server/db.js')).default;
const { inferLegacyPlaylistKind } = await import('../server/db.js');
const metaStore = (await import('../server/metaStore.js')).default;
const { parseMusicName } = await import('../server/libraryParser.js');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed += 1; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); passed += 1; };

const USER = 'user-test';
db.upsertUser({ id: USER, email: 'test@local' }, {});

const mkBook = (n) => db.upsertItem(USER, {
  kind: 'audiobook', title: `Book ${n}`, author: `Author ${n}`,
  googleFileId: `gf-book-${n}`, drivePath: `Author ${n}/Book ${n}.mp3`
});
const mkTrack = (n) => db.upsertItem(USER, {
  kind: 'track', title: `Track ${n}`, album: `Album ${n}`,
  albumArtist: `Artist ${n}`, author: `Artist ${n}`,
  googleFileId: `gf-track-${n}`, drivePath: `Artist ${n}/Album ${n}/01 Track ${n}.mp3`
});

mkBook(1); mkBook(2); mkTrack(1); mkTrack(2);
const bookIds = db.getUserItems(USER, 'audiobook').map((i) => i.id);
const trackIds = db.getUserItems(USER, 'track').map((i) => i.id);

// ---- syncItems must not prune across kinds (the rescan ping-pong bug) ----
const tracks = db.getUserItems(USER, 'track');
db.syncItems(USER, tracks, []);
eq(db.getUserItems(USER, 'audiobook').length, 2, 'a music scan keeps audiobook rows');
const books = db.getUserItems(USER, 'audiobook');
db.syncItems(USER, books, []);
eq(db.getUserItems(USER, 'track').length, 2, 'an audiobook scan keeps track rows');
db.syncItems(USER, [], []);
eq(db.getUserItems(USER).length, 4, 'an empty listing prunes nothing');
db.syncItems(USER, [], [], { kind: 'music' });
eq(db.getUserItems(USER).length, 2, 'an explicitly-empty music listing prunes only tracks');
db.syncItems(USER, tracks, []);

// ---- favourites: item, artist/author, album ----------------------------
db.toggleFavorite(USER, bookIds[0], true);
db.toggleFavorite(USER, trackIds[0], true);
eq(db.getFavorites(USER, 'audiobooks'), bookIds.slice(0, 1));
eq(db.getFavorites(USER, 'music'), trackIds.slice(0, 1));

db.toggleAuthorFavorite(USER, 'Author 1', true, 'audiobooks');
db.toggleAuthorFavorite(USER, 'Artist 1', true, 'music');
db.toggleAuthorFavorite(USER, 'Ghost Band', true, 'music');
eq(db.getAuthorFavorites(USER, 'music'), ['Artist 1', 'Ghost Band']);
eq(db.getAuthorFavorites(USER, 'audiobooks'), ['Author 1']);

db.toggleAlbumFavorite(USER, 'Artist 1', 'Album 1', true);
eq(db.getAlbumFavorites(USER), ['Artist 1::Album 1']);

// YEAR::Album keys from the old search parser heal to the library artist.
db.raw().albumFavorites[USER] = ['2022::Album 2', 'Artist 1::Album 1'];
// "Album 2" belongs to "Artist 2" in this fixture.
eq(db.getAlbumFavorites(USER).sort(), ['Artist 1::Album 1', 'Artist 2::Album 2']);

// ---- playlists: one library each, never mixed ---------------------------
const audio = db.createPlaylist(USER, 'Books', { kind: 'audiobooks' });
const music = db.createPlaylist(USER, 'Tracks', { kind: 'music' });
db.setPlaylistItems(USER, audio.id, bookIds);
db.setPlaylistItems(USER, music.id, trackIds);
eq(db.getPlaylists(USER, 'audiobooks').map((p) => p.id), [audio.id]);
eq(db.getPlaylists(USER, 'music').map((p) => p.id), [music.id]);
db.setPlaylistItems(USER, audio.id, [...bookIds, ...trackIds]);
eq(db.getPlaylist(USER, audio.id).itemIds.slice().sort(), bookIds.slice().sort(), 'foreign items dropped');

// ---- smart playlists: keyword rules auto-file tracks --------------------
const rapTrack = db.upsertItem(USER, {
  kind: 'track', title: 'Beat Tape', album: 'Bars', albumArtist: 'MC Test',
  author: 'MC Test', googleFileId: 'gf-rap-1', genre: 'Hip Hop'
});
const folkTrack = db.upsertItem(USER, {
  kind: 'track', title: 'Grapes', album: 'Orchard', albumArtist: 'FM Test',
  author: 'FM Test', googleFileId: 'gf-rap-2', genre: 'Folk'
});
eq(folkTrack.genre, 'Folk', 'genre persisted on upsert');
const smartRule = db.createSmartPlaylist(USER, 'Hip Hop / Rap', 'hip hop, rap');
const applied = db.applySmartPlaylists(USER);
eq(applied['Hip Hop / Rap'], 1, 'genre-tag match filed, "Grapes" not matched by "rap"');
const smartPl = db.getPlaylists(USER, 'music').find((p) => p.name === 'Hip Hop / Rap');
ok(smartPl, 'smart playlist created on first match');
eq(db.getPlaylist(USER, smartPl.id).itemIds, [rapTrack.id], 'correct member');
eq(db.applySmartPlaylists(USER)['Hip Hop / Rap'], 0, 're-apply is idempotent');
eq(db.deleteSmartPlaylist(USER, smartRule.id), true);
ok(db.getPlaylists(USER, 'music').some((p) => p.name === 'Hip Hop / Rap'), 'removing the rule keeps the playlist');
db.deletePlaylist(USER, smartPl.id);

// ---- persisted download queue + overwrite lookup ------------------------
db.saveMusicQueue(USER, { j1: { id: 'j1', kind: 'liked', title: 'Liked Music', args: {}, queuedAt: 'x' } });
eq(Object.keys(db.getMusicQueue(USER)), ['j1'], 'queue entry persisted');
db.saveMusicQueue(USER, {});
eq(db.getMusicQueue(USER), {}, 'emptying removes the user map');
const overwritable = db.upsertItem(USER, {
  kind: 'track', title: 'Dup Track', album: 'Dup', albumArtist: 'Dup Artist',
  googleFileId: 'gf-dup-1', drivePath: 'Dup Artist/Dup/01 Dup Track.mp3'
});
eq(db.findItemByDrivePath(USER, 'dup artist/dup/01 dup track.mp3')?.id, overwritable.id, 'path lookup is case-insensitive');
eq(db.findItemByDrivePath(USER, 'nope/nope.mp3'), null);
const ytm = await import('../server/youtubeMusic.js');
db.saveMusicQueue('ghost-user', { g1: { id: 'g1', kind: 'album', title: 'x', args: {}, queuedAt: 'y' } });
const resumed = ytm.resumePendingQueue();
eq(resumed, 0, 'nothing re-queued (ghost entry only)');
eq(db.getMusicQueue('ghost-user'), {}, 'orphan entries pruned');

// ---- dehydrate: exact per-kind partitioning ----------------------------
db.saveProgress(USER, bookIds[0], 10, 100);
db.saveProgress(USER, trackIds[0], 20, 200);
const docA = metaStore.dehydrate(USER, 'audiobooks');
const docM = metaStore.dehydrate(USER, 'music');
eq(Object.values(docA.playlists).map((p) => p.name), ['Books']);
eq(Object.values(docM.playlists).map((p) => p.name), ['Tracks']);
eq(docM.favorites, ['gf-track-1']);
eq(docA.authorFavorites, ['Author 1']);
eq(docM.authorFavorites, ['Artist 1', 'Ghost Band']);
eq(docM.albumFavorites, ['Artist 1::Album 1', 'Artist 2::Album 2']);
eq(docA.albumFavorites, undefined, 'no album favourites in the audiobook doc');
ok(docA.progress['gf-book-1'] && !docA.progress['gf-track-1']);
ok(docM.progress['gf-track-1'] && !docM.progress['gf-book-1']);

// ---- hydrate: round-trips into a fresh install, never across kinds ----
const RT = 'user-rt';
db.upsertUser({ id: RT, email: 'rt@local' }, {});
for (const gf of ['gf-book-1', 'gf-book-2', 'gf-track-1', 'gf-track-2']) {
  db.upsertItem(RT, { kind: gf.includes('book') ? 'audiobook' : 'track', title: gf, googleFileId: gf });
}
metaStore.hydrate(RT, 'audiobooks', docA);
metaStore.hydrate(RT, 'music', docM);
eq(db.getPlaylists(RT, 'audiobooks').length, 1);
eq(db.getPlaylists(RT, 'music').length, 1);
eq(db.getFavorites(RT, 'audiobooks').length, 1);
eq(db.getFavorites(RT, 'music').length, 1);
eq(db.getAuthorFavorites(RT, 'music'), ['Artist 1', 'Ghost Band']);
eq(db.getAlbumFavorites(RT).sort(), ['Artist 1::Album 1', 'Artist 2::Album 2'].sort());

// Re-hydrating is idempotent.
const plCount = db.getPlaylists(RT).length;
metaStore.hydrate(RT, 'audiobooks', docA);
metaStore.hydrate(RT, 'music', docM);
eq(db.getPlaylists(RT).length, plCount, 'hydrate is idempotent');

// ---- legacy playlists without a kind are inferred from their items ------
// Before the audiobook/music split every playlist landed in the audiobooks
// library, which is how music playlists used to turn into audiobook ones.
const legacyItems = { b1: { kind: 'audiobook' }, b2: { kind: 'audiobook' }, t1: { kind: 'track' } };
eq(inferLegacyPlaylistKind({ itemIds: ['t1'] }, legacyItems), 'music', 'a track-only legacy playlist is music');
eq(inferLegacyPlaylistKind({ itemIds: ['b1', 'b2'] }, legacyItems), 'audiobooks', 'a book-only legacy playlist stays audiobooks');
eq(inferLegacyPlaylistKind({ itemIds: ['b1', 't1'] }, legacyItems), 'audiobooks', 'a tie keeps the historical audiobooks default');
eq(inferLegacyPlaylistKind({ itemIds: ['trk_x'] }, {}), 'music', 'id prefix infers music without item metadata');
eq(inferLegacyPlaylistKind({ itemIds: ['b1'], kind: 'music' }, legacyItems), 'music', 'an explicit kind always wins');

// ---- a playlist physically filed in the wrong section heals on read -----
const ON_DISK = 'user-ondisk';
const onDiskDir = path.join(DATA_DIR, 'users', ON_DISK);
fs.mkdirSync(onDiskDir, { recursive: true });
fs.writeFileSync(path.join(onDiskDir, 'audiobooks.json'), JSON.stringify({
  items: {}, progress: {}, favorites: [], authorFavorites: [],
  playlists: { pl_disk: { id: 'pl_disk', name: 'Disk Mix', kind: 'music', itemIds: [], createdAt: 'x', updatedAt: 'x' } },
  abbSeen: [], pullList: null
}));
fs.writeFileSync(path.join(onDiskDir, 'music.json'), JSON.stringify({
  items: {}, progress: {}, favorites: [], authorFavorites: [], albumFavorites: [], playlists: {}, smartPlaylists: {}, musicQueue: {}
}));
fs.writeFileSync(path.join(onDiskDir, 'user.json'), JSON.stringify({
  user: { id: ON_DISK }, settings: {}, offline: [], authorFavoriteKinds: {}
}));
eq(db.getPlaylists(ON_DISK, 'audiobooks'), [], 'mis-filed music playlist is not listed as an audiobook');
eq(db.getPlaylists(ON_DISK, 'music').map((p) => p.id), ['pl_disk'], 'mis-filed playlist is listed with music');

// ---- hydrating before the library is scanned, then again after ----------
// At login the Drive document is read before the first scan, so every
// googleFileId key resolves to nothing. The playlist must not vanish with it.
const LATE = 'user-late';
db.upsertUser({ id: LATE, email: 'late@local' }, {});
const lateDoc = {
  schema: 1, kind: 'music', progress: {}, favorites: [],
  playlists: { pl_late: { id: 'pl_late', name: 'Late Mix', items: ['gf-late-a'], createdAt: 'x' } }
};
const firstPass = metaStore.hydrate(LATE, 'music', lateDoc);
eq(firstPass.playlists, 0, 'playlist cannot resolve before the library is scanned');
eq(db.getPlaylists(LATE, 'music'), [], 'no phantom playlist before the scan');
db.upsertItem(LATE, { kind: 'track', title: 'Late A', albumArtist: 'Late Artist', googleFileId: 'gf-late-a' });
const secondPass = metaStore.hydrate(LATE, 'music', lateDoc);
eq(secondPass.playlists, 1, 'playlist restored once the item exists');
eq(db.getPlaylists(LATE, 'music').map((p) => p.name), ['Late Mix'], 'restored playlist is visible to music');

// ---- a legacy mixed playlist is split across both libraries -------------
const MIX = 'user-mixed';
db.upsertUser({ id: MIX, email: 'mix@local' }, {});
const mixBook = db.upsertItem(MIX, { kind: 'audiobook', title: 'Mix Book', googleFileId: 'gf-mix-book' });
const mixTrack = db.upsertItem(MIX, { kind: 'track', title: 'Mix Track', albumArtist: 'Mix Artist', googleFileId: 'gf-mix-track' });
const mixedDoc = {
  schema: 1, kind: 'audiobooks', progress: {}, favorites: [], authorFavorites: [],
  playlists: { pl_mix: { id: 'pl_mix', name: 'Road Trip', items: ['gf-mix-book', 'gf-mix-track'], createdAt: 'x' } }
};
metaStore.hydrate(MIX, 'audiobooks', mixedDoc);
eq(db.getPlaylists(MIX, 'audiobooks').map((p) => p.name), ['Road Trip'], 'audiobooks keeps its own half');
eq(db.getPlaylist(MIX, 'pl_mix').itemIds, [mixBook.id], 'the track half is not kept as an audiobook');
eq(metaStore.adoptDeferredPlaylists(MIX), 1, 'track half adopted after both documents load');
const mixMusic = db.getPlaylists(MIX, 'music').find((p) => p.name === 'Road Trip');
ok(mixMusic, 'music half of the mixed playlist exists');
eq(db.getPlaylist(MIX, mixMusic.id).itemIds, [mixTrack.id], 'music half holds only the track');

// ---- a whole playlist misfiled into the wrong document is recovered -----
const MF = 'user-misfiled';
db.upsertUser({ id: MF, email: 'mf@local' }, {});
db.upsertItem(MF, { kind: 'track', title: 'MF Track', albumArtist: 'MF Artist', googleFileId: 'gf-mf-track' });
metaStore.hydrate(MF, 'audiobooks', {
  schema: 1, kind: 'audiobooks', progress: {}, favorites: [],
  playlists: { pl_mf: { id: 'pl_mf', name: 'Only Tracks', items: ['gf-mf-track'], createdAt: 'x' } }
});
eq(db.getPlaylists(MF, 'audiobooks'), [], 'a track playlist is not filed as an audiobook');
eq(metaStore.adoptDeferredPlaylists(MF), 1, 'recovered into the owning library');
eq(db.getPlaylists(MF, 'music').map((p) => p.name), ['Only Tracks'], 'recovered playlist lands in music');

// Reverse direction: an audiobook playlist that was misfiled into music.
const RV = 'user-reverse';
db.upsertUser({ id: RV, email: 'rv@local' }, {});
db.upsertItem(RV, { kind: 'audiobook', title: 'RV Book', googleFileId: 'gf-rv-book' });
metaStore.hydrate(RV, 'music', {
  schema: 1, kind: 'music', progress: {}, favorites: [],
  playlists: { pl_rv: { id: 'pl_rv', name: 'Only Books', items: ['gf-rv-book'], createdAt: 'x' } }
});
eq(db.getPlaylists(RV, 'music'), [], 'a book playlist is not filed as music');
eq(metaStore.adoptDeferredPlaylists(RV), 1, 'recovered into audiobooks');
eq(db.getPlaylists(RV, 'audiobooks').map((p) => p.name), ['Only Books'], 'recovered playlist lands in audiobooks');

// ---- music file-name parsing ------------------------------------------
eq(parseMusicName('08 FRENCH TIPS.mp3').title, 'FRENCH TIPS');
eq(parseMusicName('08 FRENCH TIPS.mp3').trackNumber, 8);
eq(parseMusicName('01 - LET IT RIDE.mp3').trackNumber, 1);
eq(parseMusicName('1985.mp3').trackNumber, null, 'bare year is a title, not a track number');

// ---- audiobook chapter grouping ---------------------------------------
const { groupAudiobookItems } = await import('../server/bookGrouper.js');
const chapterItems = [
  { id: 'c2', title: '29 - Whirlwind: The X-Files, Book 2 - 02 - Chapter 2', author: 'Chapter 2', drivePath: 'Charles Grant/The X-Files Bks 1/chapter2.mp3', durationSec: 700, sizeBytes: 1500 },
  { id: 'c1', title: '29 - Whirlwind: The X-Files, Book 2 - 01 - Chapter 1', author: 'Chapter 1', drivePath: 'Charles Grant/The X-Files Bks 1/chapter1.mp3', durationSec: 600, sizeBytes: 1200 },
  { id: 'c10', title: '29 - Whirlwind: The X-Files, Book 2 - 10 - Chapter 10', author: 'Chapter 10', drivePath: 'Charles Grant/The X-Files Bks 1/chapter10.mp3', durationSec: 800, sizeBytes: 1800 },
  { id: 'single', title: 'The Hobbit', author: 'J.R.R. Tolkien', drivePath: 'Tolkien/The Hobbit.m4b', durationSec: 36000, sizeBytes: 500000000 }
];
const groupedBooks = groupAudiobookItems(chapterItems);
eq(groupedBooks.length, 2, 'grouped into 2 books instead of 4 raw items');

const multiBook = groupedBooks.find((b) => b.isMultiPart);
ok(multiBook, 'multi-part book found');
eq(multiBook.partsCount, 3, 'multi-part book has 3 chapters');
eq(multiBook.durationSec, 2100, 'duration correctly summed');
eq(multiBook.sizeBytes, 4500, 'size correctly summed');
eq(multiBook.author, 'Charles Grant', 'author resolved from folder instead of "Chapter X"');
eq(multiBook.parts.map((p) => p.partNumber), [1, 2, 10], 'chapters sorted naturally 1, 2, 10');

const singleBook = groupedBooks.find((b) => !b.isMultiPart);
ok(singleBook, 'single-file book preserved');
eq(singleBook.title, 'The Hobbit');
eq(singleBook.author, 'J.R.R. Tolkien');
eq(singleBook.partsCount, 1);

// Flush the debounced write so no timer fires after the temp dir is removed
// (otherwise the write recreates it and leaks a directory per test run).
db.flush();
fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`PASS ${passed} library/favourites/playlist/audiobook assertions`);