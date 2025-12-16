/**
 * sei_explorer_hud.js
 *
 * Drop-in HUD overlay for Tesla Dashcam SEI Explorer.
 * Layout-only: unified Tesla-style single card + Autopilot label
 */

(function () {
  const DEFAULTS = {
    useMph: true,
    maxThrottlePct: 100,
    maxSteerDeg: 540,
    zIndex: 9999
  };

  const clamp = (n, min, max) =>
    typeof n !== "number" || Number.isNaN(n) ? min : Math.max(min, Math.min(max, n));

  function pickNumber(obj, keys, fallback = null) {
    for (const k of keys) {
      const v = obj?.[k];
      if (typeof v === "number" && !Number.isNaN(v)) return v;
      if (typeof v === "string" && !Number.isNaN(Number(v))) return Number(v);
    }
    return fallback;
  }

  function pickBool(obj, keys, fallback = false) {
    for (const k of keys) {
      const v = obj?.[k];
      if (typeof v === "boolean") return v;
      if (typeof v === "number") return v !== 0;
      if (typeof v === "string") {
        const s = v.toLowerCase();
        if (["true", "1", "yes"].includes(s)) return true;
        if (["false", "0", "no"].includes(s)) return false;
      }
    }
    return fallback;
  }

  function pickString(obj, keys, fallback = "") {
    for (const k of keys) {
      const v = obj?.[k];
      if (typeof v === "string" && v.trim()) return v;
      if (typeof v === "number") return String(v);
    }
    return fallback;
  }

  function normalizeTelemetry(raw, opts) {
    const speedMps = pickNumber(raw, ["vehicleSpeedMps"], 0);
    const speedMph = speedMps * 2.23694;

    let throttleRaw = pickNumber(raw, ["acceleratorPedalPosition"], 0);
    if (throttleRaw <= 1.2) throttleRaw *= 100;

    const gearMapping = {
      GEAR_DRIVE: "D",
      GEAR_NEUTRAL: "N",
      GEAR_PARK: "P",
      GEAR_REVERSE: "P"
    };

    return {
      speed: opts.useMph ? speedMph : speedMph * 1.609,
      steerDeg: pickNumber(raw, ["steeringWheelAngle"], 0),
      left: pickBool(raw, ["blinkerOnLeft"]),
      right: pickBool(raw, ["blinkerOnRight"]),
      brake: pickBool(raw, ["brakeApplied"]),
      throttlePct: clamp(throttleRaw, 0, 100),
      autopilotState: pickString(raw, ["autopilotState"]),
      gear: gearMapping[pickString(raw?.fields?.gearState, ["displayValue"])]
    };
  }

  function injectStyles() {
    if (document.getElementById("sei-hud-styles")) return;

    const s = document.createElement("style");
    s.id = "sei-hud-styles";
    s.textContent = `
.sei-hud-root {
  position:absolute; inset:0;
  pointer-events:none;
  z-index:var(--sei-hud-z);
  font-family: system-ui,-apple-system,Segoe UI;
  color:rgba(255,255,255,.95);
}

.sei-hud-wrap {
  display:flex;
  justify-content:center;
  padding:12px;
}

/* CARD */
.sei-hud-card {
  padding: 6px 10px 8px;
  border-radius: 18px;
  backdrop-filter: blur(14px);
  background: rgba(10,10,12,.38);
  border: 1px solid rgba(255,255,255,.14);
  box-shadow: 0 10px 30px rgba(0,0,0,.25);
}

/* GRID */
.sei-hud-grid {
  display:grid;
  grid-template-columns:
    auto 1fr 32px 3ch 32px 1fr auto;
  grid-template-rows: 1fr 1fr;
  grid-template-areas:
    "gear  . left  speed right . wheel"
    "brake . .     .     .     . throttle";
  column-gap:8px;
  align-items:center;
}

/* SPEED */
.sei-hud-speed {
  display:flex;
  flex-direction:column;
  align-items:center;
  line-height:1;
}
.sei-hud-speed .val {
  font-size:28px;
  font-weight:800;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum";
}
.sei-hud-speed .unit {
  font-size:12px;
  opacity:.8;
  margin-top:4px;
}

/* Center optical cluster */
.sei-hud-signal,
.sei-hud-speed {
  transform: translateY(16px);
}

/* SIGNALS */
.sei-hud-signal {
  width:32px;
  height:24px;
  display:grid;
  place-items:center;
  border-radius:10px;
  opacity:.4;
  border:1px solid rgba(255,255,255,.15);
}
.sei-hud-signal.active {
  opacity:1;
  background:rgba(120,255,120,.18);
  border-color:rgba(120,255,120,.45);
}
.sei-hud-signal.blink {
  animation: blink .55s steps(2,end) infinite;
}
@keyframes blink {
  0%,49%{filter:brightness(1.3)}
  50%,100%{filter:brightness(.7)}
}

/* WHEEL */
.sei-hud-wheel {
  width:32px;
  height:32px;
  border-radius:50%;
  display:grid;
  place-items:center;
  border:1px solid rgba(255,255,255,.18);
}
.sei-hud-wheel svg {
  width:26px;
  height:26px;
  transform:rotate(var(--sei-wheel-rot,0deg));
  transition:transform .05s linear;
}

/* PEDALS */
.sei-hud-pedal {
  --fill: note;
  width:32px;
  height:32px;
  border-radius:50%;
  position:relative;
  border:2px solid rgba(255,255,255,.25);
  overflow:hidden;
}
.sei-hud-pedal::before {
  content:"";
  position:absolute;
  inset:4px;
  border-radius:50%;
  background:rgba(0,0,0,.4);
}
.sei-hud-pedal .fill {
  position:absolute;
  inset:4px;
  overflow:hidden;
  border-radius:50%;
}
.sei-hud-pedal .fill i {
  position:absolute;
  bottom:0; left:0; right:0;
  height:var(--fill);
  background:var(--c);
}
.sei-hud-pedal.throttle { --c:rgba(120,255,120,.7); }
.sei-hud-pedal.brake { --c:rgba(255,90,90,.75); }
.sei-hud-pedal svg {
  position:absolute;
  z-index:2;
  stroke:rgba(136,136,136,.9);
  fill:none;
}

/* GEAR */
.sei-hud-gear {
  font-size:12px;
  font-weight:800;
  padding:6px 12px;
  border-radius:999px;
  border:1px solid rgba(255,255,255,.14);
}

/* GRID AREAS */
.sei-hud-gear { grid-area:gear; }
.sei-hud-speed { grid-area:speed; }
.sei-hud-signal.left { grid-area:left; }
.sei-hud-signal.right { grid-area:right; }
.sei-hud-wheel { grid-area:wheel; }
.sei-hud-pedal.brake { grid-area:brake; justify-self:center; }
.sei-hud-pedal.throttle { grid-area:throttle; justify-self:center; }

/* AUTOPILOT LABEL */
.sei-hud-ap-status {
  margin-top:6px;
  text-align:center;
  font-size:13px;
  font-weight:600;
  letter-spacing:.3px;
  color:rgb(90,160,255);

  opacity:0;
  max-height:0;
  transform:translateY(-4px);
  transition:
    opacity .25s ease,
    transform .25s ease,
    max-height .25s ease;
}
.sei-hud-ap-status.active {
  opacity:1;
  max-height:24px;
  transform:translateY(0);
}
`;
    document.head.appendChild(s);
  }

  function createHudDom(opts) {
    const root = document.createElement("div");
    root.className = "sei-hud-root";
    root.style.setProperty("--sei-hud-z", opts.zIndex);

    const wrap = document.createElement("div");
    wrap.className = "sei-hud-wrap";

    const card = document.createElement("div");
    card.className = "sei-hud-card";

    const grid = document.createElement("div");
    grid.className = "sei-hud-grid";

    const gear = document.createElement("div");
    gear.className = "sei-hud-gear";
    gear.textContent = "—";

    const brake = document.createElement("div");
    brake.className = "sei-hud-pedal brake";
    brake.innerHTML = `
      <span class="fill"><i></i></span>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <!-- Brake pedal body -->
        <path
          d="
            M6 7
            L18 7
            L20 16
            Q12 19 4 16
            Z
          "
          stroke-width="2"
          stroke-linejoin="round"
        />

        <!-- Grip slots -->
        <line x1="8"  y1="9" x2="8"  y2="14" stroke-width="1.5" />
        <line x1="10" y1="9" x2="10" y2="14" stroke-width="1.5" />
        <line x1="12" y1="9" x2="12" y2="14" stroke-width="1.5" />
        <line x1="14" y1="9" x2="14" y2="14" stroke-width="1.5" />
        <line x1="16" y1="9" x2="16" y2="14" stroke-width="1.5" />
      </svg>
    `;



    const leftSig = document.createElement("div");
    leftSig.className = "sei-hud-signal";
    leftSig.textContent = "◀";
    leftSig.classList.add("left");
    

    const speedBox = document.createElement("div");
    speedBox.className = "sei-hud-speed";
    speedBox.innerHTML = `
      <div class="val">0</div>
      <div class="unit">${opts.useMph ? "mph" : "km/h"}</div>
    `;

    const rightSig = document.createElement("div");
    rightSig.className = "sei-hud-signal";
    rightSig.textContent = "▶";
    rightSig.classList.add("right");

    const wheel = document.createElement("div");
    wheel.className = "sei-hud-wheel";
    wheel.innerHTML = `
<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <!-- Outer rim -->
  <circle
    cx="12"
    cy="12"
    r="8"
    stroke="white"
    stroke-width="1.4"
  />

  <!-- Horizontal bar (touches near rim) -->
  <path
    d="M6.8 9.8 H17.2"
    stroke="white"
    stroke-width="2"
    stroke-linecap="round"
  />

  <!-- Vertical stem (reaches toward bottom rim) -->
  <path
    d="M12 9.8 V16.8"
    stroke="white"
    stroke-width="2"
    stroke-linecap="round"
  />

  <!-- Hub -->
  <circle
    cx="12"
    cy="12"
    r="1.8"
    stroke="white"
    stroke-width="1.4"
  />
</svg>
`;





    const throttle = document.createElement("div");
    throttle.className = "sei-hud-pedal throttle";
    throttle.innerHTML = `
      <span class="fill"><i></i></span>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <!-- Pedal body -->
        <path
          d="
            M9 4
            L15 4
            L16 18
            Q12 20 8 18
            Z
          "
          stroke-width="2"
          stroke-linejoin="round"
        />

        <!-- Top hinge / mount -->
        <rect
          x="9"
          y="2"
          width="6"
          height="2"
          rx="1"
          stroke-width="2"
        />
      </svg>
    `;

    const apStatus = document.createElement("div");
    apStatus.className = "sei-hud-ap-status";
    apStatus.textContent = "Self-Driving";

    grid.append(gear, brake, leftSig, speedBox, rightSig, wheel, throttle);
    card.append(grid, apStatus);
    wrap.appendChild(card);
    root.appendChild(wrap);

    return {
      root,
      speedVal: speedBox.querySelector(".val"),
      leftSig,
      rightSig,
      wheel,
      wheelSvg: wheel.querySelector("svg"),
      throttlePedal: throttle,
      brakePedal: brake,
      gear,
      apStatus
    };
  }

  function rafLoop(fn) {
    let stop = false;
    (function tick() {
      if (stop) return;
      fn();
      requestAnimationFrame(tick);
    })();
    return () => (stop = true);
  }

  function mount({ videoEl, getTelemetry }) {
    injectStyles();
    const container = videoEl.parentElement;
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }

    const hud = createHudDom(DEFAULTS);
    container.appendChild(hud.root);

    const stop = rafLoop(() => {
      const t = normalizeTelemetry(getTelemetry() || {}, DEFAULTS);

      hud.speedVal.textContent = Math.round(t.speed);
      hud.leftSig.classList.toggle("active", t.left);
      hud.rightSig.classList.toggle("active", t.right);
      hud.leftSig.classList.toggle("blink", t.left);
      hud.rightSig.classList.toggle("blink", t.right);

      hud.wheelSvg.style.setProperty("--sei-wheel-rot", `${t.steerDeg}deg`);
      hud.throttlePedal.style.setProperty("--fill", `${t.throttlePct}%`);
      hud.brakePedal.style.setProperty("--fill", t.brake ? "100%" : "0%");
      hud.gear.textContent = t.gear || "—";

      const isAP = t.autopilotState && t.autopilotState !== "OFF";
      hud.apStatus.classList.toggle("active", isAP);
    });

    return { unmount() { stop(); hud.root.remove(); } };
  }

  window.SeiHud = { mount };
})();
