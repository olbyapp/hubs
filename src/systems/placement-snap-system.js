import { defineQuery, enterQuery, entityExists, exitQuery, hasComponent, removeComponent } from "bitecs";
import {
  AEntity,
  Held,
  HeldRemoteLeft,
  HeldRemoteRight,
  LoadedByMediaLoader,
  MediaLoader,
  Rigidbody,
  SnapPlacing
} from "../bit-components";
import { Layers } from "../camera-layers";
import { findChildWithComponent } from "../utils/bit-utils";
import { snapPlacementEnabled } from "../utils/experimental-features";
import { getLastWorldPosition, setMatrixWorld } from "../utils/three-utils";
import { paths } from "./userinput/paths";

// Прилипание переносимого медиа к поверхностям сцены.
//
// Штатный перенос устроен так: пока объект в руке, cursor-controller вообще не
// кастует луч (см. `if (!isGrabbing)` в его tick2), объект висит на упругом
// ammo-констрейнте на фиксированной дистанции вдоль луча, а курсор принудительно
// разворачивает его лицом к игроку. Отсюда и неудобство — глубину приходится
// подбирать колесом, а прижать картинку к стене нельзя в принципе.
//
// Здесь объект вместо констрейнта остаётся kinematic (констрейнт-систему обходим
// через Not(SnapPlacing) в её запросах), а мировой трансформ каждый кадр считает
// эта система: луч из курсора даёт точку и нормаль, по нормали строится базис, и
// объект прижимается к поверхности лицевой стороной наружу. Целями служат и
// геометрия сцены, и другие медиа — чтобы фото можно было положить на рамку,
// а не только на стену за ней.
//
// Физика при этом не мешает: kinematic-тела physics-system только читает из
// object3D (см. ветку `if (type === TYPE.DYNAMIC)` в её tick), поэтому наши
// записи никто не перетирает. После отпускания объект остаётся kinematic и
// висит там, где его оставили.
//
// Alt переключает режим свободного размещения и держит его до следующего Alt:
// объект висит на дистанции вдоль луча, лицом к игроку, глубина колесом. Режим
// виден по цвету — янтарный курсор и янтарный контур вместо синего.
//
// Работает у всех. Аварийный выход — ?snap=0, см. utils/experimental-features.

const UP = new THREE.Vector3(0, 1, 0);
const IDENTITY = new THREE.Matrix4();
const ZERO_GRAVITY = { x: 0, y: 0, z: 0 };

const MAX_RAY_DISTANCE = 20;
// Зазор до поверхности: без него плоская картинка z-fight'ит со стеной.
const SURFACE_OFFSET = 0.005;
// Выше этого |cos| между нормалью и мировым «вверх» поверхность считаем
// горизонтальной (пол или потолок) — там мировой up на роль опорной оси не годится.
const HORIZONTAL_SURFACE_DOT = 0.95;
// Экспоненциальное сглаживание, 1/с. При 60 fps даёт ≈0.34 за кадр: достаточно,
// чтобы не дёргалось на стыках поверхностей, и не настолько, чтобы объект тормозил.
const SMOOTHING_RATE = 25;
// Медиа в Hubs центрируется по началу координат загрузчика, но у пустой или ещё
// не загруженной сущности бокс вырожден — тогда берём заведомо безопасный минимум.
const MIN_HALF_EXTENT = 0.005;
// Пределы ручной дистанции в свободном режиме, как у cursor-controller.
const MIN_FREE_DISTANCE = 0.5;

// Цвет призрака кодирует режим: синий — прилипание (тот же, что у курсора),
// янтарный — свободное размещение.
const SNAP_COLOR = 0x2f80ed;
const FREE_COLOR = 0xf2994a;

const snapQuery = defineQuery([SnapPlacing]);
const snapEnterQuery = enterQuery(snapQuery);
const snapExitQuery = exitQuery(snapQuery);

// eid -> { distance } — дистанция вдоль луча, на которой объект держался в
// последний раз, когда луч во что-то попал. Нужна как запасной вариант: если
// навести в небо, объект не должен улетать в бесконечность или замирать.
const placingState = new Map();

const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true; // флаг three-mesh-bvh, как в cursor-controller
const intersections = [];
const rayTargets = [];
const EMPTY_TARGETS = [];

