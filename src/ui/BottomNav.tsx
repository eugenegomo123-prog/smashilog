import { Icon, type IconName } from "./Icon";

export interface NavItem<T extends string> {
  id: T;
  label: string;
  icon: IconName;
  // A small red count on the icon's corner (e.g. pending join requests).
  badge?: number;
  // What a screen reader should say for that count ("2 waiting for approval").
  badgeLabel?: string;
}

// The bottom tab bar shared by the host page, the player's session page and
// the account page. Each tab is an icon over a label -- icon on its own line
// so five tabs line up the same way on a narrow phone -- at least 56px tall
// (the usual comfortable thumb target is 44-48px), with the safe-area padding
// for phones with a gesture bar handled in .tabs (styles.css).
//
// `active` can be null: the host's Settings page is opened from the gear in
// the header rather than from a tab, so while it's showing no tab is lit.
export function BottomNav<T extends string>({
  items,
  active,
  onChange,
}: {
  items: NavItem<T>[];
  active: T | null;
  onChange: (id: T) => void;
}) {
  return (
    <nav className="tabs" aria-label="Sections">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={item.id === active ? "active" : ""}
          aria-current={item.id === active ? "page" : undefined}
          onClick={() => onChange(item.id)}
        >
          <Icon name={item.icon} size={22} />
          <span className="tab-label">{item.label}</span>
          {!!item.badge && (
            <span className="tab-badge" aria-label={item.badgeLabel ?? `${item.badge} new`}>
              {item.badge}
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}
