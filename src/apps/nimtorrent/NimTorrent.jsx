import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@context';
import Icon from '@icons';
import styles from './NimTorrent.module.css';

const POLL_MS = 2000;

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + ' ' + units[i];
}

function formatRate(bytes) {
  return formatBytes(bytes) + '/s';
}

function formatProgress(progress) {
  return (progress * 100).toFixed(1) + '%';
}

// ─── Inline SVG icons (not in global icon system) ───
const I = { vb: '0 0 24 24', f: 'none', s: 'currentColor', sw: 1.75, lc: 'round', lj: 'round' };
const Svg = ({ size = 16, children }) => (
  <svg width={size} height={size} viewBox={I.vb} fill={I.f} stroke={I.s} strokeWidth={I.sw} strokeLinecap={I.lc} strokeLinejoin={I.lj}>{children}</svg>
);

function PauseIco({ size }) { return <Svg size={size}><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></Svg>; }
function StopIco({ size }) { return <Svg size={size}><rect x="4" y="4" width="16" height="16" rx="2"/></Svg>; }
function TrashFilesIco({ size }) { return <Svg size={size}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></Svg>; }
function MagnetIco({ size }) { return <Svg size={size}><path d="M6 2v6a6 6 0 0012 0V2"/><rect x="2" y="2" width="6" height="4" rx="1"/><rect x="16" y="2" width="6" height="4" rx="1"/></Svg>; }

function StateBadge({ state }) {
  const cls = {
    downloading: styles.badgeDownloading,
    seeding: styles.badgeSeeding,
    paused: styles.badgePaused,
    checking: styles.badgeChecking,
    metadata: styles.badgeChecking,
    error: styles.badgeError,
    finished: styles.badgeSeeding,
  }[state] || '';
  return <span className={`${styles.badge} ${cls}`}>{state}</span>;
}

