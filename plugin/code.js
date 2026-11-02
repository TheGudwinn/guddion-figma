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
    case "write_node":
      return writeNode(params);
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
