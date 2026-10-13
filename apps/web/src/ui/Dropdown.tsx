/**
 * Design-system dropdown (replaces the browser's native <select> look).
 *
 * Drop-in for <select>: accepts <option> children, `value`, `onChange(e)` with `e.target.value`,
 * `id`, `disabled`, `aria-*`. Implements the ARIA combobox + listbox pattern with full keyboard
 * support (arrows, Home/End, Enter/Space, Escape, Tab, type-ahead). The option panel is rendered in
 * the browser top layer (Popover API) so it is never clipped by tables/drawers and stays above
 * modal <dialog>s; it falls back to in-place positioning where the Popover API is unavailable.
 */
import {
  Children,
  Fragment,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Check, ChevronDown } from 'lucide-react';

export interface DropdownOption {
  value: string;
  label: ReactNode;
  text: string;
  disabled?: boolean;
}

type ChangeEvent = { target: { value: string }; currentTarget: { value: string } };

export interface DropdownProps {
  value?: string | number | readonly string[];
  onChange?: (e: ChangeEvent) => void;
  children?: ReactNode;
  options?: DropdownOption[];
  id?: string;
  className?: string;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  variant?: 'field' | 'bare';
  /** Treat an empty-value option (e.g. "Choose…") as placeholder text rather than a choice. */
  emptyIsPlaceholder?: boolean;
  'aria-label'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  'aria-describedby'?: string;
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

/** Flattens <option> children (including fragments, arrays and conditionals) into option data. */
export function optionsFromChildren(children: ReactNode): DropdownOption[] {
  const out: DropdownOption[] = [];
  const walk = (nodes: ReactNode) => {
    Children.forEach(nodes, (child) => {
      if (!isValidElement(child)) return;
      const el = child as ReactElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>;
      if (el.type === Fragment) {
        walk(el.props.children);
        return;
      }
      if (el.type === 'option') {
        const text = textOf(el.props.children);
        out.push({
          value: el.props.value !== undefined ? String(el.props.value) : text,
          label: el.props.children,
          text,
          disabled: el.props.disabled,
        });
      }
    });
  };
  walk(children);
  return out;
}

const supportsPopover = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;

export function Dropdown({
  value,
  onChange,
  children,
  options: optionsProp,
  id,
  className,
  disabled,
  placeholder: placeholderProp,
  variant = 'field',
  emptyIsPlaceholder = false,
  ...aria
}: DropdownProps) {
  const allOptions = useMemo(() => optionsProp ?? optionsFromChildren(children), [optionsProp, children]);
  const prompt = emptyIsPlaceholder ? allOptions.find((o) => o.value === '') : undefined;
  const options = useMemo(
    () => (emptyIsPlaceholder ? allOptions.filter((o) => o.value !== '') : allOptions),
    [allOptions, emptyIsPlaceholder],
  );
  const placeholder = placeholderProp ?? prompt?.text ?? 'Select…';
  const current = value === undefined || value === null ? '' : String(value);
  const selectedIndex = options.findIndex((o) => o.value === current);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const autoId = useId();
  const triggerId = id ?? `dd-${autoId}`;
  const listId = `${triggerId}-list`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLUListElement | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const typeahead = useRef({ text: '', at: 0 });

  const enabledIndex = useCallback(
    (from: number, step: 1 | -1) => {
      for (let i = from, n = 0; n < options.length; i += step, n++) {
        const idx = (i + options.length) % options.length;
        if (!options[idx].disabled) return idx;
      }
      return -1;
    },
    [options],
  );

  const openList = useCallback(
    (at?: number) => {
      if (disabled || !options.length) return;
      setActive(at ?? (selectedIndex >= 0 ? selectedIndex : enabledIndex(0, 1)));
      setOpen(true);
      triggerRef.current?.focus(); // keyboard control works however the list was opened
    },
    [disabled, options.length, selectedIndex, enabledIndex],
  );

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const choose = useCallback(
    (idx: number) => {
      const opt = options[idx];
      if (!opt || opt.disabled) return;
      if (opt.value !== current) onChange?.({ target: { value: opt.value }, currentTarget: { value: opt.value } });
      close();
    },
    [options, current, onChange, close],
  );

  // Position the panel against the trigger; flip above when there is no room below.
  const place = useCallback(() => {
    const t = triggerRef.current;
    const p = panelRef.current;
    if (!t || !p) return;
    const r = t.getBoundingClientRect();
    const width = Math.max(r.width, 220);
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const want = Math.min(p.scrollHeight, 320);
    const up = below < Math.min(want, 200) && above > below;
    const maxH = Math.max(120, Math.min(320, up ? above : below));
    const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
    if (supportsPopover) {
      Object.assign(p.style, {
        position: 'fixed',
        left: `${left}px`,
        width: `${width}px`,
        maxHeight: `${maxH}px`,
        top: up ? 'auto' : `${r.bottom + 4}px`,
        bottom: up ? `${window.innerHeight - r.top + 4}px` : 'auto',
      });
    } else {
      Object.assign(p.style, { maxHeight: `${maxH}px`, width: `${width}px` });
    }
  }, []);

  useLayoutEffect(() => {
    const p = panelRef.current;
    if (!p) return;
    if (open) {
      if (supportsPopover && !p.matches(':popover-open')) p.showPopover();
      place();
    } else if (supportsPopover && p.matches(':popover-open')) {
      p.hidePopover();
    }
  }, [open, place]);

  // Keep the active option visible.
  useEffect(() => {
    if (!open || active < 0) return;
    panelRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  // Outside click, scroll and resize handling while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close(false);
    };
    const onScroll = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      place();
    };
    // Escape closes only the list, wherever focus is. A surrounding <dialog> is told to ignore the
    // cancel request this same keystroke produces (see Dialog in kit.tsx).
    const dialog = triggerRef.current?.closest('dialog');
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (dialog) dialog.dataset.dropdownEscapeAt = String(Date.now());
      close();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', place);
    };
  }, [open, close, place]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const key = e.key;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(key)) {
        e.preventDefault();
        openList(key === 'ArrowUp' ? enabledIndex(options.length - 1, -1) : undefined);
      }
      return;
    }
    switch (key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((a) => enabledIndex(a + 1, 1));
        return;
      case 'ArrowUp':
        e.preventDefault();
        setActive((a) => enabledIndex(a - 1, -1));
        return;
      case 'Home':
        e.preventDefault();
        setActive(enabledIndex(0, 1));
        return;
      case 'End':
        e.preventDefault();
        setActive(enabledIndex(options.length - 1, -1));
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        choose(active);
        return;
      case 'Escape':
        // Close the list only; do not let a surrounding <dialog> treat this as cancel.
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      case 'Tab':
        close(false);
        return;
    }
    if (key.length === 1 && /\S/.test(key)) {
      const now = Date.now();
      const t = typeahead.current;
      t.text = now - t.at > 600 ? key.toLowerCase() : t.text + key.toLowerCase();
      t.at = now;
      const start = active < 0 ? 0 : active;
      for (let n = 0; n < options.length; n++) {
        const idx = (start + (t.text.length === 1 ? 1 : 0) + n) % options.length;
        if (!options[idx].disabled && options[idx].text.toLowerCase().startsWith(t.text)) {
          setActive(idx);
          break;
        }
      }
    }
  };

  const invalid = aria['aria-invalid'] === true || aria['aria-invalid'] === 'true';
  return (
    <div className={`dd dd-${variant}${open ? ' dd-open' : ''}${className ? ` ${className}` : ''}`}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        role="combobox"
        className={`dd-trigger${invalid ? ' dd-invalid' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        aria-label={aria['aria-label']}
        aria-invalid={aria['aria-invalid']}
        aria-describedby={aria['aria-describedby']}
        disabled={disabled}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={onKeyDown}
      >
        <span className={`dd-value${selected ? '' : ' dd-placeholder'}`}>{selected ? selected.label : placeholder}</span>
        <ChevronDown size={18} aria-hidden className="dd-chevron" />
      </button>
      <ul
        ref={(el) => {
          panelRef.current = el;
          if (el && supportsPopover && !el.hasAttribute('popover')) el.setAttribute('popover', 'manual');
        }}
        id={listId}
        role="listbox"
        aria-labelledby={triggerId}
        className={`dd-panel${supportsPopover ? '' : ' dd-panel-inline'}`}
        hidden={!supportsPopover && !open}
        tabIndex={-1}
      >
        {options.map((o, i) => (
          <li
            key={`${o.value}-${i}`}
            id={`${listId}-${i}`}
            role="option"
            data-index={i}
            aria-selected={i === selectedIndex}
            aria-disabled={o.disabled || undefined}
            className={`dd-option${i === active ? ' dd-active' : ''}${i === selectedIndex ? ' dd-selected' : ''}${o.disabled ? ' dd-disabled' : ''}`}
            onPointerMove={() => !o.disabled && active !== i && setActive(i)}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => choose(i)}
          >
            <span className="dd-option-label">{o.label}</span>
            {i === selectedIndex && <Check size={16} strokeWidth={2.5} aria-hidden className="dd-check" />}
          </li>
        ))}
      </ul>
    </div>
  );
}
