import { useState, useEffect } from 'react';
import { useAuth } from '@context';
import WidgetCard from './WidgetCard';

function formatUptime(seconds) {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function UptimeWidget({ size = '1x1' }) {
  const { token } = useAuth();
  const [uptime, setUptime] = useState(null);

  useEffect(() => {
    if (!token) return;
    const headers = { 'Authorization': `Bearer ${token}` };
    const fetchStats = () => {
      fetch('/api/uptime', { headers })
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.uptime !== undefined) setUptime(d.uptime); })
        .catch(() => {});
    };
    fetchStats();
    const iv = setInterval(fetchStats, 60000);
    return () => clearInterval(iv);
  }, [token]);

  const icon = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v4" /><path d="M12 18v4" /><path d="M4.93 4.93l2.83 2.83" /><path d="M16.24 16.24l2.83 2.83" />
      <path d="M2 12h4" /><path d="M18 12h4" /><path d="M4.93 19.07l2.83-2.83" /><path d="M16.24 7.76l2.83-2.83" />
    </svg>
  );

  return (
    <WidgetCard title="Uptime" icon={icon} size={size} loading={uptime === null}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
        <div style={{ fontSize: 'var(--text-xl)', fontWeight: 'var(--weight-bold)', color: 'var(--accent-green)', lineHeight: 1 }}>
          {formatUptime(uptime)}
        </div>
      </div>
    </WidgetCard>
  );
}
