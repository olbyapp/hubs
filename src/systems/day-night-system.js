import {
  AmbientLight,
  Color,
  CubeCamera,
  DirectionalLight,
  Object3D,
  Quaternion,
  Scene,
  Vector3,
  WebGLCubeRenderTarget
} from "three";

/**
 * Смена дня и ночи по реальному положению солнца над офисом.
 *
 * Из координат и текущего момента считаем эфемериды солнца, а из них — направление
 * и цвет направленного света, параметры неба, экспозицию и яркость ламп. Сети здесь
 * нет и не нужно: фаза цикла — чистая функция от UTC-времени, поэтому картинка у всех
 * клиентов совпадает сама собой, независимо от их часового пояса.
 *
 * Свет сцены мы только приглушаем и разворачиваем. Луна и ночная подсветка — наши
 * собственные источники с нулевой интенсивностью днём: так на закате ничего не
 * «щёлкает», каждый источник гаснет и разгорается по своей кривой.
 */

const DEG = Math.PI / 180;
const UNIT_Z = new Vector3(0, 0, 1);

// Пересчёт раз в 2 секунды: настоящее солнце проходит 15°/час, чаще незачем.
const UPDATE_INTERVAL_MS = 2000;
// В ускоренном режиме (отладка) считаем чаще, иначе видны ступеньки.
const FAST_UPDATE_INTERVAL_MS = 200;
// Пересборка env-map — единственная дорогая операция здесь, держим её редкой.
const ENVMAP_INTERVAL_MS = 180000;
// ...и пропускаем даже её, если солнце сдвинулось меньше чем на полтора градуса.
const ENVMAP_MIN_SUN_DELTA = Math.cos(1.5 * DEG);
const ENVMAP_RESOLUTION = 256;

const config = {
  // Офис в Москве. Именно эти координаты, а не часовой пояс зрителя, определяют
  // время рассвета и заката — коллега из другого пояса видит московское небо.
  latitude: 55.7558,
  longitude: 37.6173,

  // Высота солнца (градусы), между которыми разгорается дневной свет.
  dayStart: -6,
  dayEnd: 8,
  // Отдельная, более узкая кривая для самого солнца: к моменту, когда диск ушёл
  // под горизонт, прямой свет уже погашен, иначе на закате видно «подсветку снизу».
  sunStart: -4,
  sunEnd: 6,
  // Ниже этой высоты солнце считается севшим и в дело вступает луна.
  nightStart: 2,
  nightEnd: -8,
  // Выше этой высоты свет уже не «низкий» и не тёплый.
  warmthEnd: 25,

  sunZenithColor: "#fff6e8",
  sunHorizonColor: "#ff8a3d",

  moonColor: "#8fa8d8",
  // Доля от дневной интенсивности солнца сцены.
  moonIntensity: 0.06,
  // Наш ночной ambient — чтобы аватары на улице не превращались в силуэты.
  nightAmbientColor: "#3d4d70",
  nightAmbientIntensity: 0.35,

  // Во сколько раз приглушаются лампы сцены днём (1 = не трогать).
  lampDayFactor: 0.5,
  // Во сколько раз приглушается собственный ambient/hemisphere сцены ночью.
  fillNightFactor: 0.35,
  // Множитель экспозиции в глухую ночь.
  exposureNightFactor: 0.55,

  skyTurbidityDay: 4,
  skyTurbidityHorizon: 10,
  skyRayleighDay: 2,
  skyRayleighHorizon: 3,

  fogNightColor: "#0b1020",

  // Пересобирать ли карту окружения вслед за солнцем.
  envMap: true,
  // Отладка: ускорение хода времени и жёстко заданный момент.
  timeScale: 1
};

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Положение солнца для момента и точки на Земле.
 *
 * Стандартная астрономическая схема (низкоточные формулы Медоуза, та же, что в SunCalc):
 * средняя аномалия -> эклиптическая долгота -> экваториальные координаты -> горизонтальные.
 * Точность порядка угловой минуты — на порядки больше, чем нужно для картинки.
 *
 * @returns {{altitude: number, azimuth: number}} высота над горизонтом и азимут
 *          в радианах; азимут отсчитывается от юга к западу.
 */
