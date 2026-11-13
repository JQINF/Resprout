import type { CSSProperties, ReactNode } from 'react';

interface NodeCardProps {
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export default function NodeCard({ className, style, children }: NodeCardProps) {
  return (
    <div className="node-card-frame">
      <div className={`card-surface ${className}`} style={style}>{children}</div>
      <span className="node-drag-frame" aria-hidden="true">
        <span className="node-drag-edge top" />
        <span className="node-drag-edge right" />
        <span className="node-drag-edge bottom" />
        <span className="node-drag-edge left" />
      </span>
    </div>
  );
}
