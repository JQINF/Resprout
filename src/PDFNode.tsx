import { useRef } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import NodeResizeCorners from './NodeResizeCorners.tsx';
import NodeCard from './NodeCard.tsx';
import PDFViewer from './PDFViewer.tsx';
import { NodePinButton } from './NodePin.tsx';
import type { ConversationNode } from './session.ts';
import { useStore } from './store.ts';

export default function PDFNode({ id, data, selected }: NodeProps<ConversationNode>) {
  const fileName = data.fileName ?? 'PDF 文档';
  const pinned = useStore(state => state.pinnedNodeId === id);
  const pinNode = useStore(state => state.pinNode);
  const rootRef = useRef<HTMLDivElement>(null);

  if (pinned) {
    return (
      <div ref={rootRef} className="conversation-node assistant pdf-node is-docked" aria-hidden="true">
        <Handle type="target" position={Position.Left} />
        <Handle type="source" position={Position.Right} className="docked-output" />
      </div>
    );
  }

  return (
    <div ref={rootRef} className={`conversation-node assistant pdf-node ${selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-kind">PDF 文档</div>
      <NodeResizeCorners id={id} minWidth={360} minHeight={200} />
      <NodeCard
        className="assistant pdf-card"
        frameAction={<NodePinButton pinned={false} title="固定到左侧" onToggle={() => pinNode(id)} />}
      >
        <PDFViewer id={id} fileName={fileName} fileId={data.fileId} highlights={data.highlights} anchorRef={rootRef} />
      </NodeCard>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
