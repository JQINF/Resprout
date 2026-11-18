export function PinIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
    </svg>
  );
}

export function NodePinButton({ pinned, title, onToggle }: { pinned: boolean; title: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`node-pin-button nodrag nowheel nopan${pinned ? ' is-pinned' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={pinned}
      onClick={onToggle}
      onMouseDown={event => event.stopPropagation()}
    ><PinIcon filled={pinned} /></button>
  );
}