function solarPosition(date, latitude, longitude) {
  const daysSinceJ2000 = date.valueOf() / 86400000 - 0.5 + 2440588 - 2451545;

  const meanAnomaly = DEG * (357.5291 + 0.98560028 * daysSinceJ2000);
  const center =
    DEG * (1.9148 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly) + 0.0003 * Math.sin(3 * meanAnomaly));
  const eclipticLongitude = meanAnomaly + center + DEG * 102.9372 + Math.PI;
  const obliquity = DEG * 23.4397;

  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  const rightAscension = Math.atan2(Math.sin(eclipticLongitude) * Math.cos(obliquity), Math.cos(eclipticLongitude));

  const siderealTime = DEG * (280.16 + 360.9856235 * daysSinceJ2000) + DEG * longitude;
  const hourAngle = siderealTime - rightAscension;

  const lat = DEG * latitude;
  const altitude = Math.asin(
    Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle)
  );
  const azimuth = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(lat) - Math.tan(declination) * Math.cos(lat)
  );

  return { altitude, azimuth };
}

const tmpQuaternion = new Quaternion();
const parentQuaternion = new Quaternion();

// Развернуть объект так, чтобы его мировая ось +Z смотрела вдоль direction.
// Именно +Z — потому что inflateDirectionalLight вешает target потомком на (0, 0, 1),
// а three определяет направление света как position -> target.position.
function aimAlongWorldDirection(object3D, direction) {
  tmpQuaternion.setFromUnitVectors(UNIT_Z, direction);
  if (object3D.parent) {
    // В форке three матрицы обновляются по флагу, поэтому мировой поворот родителя
    // сначала надо посчитать явно.
    object3D.parent.updateMatrices();
    object3D.parent.getWorldQuaternion(parentQuaternion);
    tmpQuaternion.premultiply(parentQuaternion.invert());
  }
  object3D.quaternion.copy(tmpQuaternion);
  object3D.matrixNeedsUpdate = true;
}

const sunDirection = new Vector3();
const lightDirection = new Vector3();
const tmpColorA = new Color();
const tmpColorB = new Color();

export class DayNightSystem {
  constructor(sceneEl) {
    this.sceneEl = sceneEl;
    this.renderer = sceneEl.renderer;
    this.scene = sceneEl.object3D;
    this.config = config;

    this.sun = null;
    this.lamps = [];
    this.fills = [];
    this.baseExposure = this.renderer.toneMappingExposure;
    this.baseFogColor = null;
    this.baseSky = null;

    this.lastUpdate = -Infinity;
    this.lastEnvMapUpdate = -Infinity;
    this.lastEnvMapSun = new Vector3();
    this.envRenderTarget = null;
    this.pmremRenderTarget = null;

    this.fixedTime = null;
    this.speedAnchorWall = 0;
    this.speedAnchorReal = 0;

    this.moon = new DirectionalLight(0xffffff, 0);
    this.moon.name = "day-night-moon";
    this.moonTarget = new Object3D();
    this.moonTarget.name = "day-night-moon-target";
    this.moon.target = this.moonTarget;
    this.nightAmbient = new AmbientLight(0xffffff, 0);
    this.nightAmbient.name = "day-night-ambient";
    // Вешаем на корень сцены, а не в environment-scene: смена сцены не должна их уносить.
    this.scene.add(this.moon);
    this.scene.add(this.moonTarget);
    this.scene.add(this.nightAmbient);

    this.applyQueryStringOverrides();

    this.onSceneLoaded = this.onSceneLoaded.bind(this);
    this.sceneEl.addEventListener("environment-scene-loaded", this.onSceneLoaded);
    window.APP.store.addEventListener("statechanged", this.updatePrefs.bind(this));
    this.updatePrefs();

    window.$DN = this;
  }

  applyQueryStringOverrides() {
    const qs = new URLSearchParams(location.search);
    if (qs.has("daynight")) this.forcedOff = qs.get("daynight") === "0" || qs.get("daynight") === "false";
    if (qs.has("daynightLat")) config.latitude = parseFloat(qs.get("daynightLat"));
    if (qs.has("daynightLon")) config.longitude = parseFloat(qs.get("daynightLon"));
    if (qs.has("daynightSpeed")) this.speed(parseFloat(qs.get("daynightSpeed")));
    if (qs.has("daynightTime")) this.setTime(qs.get("daynightTime"));
  }

