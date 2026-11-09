import { useEffect, useMemo, useRef, useState } from 'react';

export type ComboboxOption = { value: string; label: string };

type Props = {
  id?: string;
  options: ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Show this many matches at most (perf). Default 100. */
  maxResults?: number;
};

/**
 * Accessible typeahead combobox: free text input filters the option list.
 * Backspace works normally. Click or arrow keys to pick a result.
 */
export function Combobox({
  id,
  options,
  value,
  onChange,
  placeholder,
  disabled,
  maxResults = 100,
}: Props) {
  const byValue = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of options) m.set(o.value, o.label);
    return m;
  }, [options]);

  const [query, setQuery] = useState(value ? (byValue.get(value) ?? '') : '');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editingRef = useRef(false);
  const selectedLabel = value ? byValue.get(value) : undefined;

  // Keep input text in sync if external value changes (e.g. form reset).
  useEffect(() => {
    if (editingRef.current) {
      editingRef.current = false;
      return;
    }
    if (!value) {
      setQuery('');
    } else if (selectedLabel) {
      setQuery(selectedLabel);
    }
  }, [value, selectedLabel]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // When the input still shows the currently-selected label verbatim,
    // treat it like an empty query so the user can see every option and
    // pick a different one without manually clearing the field first.
    const currentLabel = value ? byValue.get(value)?.toLowerCase() : undefined;
    if (!q || q === currentLabel) return options.slice(0, maxResults);
    return options
      .filter((o) => o.label.toLowerCase().includes(q))
      .slice(0, maxResults);
  }, [options, query, maxResults, value, byValue]);

  // Close on outside click.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  function commit(option: ComboboxOption) {
    onChange(option.value);
    setQuery(option.label);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setOpen(true);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(filtered.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = filtered[highlight];
      if (o) commit(o);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <input
        id={id}
        ref={inputRef}
        type="text"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        value={query}
        placeholder={placeholder}
        onFocus={() => {
          setOpen(true);
          // Select all so the user can immediately retype to replace the
          // current selection, instead of the existing label acting as a
          // filter that narrows the dropdown to a single match.
          inputRef.current?.select();
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
          // Clear selection if user is editing away from current label.
          if (value && e.target.value !== byValue.get(value)) {
            editingRef.current = true;
            onChange('');
          }
        }}
        onKeyDown={onKeyDown}
        className="field pr-9"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={id ? `${id}-listbox` : undefined}
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => {
          setOpen((o) => !o);
          inputRef.current?.focus();
          inputRef.current?.select();
        }}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-slate-400 hover:text-slate-600"
        aria-label="Toggle options"
      >
        <svg width="12" height="8" viewBox="0 0 12 8" fill="none" aria-hidden="true">
          <path
            d="M1 1L6 6L11 1"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <ul
          id={id ? `${id}-listbox` : undefined}
          role="listbox"
          className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
        >
          {filtered.length === 0 && (
            <li className="px-3 py-2 text-sm text-slate-400">No matches</li>
          )}
          {filtered.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={value === o.value}
              onMouseDown={(e) => {
                e.preventDefault();
                commit(o);
              }}
              onMouseEnter={() => setHighlight(i)}
              className={`cursor-pointer px-3 py-2 text-sm ${
                i === highlight ? 'bg-slate-100 text-brand-navy' : 'text-slate-700'
              } ${value === o.value ? 'font-semibold' : ''}`}
            >
              {o.label}
            </li>
          ))}
          {options.length > filtered.length && (
            <li className="px-3 py-1.5 text-[11px] italic text-slate-400">
              showing first {filtered.length} of {options.length} — keep typing to narrow
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
