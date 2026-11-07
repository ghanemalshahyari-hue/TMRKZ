import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { memo, useCallback, useEffect, useMemo, type DragEvent } from 'react';
import type { FlowGraph, FlowNode, FlowNodeType, FlowWhen } from '../../api/types';
import { NODE_TITLES, WHEN_LABEL, chainText, connect, edgeKey, hasInlet, newNode, outlets, placeText } from '../../lib/flowGraph';

type CardData = { noDeadline?: boolean; node: FlowNode; wired: Set<string>; hint?: string; problem?: boolean; visited?: boolean; rejected?: boolean; roleName: (c: string) => string; responsibilityName: (c: string) => string | undefined };
export const DRAG_TYPE = 'application/x-tmrkz-flow-node';

const WHEN_COLOUR: Record<FlowWhen, string> = { approved: '#1b8a42', rejected: '#d7301f', yes: '#1b8a42', no: '#b45309' };
const SHORT: Record<FlowWhen, string> = { approved: 'موافقة', rejected: 'رفض', yes: 'نعم', no: 'لا' };

const Card = memo(function Card({ data }: NodeProps<Node<CardData>>) {
  const { node: n, noDeadline, wired, hint, problem, visited, rejected, roleName, responsibilityName } = data;
  const outs = outlets(n.type);
  return (
    <div className={`fs-node t-${n.type}${problem ? ' problem' : ''}${visited ? ' visited' : ''}${rejected ? ' sim-rejected' : ''}${n.final ? ' final' : ''}`} dir="rtl" data-testid={'node-' + n.type} data-node={n.id}>
      {hasInlet(n.type) && <Handle type="target" position={Position.Top} />}
      <div className="fs-node-title">
        <b>{n.type === 'parallel' || n.type === 'join' || n.type === 'start' ? NODE_TITLES[n.type] : n.name || NODE_TITLES[n.type]}</b>
        {n.final && <span className="fs-badge">نهائية</span>}
      </div>
      {n.type === 'approval' && (
        <>
          {n.chain ? (
            <>
              <div className="fs-node-line">{n.assignees?.[0]?.role ? roleName(n.assignees[0].role) : 'دور لم يُحدد'}</div>
              <div className="fs-node-line fs-node-chain" title={chainText(n.chain)}>{chainText(n.chain)}</div>
            </>
          ) : (
            <>
              {(n.assignees ?? []).slice(0, 3).map((p, i) => (
                <div key={i} className="fs-node-line" title={placeText(p, responsibilityName)}>{p.role ? roleName(p.role) : 'دور لم يُحدد'} · {placeText(p, responsibilityName)}</div>
              ))}
              {(n.assignees?.length ?? 0) > 1 && <div className="fs-node-line muted">{n.mode === 'ALL' ? 'يوافق الجميع' : 'تكفي موافقة واحدة'}</div>}
            </>
          )}
          {!noDeadline && <div className="fs-node-line muted">المهلة {n.slaDays ?? 0} يوم</div>}
        </>
      )}
      {n.type === 'notify' && <div className="fs-node-line muted">{n.recipients?.length ?? 0} مستلم</div>}
      {hint && <div className="fs-node-hint">{hint}</div>}
      {outs.map((o, i) => (
        <Handle key={o} id={o} type="source" position={Position.Bottom} className={'h-' + o} style={outs.length > 1 ? { left: `${((i + 1) * 100) / (outs.length + 1)}%` } : undefined}>
          {o !== 'out' && !wired.has(o) && <span className="fs-handle-label">{SHORT[o]}</span>}
        </Handle>
      ))}
    </div>
  );
});

const nodeTypes = { card: Card };

