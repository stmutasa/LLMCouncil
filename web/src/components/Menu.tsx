import { Check } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

type Placement = 'top-start' | 'bottom-start' | 'bottom-end';

interface MenuContextValue {
  close: (restoreFocus?: boolean) => void;
}

const MenuContext = createContext<MenuContextValue | null>(null);

interface MenuProps {
  /** Content of the trigger button. */
  trigger: ReactNode;
  /** Accessible name of the trigger, when its content is not descriptive on its own. */
  triggerLabel?: string;
  triggerClassName?: string;
  triggerTitle?: string;
  placement?: Placement;
  /** Accessible name of the menu itself. */
  menuLabel: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
  onOpenChange?: (open: boolean) => void;
}

const MARGIN = 8;

/**
 * Menu button (WAI-ARIA menu pattern): arrow keys move between items, Home/End jump, Escape
 * closes and returns focus to the button, Tab and outside clicks close. The popup is portalled
 * and positioned in viewport coordinates so it is never clipped by scrolling containers.
 */
export function Menu({
  trigger,
  triggerLabel,
  triggerClassName = 'icon-button',
  triggerTitle,
  placement = 'bottom-start',
  menuLabel,
  disabled = false,
  className,
  children,
  onOpenChange,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const openChangeRef = useRef(onOpenChange);
  openChangeRef.current = onOpenChange;

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    setPosition(null);
    openChangeRef.current?.(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  const place = useCallback(() => {
    const button = buttonRef.current;
    const menu = menuRef.current;
    if (!button || !menu) return;
    const rect = button.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = placement === 'bottom-end' ? rect.right - width : rect.left;
    left = Math.max(MARGIN, Math.min(left, vw - width - MARGIN));
    if (placement === 'top-start') {
      setPosition({ left, bottom: Math.max(MARGIN, vh - rect.top + 6) });
    } else {
      let top = rect.bottom + 4;
      if (top + height > vh - MARGIN && rect.top - height - 4 > MARGIN) top = rect.top - height - 4;
      setPosition({ left, top });
    }
  }, [placement]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const items = menuItems(menuRef.current);
    const checked = items.find((el) => el.getAttribute('aria-checked') === 'true');
    (checked ?? items[0])?.focus();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close(false);
    };
    const onReflow = () => place();
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
  }, [open, close, place]);

  const toggle = () => {
    if (open) {
      close();
    } else {
      setOpen(true);
      onOpenChange?.(true);
    }
  };

  const onButtonKeyDown = (e: ReactKeyboardEvent) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) {
      e.preventDefault();
      setOpen(true);
      onOpenChange?.(true);
    }
  };

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = menuItems(menuRef.current);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (i: number) => items[(i + items.length) % items.length]?.focus();
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusAt(index + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusAt(index - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusAt(0);
        break;
      case 'End':
        e.preventDefault();
        focusAt(items.length - 1);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case 'Tab':
        close(false);
        break;
      default:
        break;
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={triggerLabel}
        title={triggerTitle}
        disabled={disabled}
        onClick={toggle}
        onKeyDown={onButtonKeyDown}
      >
        {trigger}
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={menuLabel}
            className={className ? `menu ${className}` : 'menu'}
            style={{
              left: position?.left ?? 0,
              top: position?.top,
              bottom: position?.bottom,
              visibility: position ? 'visible' : 'hidden',
            }}
            onKeyDown={onMenuKeyDown}
          >
            <MenuContext.Provider value={{ close }}>{children}</MenuContext.Provider>
          </div>,
          document.body,
        )}
    </>
  );
}

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])'));
}

interface MenuItemProps {
  onSelect: () => void;
  children: ReactNode;
  /** Present for radio items: whether this one is the current choice. */
  checked?: boolean;
  description?: string;
  icon?: ReactNode;
  danger?: boolean;
  /** Keep focus where onSelect puts it (e.g. an inline editor) instead of on the menu button. */
  restoreFocus?: boolean;
}

export function MenuItem({ onSelect, children, checked, description, icon, danger, restoreFocus = true }: MenuItemProps) {
  const ctx = useContext(MenuContext);
  const radio = checked !== undefined;
  const select = () => {
    ctx?.close(restoreFocus);
    onSelect();
  };
  return (
    <div
      role={radio ? 'menuitemradio' : 'menuitem'}
      aria-checked={radio ? checked : undefined}
      tabIndex={-1}
      className={`menu-item${danger ? ' danger' : ''}`}
      onClick={select}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select();
        }
      }}
    >
      {icon && <span className="menu-item-icon">{icon}</span>}
      <span className="menu-item-body">
        <span className="menu-item-label">{children}</span>
        {description && <span className="menu-item-description">{description}</span>}
      </span>
      {radio && <span className="menu-item-check">{checked && <Check size={16} aria-hidden="true" />}</span>}
    </div>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="menu-separator" />;
}

/** A labelled section of a menu; the visible heading is decorative, the group carries the name. */
export function MenuGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label}>
      <div className="menu-heading" aria-hidden="true">
        {label}
      </div>
      {children}
    </div>
  );
}
