/**
 * Отладочная панель цикла дня и ночи.
 *
 * Открывается через `?daynightPanel=1` или `$DN.panel()`. Живёт только у того, кто её
 * открыл, в комнату ничего не уходит.
 *
 * У каждого параметра есть и ползунок, и кнопки с шагами. Ползунок удобнее человеку,
 * кнопки — единственное, чем может пользоваться агент через доступность страницы, и
 * заодно дают воспроизводимые значения вместо «примерно вот столько».
 */

export const DAY_NIGHT_PANEL_ID = "day-night-panel";

const pad = n => String(n).padStart(2, "0");
const hhmm = minutes => `${pad(Math.floor(minutes / 60))}:${pad(Math.round(minutes) % 60)}`;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const TIME_PRESETS = ["06:00", "09:00", "13:00", "17:00", "20:30", "23:00"];

export function openDayNightPanel(system) {
  const existing = document.getElementById(DAY_NIGHT_PANEL_ID);
  if (existing) {
    existing.__dispose();
    return null;
  }
  if (!system.baseSky) {
    console.warn("[day-night] небо ещё не найдено — панель откроется после загрузки сцены");
    return null;
  }

  // Параметры неба живут в config как переопределения: null означает «взять из сцены».
  // Панель всегда пишет именно туда, иначе система перезапишет правку на ближайшем тике.
  const skyValue = (key, baseKey) => (system.config[key] === null ? system.baseSky[baseKey] : system.config[key]);
  const initial = {
    northOffset: system.config.northOffset,
    sunMode: system.config.sunMode,
    skyLuminance: system.config.skyLuminance,
    skyRayleigh: system.config.skyRayleigh,
    skyTurbidity: system.config.skyTurbidity
  };

  const root = document.createElement("div");
  root.id = DAY_NIGHT_PANEL_ID;
  root.style.cssText = `position:fixed;top:12px;right:12px;z-index:99999;width:320px;box-sizing:border-box;
    background:rgba(18,20,26,.94);color:#e8eaf0;font:12px/1.45 system-ui,sans-serif;border-radius:10px;
    padding:12px 14px;box-shadow:0 8px 28px rgba(0,0,0,.5);user-select:none`;
  // Иначе клики и клавиши уедут в сцену: аватар пойдёт гулять, пока крутишь ползунок.
  "keydown keyup keypress mousedown mouseup click wheel pointerdown pointerup"
    .split(" ")
    .forEach(type => root.addEventListener(type, event => event.stopPropagation()));
  document.body.appendChild(root);

  let playTimer = null;
  let envTimer = null;
  const rows = [];

  // Свет и небо применяем сразу, а карту окружения — с задержкой: она дорогая, и во
  // время таскания ползунка пересобирать её на каждое движение бессмысленно.
  const apply = () => {
    system.lastUpdate = -Infinity;
    if (envTimer) return;
    envTimer = setTimeout(() => {
      envTimer = null;
      system.refreshEnv();
    }, 350);
  };

  const styleButton = el => {
    el.style.cssText = `padding:4px 7px;border:0;border-radius:6px;cursor:pointer;background:#2b3040;
      color:#e8eaf0;font:11px system-ui,sans-serif;white-space:nowrap`;
  };

  const button = (label, onClick, parent) => {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = label;
    styleButton(el);
    el.addEventListener("click", onClick);
    parent.appendChild(el);
    return el;
  };

  const section = label => {
    const wrap = document.createElement("div");
    wrap.style.margin = "12px 0 0";
    if (label) {
      const head = document.createElement("div");
      head.style.cssText = "font-size:11px;opacity:.8;margin-bottom:4px";
      head.textContent = label;
      wrap.appendChild(head);
    }
    root.appendChild(wrap);
    return wrap;
  };

  const buttonRow = parent => {
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;gap:5px;flex-wrap:wrap";
    parent.appendChild(bar);
    return bar;
  };

  /** Строка параметра: подпись со значением, ползунок и кнопки с шагами. */
  const numberRow = ({ label, min, max, step, steps, get, set, format }) => {
    const wrap = section(null);
    const head = document.createElement("div");
    head.style.cssText = "display:flex;justify-content:space-between;font-size:11px;opacity:.85";
    const name = document.createElement("span");
    name.textContent = label;
    const value = document.createElement("span");
    value.style.fontFamily = "ui-monospace,monospace";
    head.append(name, value);
    wrap.appendChild(head);

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = min;
    slider.max = max;
    slider.step = step;
    slider.style.cssText = "width:100%;margin:3px 0 4px;accent-color:#7ea6ff";
    wrap.appendChild(slider);

    const render = () => {
      const current = get();
      slider.value = current;
      value.textContent = format ? format(current) : current.toFixed(2);
    };
    slider.addEventListener("input", () => {
      set(clamp(parseFloat(slider.value), min, max));
      render();
      apply();
    });

    const bar = buttonRow(wrap);
    steps.forEach(delta => {
      button(
        delta > 0 ? `+${delta}` : `${delta}`,
        () => {
          set(clamp(get() + delta, min, max));
          render();
          apply();
        },
        bar
      );
    });

    render();
    rows.push(render);
    return render;
  };

  // --- заголовок и показания ------------------------------------------------

  const title = document.createElement("div");
  title.style.cssText = "font-weight:600;font-size:13px";
  title.textContent = "День / ночь";
  const readout = document.createElement("div");
  readout.style.cssText = "font:12px ui-monospace,monospace;opacity:.9;margin-top:2px";
  root.append(title, readout);

  // --- время ----------------------------------------------------------------

  const setMinutes = minutes => {
    const date = new Date();
    date.setHours(Math.floor(minutes / 60), Math.round(minutes) % 60, 0, 0);
    system.fixedTime = date;
    system.lastUpdate = -Infinity;
  };
  const currentMinutes = () => {
    const date = system.currentDate();
    return date.getHours() * 60 + date.getMinutes();
  };

  const timeRender = numberRow({
    label: "Время суток",
    min: 0,
    max: 1439,
    step: 1,
    steps: [-60, -15, 15, 60],
    get: currentMinutes,
    set: setMinutes,
    format: hhmm
  });

  let playButton = null;
  const stopPlaying = () => {
    if (!playTimer) return;
    clearInterval(playTimer);
    playTimer = null;
    playButton.textContent = "▶ Сутки";
  };

  const timeBar = buttonRow(section(null));
  TIME_PRESETS.forEach(preset => {
    button(
      preset,
      () => {
        stopPlaying();
        const [hours, minutes] = preset.split(":").map(Number);
        setMinutes(hours * 60 + minutes);
        timeRender();
        apply();
      },
      timeBar
    );
  });
  playButton = button(
    "▶ Сутки",
    () => {
      if (playTimer) {
        stopPlaying();
        return;
      }
      playButton.textContent = "⏸ Пауза";
      playTimer = setInterval(() => {
        setMinutes((currentMinutes() + 6) % 1440);
        timeRender();
        apply();
      }, 100);
    },
    timeBar
  );
  button(
    "Реальное",
    () => {
      stopPlaying();
      system.setTime(null);
      timeRender();
    },
    timeBar
  );

  // --- параметры ------------------------------------------------------------

  numberRow({
    label: "Север (northOffset)",
    min: 0,
    max: 359,
    step: 1,
    steps: [-45, -15, -5, 5, 15, 45],
    get: () => system.config.northOffset,
    set: value => (system.config.northOffset = value),
    format: value => `${Math.round(value)}°`
  });

  numberRow({
    label: "Яркость неба (меньше = ярче)",
    min: 0.6,
    // Выше 2^(1/4) ≈ 1.189 множитель log2(2/luminance⁴) уходит в ноль и небо становится
    // чёрным намертво, поэтому шкала обрывается чуть раньше обрыва.
    max: 1.18,
    step: 0.005,
    steps: [-0.05, -0.01, 0.01, 0.05],
    get: () => skyValue("skyLuminance", "luminance"),
    set: value => (system.config.skyLuminance = value),
    format: value => value.toFixed(3)
  });

  numberRow({
    label: "Рассеяние / синева (rayleigh)",
    min: 0,
    max: 4,
    step: 0.02,
    steps: [-0.4, -0.1, 0.1, 0.4],
    get: () => skyValue("skyRayleigh", "rayleigh"),
    set: value => (system.config.skyRayleigh = value)
  });

  numberRow({
    label: "Дымка у горизонта (turbidity)",
    min: 1,
    max: 20,
    step: 0.1,
    steps: [-2, -0.5, 0.5, 2],
    get: () => skyValue("skyTurbidity", "turbidity"),
    set: value => (system.config.skyTurbidity = value)
  });

  // --- режим солнца и действия ---------------------------------------------

  const modeSection = section("Режим солнца");
  const modeBar = buttonRow(modeSection);
  let renderModes = null;
  const modeButtons = ["fill", "add", "takeover"].map(mode => {
    const el = button(
      mode,
      () => {
        system.config.sunMode = mode;
        renderModes();
        apply();
      },
      modeBar
    );
    el.dataset.mode = mode;
    return el;
  });
  renderModes = () => {
    modeButtons.forEach(el => {
      const active = el.dataset.mode === system.config.sunMode;
      el.style.background = active ? "#3f66c4" : "#2b3040";
      el.textContent = active ? `● ${el.dataset.mode}` : el.dataset.mode;
    });
  };
  renderModes();
  rows.push(renderModes);

  const actions = buttonRow(section(null));
  button(
    "Копировать",
    () => {
      const settings = {
        northOffset: system.config.northOffset,
        sunMode: system.config.sunMode,
        luminance: +skyValue("skyLuminance", "luminance").toFixed(3),
        rayleigh: +skyValue("skyRayleigh", "rayleigh").toFixed(3),
        turbidity: +skyValue("skyTurbidity", "turbidity").toFixed(2)
      };
      const text = JSON.stringify(settings);
      if (navigator.clipboard) navigator.clipboard.writeText(text);
      console.log("[day-night]", text);
      readout.textContent = text;
    },
    actions
  );
  button(
    "Сброс",
    () => {
      system.config.northOffset = initial.northOffset;
      system.config.sunMode = initial.sunMode;
      system.config.skyLuminance = initial.skyLuminance;
      system.config.skyRayleigh = initial.skyRayleigh;
      system.config.skyTurbidity = initial.skyTurbidity;
      rows.forEach(render => render());
      apply();
    },
    actions
  );
  button("✕", () => root.__dispose(), actions);

  // --- жизненный цикл -------------------------------------------------------

  const tick = setInterval(() => {
    const status = system.status();
    readout.textContent = `${hhmm(currentMinutes())} МСК  ☀ ${status.altitude}°  az ${status.azimuth}°`;
    if (!playTimer && !system.fixedTime) timeRender();
  }, 250);

  root.__dispose = () => {
    stopPlaying();
    clearInterval(tick);
    if (envTimer) clearTimeout(envTimer);
    root.remove();
    // Снимаем галку в настройках, иначе она осталась бы включённой при закрытой панели,
    // и повторное включение потребовало бы двух кликов. Панели к этому моменту уже нет,
    // так что обработчик statechanged просто увидит совпадение и ничего не сделает.
    if (window.APP?.store?.state.preferences.showDayNightPanel) {
      window.APP.store.update({ preferences: { showDayNightPanel: false } });
    }
  };

  return root;
}
