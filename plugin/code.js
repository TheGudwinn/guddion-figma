// Main thread плагина. Нет сетевого доступа — вся связь с bridge-server.ts
// идёт через ui.html (см. memory/plugin-bridge/protocol.md).

figma.showUI(__html__, { visible: false, width: 1, height: 1 });

figma.ui.onmessage = async (msg) => {
  if (msg && msg.type === "ready") {
    figma.ui.postMessage({
      type: "init",
      fileKey: figma.fileKey || null,
      fileName: figma.root.name,
      pageId: figma.currentPage.id,
      pageName: figma.currentPage.name,
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
    case "clone_node":
      return cloneNode(params);
    case "move_node":
      return moveNode(params);
    case "find_node":
      return findNode(params);
    case "get_node":
      return getNode(params);
    case "create_instance":
      return createInstance(params);
    case "set_variable_binding":
      return setVariableBinding(params);
    case "get_selection":
      return getSelection();
    default:
      throw new Error(`UNKNOWN_COMMAND: неизвестная команда "${command}"`);
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
    throw new Error(`Неподдерживаемый тип ноды: ${type}. Поддерживаются: FRAME, RECTANGLE, TEXT (для компонентов — create_instance)`);
  }

  node.x = x;
  node.y = y;
  if (name) node.name = name;
  if (fills) node.fills = fills;

  const parent = await resolveParent(parentNodeId);
  parent.appendChild(node);

  await applyStyleAndLayout(node, params);

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

  await applyStyleAndLayout(node, params);

  return { id: node.id, name: node.name, type: node.type };
}

/**
 * Применяет к ноде strokes/cornerRadius/effects/opacity, типографику (для
 * TEXT) и Auto Layout (для FRAME/COMPONENT/INSTANCE) — общий код для
 * writeNode и updateNode. Все поля опциональны, трогаем только то, что
 * передано.
 */
async function applyStyleAndLayout(node, params) {
  const { strokes, strokeWeight, cornerRadius, effects, typography, layout } = params || {};

  if (strokes !== undefined) node.strokes = strokes;
  if (strokeWeight !== undefined) node.strokeWeight = strokeWeight;
  if (cornerRadius !== undefined && "cornerRadius" in node) node.cornerRadius = cornerRadius;
  if (effects !== undefined) node.effects = effects;

  if (typography && node.type === "TEXT") {
    await applyTypography(node, typography);
  }

  if (layout) {
    if ("layoutMode" in node) applyAutoLayout(node, layout);
    // sizing-поля требуют, чтобы нода уже была ребёнком auto-layout родителя — на этот момент appendChild уже вызван.
    if (layout.sizingHorizontal !== undefined && "layoutSizingHorizontal" in node) {
      node.layoutSizingHorizontal = layout.sizingHorizontal;
    }
    if (layout.sizingVertical !== undefined && "layoutSizingVertical" in node) {
      node.layoutSizingVertical = layout.sizingVertical;
    }
  }
}

async function applyTypography(node, typography) {
  const { fontFamily, fontStyle, fontSize, textAlignHorizontal, lineHeight, letterSpacing } = typography;

  const targetFont = fontFamily ? { family: fontFamily, style: fontStyle || node.fontName.style } : node.fontName;
  await figma.loadFontAsync(targetFont);
  node.fontName = targetFont;

  if (fontSize !== undefined) node.fontSize = fontSize;
  if (textAlignHorizontal !== undefined) node.textAlignHorizontal = textAlignHorizontal;
  if (lineHeight !== undefined) node.lineHeight = lineHeight;
  if (letterSpacing !== undefined) node.letterSpacing = letterSpacing;
}

function applyAutoLayout(node, layout) {
  if (layout.mode !== undefined) node.layoutMode = layout.mode;
  if (layout.gap !== undefined) node.itemSpacing = layout.gap;
  if (layout.padding !== undefined) {
    node.paddingLeft = node.paddingRight = node.paddingTop = node.paddingBottom = layout.padding;
  }
  if (layout.paddingLeft !== undefined) node.paddingLeft = layout.paddingLeft;
  if (layout.paddingRight !== undefined) node.paddingRight = layout.paddingRight;
  if (layout.paddingTop !== undefined) node.paddingTop = layout.paddingTop;
  if (layout.paddingBottom !== undefined) node.paddingBottom = layout.paddingBottom;
  if (layout.primaryAxisSizingMode !== undefined) node.primaryAxisSizingMode = layout.primaryAxisSizingMode;
  if (layout.counterAxisSizingMode !== undefined) node.counterAxisSizingMode = layout.counterAxisSizingMode;
  if (layout.primaryAxisAlignItems !== undefined) node.primaryAxisAlignItems = layout.primaryAxisAlignItems;
  if (layout.counterAxisAlignItems !== undefined) node.counterAxisAlignItems = layout.counterAxisAlignItems;
}

function getNode(params) {
  const { nodeId } = params || {};
  if (!nodeId) throw new Error("Нужен nodeId");
  return figma.getNodeByIdAsync(nodeId).then((node) => {
    if (!node) throw new Error(`Нода ${nodeId} не найдена`);
    const box = typeof node.absoluteBoundingBox !== "undefined" ? node.absoluteBoundingBox : null;
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      parentId: node.parent ? node.parent.id : null,
      x: "x" in node ? node.x : undefined,
      y: "y" in node ? node.y : undefined,
      width: box ? box.width : "width" in node ? node.width : undefined,
      height: box ? box.height : "height" in node ? node.height : undefined,
    };
  });
}

async function createInstance(params) {
  const { componentKey, componentNodeId, parentNodeId, x = 0, y = 0, name } = params || {};

  let component;
  if (componentNodeId) {
    component = await figma.getNodeByIdAsync(componentNodeId);
    if (!component || component.type !== "COMPONENT") {
      throw new Error(`Нода ${componentNodeId} не найдена или не является COMPONENT`);
    }
  } else if (componentKey) {
    component = await figma.importComponentByKeyAsync(componentKey);
  } else {
    throw new Error("Нужен componentKey (из get_components) или componentNodeId локального компонента");
  }

  const instance = component.createInstance();
  const parent = await resolveParent(parentNodeId);
  parent.appendChild(instance);
  instance.x = x;
  instance.y = y;
  if (name) instance.name = name;

  return { nodeId: instance.id };
}

async function setVariableBinding(params) {
  const { nodeId, field, variableId, paintIndex = 0 } = params || {};
  if (!nodeId || !field || !variableId) throw new Error("Нужны nodeId, field и variableId");

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Нода ${nodeId} не найдена`);

  const variable = await figma.variables.getVariableByIdAsync(variableId);
  if (!variable) throw new Error(`Variable ${variableId} не найдена`);

  if (field === "fills" || field === "strokes") {
    const paints = node[field];
    if (!Array.isArray(paints) || !paints[paintIndex]) {
      throw new Error(`У ноды нет ${field}[${paintIndex}]`);
    }
    const updated = paints.slice();
    updated[paintIndex] = figma.variables.setBoundVariableForPaint(updated[paintIndex], "color", variable);
    node[field] = updated;
  } else {
    if (typeof node.setBoundVariable !== "function") {
      throw new Error(`Нода ${nodeId} не поддерживает variable bindings`);
    }
    node.setBoundVariable(field, variable);
  }

  return { id: node.id, field, variableId };
}

async function deleteNode(params) {
  const { nodeId } = params || {};
  if (!nodeId) throw new Error("Нужен nodeId");

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Нода ${nodeId} не найдена`);

  node.remove();
  return { deleted: nodeId };
}

