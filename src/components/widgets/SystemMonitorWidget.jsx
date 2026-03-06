import { useState, useEffect } from 'react';
import { useAuth } from '@context';
import WidgetCard from './WidgetCard';

function ProgressBar({ label, percent, color }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', fontWeight: 'var(--weight-medium)' }}>{label}</span>
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-bold)', color, fontVariantNumeric: 'tabular-nums' }}>{percent}%</span>
      </div>
      <div style={{ height: 10, borderRadius: 5, background: 'var(--bg-hover)', overflow: 'hidden' }}>
        <div style={{
          height: '100%',
          borderRadius: 5,
          width: `${percent}%`,
          background: `linear-gradient(90deg, ${color}, ${color}cc)`,
          boxShadow: `0 0 10px ${color}50`,
          transition: 'width 0.6s ease',
        }} />
      </div>
    </div>
  );
}

export default function SystemMonitorWidget({ size = '2x1', onClick }) {
  const { token } = useAuth();
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!token) return;
    const headers = { 'Authorization': `Bearer ${token}` };
    const fetchStats = () => {
      fetch('/api/system', { headers })
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d) setData(d); })
        .catch(() => {});
    };
    fetchStats();
    const iv = setInterval(fetchStats, 3000);
    return () => clearInterval(iv);
  }, [token]);

  const icon = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );

  const cpu = data?.cpu?.percent || 0;
  const mem = data?.memory?.percent || 0;
  const temp = data?.mainTemp || null;

  const cpuColor = cpu > 80 ? '#EF5350' : cpu > 50 ? '#FFA726' : '#4CAF50';
  const memColor = mem > 80 ? '#EF5350' : mem > 60 ? '#FFA726' : '#42A5F5';

  return (
    <WidgetCard title="System Monitor" icon={icon} size={size} onClick={onClick} loading={!data}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, justifyContent: 'center' }}>
        <ProgressBar label="CPU" percent={cpu} color={cpuColor} />
        <ProgressBar label="RAM" percent={mem} color={memColor} />
        {temp !== null && (
          <div style={{
            display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6,
            marginTop: 2, padding: '6px 0 0',
            borderTop: '1px solid var(--border)',
          }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={temp > 70 ? '#EF5350' : 'var(--text-muted)'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 14.76V3.5a2.5 2.5 0 00-5 0v11.26a4.5 4.5 0 105 0z" />
            </svg>
            <span style={{
              fontSize: 'var(--text-sm)',
              fontWeight: 'var(--weight-bold)',
              color: temp > 70 ? '#EF5350' : temp > 55 ? '#FFA726' : 'var(--text-secondary)',
              fontVariantNumeric: 'tabular-nums',
            }}>
              {temp}°C
            </span>
          </div>
        )}
      </div>
    </WidgetCard>
  );
}
