// ═══════════════════════════════════
// NimbusOS Settings Hub Icons
//
// Large outline icons for the settings grid.
// viewBox 0 0 48 48, stroke-width 1.2
// To customize: replace SVG paths below.
// ═══════════════════════════════════

const H = ({ size = 44, children, style, className }) => (
  <svg
    viewBox="0 0 48 48" width={size} height={size}
    fill="none" stroke="currentColor" strokeWidth="1.2"
    strokeLinecap="round" strokeLinejoin="round"
    style={style} className={className}
  >{children}</svg>
);

// ─── System Tab ───

export function HubStorageIcon(p) {
  return <H {...p}><rect x="6" y="8" width="36" height="10" rx="2"/><rect x="6" y="22" width="36" height="10" rx="2"/><circle cx="12" cy="13" r="1.5"/><circle cx="12" cy="27" r="1.5"/><line x1="30" y1="13" x2="36" y2="13"/><line x1="30" y1="27" x2="36" y2="27"/><rect x="6" y="36" width="36" height="6" rx="2" strokeDasharray="3 2"/></H>;
}

export function HubContainersIcon(p) {
  return <H {...p}><rect x="8" y="8" width="14" height="14" rx="2"/><rect x="26" y="8" width="14" height="14" rx="2"/><rect x="8" y="26" width="14" height="14" rx="2"/><rect x="26" y="26" width="14" height="14" rx="2" strokeDasharray="3 2"/></H>;
}

export function HubNetworkIcon(p) {
  return <H {...p}><circle cx="24" cy="10" r="4"/><circle cx="10" cy="34" r="4"/><circle cx="38" cy="34" r="4"/><line x1="24" y1="14" x2="10" y2="30"/><line x1="24" y1="14" x2="38" y2="30"/><line x1="10" y1="34" x2="38" y2="34"/></H>;
}

export function HubUsersIcon(p) {
  return <H {...p}><circle cx="24" cy="16" r="7"/><path d="M10 40c0-7.7 6.3-14 14-14s14 6.3 14 14"/></H>;
}

export function HubPortalIcon(p) {
  return <H {...p}><rect x="6" y="6" width="36" height="28" rx="3"/><line x1="6" y1="14" x2="42" y2="14"/><circle cx="12" cy="10" r="1.2"/><circle cx="17" cy="10" r="1.2"/><circle cx="22" cy="10" r="1.2"/><line x1="18" y1="40" x2="30" y2="40"/><line x1="24" y1="34" x2="24" y2="40"/></H>;
}

export function HubAppearanceIcon(p) {
  return <H {...p}><circle cx="24" cy="24" r="16"/><path d="M24 8a16 16 0 0 1 0 32" fill="rgba(255,255,255,0.06)"/><circle cx="18" cy="16" r="3"/><circle cx="30" cy="18" r="2.5"/><circle cx="16" cy="28" r="2"/><circle cx="28" cy="30" r="3.5"/></H>;
}

export function HubMonitorIcon(p) {
  return <H {...p}><rect x="6" y="6" width="36" height="36" rx="3"/><polyline points="12 30 18 22 24 28 30 16 36 24"/></H>;
}

export function HubUpdatesIcon(p) {
  return <H {...p}><path d="M24 8v20"/><polyline points="16 20 24 28 32 20"/><path d="M8 34v4a2 2 0 002 2h28a2 2 0 002-2v-4"/></H>;
}

export function HubPowerIcon(p) {
  return <H {...p}><line x1="24" y1="6" x2="24" y2="24"/><path d="M14 12.5A14 14 0 1034 12.5"/></H>;
}

export function HubAboutIcon(p) {
  return <H {...p}><circle cx="24" cy="24" r="16"/><line x1="24" y1="22" x2="24" y2="34"/><circle cx="24" cy="16" r="1.5" fill="currentColor" stroke="none"/></H>;
}

// ─── Storage Tab ───

export function HubDisksIcon(p) {
  return <H {...p}><ellipse cx="24" cy="12" rx="16" ry="6"/><path d="M8 12v24c0 3.3 7.2 6 16 6s16-2.7 16-6V12"/><ellipse cx="24" cy="24" rx="16" ry="6" strokeDasharray="3 2"/></H>;
}

export function HubPoolsIcon(p) {
  return <H {...p}><rect x="6" y="10" width="36" height="8" rx="2"/><rect x="6" y="22" width="36" height="8" rx="2"/><rect x="6" y="34" width="36" height="8" rx="2"/><circle cx="36" cy="14" r="1.5"/><circle cx="36" cy="26" r="1.5"/><circle cx="36" cy="38" r="1.5"/></H>;
}

export function HubSharedFoldersIcon(p) {
  return <H {...p}><path d="M6 14l4-6h12l4 6"/><rect x="6" y="14" width="36" height="24" rx="2"/><line x1="20" y1="24" x2="28" y2="24"/></H>;
}

export function HubHealthIcon(p) {
  return <H {...p}><path d="M24 42s-16-9.6-16-21.6c0-6.6 5.4-12 12-12 3.6 0 6.6 1.5 8 4a10.3 10.3 0 018-4c6.6 0 12 5.4 12 12C44 32.4 28 42 24 42z"/><polyline points="16 26 22 26 24 20 28 32 30 26 36 26"/></H>;
}

