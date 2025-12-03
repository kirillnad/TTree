import { refs } from './refs.js';
import { apiRequest } from './api.js';
import { navigate, routing } from './routing.js';

let graphData = null;
let positions = {};
let draggingNodeId = null;
let isDragging = false;
let deviceRatio = 1;

function ensureCanvas() {
  if (!refs.graphCanvas) return null;
  const canvas = refs.graphCanvas;
  const rect = canvas.getBoundingClientRect();
  deviceRatio = window.devicePixelRatio || 1;
  canvas.width = rect.width * deviceRatio;
  canvas.height = rect.height * deviceRatio;
  return canvas;
}

function initialLayout(nodes) {
  // Очень простой стартовый расклад: узлы по кругу.
  const placed = {};
  const R = 220;
  const cx = 0;
  const cy = 0;
  const n = nodes.length || 1;
  nodes.forEach((node, index) => {
    const angle = (2 * Math.PI * index) / n;
    placed[node.id] = {
      x: cx + R * Math.cos(angle),
      y: cy + R * Math.sin(angle),
    };
  });
  return placed;
}

function ensurePositions() {
  if (!graphData) return;
  if (!positions || Object.keys(positions).length === 0) {
    positions = initialLayout(graphData.nodes);
    return;
  }
  // Если появились новые узлы — добавляем им стартовые позиции.
  const known = new Set(Object.keys(positions));
  const missing = graphData.nodes.filter((n) => !known.has(n.id));
  if (missing.length) {
    const extra = initialLayout(missing);
    positions = { ...positions, ...extra };
  }
}

function renderGraph() {
  if (!graphData || !refs.graphCanvas) return;
  const canvas = ensureCanvas();
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);

  ensurePositions();
  const centerX = width / 2;
  const centerY = height / 2;

  // Рёбра
  ctx.strokeStyle = '#d1d5db';
  ctx.lineWidth = 1;
  graphData.edges.forEach((edge) => {
    const a = positions[edge.source];
    const b = positions[edge.target];
    if (!a || !b) return;
    ctx.beginPath();
    ctx.moveTo(centerX + a.x, centerY + a.y);
    ctx.lineTo(centerX + b.x, centerY + b.y);
    ctx.stroke();
  });

  // Узлы
  graphData.nodes.forEach((node) => {
    const pos = positions[node.id];
    if (!pos) return;
    const isPublic = Boolean(node.public);
    const isEncrypted = Boolean(node.encrypted);
    const r = isEncrypted ? 6 : 4;
    ctx.beginPath();
    ctx.arc(centerX + pos.x, centerY + pos.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = isPublic ? '#0ea5e9' : '#111827';
    ctx.fill();
  });
}

function pickNodeAt(canvasX, canvasY) {
  if (!graphData) return null;
  const width = refs.graphCanvas.width;
  const height = refs.graphCanvas.height;
  const centerX = width / 2;
  const centerY = height / 2;
  const hitRadius = 10;
  let picked = null;
  graphData.nodes.forEach((node) => {
    const pos = positions[node.id];
    if (!pos) return;
    const dx = centerX + pos.x - canvasX;
    const dy = centerY + pos.y - canvasY;
    const dist2 = dx * dx + dy * dy;
    if (dist2 <= hitRadius * hitRadius) {
      picked = node;
    }
  });
  return picked;
}

export async function openGraphView() {
  if (!refs.graphView || !refs.graphCanvas) return;
  // Ленивая загрузка графа.
  if (!graphData) {
    graphData = await apiRequest('/api/graph');
  }
  refs.articleListView.classList.add('hidden');
  refs.articleView.classList.add('hidden');
  refs.usersView.classList.add('hidden');
  refs.graphView.classList.remove('hidden');
  renderGraph();
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
      if (refs.articleListView) refs.articleListView.classList.remove('hidden');
    });
  }

  // Обработка перерисовки при изменении размера.
  window.addEventListener('resize', () => {
    if (!refs.graphView.classList.contains('hidden')) {
      renderGraph();
    }
  });

  // Drag & drop узлов.
  refs.graphCanvas.addEventListener('mousedown', (event) => {
    if (!graphData) return;
    const rect = refs.graphCanvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * deviceRatio;
    const y = (event.clientY - rect.top) * deviceRatio;
    const picked = pickNodeAt(x, y);
    if (picked) {
      draggingNodeId = picked.id;
      isDragging = true;
      event.preventDefault();
    }
  });

  window.addEventListener('mousemove', (event) => {
    if (!isDragging || !draggingNodeId || !refs.graphCanvas) return;
    const rect = refs.graphCanvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * deviceRatio;
    const y = (event.clientY - rect.top) * deviceRatio;
    const width = refs.graphCanvas.width;
    const height = refs.graphCanvas.height;
    const centerX = width / 2;
    const centerY = height / 2;
    const pos = positions[draggingNodeId];
    if (!pos) return;
    pos.x = x - centerX;
    pos.y = y - centerY;
    renderGraph();
  });

  window.addEventListener('mouseup', () => {
    isDragging = false;
    draggingNodeId = null;
  });
}