const xAxis = new THREE.Vector3();
const yAxis = new THREE.Vector3();
const zAxis = new THREE.Vector3();
const basis = new THREE.Matrix4();
const normalMatrix = new THREE.Matrix3();
const surfaceNormal = new THREE.Vector3();
const viewForward = new THREE.Vector3();
const localBounds = new THREE.Box3();
const boundsCenter = new THREE.Vector3();
const boundsSize = new THREE.Vector3();
const nodeBounds = new THREE.Box3();
const ancestorChain = [];
const rootInverse = new THREE.Matrix4();
const toRootSpace = new THREE.Matrix4();
const currentPosition = new THREE.Vector3();
const currentQuaternion = new THREE.Quaternion();
const currentScale = new THREE.Vector3();
const targetPosition = new THREE.Vector3();
const targetQuaternion = new THREE.Quaternion();
const targetMatrix = new THREE.Matrix4();
const cameraPosition = new THREE.Vector3();
const towardsViewer = new THREE.Vector3();
const ghostCenter = new THREE.Vector3();
const ghostCorner = new THREE.Vector3();

let environmentRoot = null;
let ghost = null;

// Режим свободного размещения: переключается Alt и держится до следующего Alt.
//
// Раньше Alt читался как зажатая клавиша через userinput, и это не работало:
// при нажатии Alt браузер уводит фокус в меню окна, прилетает window blur, а
// KeyboardDevice на blur делает `this.keys = {}` и `seenKeys.clear()`. После
// этого путь /device/keyboard/alt перестаёт попадать во фрейм, читается как
// undefined — и прилипание возвращалось прямо под зажатым Alt.
//
// Поэтому слушаем клавишу сами: состояние живёт здесь и от чистки ввода не
// зависит, а preventDefault не даёт браузеру забрать фокус в меню. Побочный
// эффект: во вкладке с комнатой Alt больше не открывает меню браузера.
let freePlacementMode = false;
let keyListenerAttached = false;

export function isFreePlacementMode() {
  return snapPlacementEnabled() && freePlacementMode;
}

function isTypingTarget(el) {
  if (!el) return false;
  return ["INPUT", "TEXTAREA"].includes(el.nodeName) || el.contentEditable === "true";
}

function announceMode() {
  APP.messageDispatch?.receive({
    type: "chat",
    name: "System",
    body: freePlacementMode
      ? "Свободное размещение включено (Alt) — объект не прилипает к поверхностям"
      : "Прилипание к поверхностям включено (Alt)",
    sent: false
  });
}

function ensureKeyListener() {
  if (keyListenerAttached) return;
  keyListenerAttached = true;
  // keydown, а не keyup: в Firefox меню окна открывается именно по keyup, и
  // отменять надо более раннее событие. repeat отсекаем — модификаторы шлют
  // keydown повторно, пока их держат, и режим мигал бы каждый повтор.
  document.addEventListener("keydown", event => {
    if (event.key !== "Alt" || event.repeat) return;
    if (!snapPlacementEnabled() || isTypingTarget(document.activeElement)) return;
    event.preventDefault();
    freePlacementMode = !freePlacementMode;
    announceMode();
  });
}

/**
 * Медиа, которое имеет смысл прижимать к поверхности. Игрушки и прочие
 * physics-объекты специально оставлены на старом поведении: их бросают, а не
 * размещают, и упругий констрейнт для них — фича, а не баг.
 */
function isPlaceableMedia(world, eid) {
  if (hasComponent(world, MediaLoader, eid)) return true;
  if (hasComponent(world, AEntity, eid)) {
    const el = world.eid2obj.get(eid)?.el;
    return !!el?.components?.["media-loader"];
  }
  return false;
}

export function shouldSnapPlace(world, eid) {
  if (!snapPlacementEnabled()) return false;
  // Без Rigidbody объект нельзя перевести в kinematic, а значит физика будет
  // спорить с нашими записями в трансформ.
  if (!hasComponent(world, Rigidbody, eid)) return false;
  return isPlaceableMedia(world, eid);
}

/**
 * Годится ли попадание как поверхность для прилипания.
 *
 * Заспавненное медиа висит в корне сцены, а не в #objects-root (см. addMedia в
 * utils/media-utils), поэтому «все объекты» одним поддеревом не возьмёшь — цели
 * приходится брать из cursor-targetting-system и фильтровать попадания здесь.
 *
 * Принимаем только геометрию сцены и другие медиа. Всё прочее — меню, аватары,
 * коллайдеры инспектора — отсекаем: прилипнуть к чужому меню было бы сюрпризом.
 * Проверка на сам переносимый объект идёт первой, иначе он поймал бы сам себя.
 */
