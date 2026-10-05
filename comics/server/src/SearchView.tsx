import React, { useState, useEffect, useRef } from 'react';
import type { Comic } from './Library';
import { apiUrl, downloadComic } from './api';
import type { GoogleUserProfile } from './AuthModal';

interface LocalComicResult {
  id: any;
  title: string;
  filepath?: string;
  coverImage?: string | null;
  coverUrl?: string;
  type?: string;
  inLibrary: true;
  googleFileId?: string;
}

interface OnlineComicResult {
  title: string;
  chapterUrl: string;
  cover: string | null;
  publisher?: string;
  size?: string;
  year?: string;
  inLibrary?: boolean;
}

interface SearchResponse {
  query: string;
  local: LocalComicResult[];
  online: OnlineComicResult[];
  total: number;
}

interface SearchViewProps {
  onOpenComic: (comic: Comic) => void;
  initialQuery?: string;
  user?: GoogleUserProfile | null;
  onOpenAuthModal?: () => void;
  onOpenDrivePicker?: () => void;
}

const QUICK_SEARCH_TAGS = [
  'Batman',
  'Spider-Man',
  'X-Men',
  'Superman',
  'Deadpool',
  'TMNT',
  'Star Wars',
  'Daredevil',
  'Avengers',
  'Transformers'
];

