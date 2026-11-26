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
    case "get_node_details":
      return getNodeDetails(params);
    case "export_node":
      return exportNode(params);
    case "get_image":
      return getImage(params);
    case "set_image_fill":
      return setImageFill(params);
    case "apply_template":
      return applyTemplate(params);
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
    width,
    height,
    text,
    fills,
  } = params || {};

  let node;
  if (type === "FRAME") {
    node = figma.createFrame();
    node.resize(orDefault(width, 100), orDefault(height, 100));
  } else if (type === "RECTANGLE") {
    node = figma.createRectangle();
    node.resize(orDefault(width, 100), orDefault(height, 100));
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
  // Размер текста — после типографики: от шрифта зависит перенос строк.
  if (node.type === "TEXT") await resizeText(node, width, height);

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

  if (node.type !== "TEXT" && (width !== undefined || height !== undefined) && typeof node.resize === "function") {
    node.resize(orDefault(width, node.width), orDefault(height, node.height));
  }

  if (text !== undefined) {
    if (node.type !== "TEXT") throw new Error(`Нода ${nodeId} не TEXT, нельзя задать text`);
    await setText(node, text);
  }

  await applyStyleAndLayout(node, params);
  if (node.type === "TEXT") await resizeText(node, width, height);

  return { id: node.id, name: node.name, type: node.type };
}

/**
 * Применяет к ноде strokes/cornerRadius/effects/opacity, типографику (для
 * TEXT) и Auto Layout (для FRAME/COMPONENT/INSTANCE) — общий код для
 * writeNode и updateNode. Все поля опциональны, трогаем только то, что
 * передано.
 */