function Canvas({ noDeadline, graph, selected, selectedEdge, hints, problems, route, onGraph, onCommit, onSelect, onSelectEdge, focus, roleName, responsibilityName }: {
  noDeadline?: boolean;
  graph: FlowGraph;
  selected: string | null;
  selectedEdge: string | null;
  hints: Map<string, string>;
  problems: Set<string>;
  route: { visited: Set<string>; taken: Map<string, string> } | null;
  onGraph: (g: FlowGraph) => void;
  onCommit: () => void;
  onSelect: (id: string | null) => void;
  onSelectEdge: (key: string | null) => void;
  focus: { id: string; key: number } | null;
  roleName: (c: string) => string;
  responsibilityName: (c: string) => string | undefined;
}) {
  const rf = useReactFlow();
  const nodes: Node<CardData>[] = useMemo(
    () =>
      graph.nodes.map((n) => ({
        id: n.id,
        type: 'card',
        position: { x: n.x, y: n.y },
        selected: n.id === selected,
        deletable: n.type !== 'start',
        data: { noDeadline, node: n, wired: new Set(graph.edges.filter((e) => e.from === n.id).map((e) => e.when ?? 'out')), hint: hints.get(n.id), problem: problems.has(n.id), visited: route?.visited.has(n.id), rejected: route?.taken.get(n.id) === 'rejected', roleName, responsibilityName },
      })),
    [noDeadline, graph.nodes, graph.edges, selected, hints, problems, route, roleName, responsibilityName],
  );
  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => {
        const colour = e.when ? WHEN_COLOUR[e.when] : '#5b6b7a';
        const on = route ? route.visited.has(e.from) && route.visited.has(e.to) && (!e.when || route.taken.get(e.from) === e.when) : false;
        return {
          id: edgeKey(e),
          source: e.from,
          target: e.to,
          sourceHandle: e.when ?? 'out',
          label: e.when ? WHEN_LABEL[e.when] : undefined,
          selected: edgeKey(e) === selectedEdge,
          animated: on,
          style: { stroke: colour, strokeWidth: on ? 3.5 : 2, opacity: route && !on ? 0.3 : 1 },
          labelStyle: { fill: colour, fontWeight: 700, fontSize: 12 },
          labelBgStyle: { fill: 'var(--paper)' },
          labelBgPadding: [6, 3] as [number, number],
          markerEnd: { type: MarkerType.ArrowClosed, color: colour },
        };
      }),
    [graph.edges, selectedEdge, route],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      let next = graph;
      for (const c of changes) {
        if (c.type === 'position' && c.position) {
          const pos = c.position;
          next = { ...next, nodes: next.nodes.map((n) => (n.id === c.id ? { ...n, x: Math.round(pos.x), y: Math.round(pos.y) } : n)) };
        } else if (c.type === 'remove') {
          next = { nodes: next.nodes.filter((n) => n.id !== c.id), edges: next.edges.filter((e) => e.from !== c.id && e.to !== c.id) };
          onCommit();
        }
      }
      if (next !== graph) onGraph(next);
    },
    [graph, onGraph, onCommit],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const gone = new Set(changes.filter((c) => c.type === 'remove').map((c) => c.id));
      if (gone.size) {
        onCommit();
        onGraph({ ...graph, edges: graph.edges.filter((e) => !gone.has(edgeKey(e))) });
      }
    },
    [graph, onGraph, onCommit],
  );
  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return;
      onCommit();
      onGraph(connect(graph, c.source, c.target, c.sourceHandle ?? null));
    },
    [graph, onGraph, onCommit],
  );
  const onReconnect = useCallback(
    (old: Edge, c: Connection) => {
      if (!c.source || !c.target) return;
      onCommit();
      const rest = { ...graph, edges: graph.edges.filter((e) => edgeKey(e) !== old.id) };
      onGraph(connect(rest, c.source, c.target, c.sourceHandle ?? null));
    },
    [graph, onGraph, onCommit],
  );
  const onDrop = (e: DragEvent) => {
    const type = e.dataTransfer.getData(DRAG_TYPE) as FlowNodeType;
    if (!type) return;
    e.preventDefault();
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    onCommit();
    const n = newNode(type, Math.round(p.x - 100), Math.round(p.y - 30));
    onGraph({ ...graph, nodes: [...graph.nodes, n] });
    onSelect(n.id);
  };
  useEffect(() => {
    if (focus) rf.fitView({ nodes: [{ id: focus.id }], padding: 1.6, maxZoom: 1.1, duration: 400 });
  }, [focus, rf]);

  return (
    <div className="fs-canvas" dir="ltr" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onReconnect={onReconnect}
        onNodeDragStart={() => onCommit()}
        onNodeClick={(_, n) => (onSelect(n.id), onSelectEdge(null))}
        onEdgeClick={(_, e) => (onSelectEdge(e.id), onSelect(null))}
        onPaneClick={() => (onSelect(null), onSelectEdge(null))}
        deleteKeyCode={['Delete', 'Backspace']}
        snapToGrid
        snapGrid={[10, 10]}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.15}
        maxZoom={1.6}
        proOptions={{ hideAttribution: false }}
      >
        <Background gap={20} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

export function FlowCanvas(props: Parameters<typeof Canvas>[0]) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

