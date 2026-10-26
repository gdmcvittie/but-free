import { useEffect, useState, useRef } from 'react';
import { X, Upload, Image as ImageIcon, Search, Loader2, Trash2, Save, RefreshCw } from 'lucide-react';
import { api } from './api';

export default function Id3EditorModal({ isOpen, itemId, onClose, onSaved, notify }) {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [searching, setSearching] = useState(false);
  const [itemData, setItemData] = useState(null);
  const [coverOptions, setCoverOptions] = useState([]);
  const [showCoverPicker, setShowCoverPicker] = useState(false);

  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [albumArtist, setAlbumArtist] = useState('');
  const [album, setAlbum] = useState('');
  const [series, setSeries] = useState('');
  const [composer, setComposer] = useState('');
  const [genre, setGenre] = useState('');
  const [year, setYear] = useState('');
  const [track, setTrack] = useState('');
  const [disc, setDisc] = useState('');
  const [comment, setComment] = useState('');

  const [coverPreview, setCoverPreview] = useState(null);
  const [coverBase64, setCoverBase64] = useState(null);
  const [coverUrl, setCoverUrl] = useState(null);
  const [removeCover, setRemoveCover] = useState(false);
  const [hasCover, setHasCover] = useState(false);

  const fileInputRef = useRef(null);

  const isAudiobook = itemData?.item?.kind !== 'track';

  useEffect(() => {
    if (!isOpen || !itemId) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, itemId]);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.getId3Item(itemId);
      setItemData(data);
      const item = data.item || {};
      setTitle(item.title || '');
      setArtist(item.author || item.artist || item.albumArtist || '');
      setAlbumArtist(item.albumArtist || item.artist || item.author || '');
      setAlbum(item.album || item.series || '');
      setSeries(item.series || '');
      setComposer(item.narrator || item.composer || '');
      setGenre(item.genre || (isAudiobook ? 'Audiobook' : ''));
      setYear(item.year || '');
      setTrack(item.trackNumber ? String(item.trackNumber) : '');
      setDisc(item.discNumber ? String(item.discNumber) : '');
      setComment(item.comment || item.subtitle || '');
      setCoverPreview(data.coverUrl || null);
      setCoverBase64(null);
      setCoverUrl(null);
      setRemoveCover(false);
      setHasCover(Boolean(data.hasCover));
      setCoverOptions([]);
      setShowCoverPicker(false);
    } catch (err) {
      setLoadError(err.message || 'Could not load tags.');
    } finally {
      setLoading(false);
    }
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const base64 = event.target?.result;
      if (typeof base64 === 'string') {
        setCoverPreview(base64);
        setCoverBase64(base64);
        setCoverUrl(null);
        setRemoveCover(false);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSearchCovers = async () => {
    setSearching(true);
    try {
      const res = await api.searchCovers({
        title,
        artist,
        album,
        kind: isAudiobook ? 'audiobooks' : 'music',
        itemId
      });
      setCoverOptions(res.options || []);
      setShowCoverPicker(true);
      if (!res.options?.length) {
        notify?.('No covers found', (res.sourceErrors || []).join('; ') || `Nothing matched "${res.query}".`, true);
      }
    } catch (err) {
      notify?.('Cover search failed', err.message, true);
    } finally {
      setSearching(false);
    }
  };

  const pickCover = (option) => {
    setCoverPreview(option.artworkUrl);
    setCoverUrl(option.artworkUrl);
    setCoverBase64(null);
    setRemoveCover(false);
    setShowCoverPicker(false);
  };

  const handleRemoveCover = () => {
    setCoverPreview(null);
    setCoverBase64(null);
    setCoverUrl(null);
    setRemoveCover(true);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        title: title.trim(),
        artist: artist.trim(),
        albumArtist: albumArtist.trim() || artist.trim(),
        album: album.trim(),
        genre: genre.trim(),
        year: year.trim(),
        track: track.trim(),
        disc: disc.trim(),
        comment: comment.trim()
      };
      if (isAudiobook) {
        payload.series = series.trim();
        payload.composer = composer.trim();
      } else {
        payload.composer = composer.trim();
      }

      if (removeCover) payload.removeCover = true;
      if (coverBase64) payload.coverBase64 = coverBase64;
      if (coverUrl) payload.coverUrl = coverUrl;

      const res = await api.saveId3Item(itemId, payload);
      if (res?.success) {
        notify?.('ID3 tags updated', 'Tags and cover art saved to the original file.');
        onSaved?.(res);
        onClose?.();
      }
    } catch (err) {
      notify?.('Failed to save tags', err.message, true);
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-container wide" style={{ maxWidth: 760 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>ID3 Tag Editor</h2>
            <p style={{ marginTop: '0.25rem', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
              Edit tags and cover art in place. Audio is copied with no re-encoding.
            </p>
          </div>
          <button type="button" className="modal-close-btn" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {loadError ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem', padding: '2rem', textAlign: 'center' }}>
              <span style={{ color: 'var(--danger, #ef4444)' }}>Could not load tags: {loadError}</span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={load}>
                <RefreshCw size={14} />
                <span>Retry</span>
              </button>
            </div>
          ) : loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '2rem' }}>
              <Loader2 size={16} className="spin" />
              <span>Loading tags...</span>
            </div>
          ) : (
            <>
              <div className="meta-grid">
                <div className="cover-picker-box">
                  <div
                    className="cover-thumb-preview"
                    style={{ width: 140, height: 140 }}
                    onClick={() => fileInputRef.current?.click()}
                    title="Upload cover art"
                  >
                    {coverPreview ? (
                      <img src={coverPreview} alt="Cover art" />
                    ) : (
                      <div className="cover-placeholder">
                        <ImageIcon size={28} />
                        <span>No Cover</span>
                      </div>
                    )}
                    <div className="cover-hover-tag">Change</div>
                  </div>
                  <div className="cover-btn-row">
                    <button type="button" className="btn btn-secondary btn-xs" onClick={() => fileInputRef.current?.click()}>
                      <Upload size={12} />
                      <span>Upload</span>
                    </button>
                    <button type="button" className="btn btn-secondary btn-xs" onClick={handleSearchCovers} disabled={searching}>
                      {searching ? <Loader2 size={12} className="spin" /> : <Search size={12} />}
                      <span>Search</span>
                    </button>
                    {(coverPreview || hasCover) && (
                      <button type="button" className="btn btn-ghost btn-xs" onClick={handleRemoveCover}>
                        <Trash2 size={12} />
                        <span>Remove</span>
                      </button>
                    )}
                  </div>
                  <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" style={{ display: 'none' }} onChange={handleFileChange} />
                </div>

                <div className="meta-fields-main">
                  <div className="form-field">
                    <label className="form-label">Title</label>
                    <input className="stitcher-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Track or book title" />
                  </div>
                  <div className="form-field">
                    <label className="form-label">{isAudiobook ? 'Author' : 'Artist'}</label>
                    <input className="stitcher-input" value={artist} onChange={(e) => setArtist(e.target.value)} placeholder={isAudiobook ? 'Author' : 'Artist'} />
                  </div>
                  <div className="form-grid-2">
                    <div className="form-field">
                      <label className="form-label">Album Artist</label>
                      <input className="stitcher-input" value={albumArtist} onChange={(e) => setAlbumArtist(e.target.value)} />
                    </div>
                    <div className="form-field">
                      <label className="form-label">{isAudiobook ? 'Series / Album' : 'Album'}</label>
                      <input className="stitcher-input" value={album} onChange={(e) => setAlbum(e.target.value)} />
                    </div>
                  </div>
                </div>
              </div>

              {isAudiobook && (
                <div className="form-grid-2">
                  <div className="form-field">
                    <label className="form-label">Series</label>
                    <input className="stitcher-input" value={series} onChange={(e) => setSeries(e.target.value)} placeholder="Series name" />
                  </div>
                  <div className="form-field">
                    <label className="form-label">Narrator</label>
                    <input className="stitcher-input" value={composer} onChange={(e) => setComposer(e.target.value)} placeholder="Narrator" />
                  </div>
                </div>
              )}

              <div className="form-grid-3">
                <div className="form-field">
                  <label className="form-label">Genre</label>
                  <input className="stitcher-input" value={genre} onChange={(e) => setGenre(e.target.value)} />
                </div>
                <div className="form-field">
                  <label className="form-label">Year</label>
                  <input className="stitcher-input" value={year} onChange={(e) => setYear(e.target.value)} placeholder="2024" />
                </div>
                <div className="form-field">
                  <label className="form-label">Track #</label>
                  <input className="stitcher-input" value={track} onChange={(e) => setTrack(e.target.value)} placeholder="1" />
                </div>
              </div>

              <div className="form-grid-3">
                <div className="form-field">
                  <label className="form-label">Disc #</label>
                  <input className="stitcher-input" value={disc} onChange={(e) => setDisc(e.target.value)} placeholder="1" />
                </div>
                {!isAudiobook && (
                  <div className="form-field">
                    <label className="form-label">Composer</label>
                    <input className="stitcher-input" value={composer} onChange={(e) => setComposer(e.target.value)} />
                  </div>
                )}
                <div className="form-field">
                  <label className="form-label">Comment</label>
                  <input className="stitcher-input" value={comment} onChange={(e) => setComment(e.target.value)} />
                </div>
              </div>

              {showCoverPicker && (
                <div style={{ border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', overflow: 'hidden', flexShrink: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.6rem 0.8rem', background: 'var(--panel-bg)' }}>
                    <span style={{ fontSize: '0.88rem', fontWeight: 600 }}>Search results</span>
                    <button type="button" className="btn btn-ghost btn-xs" onClick={() => setShowCoverPicker(false)}>
                      <X size={12} />
                    </button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '0.8rem', padding: '0.8rem', maxHeight: 360, overflowY: 'auto' }}>
                    {coverOptions.length === 0 ? (
                      <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: 'var(--text-muted)', padding: '1rem' }}>
                        No covers found. Try a different search.
                      </div>
                    ) : (
                      coverOptions.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => pickCover(opt)}
                          style={{
                            border: '1px solid var(--border-color)',
                            borderRadius: 'var(--radius-sm)',
                            overflow: 'hidden',
                            background: 'var(--panel-bg)',
                            textAlign: 'left'
                          }}
                        >
                          <img src={opt.thumbnailUrl} alt={opt.title} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover' }} />
                          <div style={{ padding: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                            <div style={{ fontSize: '0.82rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{opt.title}</div>
                            <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{opt.artist}</div>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving || loading || Boolean(loadError)}>
            {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
            <span>{saving ? 'Saving...' : 'Save to file'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