function isAcceptableSurface(world, hitObject, heldObj, envRoot) {
  for (let node = hitObject; node; node = node.parent) {
    if (node === heldObj) return false;
    if (envRoot && node === envRoot) return true;
    if (node.eid && hasComponent(world, MediaLoader, node.eid)) return true;
    if (node.el?.components?.["media-loader"]) return true;
  }
  return false;
}

function findAcceptableHit(world, heldObj, envRoot) {
  for (let i = 0; i < intersections.length; i++) {
    const hit = intersections[i];
    if (hit.face && isAcceptableSurface(world, hit.object, heldObj, envRoot)) return hit;
  }
  return null;
}

function getEnvironmentRoot() {
  if (!environmentRoot) {
    // #environment-root переживает смену сцены — меняется только его потомок
    // #environment-scene, так что ссылку можно держать.
    environmentRoot = document.getElementById("environment-root")?.object3D || null;
  }
  return environmentRoot;
}

// Какой рукой взяли, запоминаем при захвате: в кадре отпускания HeldRemote*
// уже сняты, а поза курсора там ещё нужна, чтобы доложить объект до места.
function isHeldByLeftCursor(world, eid) {
  return hasComponent(world, HeldRemoteLeft, eid);
}

function getCursorPose(userinput, left) {
  return userinput.get(left ? paths.actions.cursor.left.pose : paths.actions.cursor.right.pose);
}

// Колесо мыши. Нужно только в режиме байпаса — при прилипании глубину задаёт
// поверхность, и это как раз то, ради чего всё затевалось.
function getCursorModDelta(userinput, left) {
  return userinput.get(left ? paths.actions.cursor.left.modDelta : paths.actions.cursor.right.modDelta) || 0;
}

/**
 * Размещение продолжается, пока объект держит тот же курсор, что его взял.
 * Проверять только Held недостаточно: если в VR тот же объект перехватить рукой,
 * dontHoldWithHandAndRemote снимет HeldRemote*, а Held оставит — и объект так и
 * ездил бы за курсором, игнорируя руку (констрейнт руки мы себе запретили сами).
 */
function isStillPlacing(world, eid, state) {
  if (!hasComponent(world, Held, eid)) return false;
  return hasComponent(world, state.left ? HeldRemoteLeft : HeldRemoteRight, eid);
}

/**
 * Поддерево с самим медиа. Для нового загрузчика это дочерняя сущность
 * LoadedByMediaLoader, для легаси — меш на самой сущности. Важно не мерить
 * габариты по всему поддереву: у легаси-шаблона #interactable-media в детях
 * висит меню (.ui interactable-ui), и оно раздуло бы бокс.
 */
function findContentRoot(world, eid, obj) {
  const contentEid = findChildWithComponent(world, LoadedByMediaLoader, eid);
  if (contentEid) {
    const contentObj = world.eid2obj.get(contentEid);
    if (contentObj) return contentObj;
  }
  const mesh = obj.el?.getObject3D?.("mesh");
  return mesh || obj;
}

/**
 * AABB контента в системе координат переносимого корня (до применения его
 * собственного масштаба). Считаем каждый кадр: это несколько умножений матриц
 * на меш, зато бокс всегда актуален — и при масштабировании на лету
 * (scale-when-grabbed-system), и когда медиа догрузилось уже в руке.
 */
function computeContentBounds(root, contentRoot, target) {
  target.makeEmpty();
  root.updateMatrices();
  // traverse() обновляет матрицы сверху вниз сам, но начинаем мы не с корня, а с
  // поддерева контента — промежуточные узлы (у нового загрузчика это offset-объект,
  // который ещё и анимирует масштаб при догрузке) надо освежить отдельно.
  ancestorChain.length = 0;
  for (let node = contentRoot; node && node !== root; node = node.parent) {
    ancestorChain.push(node);
  }
  for (let i = ancestorChain.length - 1; i >= 0; i--) {
    ancestorChain[i].updateMatrices();
  }

  rootInverse.copy(root.matrixWorld).invert();
  contentRoot.traverse(node => {
    if (!node.visible || !node.geometry) return;
    if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
    if (!node.geometry.boundingBox) return;
    node.updateMatrices();
    toRootSpace.multiplyMatrices(rootInverse, node.matrixWorld);
    target.union(nodeBounds.copy(node.geometry.boundingBox).applyMatrix4(toRootSpace));
  });
  if (target.isEmpty()) {
    target.min.set(-MIN_HALF_EXTENT, -MIN_HALF_EXTENT, -MIN_HALF_EXTENT);
    target.max.set(MIN_HALF_EXTENT, MIN_HALF_EXTENT, MIN_HALF_EXTENT);
  }
  return target;
}

