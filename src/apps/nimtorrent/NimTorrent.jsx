import styles from './NimTorrent.module.css';

export default function NimTorrent() {
  return (
    <div className={styles.layout}>
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-primary)' }}>
        <h2>NimTorrent</h2>
        <p style={{ color: 'var(--text-muted)' }}>Torrent engine loading...</p>
      </div>
    </div>
  );
}
