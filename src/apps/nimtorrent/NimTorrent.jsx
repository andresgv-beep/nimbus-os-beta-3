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

export default function NimTorrent() {
  const { token } = useAuth();
  const [torrents, setTorrents] = useState([]);
  const [stats, setStats] = useState(null);
  const [selected, setSelected] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [magnetInput, setMagnetInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [daemonOk, setDaemonOk] = useState(null); // null = checking, true/false
  const [error, setError] = useState('');
  const timerRef = useRef(null);

  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  // ─── Polling ───
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

  // ─── Actions ───
  const addTorrent = async () => {
    if (!magnetInput.trim()) return;
    setAdding(true);
    setError('');
    try {
      const res = await fetch('/api/torrent/torrent/add', {
        method: 'POST', headers,
        body: JSON.stringify({ magnet: magnetInput.trim() }),
      });
      const data = await res.json();
      if (data.error) setError(data.error);
      else { setShowAdd(false); setMagnetInput(''); fetchData(); }
    } catch { setError('Failed to add torrent'); }
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
    if (!confirm(deleteFiles ? 'Remove torrent AND delete files?' : 'Remove torrent? Files will be kept.')) return;
    await fetch('/api/torrent/torrent/remove', { method: 'POST', headers, body: JSON.stringify({ hash, delete_files: deleteFiles }) });
    setSelected(null);
    fetchData();
  };

  // ─── Daemon not running ───
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

  // ─── Loading ───
  if (daemonOk === null) {
    return (
      <div className={styles.layout}>
        <div className={styles.empty}>
          <div style={{ color: 'var(--text-muted)' }}>Connecting to torrent daemon...</div>
        </div>
      </div>
    );
  }

  const selectedTorrent = torrents.find(t => t.hash === selected);

  return (
    <div className={styles.layout}>
      {/* Toolbar */}
      <div className={styles.toolbar}>
        <button className={styles.toolBtnPrimary} onClick={() => setShowAdd(true)}>
          <Icon name="plus" size={14} /> Add Torrent
        </button>

        {selectedTorrent && (
          <>
            {selectedTorrent.paused ? (
              <button className={styles.toolBtn} onClick={() => resumeTorrent(selected)}>
                <Icon name="play" size={14} /> Resume
              </button>
            ) : (
              <button className={styles.toolBtn} onClick={() => pauseTorrent(selected)}>
                <Icon name="pause" size={14} /> Pause
              </button>
            )}
            <button className={styles.toolBtnDanger} onClick={() => removeTorrent(selected, false)}>
              <Icon name="x" size={14} /> Remove
            </button>
          </>
        )}

        <div className={styles.spacer} />
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          {torrents.length} torrent{torrents.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Stats bar */}
      {stats && (
        <div className={styles.statsBar}>
          <div className={styles.statItem}>
            <span>↓</span>
            <span className={`${styles.statValue} ${styles.statDown}`}>{formatRate(stats.download_rate)}</span>
          </div>
          <div className={styles.statItem}>
            <span>↑</span>
            <span className={`${styles.statValue} ${styles.statUp}`}>{formatRate(stats.upload_rate)}</span>
          </div>
          <div className={styles.statItem}>
            Active: <span className={styles.statValue}>{stats.active}</span>
          </div>
          <div className={styles.statItem}>
            Seeding: <span className={styles.statValue}>{stats.seeding}</span>
          </div>
        </div>
      )}

      {/* Torrent list */}
      <div className={styles.list}>
        {torrents.length === 0 ? (
          <div className={styles.empty}>
            <Icon name="cloud" size={48} className={styles.emptyIcon} />
            <div>No torrents. Click "Add Torrent" to start downloading.</div>
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

      {/* Add torrent modal */}
      {showAdd && (
        <div className={styles.modalOverlay} onClick={() => { setShowAdd(false); setError(''); }}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalTitle}>Add Torrent</div>
            <input
              className={styles.modalInput}
              placeholder="magnet:?xt=urn:btih:..."
              value={magnetInput}
              onChange={e => setMagnetInput(e.target.value)}
              autoFocus
              onKeyDown={e => { if (e.key === 'Enter') addTorrent(); }}
            />
            {error && <div style={{ color: 'var(--accent-red)', fontSize: 'var(--text-xs)', marginBottom: 8 }}>{error}</div>}
            <div className={styles.modalActions}>
              <button className={styles.toolBtn} onClick={() => { setShowAdd(false); setError(''); }}>Cancel</button>
              <button className={styles.toolBtnPrimary} onClick={addTorrent} disabled={adding || !magnetInput.trim()}>
                {adding ? 'Adding...' : 'Add'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