/**
 * Горизонтальное направление «от зрителя». На стене оно не нужно, а вот для пола
 * и потолка задаёт, каким боком ляжет картинка.
 */
function getViewForwardFlat(camera, out) {
  camera.updateMatrices();
  out.setFromMatrixColumn(camera.matrixWorld, 2).negate(); // камера смотрит вдоль своего -Z
  out.y = 0;
  if (out.lengthSq() < 1e-6) {
    // Камера смотрит строго вниз или вверх (режим вида сверху) — направление
    // взгляда вырождается. Берём верх экрана, спроецированную ось Y камеры:
    // тогда картинка на полу читается так же, как расположена на экране.
    out.setFromMatrixColumn(camera.matrixWorld, 1);
    out.y = 0;
  }
  if (out.lengthSq() < 1e-6) out.set(0, 0, -1);
  return out.normalize();
}

/**
 * Базис по нормали поверхности. Лицевая сторона медиа в Hubs — это +Z (курсор
 * держит объект через lookAt на камеру, а lookAt у обычного Object3D направляет
 * на цель именно +Z), поэтому +Z кладём вдоль нормали, наружу от стены.
 */
function orientationFromNormal(normal, referenceUp, outQuaternion) {
  zAxis.copy(normal);
  yAxis.copy(referenceUp).addScaledVector(zAxis, -referenceUp.dot(zAxis));
  if (yAxis.lengthSq() < 1e-6) {
    // Опорная ось совпала с нормалью — годится любая перпендикулярная.
    yAxis.set(0, 0, 1).addScaledVector(zAxis, -zAxis.z);
    if (yAxis.lengthSq() < 1e-6) yAxis.set(1, 0, 0).addScaledVector(zAxis, -zAxis.x);
  }
  yAxis.normalize();
  xAxis.crossVectors(yAxis, zAxis).normalize();
  basis.makeBasis(xAxis, yAxis, zAxis);
  outQuaternion.setFromRotationMatrix(basis);
}

function ensureGhost(sceneEl) {
  if (ghost) return ghost;
  const geometry = new THREE.BufferGeometry();
  // 4 ребра прямоугольника + «гвоздик» вдоль нормали = 5 отрезков.
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(5 * 2 * 3), 3));
  ghost = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({ color: SNAP_COLOR, depthTest: false, transparent: true, opacity: 0.9 })
  );
  ghost.renderOrder = 999;
  ghost.frustumCulled = false;
  // Те же слои, что у курсора: видно в комнате, но не попадает в снимки камеры-инструмента.
  ghost.layers.set(Layers.CAMERA_LAYER_UI);
  ghost.layers.enable(Layers.CAMERA_LAYER_FX_MASK);
  ghost.visible = false;
  sceneEl.object3D.add(ghost);
  ghost.applyMatrix4(IDENTITY); // hubs-оптимизации матриц: гарантируем первое обновление
  return ghost;
}

const GHOST_CORNER_SIGNS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1]
];
const ghostCorners = GHOST_CORNER_SIGNS.map(() => new THREE.Vector3());

/**
 * Контур в плоскости поверхности по габаритам объекта плюс короткая нормаль.
 * Рисуется по цели, а не по сглаженному положению, поэтому идёт впереди объекта
 * и читается как «вот сюда встанет».
 */
function updateGhost(sceneEl, point, normal, halfWidth, halfHeight, color) {
  const g = ensureGhost(sceneEl);
  g.material.color.setHex(color);
  const positions = g.geometry.attributes.position.array;

  for (let c = 0; c < 4; c++) {
    ghostCorners[c]
      .copy(point)
      .addScaledVector(normal, SURFACE_OFFSET)
      .addScaledVector(xAxis, GHOST_CORNER_SIGNS[c][0] * halfWidth)
      .addScaledVector(yAxis, GHOST_CORNER_SIGNS[c][1] * halfHeight);
  }

  let i = 0;
  for (let c = 0; c < 4; c++) {
    const a = ghostCorners[c];
    const b = ghostCorners[(c + 1) % 4];
    positions[i++] = a.x;
    positions[i++] = a.y;
    positions[i++] = a.z;
    positions[i++] = b.x;
    positions[i++] = b.y;
    positions[i++] = b.z;
  }

  ghostCorner.copy(point).addScaledVector(normal, Math.min(halfWidth, halfHeight) * 0.35 + SURFACE_OFFSET);
  positions[i++] = point.x;
  positions[i++] = point.y;
  positions[i++] = point.z;
  positions[i++] = ghostCorner.x;
  positions[i++] = ghostCorner.y;
  positions[i++] = ghostCorner.z;

  g.geometry.attributes.position.needsUpdate = true;
  g.geometry.computeBoundingSphere();
  g.visible = true;
}

