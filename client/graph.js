import { refs } from './refs.js';
import { apiRequest } from './api.js?v=2';
import { navigate, routing } from './routing.js';
import { state } from './state.js';
import { showToast } from './toast.js';

// Данные графа с сервера.
let graphData = null;

// Экземпляр vis-network и его датасеты.
let network = null;
let nodesDataset = null;
let edgesDataset = null;

// Карты компонент связности (созвездий) для подсветки.
let nodeToComponent = new Map();
let componentToNodes = new Map();

// Базовые стили, чтобы можно было временно подсвечивать/тускнить.
let baseNodeStyles = new Map();
let baseEdgeStyles = new Map();

// Геометрия узлов (используем для размера и расстояний).
const NODE_DIAMETER = 22;

function ensureVis() {
  if (typeof window === 'undefined') return null;
  const vis = window.vis;
  if (!vis || !vis.Network) return null;
  return vis;
}

function computeComponents(nodeIds, edges) {
  const adjacency = new Map();
  nodeIds.forEach((id) => {
    adjacency.set(id, new Set());
  });
  edges.forEach((e) => {
    const { from, to } = e;
    if (!adjacency.has(from) || !adjacency.has(to)) return;
    adjacency.get(from).add(to);
    adjacency.get(to).add(from);
  });

  const nodeToComp = new Map();
  const compToNodes = new Map();
  let compIndex = 0;

  nodeIds.forEach((id) => {
    if (nodeToComp.has(id)) return;
    const queue = [id];
    nodeToComp.set(id, compIndex);
    const set = new Set([id]);
    while (queue.length) {
      const cur = queue.shift();
      const neighbors = adjacency.get(cur) || new Set();
      neighbors.forEach((nid) => {
        if (!nodeToComp.has(nid)) {
          nodeToComp.set(nid, compIndex);
          set.add(nid);
          queue.push(nid);
        }
      });
    }
    compToNodes.set(compIndex, set);
    compIndex += 1;
  });

  return { nodeToComp, compToNodes };
}

function prepareVisData() {
  if (!graphData) return { nodes: [], edges: [] };
  const rawNodes = graphData.nodes || [];
  const rawEdges = graphData.edges || [];

  // Палитра для «созвездий».
  const palette = ['#fecaca', '#fde68a', '#bbf7d0', '#bfdbfe', '#ddd6fe', '#f9a8d4'];

  // Строим список узлов и рёбер для vis-network.
  const nodeIds = rawNodes.map((n) => n.id);
  const edges = rawEdges.map((e, idx) => ({
    id: `e-${idx}`,
    from: e.source,
    to: e.target,
  }));

  // Компоненты связности по текущим рёбрам.
  const { nodeToComp: ntc, compToNodes: ctn } = computeComponents(nodeIds, edges);
  nodeToComponent = ntc;
  componentToNodes = ctn;

  baseNodeStyles = new Map();
  baseEdgeStyles = new Map();

  const nodes = rawNodes.map((n) => {
    const id = n.id;
    const degree =
      rawEdges.filter((e) => e.source === id || e.target === id).length;
    const comp = nodeToComponent.get(id) ?? 0;
    const baseFill = palette[comp % palette.length];

    const isCurrent = state.articleId === id;
    const stroke =
      isCurrent ? '#f97316' : n.public ? '#0ea5e9' : '#64748b';
    const borderWidth = isCurrent ? 3 : degree >= 4 ? 2 : 1.5;

    const fontConfig = {
      size: 18,
      color: '#111827',
      face: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
    };

    const baseColor = {
      background: baseFill,
      border: stroke,
    };
    const dimColor = {
      background: '#e5e7eb',
      border: '#cbd5f5',
    };
    const highlightColor = {
      background: baseFill,
      border: '#f97316',
    };

    baseNodeStyles.set(id, {
      color: baseColor,
      dimColor,
      highlightColor,
      borderWidth,
      font: fontConfig,
    });

    return {
      id,
      label: n.title || 'Без названия',
      title: n.title || 'Без названия',
      value: Math.max(1, degree),
      shape: 'dot',
      size: NODE_DIAMETER / 2,
      color: baseColor,
      borderWidth,
      font: fontConfig,
    };
  });

  edges.forEach((e) => {
    baseEdgeStyles.set(e.id, {
      color: '#d1d5db',
      highlightColor: '#f97316',
      width: 1,
      highlightWidth: 1.5,
    });
  });

  return { nodes, edges };
}

function getVisOptions() {
  const container = refs.graphCanvas;
  const rect = container.getBoundingClientRect();
  const width = rect.width || 600;
  const height = rect.height || 400;

  return {
    autoResize: true,
    width: `${width}px`,
    height: `${height}px`,
    interaction: {
      hover: true,
      tooltipDelay: 80,
    },
    physics: {
      enabled: true,
      solver: 'forceAtlas2Based',
      stabilization: {
        enabled: true,
        // Меньше итераций — быстрее «успокаивается».
        iterations: 300,
        updateInterval: 30,
        fit: false,
      },
      forceAtlas2Based: {
        gravitationalConstant: -100, // Сильное отталкивание
        centralGravity: 0.005,       // Очень слабая гравитация к центру
        springLength: NODE_DIAMETER * 5,
        springConstant: 0.1,         // Пружины держат друзей крепко
        damping: 0.4, // это сопротивление среды или «вязкость воздуха». Этот параметр определяет, как быстро узел теряет скорость и останавливается после того, как его толкнули или потянула пружина.
        avoidOverlap: 1.0,
      },
      // Чем больше minVelocity — тем раньше физика считает,
      // что всё достаточно стабилизировалось.
      minVelocity: 0.7,
    },
    nodes: {
      shape: 'dot',
      scaling: {
        min: 10,
        max: 20,
      },
      font: {
        size: 14,
        color: '#111827',
        face: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
        strokeWidth: 2,
        strokeColor: '#f8fafc',
      },
    },
    edges: {
      smooth: false,
      color: {
        color: '#d1d5db',
        highlight: '#f97316',
      },
    },
  };
}

