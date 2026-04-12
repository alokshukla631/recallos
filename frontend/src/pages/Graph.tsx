import { useState, useEffect, useRef, useCallback } from "react";
import "./Graph.css";

interface GraphNode {
  id: string;
  key: string;
  type: string;
  value: string;
  scope: string;
  domain: string | null;
  pinned: boolean;
  importance: number;
  // Layout fields (computed client-side)
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  strength: number;
}

interface GraphData {
  nodes: Omit<GraphNode, "x" | "y" | "vx" | "vy">[];
  edges: GraphEdge[];
  stats: { node_count: number; edge_count: number; implicit_edge_count: number };
}

const TYPE_COLORS: Record<string, string> = {
  preference: "#3b82f6",
  constraint: "#ef4444",
  fact: "#22c55e",
  goal: "#a855f7",
  override: "#f97316",
};

const RELATION_COLORS: Record<string, string> = {
  related_to: "#6b7280",
  depends_on: "#3b82f6",
  conflicts_with: "#ef4444",
  refines: "#22c55e",
  derived_from: "#a855f7",
  same_key: "#f59e0b",
};

function Graph() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [stats, setStats] = useState({ node_count: 0, edge_count: 0, implicit_edge_count: 0 });
  const [loading, setLoading] = useState(true);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [filterType, setFilterType] = useState("all");
  const [showImplicit, setShowImplicit] = useState(true);

  const nodesRef = useRef<GraphNode[]>([]);
  const edgesRef = useRef<GraphEdge[]>([]);
  const animRef = useRef<number>(0);
  const dragRef = useRef<{ node: GraphNode; offsetX: number; offsetY: number } | null>(null);
  const panRef = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const isPanningRef = useRef(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    fetchGraph();
  }, []);

  async function fetchGraph() {
    setLoading(true);
    try {
      const res = await fetch("/api/memory/graph");
      if (!res.ok) return;
      const data: GraphData = await res.json();
      setStats(data.stats);

      // Initialize positions using a circular layout
      const layoutNodes: GraphNode[] = data.nodes.map((n, i) => {
        const angle = (2 * Math.PI * i) / data.nodes.length;
        const radius = Math.min(300, data.nodes.length * 12);
        return {
          ...n,
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
          vx: 0,
          vy: 0,
        };
      });

      setNodes(layoutNodes);
      setEdges(data.edges);
      nodesRef.current = layoutNodes;
      edgesRef.current = data.edges;
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  // Force-directed layout simulation
  const simulate = useCallback(() => {
    const ns = nodesRef.current;
    const es = edgesRef.current;
    if (ns.length === 0) return;

    const damping = 0.85;
    const repulsion = 3000;
    const attraction = 0.005;
    const idealLength = 120;

    // Repulsion between all nodes
    for (let i = 0; i < ns.length; i++) {
      for (let j = i + 1; j < ns.length; j++) {
        const dx = ns[j].x - ns[i].x;
        const dy = ns[j].y - ns[i].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = repulsion / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        ns[i].vx -= fx;
        ns[i].vy -= fy;
        ns[j].vx += fx;
        ns[j].vy += fy;
      }
    }

    // Attraction along edges
    const nodeMap = new Map(ns.map((n) => [n.id, n]));
    for (const edge of es) {
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      if (!source || !target) continue;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - idealLength) * attraction * edge.strength;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      source.vx += fx;
      source.vy += fy;
      target.vx -= fx;
      target.vy -= fy;
    }

    // Center gravity
    for (const n of ns) {
      n.vx -= n.x * 0.0005;
      n.vy -= n.y * 0.0005;
    }

    // Apply velocities with damping
    for (const n of ns) {
      if (dragRef.current?.node.id === n.id) continue;
      n.vx *= damping;
      n.vy *= damping;
      n.x += n.vx;
      n.y += n.vy;
    }
  }, []);

  // Render loop
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const zoom = zoomRef.current;
    const pan = panRef.current;

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2 + pan.x, h / 2 + pan.y);
    ctx.scale(zoom, zoom);

    const ns = nodesRef.current;
    const es = edgesRef.current;
    const nodeMap = new Map(ns.map((n) => [n.id, n]));

    // Filter
    const visibleNodes = filterType === "all" ? ns : ns.filter((n) => n.type === filterType);
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    const visibleEdges = es.filter((e) => {
      if (!visibleIds.has(e.source) || !visibleIds.has(e.target)) return false;
      if (!showImplicit && e.relation === "same_key") return false;
      return true;
    });

    // Draw edges
    for (const edge of visibleEdges) {
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      if (!source || !target) continue;

      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
      ctx.strokeStyle = RELATION_COLORS[edge.relation] || "#6b7280";
      ctx.globalAlpha = edge.relation === "same_key" ? 0.2 : 0.4;
      ctx.lineWidth = edge.relation === "same_key" ? 1 : 1.5;
      if (edge.relation === "same_key") {
        ctx.setLineDash([4, 4]);
      } else {
        ctx.setLineDash([]);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
    }

    // Draw nodes
    for (const node of visibleNodes) {
      const radius = 4 + (node.importance / 100) * 12;
      const color = TYPE_COLORS[node.type] || "#6b7280";
      const isHovered = hoveredNode?.id === node.id;
      const isSelected = selectedNode?.id === node.id;

      // Glow for pinned
      if (node.pinned) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius + 4, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(245, 158, 11, 0.2)";
        ctx.fill();
      }

      // Node circle
      ctx.beginPath();
      ctx.arc(node.x, node.y, isHovered || isSelected ? radius + 2 : radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = isHovered || isSelected ? 1 : 0.8;
      ctx.fill();
      ctx.globalAlpha = 1;

      if (isSelected) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Label (only if zoomed in enough or node is important)
      if (zoom > 0.6 || node.importance > 40 || isHovered || isSelected) {
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.font = `${isHovered || isSelected ? "bold " : ""}${Math.max(9, 10 / zoom)}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText(node.key, node.x, node.y + radius + 12);
      }
    }

    ctx.restore();

    // HUD
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = "11px monospace";
    ctx.textAlign = "left";
    ctx.fillText(`${visibleNodes.length} nodes, ${visibleEdges.length} edges`, 10, h - 10);
  }, [hoveredNode, selectedNode, filterType, showImplicit]);

  // Animation loop
  useEffect(() => {
    let running = true;
    let frameCount = 0;

    function tick() {
      if (!running) return;
      // Run simulation for the first 300 frames, then slow down
      if (frameCount < 300) {
        simulate();
      } else if (frameCount % 5 === 0) {
        simulate();
      }
      render();
      frameCount++;
      animRef.current = requestAnimationFrame(tick);
    }

    tick();
    return () => {
      running = false;
      cancelAnimationFrame(animRef.current);
    };
  }, [simulate, render]);

  // Canvas resizing
  useEffect(() => {
    function resize() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const parent = canvas.parentElement;
      if (!parent) return;
      canvas.width = parent.clientWidth;
      canvas.height = parent.clientHeight;
    }
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  // Mouse interactions
  function screenToWorld(sx: number, sy: number) {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const zoom = zoomRef.current;
    const pan = panRef.current;
    return {
      x: (sx - canvas.width / 2 - pan.x) / zoom,
      y: (sy - canvas.height / 2 - pan.y) / zoom,
    };
  }

  function findNodeAt(wx: number, wy: number): GraphNode | null {
    const ns = nodesRef.current;
    for (let i = ns.length - 1; i >= 0; i--) {
      const n = ns[i];
      const r = 4 + (n.importance / 100) * 12 + 4;
      const dx = wx - n.x;
      const dy = wy - n.y;
      if (dx * dx + dy * dy < r * r) return n;
    }
    return null;
  }

  function handleMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const { x: wx, y: wy } = screenToWorld(sx, sy);
    const node = findNodeAt(wx, wy);

    if (node) {
      dragRef.current = { node, offsetX: wx - node.x, offsetY: wy - node.y };
    } else {
      isPanningRef.current = true;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
    }
  }

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const { x: wx, y: wy } = screenToWorld(sx, sy);

    if (dragRef.current) {
      dragRef.current.node.x = wx - dragRef.current.offsetX;
      dragRef.current.node.y = wy - dragRef.current.offsetY;
      dragRef.current.node.vx = 0;
      dragRef.current.node.vy = 0;
      return;
    }

    if (isPanningRef.current) {
      panRef.current.x += e.clientX - lastMouseRef.current.x;
      panRef.current.y += e.clientY - lastMouseRef.current.y;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
      return;
    }

    const node = findNodeAt(wx, wy);
    setHoveredNode(node);
  }

  function handleMouseUp() {
    if (dragRef.current) {
      setSelectedNode(dragRef.current.node);
    }
    dragRef.current = null;
    isPanningRef.current = false;
  }

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const { x: wx, y: wy } = screenToWorld(sx, sy);
    const node = findNodeAt(wx, wy);
    setSelectedNode(node);
  }

  function handleWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    zoomRef.current = Math.max(0.1, Math.min(5, zoomRef.current * delta));
  }

  // Get connected nodes for the selected node
  const connectedEdges = selectedNode
    ? edges.filter((e) => e.source === selectedNode.id || e.target === selectedNode.id)
    : [];

  return (
    <div className="page graph-page">
      <h2>Memory Graph</h2>
      <p>Visual map of memory items and their relationships. Drag nodes, scroll to zoom, click to inspect.</p>

      {/* Controls */}
      <div className="graph-controls">
        <label className="graph-filter">
          Type
          <select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
            <option value="all">All</option>
            <option value="preference">Preference</option>
            <option value="constraint">Constraint</option>
            <option value="fact">Fact</option>
            <option value="goal">Goal</option>
            <option value="override">Override</option>
          </select>
        </label>
        <label className="graph-toggle">
          <input type="checkbox" checked={showImplicit} onChange={(e) => setShowImplicit(e.target.checked)} />
          Show same-key links
        </label>
        <div className="graph-legend">
          {Object.entries(TYPE_COLORS).map(([type, color]) => (
            <span key={type} className="legend-item">
              <span className="legend-dot" style={{ background: color }} />
              {type}
            </span>
          ))}
        </div>
        <span className="graph-stats">
          {stats.node_count} nodes / {stats.edge_count} links / {stats.implicit_edge_count} implicit
        </span>
      </div>

      {loading ? (
        <div className="graph-loading">Loading graph data...</div>
      ) : nodes.length === 0 ? (
        <div className="graph-empty">No memory items to visualize. Add some items first.</div>
      ) : (
        <div className="graph-container">
          <canvas
            ref={canvasRef}
            className="graph-canvas"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onClick={handleClick}
            onWheel={handleWheel}
          />

          {/* Info panel */}
          {selectedNode && (
            <div className="graph-info-panel">
              <div className="graph-info-header">
                <span className="graph-info-type" data-type={selectedNode.type}>{selectedNode.type}</span>
                <h4>{selectedNode.key}</h4>
                <button className="graph-info-close" onClick={() => setSelectedNode(null)}>x</button>
              </div>
              <p className="graph-info-value">{selectedNode.value}</p>
              <div className="graph-info-meta">
                <span>Scope: {selectedNode.scope}</span>
                {selectedNode.domain && <span>Domain: {selectedNode.domain}</span>}
                <span>Importance: {selectedNode.importance}/100</span>
                {selectedNode.pinned && <span className="graph-info-pinned">Pinned</span>}
              </div>
              {connectedEdges.length > 0 && (
                <div className="graph-info-links">
                  <h5>Connections ({connectedEdges.length})</h5>
                  {connectedEdges.map((edge) => {
                    const otherId = edge.source === selectedNode.id ? edge.target : edge.source;
                    const other = nodes.find((n) => n.id === otherId);
                    return (
                      <div key={edge.id} className="graph-info-link">
                        <span className="graph-link-relation">{edge.relation}</span>
                        <span className="graph-link-target" onClick={() => {
                          if (other) setSelectedNode(other);
                        }}>{other?.key || otherId.slice(0, 8)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Hover tooltip */}
          {hoveredNode && !selectedNode && (
            <div className="graph-tooltip">
              <strong>{hoveredNode.key}</strong> ({hoveredNode.type})
              <br />
              {hoveredNode.value}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default Graph;
