import { useEffect } from 'react';

const icons = {
  spark: '<path d="m12 3 1.3 4.2L17 9l-3.7 1.8L12 15l-1.3-4.2L7 9l3.7-1.8L12 3Z"/><path d="m18 15 .7 2.3L21 18l-2.3.7L18 21l-.7-2.3L15 18l2.3-.7L18 15Z"/>',
  tree: '<circle cx="7" cy="5" r="2"/><circle cx="17" cy="7" r="2"/><circle cx="7" cy="19" r="2"/><path d="M7 7v10M9 7c5 0 3 8 6 8h2M17 9v6"/>',
  rules: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 11h6M9 15h6"/>',
  ship: '<path d="M12 3v12"/><path d="m8 7 4-4 4 4"/><path d="M4 15v4h16v-4"/>',
  play: '<path d="m8 5 11 7-11 7V5Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  shield: '<path d="M12 3 4 7v5c0 5 3.4 8 8 9 4.6-1 8-4 8-9V7l-8-4Z"/><path d="m9 12 2 2 4-4"/>',
  branch: '<circle cx="7" cy="5" r="2"/><circle cx="17" cy="7" r="2"/><circle cx="7" cy="19" r="2"/><path d="M7 7v10M9 7c5 0 3 8 6 8h2M17 9v6"/>',
  terminal: '<path d="m5 7 4 4-4 4M11 15h7"/>',
  send: '<path d="m4 12 16-8-6 16-2-6-8-2Z"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  inbox: '<path d="M4 5h16v14H4z"/><path d="M4 14h4l2 3h4l2-3h4"/>'
};

export function Icon({ name, size = 16 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icons[name] || icons.spark }} />;
}

export function Button({ children, variant = 'secondary', icon, ...props }) {
  return <button className={`button ${variant}`} {...props}>{icon && <Icon name={icon} />}{children}</button>;
}

export function Modal({ title, description, children, onClose, className = '' }) {
  useEffect(() => {
    const handler = (event) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`modal ${className}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <header><div><h2 id="modal-title">{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><Icon name="close" /></button></header>
        {children}
      </section>
    </div>
  );
}

export function Field({ label, hint, as = 'input', ...props }) {
  const Element = as;
  return <label className="field"><span>{label}</span>{hint && <small>{hint}</small>}<Element {...props} /></label>;
}

export function confirmTyped(word, summary) {
  const answer = window.prompt(`${summary}\n\nType "${word}" to confirm.`);
  return answer === word;
}

export function timeAgo(value) {
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return '';
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return new Date(value).toLocaleDateString();
}
