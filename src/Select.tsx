import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps {
  ariaLabel: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  variant?: 'field' | 'compact';
  onOpenChange?: (open: boolean) => void;
}

export default function Select({
  ariaLabel,
  value,
  options,
  onChange,
  disabled = false,
  placeholder = '请选择',
  variant = 'field',
  onOpenChange,
}: SelectProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [placement, setPlacement] = useState<'top' | 'bottom'>('bottom');
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedIndex = options.findIndex(option => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const activeOption = activeIndex >= 0 ? options[activeIndex] : undefined;

  useEffect(() => {
    onOpenChange?.(open);
  }, [onOpenChange, open]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu();
    };
    document.addEventListener('pointerdown', closeOutside, { passive: true });
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  useEffect(() => () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
  }, []);

  useEffect(() => {
    if (!disabled) return;
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setOpen(false);
    setClosing(false);
  }, [disabled]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    rootRef.current?.querySelector(`[data-select-option="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  function openMenu(direction: 1 | -1 = 1) {
    if (disabled || !options.length) return;
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setClosing(false);
    if (variant === 'compact') {
      setPlacement('top');
    } else {
      const rect = rootRef.current?.getBoundingClientRect();
      if (rect) {
        const menuHeight = Math.min(240, options.length * 36 + 8);
        const below = window.innerHeight - rect.bottom;
        setPlacement(below < menuHeight + 12 && rect.top > below ? 'top' : 'bottom');
      }
    }
    const selectedEnabled = selectedIndex >= 0 && !options[selectedIndex]?.disabled;
    const fallback = direction === 1
      ? options.findIndex(option => !option.disabled)
      : options.findLastIndex(option => !option.disabled);
    setActiveIndex(selectedEnabled ? selectedIndex : fallback);
    setOpen(true);
  }

  function closeMenu(focusTrigger = false) {
    if (!open || closeTimer.current !== null) return;
    setClosing(true);
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 120;
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
      setClosing(false);
      if (focusTrigger) triggerRef.current?.focus();
    }, duration);
  }

  function moveActive(direction: 1 | -1) {
    if (!options.length) return;
    let next = activeIndex;
    for (let count = 0; count < options.length; count += 1) {
      next = (next + direction + options.length) % options.length;
      if (!options[next]?.disabled) {
        setActiveIndex(next);
        return;
      }
    }
  }

  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    closeMenu(true);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      if (!open) openMenu(direction);
      else moveActive(direction);
      return;
    }
    if (event.key === 'Home' && open) {
      event.preventDefault();
      const index = options.findIndex(option => !option.disabled);
      if (index >= 0) setActiveIndex(index);
      return;
    }
    if (event.key === 'End' && open) {
      event.preventDefault();
      const index = options.findLastIndex(option => !option.disabled);
      if (index >= 0) setActiveIndex(index);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open && activeOption) choose(activeIndex);
      else if (open) closeMenu(true);
      else openMenu();
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (event.key === 'Tab') closeMenu();
  }

  return (
    <div ref={rootRef} className={`select select--${variant}${open ? ' is-open' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && activeOption ? `${listId}-option-${activeIndex}` : undefined}
        disabled={disabled || !options.length}
        onClick={() => open ? closeMenu(true) : openMenu()}
        onKeyDown={onKeyDown}
      >
        <span className="select-value">{selected?.label ?? placeholder}</span>
        <svg className="select-caret" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m3 5 3 3 3-3" />
        </svg>
      </button>
      {open && (
        <ul id={listId} className={`select-menu select-menu--${placement}${closing ? ' is-closing' : ''}`} role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <li
              id={`${listId}-option-${index}`}
              key={option.value}
              className={`select-option${index === activeIndex ? ' is-active' : ''}${option.value === value ? ' is-selected' : ''}`}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              data-select-option={index}
              title={option.label}
              onMouseEnter={() => {
                if (!option.disabled) setActiveIndex(index);
              }}
              onMouseDown={event => event.preventDefault()}
              onClick={() => choose(index)}
            >
              <span className="select-option-label">{option.label}</span>
              <span className="select-option-check" aria-hidden="true">{option.value === value ? '✓' : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