  updatePrefs() {
    const enabled = !this.forcedOff && window.APP.store.state.preferences.enableDayNightCycle !== false;
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.lastUpdate = -Infinity;
      this.lastEnvMapUpdate = -Infinity;
    } else {
      this.restore();
    }
  }

  onSceneLoaded() {
    this.scanScene();
    // Экспозицию и туман забираем уже после того, как EnvironmentSystem применил
    // настройки сцены — иначе за базу примем наше же значение с прошлой сцены.
    this.baseExposure = this.renderer.toneMappingExposure;
    this.baseFogColor = this.scene.fog ? this.scene.fog.color.clone() : null;
    this.lastUpdate = -Infinity;
    this.lastEnvMapUpdate = -Infinity;
  }

  scanScene() {
    const root = document.getElementById("environment-scene");
    this.sun = null;
    this.lamps = [];
    this.fills = [];
    this.baseSky = null;
    if (!root || !root.object3D) return;

    let brightest = -Infinity;
    root.object3D.traverse(object3D => {
      if (!object3D.isLight) return;
      if (object3D.isDirectionalLight) {
        // Солнцем считаем самый яркий направленный свет. Остальные (заполняющие)
        // не трогаем — автор сцены поставил их осознанно.
        if (object3D.intensity > brightest) {
          brightest = object3D.intensity;
          this.sun = {
            light: object3D,
            intensity: object3D.intensity,
            color: object3D.color.clone(),
            quaternion: object3D.quaternion.clone(),
            position: object3D.position.clone()
          };
        }
      } else if (object3D.isPointLight || object3D.isSpotLight) {
        this.lamps.push({ light: object3D, intensity: object3D.intensity });
      } else if (object3D.isAmbientLight || object3D.isHemisphereLight) {
        this.fills.push({ light: object3D, intensity: object3D.intensity });
      }
    });

    this.captureSky();
  }

  captureSky() {
    const sky = this.environmentSystem?.skybox;
    if (!sky) return;
    const uniforms = sky.sky.material.uniforms;
    this.baseSky = {
      sunPosition: uniforms.sunPosition.value.clone(),
      turbidity: uniforms.turbidity.value,
      rayleigh: uniforms.rayleigh.value
    };
  }

  get environmentSystem() {
    return this.sceneEl.systems["hubs-systems"]?.environmentSystem;
  }

  /** Момент, для которого считаем солнце: реальный, зафиксированный или ускоренный. */
  currentDate() {
    if (this.fixedTime) return this.fixedTime;
    if (config.timeScale === 1) return new Date();
    return new Date(this.speedAnchorWall + (Date.now() - this.speedAnchorReal) * config.timeScale);
  }

  tick() {
    if (!this.enabled) return;
    const now = Date.now();
    const interval = this.fixedTime || config.timeScale !== 1 ? FAST_UPDATE_INTERVAL_MS : UPDATE_INTERVAL_MS;
    if (now - this.lastUpdate < interval) return;
    this.lastUpdate = now;
    this.apply(now);
  }

  apply(now) {
    const date = this.currentDate();
    const { altitude, azimuth } = solarPosition(date, config.latitude, config.longitude);

    // Мировые оси Hubs: +X — восток, -Z — север, +Y — вверх. Азимут из solarPosition
    // отсчитан от юга к западу, поэтому доворачиваем на 180° до компасного.
    const compass = azimuth + Math.PI;
    const cosAltitude = Math.cos(altitude);
    sunDirection.set(Math.sin(compass) * cosAltitude, Math.sin(altitude), -Math.cos(compass) * cosAltitude);

    const day = smoothstep(config.dayStart * DEG, config.dayEnd * DEG, altitude);
    const sunUp = smoothstep(config.sunStart * DEG, config.sunEnd * DEG, altitude);
    const night = smoothstep(config.nightStart * DEG, config.nightEnd * DEG, altitude);
    const warmth = 1 - smoothstep(0, config.warmthEnd * DEG, altitude);

    this.applySky(warmth);
    this.applySun(sunUp, warmth);
    this.applyMoon(night);
    this.applyLamps(night);
    this.applyExposureAndFog(day);

    if (config.envMap) this.maybeRegenerateEnvMap(now);

    this.altitude = altitude / DEG;
    this.azimuth = compass / DEG;
    this.phase = { day, sunUp, night, warmth };
  }

  applySky(warmth) {
    const sky = this.environmentSystem?.skybox;
    if (!sky) return;
    // Небо могло появиться позже света — доснимаем базу, но лампы не пересканируем:
    // их интенсивности мы к этому моменту уже крутим, и они больше не «базовые».
    if (!this.baseSky) this.captureSky();
    const uniforms = sky.sky.material.uniforms;
    // Шейдер сам нормализует sunPosition, поэтому пишем единичный вектор — ровно то же,
    // что делает штатный updateSunPosition, только направление берём из эфемерид.
    uniforms.sunPosition.value.copy(sunDirection);
    uniforms.turbidity.value = config.skyTurbidityDay + (config.skyTurbidityHorizon - config.skyTurbidityDay) * warmth;
    uniforms.rayleigh.value = config.skyRayleighDay + (config.skyRayleighHorizon - config.skyRayleighDay) * warmth;
    // Гасить небо вручную не нужно: ниже горизонта модель Пришема темнеет сама.
  }

  applySun(sunUp, warmth) {
    if (!this.sun) return;
    const { light, intensity } = this.sun;
    light.intensity = intensity * sunUp;
    tmpColorA.set(config.sunZenithColor);
    tmpColorB.set(config.sunHorizonColor);
    light.color.lerpColors(tmpColorA, tmpColorB, warmth).convertSRGBToLinear();

    lightDirection.copy(sunDirection).negate();
    if (light.target && light.target.parent === light) {
      aimAlongWorldDirection(light, lightDirection);
    } else {
      // Свет не из inflateDirectionalLight: target живёт отдельно, значит направление
      // задаём парой позиций, а не поворотом.
      light.position.copy(lightDirection).multiplyScalar(-100);
      light.matrixNeedsUpdate = true;
      light.target.position.set(0, 0, 0);
      light.target.matrixNeedsUpdate = true;
    }
  }

  applyMoon(night) {
    const baseIntensity = this.sun ? this.sun.intensity : 3;
    this.moon.intensity = baseIntensity * config.moonIntensity * night;
    this.nightAmbient.intensity = config.nightAmbientIntensity * night;
    if (night <= 0) return;

    this.moon.color.set(config.moonColor).convertSRGBToLinear();
    this.nightAmbient.color.set(config.nightAmbientColor).convertSRGBToLinear();
    // Луну ставим в противосолнечную точку: когда солнце глубоко под горизонтом,
    // она оказывается высоко, и это правдоподобно без счёта настоящих фаз.
    this.moon.position.copy(sunDirection).multiplyScalar(-100);
    this.moon.matrixNeedsUpdate = true;
    this.moonTarget.position.set(0, 0, 0);
    this.moonTarget.matrixNeedsUpdate = true;
  }

  applyLamps(night) {
    const lampFactor = config.lampDayFactor + (1 - config.lampDayFactor) * night;
    for (let i = 0; i < this.lamps.length; i++) {
      this.lamps[i].light.intensity = this.lamps[i].intensity * lampFactor;
    }
    const fillFactor = config.fillNightFactor + (1 - config.fillNightFactor) * (1 - night);
    for (let i = 0; i < this.fills.length; i++) {
      this.fills[i].light.intensity = this.fills[i].intensity * fillFactor;
    }
  }

  applyExposureAndFog(day) {
    this.renderer.toneMappingExposure =
      this.baseExposure * (config.exposureNightFactor + (1 - config.exposureNightFactor) * day);

    if (this.scene.fog && this.baseFogColor) {
      tmpColorA.set(config.fogNightColor);
      this.scene.fog.color.lerpColors(tmpColorA, this.baseFogColor, day);
    }
  }

  /**
   * Пересобрать карту окружения из текущего неба.
   *
   * Штатный Sky.generateEnvironmentMap каждый раз создаёт свой PMREMGenerator и cube
   * render target — на разовом вызове при загрузке это нормально, но не когда мы зовём
   * его повторно. Поэтому держим свои ресурсы и переиспользуем генератор EnvironmentSystem.
   */
  maybeRegenerateEnvMap(now) {
    const envSystem = this.environmentSystem;
    const sky = envSystem?.skybox;
    if (!sky || !envSystem.envMapFromSkybox) return;
    if (now - this.lastEnvMapUpdate < ENVMAP_INTERVAL_MS) return;
    if (this.lastEnvMapUpdate !== -Infinity && this.lastEnvMapSun.dot(sunDirection) > ENVMAP_MIN_SUN_DELTA) return;

    this.lastEnvMapUpdate = now;
    this.lastEnvMapSun.copy(sunDirection);
    this.regenerateEnvMap(sky, envSystem);
  }

  regenerateEnvMap(sky, envSystem) {
    if (!this.envRenderTarget) {
      this.envRenderTarget = new WebGLCubeRenderTarget(ENVMAP_RESOLUTION);
      this.envCamera = new CubeCamera(1, 100000, this.envRenderTarget);
      this.envScene = new Scene();
      this.envScene.add(this.envCamera);
    }

    const mesh = sky.sky;
    const parent = mesh.parent;
    this.envScene.add(mesh);
    const xrWasEnabled = this.renderer.xr.enabled;
    this.renderer.xr.enabled = false;
    this.envCamera.update(this.renderer, this.envScene);
    this.renderer.xr.enabled = xrWasEnabled;
    if (parent) parent.add(mesh);

    const previousRenderTarget = this.pmremRenderTarget;
    const previousTexture = this.scene.environment;
    this.pmremRenderTarget = envSystem.pmremGenerator.fromCubemap(this.envRenderTarget.texture);
    this.scene.environment = this.pmremRenderTarget.texture;
    // Первую карту сделал EnvironmentSystem и render target от неё нам не достался —
    // освобождаем хотя бы текстуру.
    if (previousRenderTarget) previousRenderTarget.dispose();
    else if (previousTexture) previousTexture.dispose();
  }

  restore() {
    if (this.sun) {
      this.sun.light.intensity = this.sun.intensity;
      this.sun.light.color.copy(this.sun.color);
      this.sun.light.quaternion.copy(this.sun.quaternion);
      this.sun.light.position.copy(this.sun.position);
      this.sun.light.matrixNeedsUpdate = true;
    }
    for (let i = 0; i < this.lamps.length; i++) this.lamps[i].light.intensity = this.lamps[i].intensity;
    for (let i = 0; i < this.fills.length; i++) this.fills[i].light.intensity = this.fills[i].intensity;

    this.moon.intensity = 0;
    this.nightAmbient.intensity = 0;
    this.renderer.toneMappingExposure = this.baseExposure;
    if (this.scene.fog && this.baseFogColor) this.scene.fog.color.copy(this.baseFogColor);

    const envSystem = this.environmentSystem;
    const sky = envSystem?.skybox;
    if (sky && this.baseSky) {
      const uniforms = sky.sky.material.uniforms;
      uniforms.sunPosition.value.copy(this.baseSky.sunPosition);
      uniforms.turbidity.value = this.baseSky.turbidity;
      uniforms.rayleigh.value = this.baseSky.rayleigh;
      if (envSystem.envMapFromSkybox) {
        this.lastEnvMapSun.set(0, 0, 0);
        this.regenerateEnvMap(sky, envSystem);
      }
    }
  }

  // --- отладка из консоли -------------------------------------------------

  /** $DN.setTime("21:30") — застыть на этом местном времени; $DN.setTime(null) — вернуть реальное. */
  setTime(value) {
    if (!value) {
      this.fixedTime = null;
    } else {
      const [hours, minutes] = String(value).split(":");
      const date = new Date();
      date.setHours(parseInt(hours, 10), parseInt(minutes || "0", 10), 0, 0);
      this.fixedTime = date;
    }
    this.lastUpdate = -Infinity;
    this.lastEnvMapUpdate = -Infinity;
    return this.status();
  }

  /** $DN.speed(600) — сутки за 2.5 минуты; $DN.speed(1) — обратно в реальное время. */
  speed(multiplier) {
    this.fixedTime = null;
    this.speedAnchorWall = this.currentDate().valueOf();
    this.speedAnchorReal = Date.now();
    config.timeScale = multiplier;
    this.lastUpdate = -Infinity;
    return this.status();
  }

  status() {
    const date = this.currentDate();
    const { altitude, azimuth } = solarPosition(date, config.latitude, config.longitude);
    return {
      time: date.toLocaleString(),
      altitude: +(altitude / DEG).toFixed(2),
      azimuth: +((azimuth / DEG + 180) % 360).toFixed(2),
      phase: this.phase,
      enabled: this.enabled,
      sun: this.sun ? this.sun.light.name || "(без имени)" : null,
      lamps: this.lamps.length,
      fills: this.fills.length
    };
  }
}
