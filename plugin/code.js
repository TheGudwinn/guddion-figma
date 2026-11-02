// Main thread плагина. Нет сетевого доступа — вся связь с bridge-server.ts
// идёт через ui.html (см. memory/plugin-bridge/protocol.md).

figma.showUI(__html__, { visible: false, width: 1, height: 1 });

figma.ui.onmessage = async (msg) => {
  if (msg && msg.type === "ready") {
    figma.ui.postMessage({
      type: "init",
      fileKey: figma.fileKey || "",
      fileName: figma.root.name,
    });
    return;
  }

  const { id, command, params } = msg || {};
  if (!id || !command) return;

  try {
    const result = await handleCommand(command, params || {});
    figma.ui.postMessage({ id, ok: true, result });
  } catch (err) {
    figma.ui.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
  }
};

async function handleCommand(command, params) {
  switch (command) {
    case "get_variables":
      return getVariables();
    case "set_variable":
      return setVariable(params);
    case "write_node":
      return writeNode(params);
    case "update_node":
      return updateNode(params);
    case "delete_node":
      return deleteNode(params);
    case "find_node":
      return findNode(params);
    case "get_selection":
      return getSelection();
    default:
      throw new Error(`Неизвестная команда: ${command}`);
  }
}

async function getVariables() {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const variables = await figma.variables.getLocalVariablesAsync();
  return {
    collections: collections.map((c) => ({
      id: c.id,
      name: c.name,
      modes: c.modes,
      variableIds: c.variableIds,
    })),
    variables: variables.map((v) => ({
      id: v.id,
      name: v.name,
      resolvedType: v.resolvedType,
      valuesByMode: v.valuesByMode,
      variableCollectionId: v.variableCollectionId,
    })),
  };
}

function getSelection() {
  return figma.currentPage.selection.map((n) => ({ id: n.id, name: n.name, type: n.type }));
}

async function setVariable(params) {
  const { variableId, modeId, value } = params || {};
  if (!variableId || !modeId) {
    throw new Error("Нужны variableId и modeId");
  }
  const variable = await figma.variables.getVariableByIdAsync(variableId);
  if (!variable) {
    throw new Error(`Variable ${variableId} не найдена`);
  }
  variable.setValueForMode(modeId, value);
  return { id: variable.id, name: variable.name, valuesByMode: variable.valuesByMode };
}

async function findNode(params) {
  const { query, type, parentNodeId } = params || {};
  const root = parentNodeId
    ? await figma.getNodeByIdAsync(parentNodeId)
    : figma.currentPage;
  if (!root || typeof root.findAll !== "function") {
    throw new Error(`Нода ${parentNodeId} не найдена или не содержит детей`);
  }

  const needle = (query || "").toLowerCase();
  const matches = root.findAll((n) => {
    if (type && n.type !== type) return false;
    if (needle && !n.name.toLowerCase().includes(needle)) return false;
    return true;
  });

  return matches.slice(0, 100).map((n) => ({ id: n.id, name: n.name, type: n.type }));
}

async function writeNode(params) {
  const {
    parentNodeId,
    type,
    name,
    x = 0,
    y = 0,
    width = 100,
    height = 100,
    text,
    fills,
  } = params || {};

  let node;
  if (type === "FRAME") {
    node = figma.createFrame();
    node.resize(width, height);
  } else if (type === "RECTANGLE") {
    node = figma.createRectangle();
    node.resize(width, height);
  } else if (type === "TEXT") {
    node = figma.createText();
    await figma.loadFontAsync(node.fontName);
    node.characters = text || "";
  } else {
    throw new Error(`Неподдерживаемый тип ноды: ${type}. Поддерживаются: FRAME, RECTANGLE, TEXT`);
  }

  node.x = x;
  node.y = y;
  if (name) node.name = name;
  if (fills) node.fills = fills;

  let parent = figma.currentPage;
  if (parentNodeId) {
    const found = await figma.getNodeByIdAsync(parentNodeId);
    if (!found || typeof found.appendChild !== "function") {
      throw new Error(`Родительская нода ${parentNodeId} не найдена или не может содержать детей`);
    }
    parent = found;
  }
  parent.appendChild(node);

  return { nodeId: node.id };
}

async function updateNode(params) {
  const { nodeId, name, x, y, width, height, fills, text, visible, opacity } = params || {};
  if (!nodeId) throw new Error("Нужен nodeId");

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Нода ${nodeId} не найдена`);

  if (name !== undefined) node.name = name;
  if (x !== undefined) node.x = x;
  if (y !== undefined) node.y = y;
  if (visible !== undefined) node.visible = visible;
  if (opacity !== undefined) node.opacity = opacity;
  if (fills !== undefined) node.fills = fills;

  if ((width !== undefined || height !== undefined) && typeof node.resize === "function") {
    node.resize(width ?? node.width, height ?? node.height);
  }

  if (text !== undefined) {
    if (node.type !== "TEXT") throw new Error(`Нода ${nodeId} не TEXT, нельзя задать text`);
    await figma.loadFontAsync(node.fontName);
    node.characters = text;
  }

  return { id: node.id, name: node.name, type: node.type };
}

async function deleteNode(params) {
  const { nodeId } = params || {};
  if (!nodeId) throw new Error("Нужен nodeId");

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Нода ${nodeId} не найдена`);

  node.remove();
  return { deleted: nodeId };
}