// ─── Network Tab ───

export function HubInterfacesIcon(p) {
  return <H {...p}><rect x="8" y="18" width="32" height="16" rx="3"/><line x1="14" y1="24" x2="14" y2="28"/><line x1="20" y1="22" x2="20" y2="28"/><line x1="26" y1="24" x2="26" y2="28"/><line x1="32" y1="20" x2="32" y2="28"/><path d="M16 18v-6h16v6"/></H>;
}

export function HubRemoteAccessIcon(p) {
  return <H {...p}><circle cx="24" cy="24" r="16"/><ellipse cx="24" cy="24" rx="8" ry="16"/><line x1="8" y1="18" x2="40" y2="18"/><line x1="8" y1="30" x2="40" y2="30"/></H>;
}

export function HubDdnsIcon(p) {
  return <H {...p}><path d="M12 28l-4 4 4 4"/><path d="M36 12l4 4-4 4"/><line x1="8" y1="32" x2="32" y2="32"/><line x1="16" y1="16" x2="40" y2="16"/></H>;
}

export function HubReverseProxyIcon(p) {
  return <H {...p}><rect x="6" y="18" width="12" height="12" rx="2"/><rect x="30" y="8" width="12" height="10" rx="2"/><rect x="30" y="30" width="12" height="10" rx="2"/><line x1="18" y1="24" x2="30" y2="13"/><line x1="18" y1="24" x2="30" y2="35"/></H>;
}

export function HubSmbIcon(p) {
  return <H {...p}><path d="M6 14l4-6h12l4 6"/><rect x="6" y="14" width="36" height="24" rx="2"/><path d="M24 24v8"/><path d="M20 28h8"/></H>;
}

export function HubSshIcon(p) {
  return <H {...p}><rect x="6" y="10" width="36" height="28" rx="3"/><text x="24" y="29" textAnchor="middle" fontSize="11" fontWeight="600" fill="none" stroke="currentColor" strokeWidth="1">{'$ _'}</text></H>;
}

export function HubFtpIcon(p) {
  return <H {...p}><path d="M24 6v28"/><polyline points="16 26 24 34 32 26"/><path d="M8 38v2a2 2 0 002 2h28a2 2 0 002-2v-2"/></H>;
}

export function HubNfsIcon(p) {
  return <H {...p}><rect x="10" y="6" width="28" height="36" rx="2"/><line x1="16" y1="14" x2="32" y2="14"/><line x1="16" y1="20" x2="32" y2="20"/><line x1="16" y1="26" x2="28" y2="26"/><path d="M30 32l4 4 8-8" strokeWidth="2"/></H>;
}

export function HubWebDavIcon(p) {
  return <H {...p}><circle cx="24" cy="24" r="16"/><polyline points="16 20 22 30 24 18 26 30 32 20"/></H>;
}

// ─── Security Tab ───

export function HubFirewallIcon(p) {
  return <H {...p}><path d="M24 4L8 12v12c0 11 7 20 16 24 9-4 16-13 16-24V12z"/><polyline points="18 24 22 28 30 20"/></H>;
}

export function HubCertificatesIcon(p) {
  return <H {...p}><rect x="8" y="6" width="32" height="24" rx="3"/><circle cx="24" cy="18" r="6"/><line x1="20" y1="30" x2="20" y2="42"/><line x1="28" y1="30" x2="28" y2="42"/><polyline points="20 38 24 42 28 38"/></H>;
}

export function HubLockIcon(p) {
  return <H {...p}><rect x="12" y="20" width="24" height="20" rx="3"/><path d="M16 20v-6a8 8 0 0116 0v6"/><circle cx="24" cy="30" r="3"/><line x1="24" y1="33" x2="24" y2="36"/></H>;
}

export function HubSessionsIcon(p) {
  return <H {...p}><circle cx="16" cy="16" r="6"/><path d="M6 34c0-5.5 4.5-10 10-10"/><circle cx="32" cy="16" r="6"/><path d="M22 34c0-5.5 4.5-10 10-10"/></H>;
}

export function HubBackupIcon(p) {
  return <H {...p}><path d="M12 40V12l6-6h18a2 2 0 012 2v32a2 2 0 01-2 2H14a2 2 0 01-2-2z"/><path d="M12 12h6V6"/><polyline points="20 28 24 32 32 22"/></H>;
}

export function HubLogsIcon(p) {
  return <H {...p}><rect x="8" y="6" width="32" height="36" rx="2"/><line x1="14" y1="14" x2="34" y2="14"/><line x1="14" y1="20" x2="34" y2="20"/><line x1="14" y1="26" x2="28" y2="26"/><line x1="14" y1="32" x2="22" y2="32"/></H>;
}

export function HubDnsIcon(p) {
  return <H {...p}><circle cx="24" cy="24" r="16"/><text x="24" y="29" textAnchor="middle" fontSize="12" fontWeight="600" fill="none" stroke="currentColor" strokeWidth="1">DNS</text></H>;
}