async function resolveParent(parentNodeId) {
  if (!parentNodeId) return figma.currentPage;
  const parent = await figma.getNodeByIdAsync(parentNodeId);
  if (!parent || typeof parent.appendChild !== "function") {
    throw new Error(`Родительская нода ${parentNodeId} не найдена или не может содержать детей`);
  }
  return parent;
}

async function cloneNode(params) {
  const { nodeId, parentNodeId, x, y, name } = params || {};
  if (!nodeId) throw new Error("Нужен nodeId");

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node || typeof node.clone !== "function") {
    throw new Error(`Нода ${nodeId} не найдена или не поддерживает клонирование`);
  }

  const clone = node.clone();
  const parent = await resolveParent(parentNodeId);
  parent.appendChild(clone);

  if (x !== undefined) clone.x = x;
  if (y !== undefined) clone.y = y;
  if (name) clone.name = name;

  return { nodeId: clone.id };
}

async function moveNode(params) {
  const { nodeId, parentNodeId, x, y } = params || {};
  if (!nodeId) throw new Error("Нужен nodeId");

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Нода ${nodeId} не найдена`);

  if (parentNodeId !== undefined) {
    const parent = await resolveParent(parentNodeId);
    parent.appendChild(node);
  }
  if (x !== undefined) node.x = x;
  if (y !== undefined) node.y = y;

  return { id: node.id, parentId: node.parent ? node.parent.id : null, x: node.x, y: node.y };
}