export default function SearchView({
  onOpenComic,
  initialQuery = '',
  user,
  onOpenAuthModal,
  onOpenDrivePicker
}: SearchViewProps) {
  const [query, setQuery] = useState(initialQuery);
  const [activeTab, setActiveTab] = useState<'all' | 'local' | 'online'>('all');
  const [selectedPublisher, setSelectedPublisher] = useState<string>('All');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  const [localResults, setLocalResults] = useState<LocalComicResult[]>([]);
  const [onlineResults, setOnlineResults] = useState<OnlineComicResult[]>([]);

  // Track downloading states per online comic URL
  const [downloadingUrls, setDownloadingUrls] = useState<Record<string, 'downloading' | 'done' | 'error'>>({});
  const [downloadErrors, setDownloadErrors] = useState<Record<string, string>>({});
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Track cover loading errors for fallback rendering
  const [failedCovers, setFailedCovers] = useState<Set<string>>(new Set());

  const searchInputRef = useRef<HTMLInputElement>(null);

  const performSearch = async (searchTerm: string) => {
    const q = searchTerm.trim();
    if (!q) {
      setLocalResults([]);
      setOnlineResults([]);
      setHasSearched(false);
      return;
    }

    setLoading(true);
    setError(null);
    setHasSearched(true);

    try {
      const res = await fetch(apiUrl(`/api/search?q=${encodeURIComponent(q)}`));
      if (res.ok) {
        const data: SearchResponse = await res.json();
        setLocalResults(data.local || []);
        setOnlineResults(data.online || []);
        return;
      }

      // Fallback: search local comics via /api/comics
      const comicsRes = await fetch(apiUrl('/api/comics'));
      if (comicsRes.ok) {
        const allComics = await comicsRes.json();
        const matches = (allComics || [])
          .filter((c: any) => (c.title || '').toLowerCase().includes(q.toLowerCase()))
          .map((c: any) => ({
            id: c.id,
            title: c.title,
            filepath: c.filepath || '',
            coverImage: c.coverImage,
            coverUrl: apiUrl(`/api/comics/${c.id}/cover`),
            type: c.type || 'CBZ',
            googleFileId: c.googleFileId,
            inLibrary: true as const
          }));
        setLocalResults(matches);
      } else {
        throw new Error(`Search failed: HTTP ${res.status}`);
      }
    } catch (err: any) {
      console.error('Search request error:', err);
      setError(err.message || 'Failed to search comics');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initialQuery) {
      performSearch(initialQuery);
    } else {
      searchInputRef.current?.focus();
    }
  }, [initialQuery]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    performSearch(query);
  };

  const handleTagClick = (tag: string) => {
    setQuery(tag);
    performSearch(tag);
  };

  const handleClear = () => {
    setQuery('');
    setLocalResults([]);
    setOnlineResults([]);
    setHasSearched(false);
    setError(null);
    searchInputRef.current?.focus();
  };

  // Inline download triggered directly from search card
  const handleDownloadOnlineComic = async (item: OnlineComicResult) => {
    if (user === null && onOpenAuthModal) {
      onOpenAuthModal();
      return;
    }
    if (user && !user.driveFolderId && onOpenDrivePicker) {
      onOpenDrivePicker();
      return;
    }

    setDownloadingUrls((prev) => ({ ...prev, [item.chapterUrl]: 'downloading' }));
    setToastMessage(`⚡ Downloading "${item.title}" to Google Drive... You can keep searching!`);
    setDownloadErrors((prev) => {
      const copy = { ...prev };
      delete copy[item.chapterUrl];
      return copy;
    });

    try {
      const result = await downloadComic(item.chapterUrl, undefined, {
        onProgress: (s) => {
          if (s.message) {
            setToastMessage(`⚡ "${item.title}": ${s.message}`);
          }
        }
      });

      setDownloadingUrls((prev) => ({ ...prev, [item.chapterUrl]: 'done' }));

      // Add to local results list
      const newLocalComic: LocalComicResult = {
        id: result.id || Date.now(),
        title: result.title || item.title,
        filepath: result.filePath || '',
        coverImage: result.coverImage || result.coverUrl,
        coverUrl: result.coverImage || result.coverUrl || item.cover || '',
        type: 'CBZ',
        googleFileId: result.googleFileId,
        inLibrary: true
      };

      setLocalResults((prev) => [newLocalComic, ...prev]);

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('comix_library_updated'));
      }

      const compText = result.isCompressed
        ? ` [Compressed ${result.percentSaved || ''}%]`
        : result.compressionError
          ? ` [Not compressed: ${result.compressionError}]`
          : '';
      setToastMessage(`✓ "${result.title || item.title}"${compText} saved to Google Drive! Click "Read Now" or find it in your Library.`);
      setTimeout(() => {
        setToastMessage((cur) => (cur?.includes(item.title) ? null : cur));
      }, 5000);
    } catch (err: any) {
      console.error('Download error from search:', err);
      setDownloadingUrls((prev) => ({ ...prev, [item.chapterUrl]: 'error' }));
      setDownloadErrors((prev) => ({ ...prev, [item.chapterUrl]: err.message || 'Download failed' }));
      setToastMessage(`❌ Download failed: ${err.message || 'Unknown error'}`);
      setTimeout(() => {
        setToastMessage((cur) => (cur?.includes('Download failed') ? null : cur));
      }, 6000);
    }
  };

  // Extract publisher categories for filtering, excluding 'news'
  const publishers = [
    'All',
    ...Array.from(
      new Set(
        onlineResults
          .map((r) => r.publisher)
          .filter((p): p is string => typeof p === 'string' && !p.toLowerCase().includes('news'))
      )
    )
  ];

  // Filtered lists
  const filteredLocal = localResults;

  const filteredOnline = onlineResults.filter((item) => {
    if (selectedPublisher === 'All') return true;
    return item.publisher?.toLowerCase() === selectedPublisher.toLowerCase();
  });

  const totalFilteredCount =
    activeTab === 'all'
      ? filteredLocal.length + filteredOnline.length
      : activeTab === 'local'
      ? filteredLocal.length
      : filteredOnline.length;

  return (
    <div style={{ paddingBottom: '3rem' }}>
      {/* Header */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '0.4rem' }}>
          Unified Comic Search
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>
          Search your Google Drive collection and live GetComics releases simultaneously.
        </p>
      </div>

      {/* Search Input Bar */}
      <form onSubmit={handleSubmit} style={{ marginBottom: '1.25rem' }}>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <span
            style={{
              position: 'absolute',
              left: '1rem',
              fontSize: '1.2rem',
              color: 'var(--text-secondary)',
              pointerEvents: 'none'
            }}
          >
            🔍
          </span>

          <input
            ref={searchInputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search comics by title, superhero, or series (e.g. Batman, Spider-Man, Saga)..."
            style={{
              width: '100%',
              padding: '0.85rem 3.5rem 0.85rem 3rem',
              background: '#1e293b',
              border: '1px solid var(--border-color)',
              borderRadius: '12px',
              color: 'var(--text-primary)',
              fontSize: '1rem',
              outline: 'none',
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.2)',
              transition: 'border-color 0.2s, box-shadow 0.2s'
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'var(--accent-color)';
              e.currentTarget.style.boxShadow = '0 0 0 3px rgba(59, 130, 246, 0.25)';
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'var(--border-color)';
              e.currentTarget.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.2)';
            }}
          />

          <div style={{ position: 'absolute', right: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            {query && (
              <button
                type="button"
                onClick={handleClear}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  fontSize: '1.1rem',
                  padding: '4px 8px',
                  borderRadius: '4px'
                }}
                title="Clear search"
              >
                ✕
              </button>
            )}

            <button
              type="submit"
              disabled={loading || !query.trim()}
              style={{
                background: 'var(--accent-color)',
                color: '#fff',
                border: 'none',
                padding: '0.5rem 1.2rem',
                borderRadius: '8px',
                fontWeight: 600,
                fontSize: '0.9rem',
                cursor: loading || !query.trim() ? 'not-allowed' : 'pointer',
                opacity: loading || !query.trim() ? 0.6 : 1,
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem'
              }}
            >
              {loading ? 'Searching...' : 'Search'}
            </button>
          </div>
        </div>
      </form>

      {/* Quick Search Tag Pills */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1.75rem' }}>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Popular:</span>
        {QUICK_SEARCH_TAGS.map((tag) => (
          <button
            key={tag}
            type="button"
            onClick={() => handleTagClick(tag)}
            style={{
              background: query.toLowerCase() === tag.toLowerCase() ? 'rgba(59, 130, 246, 0.25)' : 'rgba(255, 255, 255, 0.05)',
              border: `1px solid ${query.toLowerCase() === tag.toLowerCase() ? 'var(--accent-color)' : 'var(--border-color)'}`,
              color: query.toLowerCase() === tag.toLowerCase() ? 'var(--accent-color)' : 'var(--text-secondary)',
              padding: '0.25rem 0.75rem',
              borderRadius: '16px',
              fontSize: '0.78rem',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'all 0.15s ease'
            }}
          >
            {tag}
          </button>
        ))}
      </div>

      {/* Error Banner */}
      {error && (
        <div
          style={{
            background: 'rgba(239, 68, 68, 0.12)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: '8px',
            padding: '1rem',
            color: '#f87171',
            marginBottom: '1.5rem',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}
        >
          <div>⚠️ {error}</div>
          <button
            onClick={() => performSearch(query)}
            style={{
              background: 'rgba(239, 68, 68, 0.2)',
              border: 'none',
              color: '#fff',
              padding: '0.3rem 0.75rem',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '0.82rem'
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Segmented Filter Tabs */}
      {hasSearched && !loading && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderBottom: '1px solid var(--border-color)',
            paddingBottom: '0.75rem',
            marginBottom: '1.5rem',
            flexWrap: 'wrap',
            gap: '1rem'
          }}
        >
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={() => setActiveTab('all')}
              style={{
                background: activeTab === 'all' ? 'var(--accent-color)' : 'rgba(255, 255, 255, 0.05)',
                border: 'none',
                color: activeTab === 'all' ? '#fff' : 'var(--text-secondary)',
                padding: '0.45rem 1rem',
                borderRadius: '8px',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.15s'
              }}
            >
              All Results ({filteredLocal.length + filteredOnline.length})
            </button>

            <button
              onClick={() => setActiveTab('local')}
              style={{
                background: activeTab === 'local' ? '#10b981' : 'rgba(255, 255, 255, 0.05)',
                border: 'none',
                color: activeTab === 'local' ? '#fff' : 'var(--text-secondary)',
                padding: '0.45rem 1rem',
                borderRadius: '8px',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.15s'
              }}
            >
              📖 In Library ({filteredLocal.length})
            </button>

            <button
              onClick={() => setActiveTab('online')}
              style={{
                background: activeTab === 'online' ? 'var(--accent-color)' : 'rgba(255, 255, 255, 0.05)',
                border: 'none',
                color: activeTab === 'online' ? '#fff' : 'var(--text-secondary)',
                padding: '0.45rem 1rem',
                borderRadius: '8px',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.15s'
              }}
            >
              🌐 Online GetComics ({filteredOnline.length})
            </button>
          </div>

          {/* Publisher Pills (if online results exist) */}
          {publishers.length > 2 && (activeTab === 'all' || activeTab === 'online') && (
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Publisher:</span>
              {publishers.map((pub) => (
                <button
                  key={pub}
                  onClick={() => setSelectedPublisher(pub)}
                  style={{
                    background: selectedPublisher === pub ? 'rgba(59, 130, 246, 0.3)' : 'transparent',
                    border: `1px solid ${selectedPublisher === pub ? 'var(--accent-color)' : 'var(--border-color)'}`,
                    color: selectedPublisher === pub ? '#93c5fd' : 'var(--text-secondary)',
                    padding: '0.2rem 0.6rem',
                    borderRadius: '12px',
                    fontSize: '0.75rem',
                    cursor: 'pointer'
                  }}
                >
                  {pub}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Loading State */}
      {loading && (
        <div style={{ textAlign: 'center', padding: '4rem 1rem', color: 'var(--accent-color)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '1rem', animation: 'spin 1.5s linear infinite' }}>⏳</div>
          <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>Searching local library and GetComics catalogue...</div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.88rem', marginTop: '0.5rem' }}>
            Fetching live releases, checking digital CBZ availability...
          </div>
        </div>
      )}

      {/* Empty State: Pre-search */}
      {!hasSearched && !loading && (
        <div
          style={{
            textAlign: 'center',
            padding: '4rem 2rem',
            background: 'rgba(255, 255, 255, 0.02)',
            borderRadius: '16px',
            border: '1px dashed var(--border-color)'
          }}
        >
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📚</div>
          <h3 style={{ fontSize: '1.3rem', fontWeight: 600, marginBottom: '0.5rem' }}>
            Search Millions of Comic Pages
          </h3>
          <p style={{ color: 'var(--text-secondary)', maxWidth: '520px', margin: '0 auto 1.5rem', lineHeight: '1.5' }}>
            Enter a title or comic character above to search through your Google Drive collection and live GetComics digital catalog.
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            {['Batman: Year One', 'Amazing Spider-Man', 'Deadpool', 'TMNT The Last Ronin'].map((sample) => (
              <button
                key={sample}
                onClick={() => {
                  setQuery(sample);
                  performSearch(sample);
                }}
                style={{
                  background: 'rgba(59, 130, 246, 0.1)',
                  border: '1px solid rgba(59, 130, 246, 0.3)',
                  color: '#93c5fd',
                  padding: '0.45rem 1rem',
                  borderRadius: '20px',
                  fontSize: '0.85rem',
                  cursor: 'pointer'
                }}
              >
                Try "{sample}"
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Empty State: No results found */}
      {hasSearched && !loading && totalFilteredCount === 0 && (
        <div
          style={{
            textAlign: 'center',
            padding: '3.5rem 2rem',
            background: 'rgba(255, 255, 255, 0.02)',
            borderRadius: '16px',
            border: '1px solid var(--border-color)'
          }}
        >
          <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>🔍</div>
          <h3 style={{ fontSize: '1.2rem', fontWeight: 600, marginBottom: '0.4rem' }}>
            No Comics Found for "{query}"
          </h3>
          <p style={{ color: 'var(--text-secondary)', maxWidth: '440px', margin: '0 auto 1.25rem' }}>
            We couldn't find any matches in your library or on GetComics. Try checking the spelling or searching by a broader keyword.
          </p>
          <button
            onClick={handleClear}
            style={{
              background: 'var(--accent-color)',
              color: '#fff',
              border: 'none',
              padding: '0.5rem 1.2rem',
              borderRadius: '8px',
              cursor: 'pointer',
              fontWeight: 600
            }}
          >
            Clear Search
          </button>
        </div>
      )}

      {/* Results Grid */}
      {hasSearched && !loading && totalFilteredCount > 0 && (
        <div>
          {/* Local Library Section (shown when 'all' or 'local' is active) */}
          {(activeTab === 'all' || activeTab === 'local') && filteredLocal.length > 0 && (
            <div style={{ marginBottom: '2.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
                <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: '#34d399' }}>
                  📖 In Your Library ({filteredLocal.length})
                </h2>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  Ready to read with high-res CBZ reader
                </span>
              </div>

              <div className="library-grid">
                {filteredLocal.map((comic) => {
                  const coverSrc = failedCovers.has(`local_${comic.id}`)
                    ? comic.coverImage || null
                    : apiUrl(`/api/comics/${comic.id}/cover`);

                  return (
                    <div
                      key={`local_${comic.id}`}
                      className="comic-card"
                      style={{ border: '1px solid rgba(52, 211, 153, 0.35)', position: 'relative' }}
                    >
                      <div style={{ position: 'relative' }}>
                        {coverSrc ? (
                          <img
                            src={coverSrc}
                            alt={comic.title}
                            className="comic-cover"
                            onError={() => {
                              setFailedCovers((prev) => new Set([...prev, `local_${comic.id}`]));
                            }}
                          />
                        ) : (
                          <div
                            className="comic-cover placeholder"
                            style={{
                              background: 'linear-gradient(135deg, #065f46 0%, #047857 100%)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexDirection: 'column',
                              color: '#fff'
                            }}
                          >
                            <span style={{ fontSize: '2rem' }}>📖</span>
                            <span style={{ fontSize: '0.8rem', fontWeight: 600, marginTop: '0.5rem' }}>CBZ ARCHIVE</span>
                          </div>
                        )}

                        <div
                          style={{
                            position: 'absolute',
                            top: '8px',
                            left: '8px',
                            background: 'rgba(16, 185, 129, 0.9)',
                            color: '#fff',
                            padding: '3px 8px',
                            borderRadius: '4px',
                            fontSize: '0.68rem',
                            fontWeight: 700,
                            letterSpacing: '0.5px'
                          }}
                        >
                          ✓ IN LIBRARY
                        </div>

                        <div
                          style={{
                            position: 'absolute',
                            bottom: '8px',
                            right: '8px',
                            background: 'rgba(0, 0, 0, 0.75)',
                            color: '#93c5fd',
                            padding: '2px 7px',
                            borderRadius: '4px',
                            fontSize: '0.7rem',
                            fontWeight: 600
                          }}
                        >
                          {comic.type || 'CBZ'}
                        </div>
                      </div>

                      <div className="comic-info">
                        <div className="comic-title" title={comic.title} style={{ marginBottom: '0.75rem' }}>
                          {comic.title}
                        </div>

                        <button
                          onClick={() => onOpenComic(comic as unknown as Comic)}
                          style={{
                            width: '100%',
                            background: '#10b981',
                            color: '#fff',
                            border: 'none',
                            padding: '0.55rem',
                            borderRadius: '6px',
                            fontWeight: 600,
                            fontSize: '0.85rem',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '0.4rem',
                            transition: 'background 0.2s'
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = '#059669')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = '#10b981')}
                        >
                          📖 Read Now
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Online GetComics Section (shown when 'all' or 'online' is active) */}
          {(activeTab === 'all' || activeTab === 'online') && filteredOnline.length > 0 && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
                <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--accent-color)' }}>
                  🌐 Available on GetComics ({filteredOnline.length})
                </h2>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  Click to download high-speed CBZ directly into library
                </span>
              </div>

              <div className="library-grid">
                {filteredOnline.map((item, idx) => {
                  const isDownloading = downloadingUrls[item.chapterUrl] === 'downloading';
                  const isDone = downloadingUrls[item.chapterUrl] === 'done' || item.inLibrary;
                  const dlError = downloadErrors[item.chapterUrl];

                  return (
                    <div key={`online_${idx}`} className="comic-card">
                      <div style={{ position: 'relative' }}>
                        <img
                          src={item.cover || 'https://getcomics.org/share/uploads/2020/04/cropped-GetComics-Favicon.png'}
                          alt={item.title}
                          className="comic-cover"
                          loading="lazy"
                          onError={(e: any) => {
                            e.target.style.opacity = '0.4';
                          }}
                        />

                        {isDone && (
                          <div
                            style={{
                              position: 'absolute',
                              top: '8px',
                              left: '8px',
                              background: 'rgba(16, 185, 129, 0.9)',
                              color: '#fff',
                              padding: '3px 8px',
                              borderRadius: '4px',
                              fontSize: '0.68rem',
                              fontWeight: 700
                            }}
                          >
                            ✓ IN LIBRARY
                          </div>
                        )}

                        {item.size && (
                          <div
                            style={{
                              position: 'absolute',
                              bottom: '8px',
                              right: '8px',
                              background: 'rgba(0, 0, 0, 0.75)',
                              backdropFilter: 'blur(4px)',
                              color: '#93c5fd',
                              padding: '2px 7px',
                              borderRadius: '4px',
                              fontSize: '0.7rem',
                              fontWeight: 600
                            }}
                          >
                            💾 {item.size}
                          </div>
                        )}
                      </div>

                      <div className="comic-info">
                        {item.publisher && (
                          <div
                            style={{
                              fontSize: '0.72rem',
                              color: 'var(--accent-color)',
                              fontWeight: 600,
                              textTransform: 'uppercase',
                              marginBottom: '0.2rem'
                            }}
                          >
                            {item.publisher}
                          </div>
                        )}

                        <div className="comic-title" title={item.title} style={{ marginBottom: '0.6rem' }}>
                          {item.title}
                        </div>

                        {item.year && (
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.6rem' }}>
                            📅 {item.year}
                          </div>
                        )}

                        {dlError && (
                          <div
                            style={{
                              fontSize: '0.72rem',
                              color: '#f87171',
                              marginBottom: '0.4rem',
                              background: 'rgba(239, 68, 68, 0.1)',
                              padding: '3px 6px',
                              borderRadius: '4px'
                            }}
                          >
                            {dlError}
                          </div>
                        )}

                        {isDone ? (
                          <button
                            onClick={() => {
                              const foundLocal = localResults.find(
                                (l) => l.title.toLowerCase().trim() === item.title.toLowerCase().trim()
                              );
                              onOpenComic(
                                foundLocal
                                  ? (foundLocal as unknown as Comic)
                                  : ({
                                      id: Date.now(),
                                      title: item.title,
                                      type: 'CBZ',
                                      coverImage: item.cover,
                                      filepath: ''
                                    } as unknown as Comic)
                              );
                            }}
                            style={{
                              width: '100%',
                              background: '#10b981',
                              color: '#fff',
                              border: 'none',
                              padding: '0.55rem',
                              borderRadius: '6px',
                              fontWeight: 600,
                              fontSize: '0.85rem',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: '0.4rem',
                              transition: 'background 0.2s'
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.background = '#059669')}
                            onMouseLeave={(e) => (e.currentTarget.style.background = '#10b981')}
                          >
                            📖 Read Now
                          </button>
                        ) : (
                          <button
                            onClick={() => handleDownloadOnlineComic(item)}
                            disabled={isDownloading}
                            style={{
                              width: '100%',
                              background: isDownloading ? 'rgba(59, 130, 246, 0.3)' : 'var(--accent-color)',
                              color: '#fff',
                              border: 'none',
                              padding: '0.55rem',
                              borderRadius: '6px',
                              fontWeight: 600,
                              fontSize: '0.85rem',
                              cursor: isDownloading ? 'wait' : 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: '0.4rem',
                              transition: 'all 0.2s'
                            }}
                          >
                            {isDownloading ? (
                              <>
                                <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⏳</span>
                                Downloading...
                              </>
                            ) : (
                              '⚡ Download CBZ'
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Floating Toast Notification */}
      {toastMessage && (
        <div
          style={{
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            background: 'rgba(15, 23, 42, 0.95)',
            border: '1px solid rgba(59, 130, 246, 0.4)',
            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5)',
            backdropFilter: 'blur(12px)',
            color: '#fff',
            padding: '0.85rem 1.25rem',
            borderRadius: '12px',
            fontSize: '0.9rem',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            zIndex: 9999,
            animation: 'slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)'
          }}
        >
          <span>{toastMessage}</span>
          <button
            onClick={() => setToastMessage(null)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: '1rem',
              marginLeft: '0.5rem',
              lineHeight: 1
            }}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
