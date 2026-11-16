import React, { useState, useEffect, useMemo } from 'react';
import {
  Tv,
  Radio,
  Play,
  RefreshCw,
  Search,
  AlertCircle,
  Heart as HeartSvg,
  Clock,
  Sparkles,
  Volume2,
  StopCircle
} from 'lucide-react';
import TvPlayer from './TvPlayer.jsx';

function formatDuration(ms) {
  if (!ms || ms <= 0) return null;
  const hours = Math.floor(ms / 3600);
  const minutes = Math.floor((ms % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatClock(seconds) {
  if (!seconds) return '';
  const date = new Date(seconds * 1000);
  let hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12;
  return `${hours}:${minutes} ${ampm}`;
}

function getItemTitle(item, channelType) {
  if (!item) return 'Live Broadcast';
  const show = item.show || item.series;
  const season = item.season;
  const episode = item.episode;
  const title = item.title;

  if (show) {
    let epStr = '';
    if (season && episode) {
      epStr = ` S${season}E${episode.toString().padStart(2, '0')}`;
    }
    if (title && title.toLowerCase() !== show.toLowerCase()) {
      return `${show}${epStr} — ${title}`;
    }
    return `${show}${epStr}`;
  }

  if (title) return title;
  if (item.filename) return item.filename.replace(/\.[^/.]+$/, '');
  return 'Live Broadcast';
}

function computeSchedule(channel, nowSec) {
  const playlist = channel?.playlist || [];
  if (!playlist.length) return null;

  const durations = playlist.map(item => {
    let d = item.duration || 0;
    if (d > 100000) d = Math.floor(d / 1000);
    if (d >= 60) return d;
    if (channel.channelType === 'movies' || channel.channelType === 'genre') return 5400; // 90 min default
    return 1800; // 30 min default
  });

  const total = durations.reduce((a, b) => a + b, 0) || 1;
  const curPos = ((nowSec % total) + total) % total;

  let acc = 0;
  let nowIdx = 0;
  let nowOffset = 0;
  for (let i = 0; i < durations.length; i++) {
    if (curPos < acc + durations[i]) {
      nowIdx = i;
      nowOffset = curPos - acc;
      break;
    }
    acc += durations[i];
  }

  const currentItem = playlist[nowIdx];
  const nextIdx = (nowIdx + 1) % playlist.length;
  const nextItem = playlist[nextIdx];

  const currentDur = durations[nowIdx] || 1800;
  const nextDur = durations[nextIdx] || 1800;

  const startSec = nowSec - nowOffset;
  const stopSec = startSec + currentDur;
  const nextStartSec = stopSec;
  const nextStopSec = nextStartSec + nextDur;

  const progressPct = Math.min(100, Math.max(0, (nowOffset / currentDur) * 100));
  const remainingSec = Math.max(0, currentDur - nowOffset);
  const remainingMin = Math.ceil(remainingSec / 60);

  return {
    nowIdx,
    nowOffset,
    currentItem,
    nextItem,
    startSec,
    stopSec,
    nextStartSec,
    nextStopSec,
    progressPct,
    remainingMin,
    currentDur
  };
}

export default function ChannelsView({
  onPlayChannel,
  favorites = [],
  onToggleFavorite,
  activeVideo = null,
  videoOffset = 0,
  onStopVideo,
  onTimeUpdate,
  onEnded,
  channelPlaylist = null,
  channelIndex = 0
}) {
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [selectedChannelId, setSelectedChannelId] = useState(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const [guideCategory, setGuideCategory] = useState('all');

  // Live clock tick to update program progress bars in real-time
  useEffect(() => {
    const timer = setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000));
    }, 20000);
    return () => clearInterval(timer);
  }, []);

  const loadChannels = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/drive/channels');
      const data = await res.json();
      const list = Array.isArray(data.channels) ? data.channels : [];
      setChannels(list);
      if (list.length > 0 && !selectedChannelId) {
        setSelectedChannelId(list[0].id);
      }
    } catch (err) {
      console.error('Error loading channels:', err);
      setError('Failed to load channels from your Google Drive.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadChannels();
  }, []);

  // Sync selected channel with active playing channel if playing
  useEffect(() => {
    if (channelPlaylist?.id) {
      setSelectedChannelId(channelPlaylist.id);
    }
  }, [channelPlaylist]);

  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    return q ? channels.filter(c => c.name.toLowerCase().includes(q)) : channels;
  }, [channels, q]);

  // Category filtering
  const guideFilteredChannels = useMemo(() => {
    let list = filtered;
    if (guideCategory === 'featured') {
      list = filtered.filter(c => c.channelType === 'new_episodes' || c.channelType === 'movies');
    } else if (guideCategory === 'show') {
      list = filtered.filter(c => c.channelType === 'show');
    } else if (guideCategory === 'genre') {
      list = filtered.filter(c => c.channelType === 'genre');
    } else if (guideCategory === 'faves') {
      list = filtered.filter(c =>
        favorites.some(f => f.title && f.title.toLowerCase() === c.name.toLowerCase())
      );
    }
    return list;
  }, [filtered, guideCategory, favorites]);

  // Selected channel for preview & EPG pane
  const selectedChannel = useMemo(() => {
    if (selectedChannelId) {
      const found = channels.find(c => c.id === selectedChannelId);
      if (found) return found;
    }
    return guideFilteredChannels[0] || channels[0] || null;
  }, [selectedChannelId, channels, guideFilteredChannels]);

  const selectedSchedule = useMemo(() => {
    if (!selectedChannel) return null;
    return computeSchedule(selectedChannel, nowSec);
  }, [selectedChannel, nowSec]);

  const isSelectedFav = selectedChannel
    ? favorites.some(f => f.title && f.title.toLowerCase() === selectedChannel.name.toLowerCase())
    : false;

  const isChannelPlaying = (ch) => {
    return Boolean(
      (channelPlaylist?.id && channelPlaylist.id === ch.id) ||
      (activeVideo && activeVideo.channelId === ch.id)
    );
  };

  const handleTuneIn = (channel, schedule) => {
    if (!channel || !onPlayChannel) return;
    const startIdx = schedule ? schedule.nowIdx : 0;
    const offset = schedule ? schedule.nowOffset : 0;
    onPlayChannel(channel, startIdx, offset);
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: '12px' }}>
        <RefreshCw size={22} className="spin" style={{ color: 'var(--primary)' }} />
        <span style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>Loading Live Channel Guide...</span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Top Header Row with Title, Search & Refresh */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Radio size={20} style={{ color: 'var(--primary)' }} /> Live Channels &amp; TV Guide
          </h1>
          <p style={{ fontSize: '12.5px', color: 'var(--text-secondary)', margin: '4px 0 0' }}>
            TiVo &amp; Roku-style synchronized live TV guide. Tune in and watch continuously.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button className="action-btn" onClick={loadChannels} title="Refresh channels" style={{ padding: '7px 10px', display: 'flex' }}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', borderRadius: '4px', border: '1px solid var(--border-color)', background: '#1c1c24' }}>
            <Search size={14} style={{ color: 'var(--text-muted)' }} />
            <input
              type="text"
              placeholder="Filter channels..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: '12px', width: '160px' }}
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="glass-panel" style={{ padding: '18px', display: 'flex', alignItems: 'center', gap: '10px', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--text-primary)' }}>
          <AlertCircle size={18} style={{ color: 'var(--accent)' }} />
          <span style={{ fontSize: '13px', flex: 1 }}>{error}</span>
          <button className="action-btn" onClick={loadChannels}>Retry</button>
        </div>
      )}

      {!error && channels.length === 0 && (
        <div className="glass-panel" style={{ padding: '28px', textAlign: 'center', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
          <Tv size={34} style={{ color: 'var(--primary)' }} />
          <div style={{ fontSize: '14px', fontWeight: 600 }}>
            No channels built yet.
          </div>
          <div style={{ fontSize: '12.5px', maxWidth: '420px' }}>
            Scan your Google Drive in Settings to build channels. Each TV show and movie genre becomes a 24/7 continuous channel.
          </div>
        </div>
      )}

      {/* =========================================================================
          TI-VO & ROKU STYLE TV GUIDE (Permanent Layout)
          ========================================================================= */}
      {channels.length > 0 && (
        <div className="guide-view-layout">
          {/* Top Hub: Embedded Video Player / Preview (Left) + Detailed EPG Info (Right) */}
          {selectedChannel && (
            <div className="guide-top-hub">
              {/* Left: Video Player (when playing) OR Channel Preview Card */}
              <div className={`guide-preview-card ${!activeVideo ? 'interactive' : ''}`}>
                {activeVideo ? (
                  /* Video Player directly in the TV Guide preview frame */
                  <TvPlayer
                    currentVideo={activeVideo}
                    offset={videoOffset}
                    onStop={onStopVideo}
                    onTimeUpdate={onTimeUpdate}
                    onEnded={onEnded}
                  />
                ) : (
                  /* Channel Preview Poster & Tune In Overlay */
                  <div
                    onClick={() => handleTuneIn(selectedChannel, selectedSchedule)}
                    style={{ position: 'relative', width: '100%', height: '100%', cursor: 'pointer' }}
                    title={`Click to tune into ${selectedChannel.name}`}
                  >
                    {selectedChannel.posterUrl && (
                      <img
                        src={selectedChannel.posterUrl}
                        alt={selectedChannel.name}
                        className="guide-preview-bg"
                      />
                    )}
                    <div className="guide-preview-overlay">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(0,0,0,0.75)', padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 700 }}>
                          <span className="live-dot-pulse" style={{ width: '6px', height: '6px' }} />
                          <span style={{ color: '#f43f5e', letterSpacing: '0.5px' }}>● LIVE</span>
                        </div>

                        <div style={{ fontSize: '11px', color: '#ccc', background: 'rgba(0,0,0,0.6)', padding: '2px 8px', borderRadius: '4px' }}>
                          CLICK TO TUNE IN
                        </div>
                      </div>

                      <div className="guide-preview-play-btn">
                        <Play size={24} fill="#fff" style={{ marginLeft: '3px' }} />
                      </div>

                      <div>
                        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--primary)', letterSpacing: '0.5px', textTransform: 'uppercase' }}>
                          {selectedChannel.channelType === 'show' ? 'TV Show Channel' : selectedChannel.channelType === 'genre' ? 'Movie Genre' : 'Featured Channel'}
                        </div>
                        <div style={{ fontSize: '16px', fontWeight: 800, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {selectedChannel.name}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Right: Roku-style Detailed EPG Info Panel */}
              <div className="guide-info-card">
                <div className="guide-info-accent-bar" />
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {/* Provider & Type header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span className="live-dot-pulse" style={{ width: '6px', height: '6px' }} />
                      <span style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '0.5px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                        GOOGLE DRIVE · {selectedChannel.channelType === 'show' ? 'TV SERIES' : 'MOVIES'}
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (onToggleFavorite) {
                          onToggleFavorite({
                            title: selectedChannel.name,
                            type: selectedChannel.channelType === 'show' ? 'tv' : 'movie',
                            image: selectedChannel.posterUrl
                          });
                        }
                      }}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: isSelectedFav ? 'var(--accent)' : 'var(--text-muted)',
                        cursor: 'pointer',
                        padding: '4px'
                      }}
                      title={isSelectedFav ? 'Remove from favorites' : 'Add to favorites'}
                    >
                      <HeartSvg size={16} fill={isSelectedFav ? 'var(--accent)' : 'none'} />
                    </button>
                  </div>

                  {/* Channel Title */}
                  <h2 style={{ fontSize: '20px', fontWeight: 800, color: '#fff', margin: 0, fontFamily: 'var(--font-display)' }}>
                    {selectedChannel.name}
                  </h2>

                  {/* On Now Details */}
                  {selectedSchedule && (
                    <div style={{ background: '#13131a', border: '1px solid #282836', borderRadius: '4px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: '10px', fontWeight: 800, color: 'var(--primary)', letterSpacing: '0.5px' }}>
                          ON NOW
                        </span>
                        <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)' }}>
                          {formatClock(selectedSchedule.startSec)} – {formatClock(selectedSchedule.stopSec)}
                          <span style={{ color: 'var(--primary)', marginLeft: '6px' }}>
                            ({selectedSchedule.remainingMin}m left)
                          </span>
                        </span>
                      </div>

                      <div style={{ fontSize: '13.5px', fontWeight: 700, color: '#f3f4f6' }}>
                        {getItemTitle(selectedSchedule.currentItem, selectedChannel.channelType)}
                      </div>

                      {/* Progress Bar */}
                      <div style={{ width: '100%', height: '5px', background: '#242432', borderRadius: '3px', overflow: 'hidden', marginTop: '2px' }}>
                        <div
                          style={{
                            width: `${selectedSchedule.progressPct}%`,
                            height: '100%',
                            background: isChannelPlaying(selectedChannel) ? '#10b981' : 'var(--primary-dark)',
                            borderRadius: '3px',
                            transition: 'width 0.4s ease'
                          }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Up Next Preview */}
                  {selectedSchedule?.nextItem && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                      <span style={{ fontWeight: 800, color: 'var(--text-muted)' }}>UP NEXT:</span>
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {getItemTitle(selectedSchedule.nextItem, selectedChannel.channelType)}
                      </span>
                      <span style={{ marginLeft: 'auto', flexShrink: 0, color: 'var(--text-muted)' }}>
                        {formatClock(selectedSchedule.nextStartSec)}
                      </span>
                    </div>
                  )}
                </div>

                {/* Bottom Action Row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '14px' }}>
                  {activeVideo && isChannelPlaying(selectedChannel) ? (
                    <button
                      type="button"
                      className="action-btn"
                      onClick={onStopVideo}
                      style={{ flex: 1, padding: '9px 16px', fontSize: '13px', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', color: 'var(--accent)', borderColor: 'rgba(244, 63, 94, 0.4)' }}
                    >
                      <StopCircle size={15} />
                      <span>Stop Playing</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="action-btn primary"
                      onClick={() => handleTuneIn(selectedChannel, selectedSchedule)}
                      style={{ flex: 1, padding: '9px 16px', fontSize: '13px', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
                    >
                      <Play size={15} fill="#fff" />
                      <span>Tune In Now</span>
                    </button>
                  )}

                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'right' }}>
                    {selectedChannel.playlist?.length || 0} items in rotation
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Guide Table Container */}
          <div className="guide-table-container">
            {/* Table Filter & Toolbar Header */}
            <div className="guide-table-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '13px', fontWeight: 800, letterSpacing: '0.5px', color: '#fff' }}>
                  CHANNEL GUIDE
                </span>
                <span style={{ fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '10px', background: '#252534', color: 'var(--primary)' }}>
                  {guideFilteredChannels.length} CHANNELS
                </span>
              </div>

              {/* Category Pills (matching Roku source filter) */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                {[
                  { id: 'all', label: 'All' },
                  { id: 'featured', label: 'Featured' },
                  { id: 'show', label: 'TV Shows' },
                  { id: 'genre', label: 'Movie Genres' },
                  { id: 'faves', label: 'Favorites' }
                ].map(cat => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setGuideCategory(cat.id)}
                    style={{
                      background: guideCategory === cat.id ? 'var(--primary-dark)' : '#20202a',
                      color: guideCategory === cat.id ? '#fff' : 'var(--text-secondary)',
                      border: '1px solid',
                      borderColor: guideCategory === cat.id ? 'var(--primary-dark)' : 'var(--border-color)',
                      borderRadius: '4px',
                      padding: '4px 10px',
                      fontSize: '11.5px',
                      fontWeight: 600,
                      cursor: 'pointer',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Column Headers Row */}
            <div className="guide-column-headers">
              <div className="guide-col-num" style={{ textAlign: 'center' }}>#</div>
              <div style={{ textAlign: 'center' }}>LOGO</div>
              <div>CHANNEL</div>
              <div>ON NOW</div>
              <div className="guide-col-next">UP NEXT</div>
              <div style={{ textAlign: 'right' }}>ACTIONS</div>
            </div>

            {/* Channel Guide Rows */}
            <div className="guide-table-rows" style={{ display: 'flex', flexDirection: 'column' }}>
              {guideFilteredChannels.map((channel, index) => {
                const schedule = computeSchedule(channel, nowSec);
                const isSelected = selectedChannel?.id === channel.id;
                const isFav = favorites.some(
                  f => f.title && f.title.toLowerCase() === channel.name.toLowerCase()
                );
                const playing = isChannelPlaying(channel);

                return (
                  <div
                    key={channel.id}
                    className={`guide-channel-row ${isSelected ? 'selected' : ''} ${playing ? 'playing' : ''}`}
                    onClick={() => setSelectedChannelId(channel.id)}
                    onDoubleClick={() => handleTuneIn(channel, schedule)}
                    title={`Click to select, double-click to tune into ${channel.name}`}
                  >
                    {/* Channel Number */}
                    <div className="guide-row-num" style={{ fontSize: '12px', fontWeight: 800, color: isSelected ? 'var(--primary)' : 'var(--text-muted)', textAlign: 'center' }}>
                      {(index + 1).toString().padStart(2, '0')}
                    </div>

                    {/* Logo / Thumbnail */}
                    <div
                      style={{
                        width: '52px',
                        height: '30px',
                        borderRadius: '3px',
                        background: '#20202c',
                        overflow: 'hidden',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        position: 'relative',
                        flexShrink: 0
                      }}
                    >
                      {channel.posterUrl ? (
                        <img
                          src={channel.posterUrl}
                          alt={channel.name}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          loading="lazy"
                          onError={(e) => { e.target.style.display = 'none'; }}
                        />
                      ) : (
                        <Tv size={15} style={{ color: 'var(--text-muted)' }} />
                      )}
                      {playing && (
                        <div
                          style={{
                            position: 'absolute',
                            inset: 0,
                            background: 'rgba(16, 185, 129, 0.8)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                          }}
                        >
                          <Volume2 size={13} color="#fff" />
                        </div>
                      )}
                    </div>

                    {/* Channel Name */}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '13px', fontWeight: 700, color: isSelected ? '#fff' : 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {channel.name}
                      </div>
                      <div className="guide-row-meta-sub" style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <span style={{ textTransform: 'capitalize' }}>
                          {channel.channelType === 'show' ? 'TV Show' : channel.channelType === 'genre' ? 'Genre' : 'Featured'}
                        </span>
                        <span>·</span>
                        <span>{channel.playlist?.length || 0} eps</span>
                      </div>
                    </div>

                    {/* On Now Program Info */}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span className="live-dot-pulse" style={{ width: '5px', height: '5px', flexShrink: 0, background: playing ? '#10b981' : '#f43f5e' }} />
                        <span style={{ fontSize: '12.5px', fontWeight: 600, color: '#f3f4f6', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {schedule ? getItemTitle(schedule.currentItem, channel.channelType) : 'Live Broadcast'}
                        </span>
                      </div>
                      {schedule && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '3px' }}>
                          <div style={{ width: '70px', height: '3px', background: '#252536', borderRadius: '2px', overflow: 'hidden', flexShrink: 0 }}>
                            <div style={{ width: `${schedule.progressPct}%`, height: '100%', background: playing ? '#10b981' : 'var(--primary)' }} />
                          </div>
                          <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                            {schedule.remainingMin}m left
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Up Next Program Info */}
                    <div className="guide-row-up-next" style={{ minWidth: 0, fontSize: '11.5px', color: 'var(--text-muted)' }}>
                      {schedule?.nextItem ? (
                        <>
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                            {getItemTitle(schedule.nextItem, channel.channelType)}
                          </div>
                          <div style={{ fontSize: '10px', marginTop: '2px' }}>
                            {formatClock(schedule.nextStartSec)}
                          </div>
                        </>
                      ) : (
                        <span>—</span>
                      )}
                    </div>

                    {/* Actions: Favorite & Tune In */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '6px' }}>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (onToggleFavorite) {
                            onToggleFavorite({
                              title: channel.name,
                              type: channel.channelType === 'show' ? 'tv' : 'movie',
                              image: channel.posterUrl
                            });
                          }
                        }}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: isFav ? 'var(--accent)' : '#666',
                          cursor: 'pointer',
                          padding: '4px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}
                        title={isFav ? 'Remove favorite' : 'Add favorite'}
                      >
                        <HeartSvg size={14} fill={isFav ? 'var(--accent)' : 'none'} />
                      </button>

                      <button
                        type="button"
                        className="action-btn primary"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleTuneIn(channel, schedule);
                        }}
                        style={{
                          padding: '5px 10px',
                          fontSize: '11.5px',
                          fontWeight: 700,
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          background: playing ? '#10b981' : undefined
                        }}
                        title="Tune in"
                      >
                        <Play size={12} fill="#fff" />
                        <span>{playing ? 'Playing' : 'Tune In'}</span>
                      </button>
                    </div>
                  </div>
                );
              })}

              {guideFilteredChannels.length === 0 && (
                <div style={{ textAlign: 'center', padding: '40px 16px', color: 'var(--text-secondary)', fontSize: '13px' }}>
                  No channels match your filter.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
