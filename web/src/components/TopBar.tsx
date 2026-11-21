import { PanelLeftOpen, SquarePen } from 'lucide-react';
import { navigate, openSettings, setMobileSidebarOpen, toggleSidebarCollapsed } from '../actions';
import { activeProtocol, enabledMembers } from '../lib/settings';
import { useStore } from '../store';
import { MemberDot } from './icons';

export function TopBar({ narrow }: { narrow: boolean }) {
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const title = useStore((s) => {
    if (s.route.kind !== 'conversation') return '';
    const fromOpen = s.open?.id === s.route.id ? s.open.conversation?.title : undefined;
    const id = s.route.id;
    return fromOpen ?? s.conversations.find((c) => c.id === id)?.title ?? '';
  });
  const settings = useStore((s) => s.settings);
  const showSidebarButton = narrow || collapsed;

  const members = settings ? enabledMembers(settings) : [];
  const protocol = settings ? activeProtocol(settings) : undefined;
  const summaryLabel =
    members.length === 1
      ? `Direct answers from ${members[0]!.name}`
      : `${protocol?.name ?? 'Council'} with ${members.map((m) => m.name).join(', ') || 'no members'}`;

  return (
    <header className="topbar">
      <div className="topbar-start">
        {showSidebarButton && (
          <button
            type="button"
            className="icon-button"
            onClick={() => (narrow ? setMobileSidebarOpen(true) : toggleSidebarCollapsed())}
            aria-label="Open sidebar"
            title="Open sidebar"
          >
            <PanelLeftOpen size={18} aria-hidden="true" />
          </button>
        )}
        {showSidebarButton && (
          <button type="button" className="icon-button" onClick={() => navigate({ kind: 'home' })} aria-label="New chat" title="New chat">
            <SquarePen size={18} aria-hidden="true" />
          </button>
        )}
        <h1 className="topbar-title" title={title || undefined}>
          {title}
        </h1>
      </div>
      {settings && (
        <button
          type="button"
          className="council-summary"
          onClick={() => openSettings('council')}
          aria-label={`${summaryLabel}. Open council settings`}
          title="Council settings"
        >
          <span className="council-summary-dots" aria-hidden="true">
            {members.map((m) => (
              <MemberDot key={m.id} color={m.color} />
            ))}
          </span>
          <span className="council-summary-text">{members.length === 1 ? 'Direct' : protocol?.name}</span>
        </button>
      )}
    </header>
  );
}