function hideGhost() {
  if (ghost) ghost.visible = false;
}

function makeKinematic(world, physicsSystem, eid) {
  if (!hasComponent(world, Rigidbody, eid)) return;
  if (!physicsSystem.bodyUuidToData.has(Rigidbody.bodyId[eid])) return;
  // Объект мог быть брошен раньше и лететь как dynamic — тогда physics-system
  // каждый кадр перетирала бы object3D из своего буфера.
  physicsSystem.updateRigidBodyOptions(eid, { type: "kinematic", gravity: ZERO_GRAVITY });
}

function stopPlacing(world, eid) {
  placingState.delete(eid);
  if (entityExists(world, eid)) removeComponent(world, SnapPlacing, eid);
}

export function placementSnapSystem(world, userinput, physicsSystem, cursorTargettingSystem, sceneEl, dt) {
  if (!snapPlacementEnabled()) {
    snapQuery(world).forEach(eid => stopPlacing(world, eid));
    hideGhost();
    freePlacementMode = false;
    return;
  }

  ensureKeyListener();

  snapEnterQuery(world).forEach(eid => {
    makeKinematic(world, physicsSystem, eid);
    placingState.set(eid, { distance: 0, placed: false, left: isHeldByLeftCursor(world, eid) });
  });
  snapExitQuery(world).forEach(eid => placingState.delete(eid));

  const placing = snapQuery(world);
  if (!placing.length) {
    hideGhost();
    return;
  }

  const camera = sceneEl.camera;
  const envRoot = getEnvironmentRoot();
  const cursorTargets = cursorTargettingSystem?.targets || EMPTY_TARGETS;
  const transformSystem = sceneEl.systems["transform-selected-object"];
  let drewGhost = false;

  for (let i = 0; i < placing.length; i++) {
    const eid = placing[i];
    if (!entityExists(world, eid)) continue;
    const obj = world.eid2obj.get(eid);
    if (!obj || !obj.parent) continue;

    // Пока объект крутят вручную, ориентацию не трогаем — иначе две системы
    // будут спорить за кватернион в одном кадре.
    if (transformSystem?.transforming && transformSystem.target === obj) continue;

    const state = placingState.get(eid);
    if (!state) continue;

    const pose = getCursorPose(userinput, state.left);
    if (!pose) continue;

    const releasing = !isStillPlacing(world, eid, state);
    const freeMode = isFreePlacementMode();

    obj.updateMatrices();
    obj.matrixWorld.decompose(currentPosition, currentQuaternion, currentScale);

    computeContentBounds(obj, findContentRoot(world, eid, obj), localBounds);
    localBounds.getCenter(boundsCenter);
    localBounds.getSize(boundsSize);

    raycaster.ray.origin.copy(pose.position);
    raycaster.ray.direction.copy(pose.direction);
    raycaster.near = 0.01;
    raycaster.far = MAX_RAY_DISTANCE;
    intersections.length = 0;
    let hit = null;
    if (!freeMode) {
      rayTargets.length = 0;
      if (envRoot) rayTargets.push(envRoot);
      // Тут же лежат и медиа-объекты: cursor-targetting-system собирает их по
      // .interactable и по компоненту CursorRaycastable. Лишние цели (меню,
      // аватары) отсеет фильтр попаданий.
      for (let t = 0; t < cursorTargets.length; t++) rayTargets.push(cursorTargets[t]);
      raycaster.intersectObjects(rayTargets, true, intersections);
      hit = findAcceptableHit(world, obj, envRoot);
    }

    if (hit) {
      normalMatrix.getNormalMatrix(hit.object.matrixWorld);
      surfaceNormal.copy(hit.face.normal).applyNormalMatrix(normalMatrix).normalize();
      // Стены в сценах Spoke часто односторонние, и нормаль может смотреть
      // внутрь геометрии. Разворачиваем её всегда навстречу лучу.
      if (surfaceNormal.dot(raycaster.ray.direction) > 0) surfaceNormal.negate();

      const isHorizontal = Math.abs(surfaceNormal.dot(UP)) > HORIZONTAL_SURFACE_DOT;
      orientationFromNormal(
        surfaceNormal,
        isHorizontal ? getViewForwardFlat(camera, viewForward) : UP,
        targetQuaternion
      );

      // Отодвигаем объект по нормали ровно настолько, чтобы задняя грань его
      // бокса легла на поверхность. Заодно компенсируем смещение центра бокса
      // относительно начала координат — тогда объект встаёт серединой в курсор.
      targetPosition
        .copy(hit.point)
        .addScaledVector(surfaceNormal, -localBounds.min.z * currentScale.z + SURFACE_OFFSET)
        .addScaledVector(xAxis, -boundsCenter.x * currentScale.x)
        .addScaledVector(yAxis, -boundsCenter.y * currentScale.y);

      state.distance = hit.distance;

      // В кадре отпускания призрак уже не нужен — объект встаёт на его место.
      if (!drewGhost && !releasing) {
        updateGhost(
          sceneEl,
          hit.point,
          surfaceNormal,
          Math.max((boundsSize.x * currentScale.x) / 2, MIN_HALF_EXTENT),
          Math.max((boundsSize.y * currentScale.y) / 2, MIN_HALF_EXTENT),
          SNAP_COLOR
        );
        drewGhost = true;
      }
    } else {
      // Либо зажат Alt, либо луч ушёл в пустоту. В обоих случаях ведём себя как
      // старый перенос: объект висит на дистанции вдоль луча, лицом к игроку,
      // а глубину крутит колесо.
      if (!state.distance) state.distance = currentPosition.distanceTo(pose.position);
      state.distance = THREE.MathUtils.clamp(
        state.distance - getCursorModDelta(userinput, state.left),
        MIN_FREE_DISTANCE,
        MAX_RAY_DISTANCE
      );
      targetPosition.copy(pose.position).addScaledVector(pose.direction, state.distance);
      getLastWorldPosition(camera, cameraPosition);
      towardsViewer.subVectors(cameraPosition, targetPosition);
      towardsViewer.y = 0;
      if (towardsViewer.lengthSq() < 1e-6) towardsViewer.set(0, 0, 1);
      orientationFromNormal(towardsViewer.normalize(), UP, targetQuaternion);

      // Янтарный контур вокруг самого объекта — признак свободного режима.
      // Поверхности тут ни при чём, поэтому рисуем по габаритам в плоскости,
      // обращённой к игроку.
      if (!drewGhost && !releasing) {
        ghostCenter
          .copy(targetPosition)
          .addScaledVector(xAxis, boundsCenter.x * currentScale.x)
          .addScaledVector(yAxis, boundsCenter.y * currentScale.y)
          .addScaledVector(zAxis, boundsCenter.z * currentScale.z);
        updateGhost(
          sceneEl,
          ghostCenter,
          zAxis,
          Math.max((boundsSize.x * currentScale.x) / 2, MIN_HALF_EXTENT),
          Math.max((boundsSize.y * currentScale.y) / 2, MIN_HALF_EXTENT),
          FREE_COLOR
        );
        drewGhost = true;
      }
    }

    // Сглаживаем только в процессе переноса. На первом кадре ставим сразу, иначе
    // объект заметно «долетает» до курсора и это читается как лаг. В кадре
    // отпускания — тоже сразу, чтобы объект встал ровно туда, где был призрак,
    // а не замер там, куда успел доехать интерполяцией.
    const alpha = state.placed && !releasing ? 1 - Math.exp((-SMOOTHING_RATE * dt) / 1000) : 1;
    state.placed = true;
    currentPosition.lerp(targetPosition, alpha);
    currentQuaternion.slerp(targetQuaternion, alpha);

    targetMatrix.compose(currentPosition, currentQuaternion, currentScale);
    setMatrixWorld(obj, targetMatrix);
  }

  if (!drewGhost) hideGhost();

  // Пометку снимаем только после того, как объект доложен на место. Отдельным
  // проходом, а не внутри цикла: сущности, которые цикл пропустил (удалена,
  // нет позы курсора, крутят вручную), тоже надо освободить.
  snapQuery(world).forEach(eid => {
    const state = placingState.get(eid);
    if (!state || !entityExists(world, eid) || !isStillPlacing(world, eid, state)) {
      stopPlacing(world, eid);
    }
  });
}
