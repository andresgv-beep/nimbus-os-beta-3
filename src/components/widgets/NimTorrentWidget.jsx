import { useState, useEffect } from 'react';
import { useAuth } from '@context';
import WidgetCard from './WidgetCard';

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + ' ' + units[i];
}

function formatRate(bytes) { return formatBytes(bytes) + '/s'; }

// ─── State icons as inline SVG ───
function DownloadingIco() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#42A5F5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M19 12l-7 7-7-7"/>
    </svg>
  );
}

function SeedingIco() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4CAF50" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-5"/>
    </svg>
  );
}

function PausedIco() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#818183" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>
    </svg>
  );
}

function stateIco(state) {
  if (state === 'seeding' || state === 'finished') return <SeedingIco />;
  if (state === 'paused') return <PausedIco />;
  return <DownloadingIco />;
}

function stateLabel(state) {
  if (state === 'seeding' || state === 'finished') return 'Seeding';
  if (state === 'paused') return 'Paused';
  if (state === 'checking' || state === 'metadata') return 'Checking';
  return null;
}

// ─── Single torrent row (compact) ───
function TorrentRow({ t, compact }) {
  const progress = (t.progress * 100).toFixed(1);
  const isActive = t.state === 'downloading' && !t.paused;
  const isDone = t.state === 'seeding' || t.state === 'finished';
  const progressColor = isDone ? '#4CAF50' : t.state === 'paused' ? '#FFA726' : '#42A5F5';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
      <div style={{ flexShrink: 0 }}>{stateIco(t.state)}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)', color: 'var(--text-primary)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {t.name}
        </div>
        {isActive ? (
          <>
            <div style={{ height: 4, borderRadius: 2, background: 'var(--bg-hover)', marginTop: 4, overflow: 'hidden' }}>
              <div style={{ height: '100%', borderRadius: 2, width: `${progress}%`, background: progressColor, transition: 'width 0.5s ease' }} />
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 3, fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ color: '#42A5F5' }}>↓ {formatRate(t.download_rate)}</span>
              <span style={{ color: '#E95420' }}>↑ {formatRate(t.upload_rate)}</span>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 11, color: isDone ? '#4CAF50' : '#818183', marginTop: 2 }}>
            {stateLabel(t.state) || t.state}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Widget header icon ───
const headerIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5v14M19 12l-7 7-7-7"/>
  </svg>
);

export default function NimTorrentWidget({ size = '2x2', onClick }) {
  const { token } = useAuth();
  const [torrents, setTorrents] = useState(null);
  const [stats, setStats] = useState(null);

  useEffect(() => {
    if (!token) return;
    const headers = { 'Authorization': `Bearer ${token}` };
    const poll = () => {
      Promise.all([
        fetch('/api/torrent/torrents', { headers }).then(r => r.ok ? r.json() : null),
        fetch('/api/torrent/stats', { headers }).then(r => r.ok ? r.json() : null),
      ]).then(([t, s]) => {
        if (Array.isArray(t)) setTorrents(t);
        if (s && !s.error) setStats(s);
      }).catch(() => {});
    };
    poll();
    const iv = setInterval(poll, 3000);
    return () => clearInterval(iv);
  }, [token]);

  const is1x1 = size === '1x1';
  const is2x1 = size === '2x1';

  // Sort: downloading first, then recently completed, then seeding, then paused
  const sorted = torrents ? [...torrents].sort((a, b) => {
    const order = { downloading: 0, checking: 1, metadata: 1, seeding: 2, finished: 2, paused: 3 };
    return (order[a.state] ?? 4) - (order[b.state] ?? 4);
  }) : [];

  const top = sorted[0];
  const maxItems = is1x1 ? 1 : is2x1 ? 2 : 4;

  return (
    <WidgetCard title="NimTorrent" icon={headerIcon} size={size} onClick={onClick} loading={torrents === null}>
      {sorted.length === 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          No active torrents
        </div>
      ) : is1x1 && top ? (
        /* 1x1: Show only the most relevant torrent */
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', flex: 1 }}>
          <TorrentRow t={top} compact />
        </div>
      ) : (
        /* 2x1 / 2x2: Show multiple torrents */
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, justifyContent: 'center', gap: 2, overflow: 'hidden' }}>
          {sorted.slice(0, maxItems).map(t => (
            <TorrentRow key={t.hash} t={t} />
          ))}
          {sorted.length > maxItems && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', paddingTop: 2 }}>
              +{sorted.length - maxItems} more
            </div>
          )}
        </div>
      )}
    </WidgetCard>
  );
}