// ─── Toolbar icon button ───
function Tb({ icon, title, onClick, disabled, danger }) {
  return (
    <button
      className={`${styles.tbBtn} ${danger ? styles.tbBtnDanger : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >{icon}</button>
  );
}

export default function NimTorrent() {
  const { token } = useAuth();
  const [torrents, setTorrents] = useState([]);
  const [stats, setStats] = useState(null);
  const [selected, setSelected] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [magnetInput, setMagnetInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [daemonOk, setDaemonOk] = useState(null);
  const [error, setError] = useState('');
  const [shares, setShares] = useState([]);
  const [savePath, setSavePath] = useState('');
  const timerRef = useRef(null);

  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  const fetchData = useCallback(() => {
    Promise.all([
      fetch('/api/torrent/torrents', { headers: { 'Authorization': `Bearer ${token}` } }).then(r => r.json()),
      fetch('/api/torrent/stats', { headers: { 'Authorization': `Bearer ${token}` } }).then(r => r.json()),
    ]).then(([t, s]) => {
      if (t.error) { setDaemonOk(false); return; }
      setDaemonOk(true);
      setTorrents(Array.isArray(t) ? t : []);
      setStats(s);
    }).catch(() => setDaemonOk(false));
  }, [token]);

  useEffect(() => {
    fetchData();
    timerRef.current = setInterval(fetchData, POLL_MS);
    return () => clearInterval(timerRef.current);
  }, [fetchData]);

  useEffect(() => {
    fetch('/api/shares', { headers: { 'Authorization': `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => {
        if (Array.isArray(d)) {
          setShares(d);
          if (d.length > 0 && !savePath) setSavePath(d[0].path);
        }
      })
      .catch(() => {});
  }, [token]);

  // ─── Actions ───
  const addTorrent = async () => {
    if (!magnetInput.trim()) return;
    setAdding(true); setError('');
    try {
      const res = await fetch('/api/torrent/torrent/add', {
        method: 'POST', headers,
        body: JSON.stringify({ magnet: magnetInput.trim(), save_path: savePath || undefined }),
      });
      const data = await res.json();
      if (data.error) setError(data.error);
      else { setShowAdd(false); setMagnetInput(''); fetchData(); }
    } catch { setError('Failed to add torrent'); }
    setAdding(false);
  };

  const addTorrentFile = async (file) => {
    setAdding(true); setError('');
    try {
      const formData = new FormData();
      formData.append('torrent', file);
      formData.append('save_path', savePath || '');
      const res = await fetch('/api/torrent/upload', {
        method: 'POST',
        headers: { Authorization: headers.Authorization },
        body: formData,
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); }
      catch { data = { error: text || `Server returned status ${res.status}` }; }
      if (!res.ok && !data.error) data.error = `Upload failed (HTTP ${res.status})`;
      if (data.error) setError(data.error);
      else { setShowAdd(false); setMagnetInput(''); fetchData(); }
    } catch (err) {
      setError('Upload failed: ' + (err.message || 'Network error'));
    }
    setAdding(false);
  };

  const pauseTorrent = async (hash) => {
    await fetch('/api/torrent/torrent/pause', { method: 'POST', headers, body: JSON.stringify({ hash }) });
    fetchData();
  };
  const resumeTorrent = async (hash) => {
    await fetch('/api/torrent/torrent/resume', { method: 'POST', headers, body: JSON.stringify({ hash }) });
    fetchData();
  };
  const removeTorrent = async (hash, deleteFiles = false) => {
    if (!confirm(deleteFiles ? 'Remove torrent AND delete files from disk?' : 'Remove torrent from list? Files will be kept.')) return;
    await fetch('/api/torrent/torrent/remove', { method: 'POST', headers, body: JSON.stringify({ hash, delete_files: deleteFiles }) });
    setSelected(null); fetchData();
  };

  // ─── States ───
  if (daemonOk === false) {
    return (
      <div className={styles.layout}>
        <div className={styles.notInstalled}>
          <Icon name="cloud" size={64} style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
          <div className={styles.notInstalledTitle}>Torrent Engine Not Running</div>
          <div className={styles.notInstalledDesc}>
            NimTorrent requires the native torrent daemon (nimos-torrentd).
            Install it from the NimOS App Store or start the service manually.
          </div>
        </div>
      </div>
    );
  }
  if (daemonOk === null) {
    return (
      <div className={styles.layout}>
        <div className={styles.empty}>
          <div style={{ color: 'var(--text-muted)' }}>Connecting to torrent daemon...</div>
        </div>
      </div>
    );
  }

  const sel = torrents.find(t => t.hash === selected);
  const hasSel = !!sel;

  return (
    <div className={styles.layout}>
      {/* ─── Icon Toolbar ─── */}
      <div className={styles.toolbar}>
        <Tb icon={<Icon name="plus" size={16} />} title="Add torrent" onClick={() => setShowAdd(true)} />
        <Tb icon={<MagnetIco size={16} />} title="Add magnet link" onClick={() => setShowAdd(true)} />

        <div className={styles.tbSep} />

        <Tb icon={<Icon name="play" size={16} />} title="Resume" onClick={() => hasSel && resumeTorrent(selected)} disabled={!hasSel || !sel.paused} />
        <Tb icon={<PauseIco size={16} />} title="Pause" onClick={() => hasSel && pauseTorrent(selected)} disabled={!hasSel || sel.paused} />
        <Tb icon={<StopIco size={16} />} title="Stop" onClick={() => hasSel && pauseTorrent(selected)} disabled={!hasSel} />

        <div className={styles.tbSep} />

        <Tb icon={<Icon name="trash" size={16} />} title="Remove (keep files)" onClick={() => hasSel && removeTorrent(selected, false)} disabled={!hasSel} danger />
        <Tb icon={<TrashFilesIco size={16} />} title="Remove with files" onClick={() => hasSel && removeTorrent(selected, true)} disabled={!hasSel} danger />

        <div className={styles.spacer} />

        {stats && (
          <div className={styles.tbStats}>
            <span className={styles.statDown}>↓ {formatRate(stats.download_rate)}</span>
            <span className={styles.statUp}>↑ {formatRate(stats.upload_rate)}</span>
          </div>
        )}
      </div>

      {/* ─── Torrent list ─── */}
      <div className={styles.list}>
        {torrents.length === 0 ? (
          <div className={styles.empty}>
            <Icon name="cloud" size={48} className={styles.emptyIcon} />
            <div>No torrents. Click + to start downloading.</div>
          </div>
        ) : (
          torrents.map(t => {
            const progressColor = t.state === 'seeding' ? '#4CAF50' :
              t.state === 'paused' ? '#FFA726' : '#42A5F5';
            return (
              <div
                key={t.hash}
                className={`${styles.torrent} ${selected === t.hash ? styles.torrentSelected : ''}`}
                onClick={() => setSelected(selected === t.hash ? null : t.hash)}
              >
                <div className={styles.torrentIcon}>
                  <Icon name={t.state === 'seeding' ? 'upload' : 'download'} size={18} />
                </div>
                <div className={styles.torrentInfo}>
                  <div className={styles.torrentName}>{t.name}</div>
                  <div className={styles.torrentMeta}>
                    <span>{formatBytes(t.total_done)} / {formatBytes(t.total_wanted)}</span>
                    <span>{t.peers} peers · {t.seeds} seeds</span>
                  </div>
                </div>
                <div className={styles.progressWrap}>
                  <div className={styles.progressBar}>
                    <div className={styles.progressFill} style={{ width: formatProgress(t.progress), background: progressColor }} />
                  </div>
                  <div className={styles.progressText}>{formatProgress(t.progress)}</div>
                </div>
                <div className={styles.speeds}>
                  {!t.paused && t.download_rate > 0 && <div className={styles.speedDown}>↓ {formatRate(t.download_rate)}</div>}
                  {!t.paused && t.upload_rate > 0 && <div className={styles.speedUp}>↑ {formatRate(t.upload_rate)}</div>}
                  {t.paused && <div style={{ color: 'var(--text-muted)' }}>—</div>}
                </div>
                <StateBadge state={t.state} />
              </div>
            );
          })
        )}
      </div>

      {/* ─── Add torrent modal ─── */}
      {showAdd && (
        <div className={styles.modalOverlay} onClick={() => { setShowAdd(false); setError(''); }}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalTitle}>Add Torrent</div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Download to</label>
              <select className={styles.modalInput} value={savePath} onChange={e => setSavePath(e.target.value)}
                style={{ fontFamily: 'var(--font-sans)', marginBottom: 0 }}>
                {shares.map(s => (
                  <option key={s.name} value={s.path}>{s.name} ({s.path})</option>
                ))}
                <option value="/data/torrents">Default (/data/torrents)</option>
              </select>
            </div>

            <input className={styles.modalInput} placeholder="magnet:?xt=urn:btih:..."
              value={magnetInput} onChange={e => setMagnetInput(e.target.value)} autoFocus
              onKeyDown={e => { if (e.key === 'Enter') addTorrent(); }} />

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '4px 0 12px', color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
              <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
              <span>or</span>
              <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
            </div>

            <label className={styles.toolBtn}
              style={{ width: '100%', justifyContent: 'center', padding: '10px', marginBottom: 12, display: 'flex', cursor: 'pointer' }}>
              <Icon name="upload" size={14} /> Upload .torrent file
              <input type="file" accept=".torrent" style={{ display: 'none' }}
                onChange={(e) => { const file = e.target.files[0]; if (file) addTorrentFile(file); e.target.value = ''; }} />
            </label>

            {error && <div style={{ color: 'var(--accent-red)', fontSize: 'var(--text-xs)', marginBottom: 8 }}>{error}</div>}

            <div className={styles.modalActions}>
              <button className={styles.toolBtn} onClick={() => { setShowAdd(false); setError(''); }}>Cancel</button>
              <button className={styles.toolBtnPrimary} onClick={addTorrent} disabled={adding || !magnetInput.trim()}>
                {adding ? 'Adding...' : 'Add Magnet'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