async function applyStyleAndLayout(node, params) {
  const { strokes, strokeWeight, cornerRadius, effects, typography, layout, clipsContent } = params || {};

  if (clipsContent !== undefined && "clipsContent" in node) node.clipsContent = clipsContent;

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
  const { fontFamily, fontStyle, fontSize, textAlignHorizontal, lineHeight, letterSpacing, textAutoResize } = typography;

  await loadNodeFonts(node);
  if (fontFamily || fontStyle) {
    const base = node.fontName === figma.mixed ? node.getRangeFontName(0, 1) : node.fontName;
    const targetFont = { family: fontFamily || base.family, style: fontStyle || base.style };
    await figma.loadFontAsync(targetFont);
    node.fontName = targetFont;
  }

  if (fontSize !== undefined) node.fontSize = fontSize;
  if (textAlignHorizontal !== undefined) node.textAlignHorizontal = textAlignHorizontal;
  if (lineHeight !== undefined) node.lineHeight = toUnitValue(lineHeight);
  if (letterSpacing !== undefined) node.letterSpacing = toUnitValue(letterSpacing);
  if (textAutoResize !== undefined) node.textAutoResize = textAutoResize;
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
  if (parent) await loadIfPage(parent);
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

function orDefault(value, fallback) {
  return value === undefined || value === null ? fallback : value;
}

// --- Текст ---

/** Любая правка текста требует загрузить все шрифты ноды, в том числе при смешанных начертаниях. */
async function loadNodeFonts(node) {
  let fonts;
  if (node.fontName !== figma.mixed) fonts = [node.fontName];
  else fonts = node.getRangeAllFontNames(0, node.characters.length);
  await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
}

/** Замена текста. При смешанных стилях Figma оставляет стиль первого символа. */
async function setText(node, text) {
  await loadNodeFonts(node);
  node.characters = text;
}

/** Только ширина → перенос строк с авто-высотой; задана высота → фиксированный блок. */
async function resizeText(node, width, height) {
  if (width === undefined && height === undefined) return;
  await loadNodeFonts(node);
  node.resize(orDefault(width, node.width), orDefault(height, node.height));
  node.textAutoResize = height === undefined ? "HEIGHT" : "NONE";
}

function toUnitValue(value) {
  if (typeof value === "number") return { unit: "PIXELS", value };
  if (typeof value === "string") {
    if (value.trim().toUpperCase() === "AUTO") return { unit: "AUTO" };
    const number = parseFloat(value);
    if (Number.isNaN(number)) throw new Error(`Не разобрать значение "${value}"`);
    return { unit: value.trim().endsWith("%") ? "PERCENT" : "PIXELS", value: number };
  }
  return value;
}

// --- Чтение ---

const DETAIL_FIELDS = [
  "visible", "opacity", "blendMode", "isMask", "maskType", "rotation", "clipsContent",
  "fills", "strokes", "strokeWeight", "effects",
  "cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius",
  "layoutMode", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom",
  "primaryAxisAlignItems", "counterAxisAlignItems", "constraints",
];

const TEXT_FIELDS = [
  "characters", "fontName", "fontSize", "lineHeight", "letterSpacing",
  "textAlignHorizontal", "textAlignVertical", "textAutoResize",
];

function plain(value) {
  return value === figma.mixed ? "MIXED" : value;
}

/** Значения по умолчанию не выводим — иначе на десятках фреймов ответ раздувается. */
function isDefaultValue(key, value) {
  if (value === undefined) return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (key === "visible") return value === true;
  if (key === "opacity") return value === 1;
  if (key === "rotation" || key === "cornerRadius") return value === 0;
  if (key === "isMask") return value === false;
  if (key === "blendMode") return value === "PASS_THROUGH" || value === "NORMAL";
  if (key === "layoutMode") return value === "NONE";
  return false;
}

function serializeNode(node, depth) {
  const out = { id: node.id, name: node.name, type: node.type };
  if ("x" in node) {
    out.x = node.x;
    out.y = node.y;
  }
  if ("width" in node) {
    out.width = node.width;
    out.height = node.height;
  }

  const autoLayout = "layoutMode" in node && node.layoutMode !== "NONE";
  for (const key of DETAIL_FIELDS) {
    if (!(key in node)) continue;
    // Отступы и выравнивание имеют смысл только при включённом Auto Layout.
    if (!autoLayout && /^(itemSpacing|padding|primaryAxis|counterAxis)/.test(key)) continue;
    // Радиусы по углам нужны, только когда они разные.
    if (/Radius$/.test(key) && key !== "cornerRadius" && node.cornerRadius !== figma.mixed) continue;
    const value = plain(node[key]);
    if (!isDefaultValue(key, value)) out[key] = value;
  }

  if (node.type === "TEXT") {
    for (const key of TEXT_FIELDS) out[key] = plain(node[key]);
    if (TEXT_FIELDS.some((key) => node[key] === figma.mixed) || node.fills === figma.mixed) {
      out.segments = node.getStyledTextSegments(["fontName", "fontSize", "fills", "lineHeight"]);
    }
  }

  if ("children" in node && node.children.length > 0) {
    if (depth > 0) out.children = node.children.map((child) => serializeNode(child, depth - 1));
    else out.childCount = node.children.length;
  }
  return out;
}

async function requireNode(nodeId) {
  if (!nodeId) throw new Error("Нужен nodeId");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Нода ${nodeId} не найдена`);
  await loadIfPage(node);
  return node;
}

/** При documentAccess: dynamic-page дети не текущей страницы доступны только после loadAsync. */
async function loadIfPage(node) {
  if (node.type === "PAGE") await node.loadAsync();
}

/** Корень документа отдаём списком страниц, не загружая их содержимое. */
function listPages() {
  return {
    id: figma.root.id,
    name: figma.root.name,
    type: "DOCUMENT",
    children: figma.root.children.map((page) => ({
      id: page.id,
      name: page.name,
      type: page.type,
      current: page.id === figma.currentPage.id,
    })),
  };
}

async function getNodeDetails(params) {
  const { nodeIds, depth = 5 } = params || {};
  let nodes;
  if (nodeIds && nodeIds.length) nodes = await Promise.all(nodeIds.map(requireNode));
  else nodes = figma.currentPage.selection.length ? figma.currentPage.selection : [figma.currentPage];
  return nodes.map((node) => (node.type === "DOCUMENT" ? listPages() : serializeNode(node, depth)));
}

// --- Картинки и экспорт ---

async function exportNode(params) {
  const { nodeId, format = "PNG", scale, maxSize } = params || {};
  const node = await requireNode(nodeId);
  if (typeof node.exportAsync !== "function") throw new Error(`Ноду ${nodeId} нельзя экспортировать`);

  const settings = { format };
  if (maxSize !== undefined) {
    settings.constraint = { type: node.width >= node.height ? "WIDTH" : "HEIGHT", value: maxSize };
  } else if (scale !== undefined) {
    settings.constraint = { type: "SCALE", value: scale };
  }

  const bytes = await node.exportAsync(settings);
  return { nodeId: node.id, name: node.name, data: figma.base64Encode(bytes) };
}

function requireImage(imageHash) {
  const image = figma.getImageByHash(imageHash);
  if (!image) throw new Error(`Картинка ${imageHash} не найдена в файле`);
  return image;
}

async function getImage(params) {
  const { imageHash } = params || {};
  if (!imageHash) throw new Error("Нужен imageHash");
  const image = requireImage(imageHash);
  const size = await image.getSizeAsync();
  const bytes = await image.getBytesAsync();
  return { imageHash, width: size.width, height: size.height, data: figma.base64Encode(bytes) };
}

/**
 * Подгоняет кроп (в пикселях исходника) под пропорции ноды, чтобы картинку не
 * растянуло. Область только сужается — за запрошенные границы (например, на
 * вшитый в картинку текст) кроп не выйдет.
 */
function fitCrop(crop, nodeWidth, nodeHeight, anchorX, anchorY) {
  const factor = { start: 0, center: 0.5, end: 1 };
  const ratio = nodeWidth / nodeHeight;
  let width = crop.width;
  let height = crop.height;
  if (width / height > ratio) width = height * ratio;
  else height = width / ratio;
  return {
    x: crop.x + (crop.width - width) * factor[anchorX],
    y: crop.y + (crop.height - height) * factor[anchorY],
    width,
    height,
  };
}

/** Собирает и проверяет новую IMAGE-заливку, ничего не меняя на холсте. */
async function buildImagePaint(node, params) {
  const { imageHash, data, crop, anchorX = "center", anchorY = "center" } = params;
  if (!("fills" in node) || !Array.isArray(node.fills)) {
    throw new Error(`Нода ${node.id} не поддерживает заливки`);
  }

  const index = node.fills.findIndex((paint) => paint.type === "IMAGE");
  const current = index >= 0 ? node.fills[index] : null;

  let image;
  if (data) {
    image = figma.createImage(figma.base64Decode(data));
  } else {
    const hash = imageHash || (current && current.imageHash);
    if (!hash) throw new Error("Нужна картинка: imageHash или imagePath");
    image = requireImage(hash);
  }
  const size = await image.getSizeAsync();

  const paint = Object.assign({}, current || { type: "IMAGE" }, { imageHash: image.hash, visible: true });
  delete paint.imageTransform;
  delete paint.scalingFactor;
  delete paint.rotation;
  const result = { imageHash: image.hash, sourceWidth: size.width, sourceHeight: size.height };

  if (crop) {
    const outside =
      crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 ||
      crop.x + crop.width > size.width + 0.5 || crop.y + crop.height > size.height + 0.5;
    if (outside) {
      throw new Error(`Кроп ${JSON.stringify(crop)} выходит за картинку ${size.width}x${size.height}`);
    }
    const used = fitCrop(crop, node.width, node.height, anchorX, anchorY);
    paint.scaleMode = "CROP";
    paint.imageTransform = [
      [used.width / size.width, 0, used.x / size.width],
      [0, used.height / size.height, used.y / size.height],
    ];
    result.usedCrop = used;
    // Сколько пикселей ноды приходится на пиксель исходника: выше 1 — картинка растянута.
    result.upscale = node.width / used.width;
  } else {
    paint.scaleMode = "FILL";
  }

  return { paint, index, result };
}

/** Меняет только IMAGE-слой: градиенты и прочие заливки ноды остаются. */
function writeImagePaint(node, built) {
  if (built.index < 0) {
    node.fills = [built.paint];
    return;
  }
  const fills = node.fills.slice();
  fills[built.index] = built.paint;
  node.fills = fills;
}

async function setImageFill(params) {
  const node = await requireNode((params || {}).nodeId);
  const built = await buildImagePaint(node, params);
  writeImagePaint(node, built);
  return Object.assign({ nodeId: node.id }, built.result);
}

// --- Шаблон ---

/** Путь из индексов детей от шаблона до ноды — по нему находим ту же ноду в клоне. */
function pathWithin(root, node) {
  const path = [];
  let current = node;
  while (current && current.id !== root.id) {
    const parent = current.parent;
    if (!parent) break;
    const childId = current.id;
    path.unshift(parent.children.findIndex((child) => child.id === childId));
    current = parent;
  }
  if (!current || current.id !== root.id) {
    throw new Error(`Нода ${node.id} не лежит внутри шаблона ${root.id}`);
  }
  return path;
}

function followPath(root, path) {
  return path.reduce((node, index) => node.children[index], root);
}

/** Клон эталона + своя картинка с кропом + свои тексты. При любой ошибке клон удаляется. */
async function applyTemplate(params) {
  const { templateNodeId, image, texts = [], name, parentNodeId, x, y } = params || {};
  const template = await requireNode(templateNodeId);
  if (typeof template.clone !== "function") throw new Error(`Шаблон ${templateNodeId} нельзя клонировать`);

  const imagePath = image ? pathWithin(template, await requireNode(image.targetNodeId)) : null;

  const textPaths = [];
  for (const item of texts) {
    const target = await requireNode(item.targetNodeId);
    if (target.type !== "TEXT") throw new Error(`Нода ${item.targetNodeId} не TEXT`);
    textPaths.push({ path: pathWithin(template, target), text: item.text });
  }

  const parent = parentNodeId ? await resolveParent(parentNodeId) : null;
  const clone = template.clone();

  try {
    if (parent) parent.appendChild(clone);
    if (name) clone.name = name;
    if (x !== undefined) clone.x = x;
    if (y !== undefined) clone.y = y;

    let imageResult;
    if (imagePath) {
      const target = followPath(clone, imagePath);
      const built = await buildImagePaint(target, image);
      writeImagePaint(target, built);
      imageResult = Object.assign({ nodeId: target.id }, built.result);
    }

    const textResults = [];
    for (const item of textPaths) {
      const target = followPath(clone, item.path);
      await setText(target, item.text);
      textResults.push({ nodeId: target.id, y: target.y, width: target.width, height: target.height });
    }

    return { nodeId: clone.id, image: imageResult, texts: textResults };
  } catch (err) {
    clone.remove();
    throw err;
  }
}