function highlightComponent(componentIndex) {
  if (!nodesDataset || !edgesDataset) return;

  if (componentIndex === null || componentIndex === undefined) {
    const resetNodes = [];
    nodesDataset.forEach((node) => {
      const base = baseNodeStyles.get(node.id);
      if (!base) return;
      resetNodes.push({
        id: node.id,
        color: base.color,
        borderWidth: base.borderWidth,
        font: base.font,
      });
    });
    nodesDataset.update(resetNodes);

    const resetEdges = [];
    edgesDataset.forEach((edge) => {
      const base = baseEdgeStyles.get(edge.id);
      if (!base) return;
      resetEdges.push({
        id: edge.id,
        color: base.color,
        width: base.width,
      });
    });
    edgesDataset.update(resetEdges);
    return;
  }

  const compNodes = componentToNodes.get(componentIndex) || new Set();

  const updatedNodes = [];
  nodesDataset.forEach((node) => {
    const base = baseNodeStyles.get(node.id);
    if (!base) return;
    const inComp = compNodes.has(node.id);
    updatedNodes.push({
      id: node.id,
      color: inComp ? base.highlightColor : base.dimColor,
      borderWidth: base.borderWidth,
      font: base.font,
    });
  });
  nodesDataset.update(updatedNodes);

  const updatedEdges = [];
  edgesDataset.forEach((edge) => {
    const base = baseEdgeStyles.get(edge.id);
    if (!base) return;
    const inComp =
      compNodes.has(edge.from) && compNodes.has(edge.to);
    updatedEdges.push({
      id: edge.id,
      color: inComp ? base.highlightColor : base.color,
      width: inComp ? base.highlightWidth : base.width,
    });
  });
  edgesDataset.update(updatedEdges);
}

function renderWithVis() {
  const vis = ensureVis();
  if (!vis || !refs.graphCanvas) {
    showToast('Не удалось загрузить библиотеку графа (vis-network)');
    return;
  }

  const { nodes, edges } = prepareVisData();

  if (!network) {
    nodesDataset = new vis.DataSet(nodes);
    edgesDataset = new vis.DataSet(edges);

    const options = getVisOptions();
    network = new vis.Network(refs.graphCanvas, { nodes: nodesDataset, edges: edgesDataset }, options);

    // Переход по клику на ноду.
    network.on('click', (params) => {
      if (!params.nodes || !params.nodes.length) return;
      const id = params.nodes[0];
      if (!id) return;
      navigate(routing.article(id));
    });

    // Подсветка всего созвездия при наведении.
    network.on('hoverNode', (params) => {
      const nodeId = params.node;
      const comp = nodeToComponent.get(nodeId);
      if (comp === undefined) return;
      highlightComponent(comp);
    });

    network.on('blurNode', () => {
      highlightComponent(null);
    });
  } else {
    nodesDataset.clear();
    edgesDataset.clear();
    nodesDataset.add(nodes);
    edgesDataset.add(edges);

    const options = getVisOptions();
    network.setOptions(options);
  }
}

export async function openGraphView() {
  if (!refs.graphView || !refs.graphCanvas) return;

  if (refs.articleListView) refs.articleListView.classList.add('hidden');
  if (refs.articleView) refs.articleView.classList.add('hidden');
  if (refs.articleHeader) refs.articleHeader.classList.add('hidden');
  if (refs.usersView) refs.usersView.classList.add('hidden');
  refs.graphView.classList.remove('hidden');

  const vis = ensureVis();
  if (!vis) {
    showToast('Не удалось загрузить библиотеку графа (vis-network)');
    return;
  }

  if (!graphData) {
    try {
      graphData = await apiRequest('/api/graph');
    } catch (error) {
      showToast(error.message || 'Не удалось загрузить данные графа');
      return;
    }
  }

  renderWithVis();
}

export function initGraphView() {
  if (!refs.graphView || !refs.graphCanvas || !refs.graphToggleBtn) return;

  refs.graphToggleBtn.addEventListener('click', () => {
    openGraphView();
  });

  if (refs.graphBackBtn) {
    refs.graphBackBtn.addEventListener('click', () => {
      refs.graphView.classList.add('hidden');
      if (refs.articleView) refs.articleView.classList.add('hidden');
      if (refs.articleHeader) refs.articleHeader.classList.add('hidden');
      if (refs.articleListView) refs.articleListView.classList.remove('hidden');
    });
  }

  window.addEventListener('resize', () => {
    if (!refs.graphView.classList.contains('hidden') && network) {
      const options = getVisOptions();
      network.setOptions(options);
    }
  });
}
